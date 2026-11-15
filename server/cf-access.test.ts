import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  assertLoopbackBindHost,
  createCfAccessVerifier,
  loadCfAccessConfig,
  type CfAccessConfig,
} from "./cf-access.ts";
import { createServer } from "./index.ts";

const TEAM_DOMAIN = "test-team.cloudflareaccess.com";
const ISSUER = `https://${TEAM_DOMAIN}`;
const AUD = "a".repeat(64);
const OWNER_EMAIL = "reta428@gmail.com";
const PUBLIC_ORIGIN = "https://ovis.reta.dev";

function encodeBase64Url(input: string | Uint8Array): string {
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : input;
  return Buffer.from(bytes).toString("base64url");
}

interface TestKeyPair {
  kid: string;
  privateKey: CryptoKey;
  publicJwk: Record<string, unknown>;
}

async function generateRsaKey(kid: string): Promise<TestKeyPair> {
  const pair = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  const jwk = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as Record<string, unknown>;
  return {
    kid,
    privateKey: pair.privateKey,
    publicJwk: { ...jwk, kid, use: "sig", alg: "RS256" },
  };
}

async function signJwt(
  key: TestKeyPair,
  payload: Record<string, unknown>,
  headerOverrides: Record<string, unknown> = {},
): Promise<string> {
  const header = { alg: "RS256", typ: "JWT", kid: key.kid, ...headerOverrides };
  const signingInput = `${encodeBase64Url(JSON.stringify(header))}.${encodeBase64Url(JSON.stringify(payload))}`;
  const sig = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key.privateKey,
    new TextEncoder().encode(signingInput),
  );
  return `${signingInput}.${encodeBase64Url(new Uint8Array(sig))}`;
}

function testConfig(overrides: Partial<CfAccessConfig> = {}): CfAccessConfig {
  return {
    teamDomain: TEAM_DOMAIN,
    issuer: ISSUER,
    aud: AUD,
    allowedEmails: new Set([OWNER_EMAIL]),
    publicOrigin: PUBLIC_ORIGIN,
    certsUrl: `${ISSUER}/cdn-cgi/access/certs`,
    ...overrides,
  };
}

describe("assertLoopbackBindHost", () => {
  it("allows loopback hosts and rejects non-loopback hosts", () => {
    for (const allowed of ["127.0.0.1", "::1", "[::1]", "localhost"]) {
      expect(() => assertLoopbackBindHost(allowed)).not.toThrow();
    }
    for (const rejected of ["0.0.0.0", "::", "192.168.1.10", "100.64.0.1", ""]) {
      expect(() => assertLoopbackBindHost(rejected)).toThrow();
    }
  });
});

describe("loadCfAccessConfig", () => {
  const validEnv = {
    OVIS_CF_ACCESS_TEAM_DOMAIN: "test-team",
    OVIS_CF_ACCESS_AUD: AUD,
    OVIS_CF_ACCESS_ALLOWED_EMAILS: `  ${OWNER_EMAIL.toUpperCase()}  `,
    OVIS_PUBLIC_ORIGIN: PUBLIC_ORIGIN,
  };

  it("normalizes valid configuration", () => {
    const cfg = loadCfAccessConfig(validEnv);
    expect(cfg.teamDomain).toBe(TEAM_DOMAIN);
    expect(cfg.issuer).toBe(ISSUER);
    expect(cfg.certsUrl).toBe(`${ISSUER}/cdn-cgi/access/certs`);
    expect(cfg.aud).toBe(AUD);
    expect(cfg.allowedEmails.has(OWNER_EMAIL)).toBe(true);
    expect(cfg.publicOrigin).toBe(PUBLIC_ORIGIN);
  });

  it("fails closed on missing or malformed variables", () => {
    expect(() => loadCfAccessConfig({})).toThrow();
    expect(() => loadCfAccessConfig({ ...validEnv, OVIS_CF_ACCESS_TEAM_DOMAIN: "bad.domain/evil" })).toThrow();
    expect(() => loadCfAccessConfig({ ...validEnv, OVIS_CF_ACCESS_AUD: "not-hex" })).toThrow();
    expect(() => loadCfAccessConfig({ ...validEnv, OVIS_CF_ACCESS_ALLOWED_EMAILS: "" })).toThrow();
    expect(() => loadCfAccessConfig({ ...validEnv, OVIS_CF_ACCESS_ALLOWED_EMAILS: "not-an-email" })).toThrow();
    expect(() => loadCfAccessConfig({ ...validEnv, OVIS_PUBLIC_ORIGIN: "http://ovis.reta.dev" })).toThrow();
    expect(() => loadCfAccessConfig({ ...validEnv, OVIS_PUBLIC_ORIGIN: "https://ovis.reta.dev/sub" })).toThrow();
    expect(() => loadCfAccessConfig({ ...validEnv, OVIS_PUBLIC_ORIGIN: "https://user:pass@ovis.reta.dev" })).toThrow();
    expect(() => loadCfAccessConfig({
      ...validEnv,
      OVIS_PUBLIC_ORIGIN: "http://192.168.1.10:7317",
      OVIS_ALLOW_HTTP_LOOPBACK_ORIGIN: "1",
    })).toThrow();
  });

  it("permits http loopback origin only when explicitly enabled", () => {
    expect(() => loadCfAccessConfig({ ...validEnv, OVIS_PUBLIC_ORIGIN: "http://127.0.0.1:7317" })).toThrow();
    const localCfg = loadCfAccessConfig({
      ...validEnv,
      OVIS_PUBLIC_ORIGIN: "http://127.0.0.1:7317",
      OVIS_ALLOW_HTTP_LOOPBACK_ORIGIN: "1",
    });
    expect(localCfg.publicOrigin).toBe("http://127.0.0.1:7317");
  });
});

describe("createCfAccessVerifier", () => {
  let key1: TestKeyPair;
  let key2: TestKeyPair;

  beforeAll(async () => {
    key1 = await generateRsaKey("kid-1");
    key2 = await generateRsaKey("kid-2");
  });

  it("validates RS256 signatures, standard claims, and allowed email", async () => {
    let nowMs = 1_700_000_000_000;
    const nowSec = () => Math.floor(nowMs / 1000);
    let fetchCalls = 0;
    const verifier = createCfAccessVerifier(testConfig(), {
      now: () => nowMs,
      fetch: async () => {
        fetchCalls += 1;
        return Response.json({ keys: [key1.publicJwk] });
      },
    });

    const baseClaims = () => ({
      iss: ISSUER,
      aud: [AUD],
      email: "  Reta428@gmail.com ",
      sub: "user-sub-1",
      iat: nowSec() - 10,
      nbf: nowSec() - 10,
      exp: nowSec() + 300,
    });

    expect((await verifier.verify(null)).ok).toBe(false);
    expect((await verifier.verify("")).ok).toBe(false);
    expect((await verifier.verify("a.b")).ok).toBe(false);

    const algNone = `${encodeBase64Url(JSON.stringify({ alg: "none", kid: key1.kid }))}.${encodeBase64Url(JSON.stringify(baseClaims()))}.sig`;
    expect(await verifier.verify(algNone)).toEqual({ ok: false, reason: "unsupported_alg" });

    const hs256 = await signJwt(key1, baseClaims(), { alg: "HS256" });
    expect(await verifier.verify(hs256)).toEqual({ ok: false, reason: "unsupported_alg" });

    const valid = await signJwt(key1, baseClaims());
    expect(await verifier.verify(valid)).toEqual({ ok: true, email: OWNER_EMAIL, sub: "user-sub-1" });
    expect(fetchCalls).toBe(1);

    // Tampered payload
    const [h, , s] = valid.split(".") as [string, string, string];
    const tampered = `${h}.${encodeBase64Url(JSON.stringify({ ...baseClaims(), sub: "other" }))}.${s}`;
    expect(await verifier.verify(tampered)).toEqual({ ok: false, reason: "invalid_signature" });

    // Claim validations
    expect(await verifier.verify(await signJwt(key1, { ...baseClaims(), iss: "https://other.cloudflareaccess.com" }))).toEqual({ ok: false, reason: "invalid_issuer" });
    expect(await verifier.verify(await signJwt(key1, { ...baseClaims(), aud: ["b".repeat(64)] }))).toEqual({ ok: false, reason: "invalid_audience" });
    expect(await verifier.verify(await signJwt(key1, { ...baseClaims(), exp: nowSec() - 120 }))).toEqual({ ok: false, reason: "token_expired" });
    expect(await verifier.verify(await signJwt(key1, { ...baseClaims(), nbf: nowSec() + 120 }))).toEqual({ ok: false, reason: "token_not_yet_valid" });
    expect(await verifier.verify(await signJwt(key1, { ...baseClaims(), iat: nowSec() + 120 }))).toEqual({ ok: false, reason: "invalid_iat" });
    expect(await verifier.verify(await signJwt(key1, { ...baseClaims(), email: "attacker@example.com" }))).toEqual({ ok: false, reason: "email_not_allowed" });

    // JWKS stays cached across repeated checks within 10m TTL
    expect(fetchCalls).toBe(1);
  });

  it("caches JWKS, prevents cold-start unknown-kid flood, and rotates after cooldown", async () => {
    let nowMs = 1_700_000_000_000;
    const nowSec = () => Math.floor(nowMs / 1000);
    let activeKeys = [key1.publicJwk];
    let fetchCalls = 0;

    const verifier = createCfAccessVerifier(testConfig(), {
      now: () => nowMs,
      fetch: async () => {
        fetchCalls += 1;
        return Response.json({ keys: activeKeys });
      },
    });

    const claim = () => ({
      iss: ISSUER,
      aud: AUD,
      email: OWNER_EMAIL,
      sub: "user-1",
      iat: nowSec() - 5,
      exp: nowSec() + 600,
    });

    // Cold fetch loads key1; immediately presenting unknown key2 must NOT force another fetch within 60s.
    expect(await verifier.verify(await signJwt(key1, claim()))).toEqual({ ok: true, email: OWNER_EMAIL, sub: "user-1" });
    expect(fetchCalls).toBe(1);

    activeKeys = [key1.publicJwk, key2.publicJwk];
    expect(await verifier.verify(await signJwt(key2, claim()))).toEqual({ ok: false, reason: "unknown_kid" });
    expect(fetchCalls).toBe(1);

    // After 60s cooldown, unknown kid refreshes JWKS once and accepts key2.
    nowMs += 61_000;
    expect(await verifier.verify(await signJwt(key2, claim()))).toEqual({ ok: true, email: OWNER_EMAIL, sub: "user-1" });
    expect(fetchCalls).toBe(2);

    // Known key within cooldown triggers no extra fetch.
    expect(await verifier.verify(await signJwt(key1, claim()))).toEqual({ ok: true, email: OWNER_EMAIL, sub: "user-1" });
    expect(fetchCalls).toBe(2);

    // After 10m TTL, next verify refreshes JWKS.
    nowMs += 10 * 60_000 + 1;
    expect(await verifier.verify(await signJwt(key2, claim()))).toEqual({ ok: true, email: OWNER_EMAIL, sub: "user-1" });
    expect(fetchCalls).toBe(3);
  });
});

describe("hardened createServer enforcement", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "ovis-cf-access-"));
  let server: ReturnType<typeof createServer>;
  let baseUrl: string;
  let validJwt: string;

  beforeAll(async () => {
    const key = await generateRsaKey("srv-kid");
    const nowSec = Math.floor(Date.now() / 1000);
    const cfg = testConfig();
    const verifier = createCfAccessVerifier(cfg, {
      fetch: async () => Response.json({ keys: [key.publicJwk] }),
    });
    validJwt = await signJwt(key, {
      iss: ISSUER,
      aud: AUD,
      email: OWNER_EMAIL,
      sub: "owner-sub",
      iat: nowSec - 10,
      exp: nowSec + 3600,
    });
    server = createServer({
      port: 0,
      hostname: "127.0.0.1",
      stateDir,
      system: null,
      cfAccess: { verifier, publicOrigin: PUBLIC_ORIGIN },
    });
    baseUrl = `http://127.0.0.1:${server.port}`;
  });

  afterAll(() => {
    server.stop();
    rmSync(stateDir, { recursive: true, force: true });
  });

  it("fails closed if createServer is called without cfAccess config or non-loopback hostname", () => {
    expect(() => createServer({ port: 0, hostname: "0.0.0.0", stateDir })).toThrow();
    const prevTeam = process.env["OVIS_CF_ACCESS_TEAM_DOMAIN"];
    delete process.env["OVIS_CF_ACCESS_TEAM_DOMAIN"];
    try {
      expect(() => createServer({ port: 0, hostname: "127.0.0.1", stateDir })).toThrow();
    } finally {
      if (prevTeam !== undefined) process.env["OVIS_CF_ACCESS_TEAM_DOMAIN"] = prevTeam;
    }
  });

  it("requires valid Cf-Access-Jwt-Assertion on static, health, API, and WS routes", async () => {
    for (const path of ["/", "/assets/index.js", "/api/health", "/api/access", "/ws"]) {
      const res = await fetch(`${baseUrl}${path}`);
      expect(res.status).toBe(401);
    }
    const bearerAttempt = await fetch(`${baseUrl}/api/access`, {
      headers: { authorization: "Bearer ignored-legacy-token" },
    });
    expect(bearerAttempt.status).toBe(401);

    const accessRes = await fetch(`${baseUrl}/api/access`, {
      headers: { "cf-access-jwt-assertion": validJwt },
    });
    expect(accessRes.status).toBe(200);
    const body = await accessRes.json() as { tailscale: { state: string } };
    expect(body.tailscale.state).toBe("missing");

    const rootRes = await fetch(`${baseUrl}/`, {
      headers: { "cf-access-jwt-assertion": validJwt },
    });
    expect(rootRes.status).not.toBe(401);
    expect(rootRes.status).not.toBe(403);
  });

  it("enforces strict public Origin checks on mutations and /ws", async () => {
    const payload = JSON.stringify({ settings: { theme: "dark" } });

    const missingOrigin = await fetch(`${baseUrl}/api/preferences`, {
      method: "PUT",
      headers: {
        "cf-access-jwt-assertion": validJwt,
        "content-type": "application/json",
      },
      body: payload,
    });
    expect(missingOrigin.status).toBe(403);

    const wrongOrigin = await fetch(`${baseUrl}/api/preferences`, {
      method: "PUT",
      headers: {
        "cf-access-jwt-assertion": validJwt,
        "content-type": "application/json",
        origin: "https://evil.example",
      },
      body: payload,
    });
    expect(wrongOrigin.status).toBe(403);

    const validOrigin = await fetch(`${baseUrl}/api/preferences`, {
      method: "PUT",
      headers: {
        "cf-access-jwt-assertion": validJwt,
        "content-type": "application/json",
        origin: PUBLIC_ORIGIN,
      },
      body: payload,
    });
    expect(validOrigin.status).toBe(200);

    const wsMissingOrigin = await fetch(`${baseUrl}/ws`, {
      headers: { "cf-access-jwt-assertion": validJwt },
    });
    expect(wsMissingOrigin.status).toBe(403);

    const wsWrongOrigin = await fetch(`${baseUrl}/ws`, {
      headers: {
        "cf-access-jwt-assertion": validJwt,
        origin: "https://evil.example",
      },
    });
    expect(wsWrongOrigin.status).toBe(403);

    const wsRemoteMachine = await fetch(`${baseUrl}/ws?machine_id=remote1`, {
      headers: {
        "cf-access-jwt-assertion": validJwt,
        origin: PUBLIC_ORIGIN,
      },
    });
    expect(wsRemoteMachine.status).toBe(403);
  });

  it("blocks disabled endpoints with 403 and stubs telemetry/push with 404", async () => {
    const commonHeaders = {
      "cf-access-jwt-assertion": validJwt,
      origin: PUBLIC_ORIGIN,
      "x-herdr-machine": "1",
    };

    const blocked: Array<[string, string]> = [
      ["POST", "/api/auth"],
      ["GET", "/api/devices"],
      ["GET", "/api/portal"],
      ["GET", "/api/relay"],
      ["GET", "/api/account/session"],
      ["POST", "/api/bridge"],
      ["GET", "/api/runtime"],
      ["POST", "/api/runtime/move"],
      ["POST", "/api/agent-catalog/install"],
      ["POST", "/api/machines/local/agent-catalog/install"],
      ["POST", "/api/machines/setup"],
      ["GET", "/api/machines/ssh-candidates"],
      ["POST", "/api/alerts/webhook"],
      ["POST", "/api/updates/check"],
      ["POST", "/api/herdr/update"],
    ];

    for (const [method, path] of blocked) {
      const res = await fetch(`${baseUrl}${path}`, { method, headers: commonHeaders });
      expect(res.status).toBe(403);
    }

    const telemetryRes = await fetch(`${baseUrl}/api/telemetry`, {
      headers: { "cf-access-jwt-assertion": validJwt },
    });
    expect(telemetryRes.status).toBe(404);

    const pushRes = await fetch(`${baseUrl}/api/push/vapid-public-key`, {
      headers: { "cf-access-jwt-assertion": validJwt },
    });
    expect(pushRes.status).toBe(404);
  });
});
