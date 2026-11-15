import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  assertLoopbackBindHost,
  createCfAccessVerifier,
  loadCfAccessConfig,
  scheduleCfAccessExpiry,
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
    expect(await verifier.verify(valid)).toEqual({
      ok: true,
      email: OWNER_EMAIL,
      sub: "user-sub-1",
      exp: nowSec() + 300,
      expiresAtMs: (nowSec() + 360) * 1000,
    });
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
    const c1 = claim();
    expect(await verifier.verify(await signJwt(key1, c1))).toEqual({
      ok: true,
      email: OWNER_EMAIL,
      sub: "user-1",
      exp: c1.exp,
      expiresAtMs: (c1.exp + 60) * 1000,
    });
    expect(fetchCalls).toBe(1);

    activeKeys = [key1.publicJwk, key2.publicJwk];
    expect(await verifier.verify(await signJwt(key2, claim()))).toEqual({ ok: false, reason: "unknown_kid" });
    expect(fetchCalls).toBe(1);

    // After 60s cooldown, unknown kid refreshes JWKS once and accepts key2.
    nowMs += 61_000;
    const c2 = claim();
    expect(await verifier.verify(await signJwt(key2, c2))).toEqual({
      ok: true,
      email: OWNER_EMAIL,
      sub: "user-1",
      exp: c2.exp,
      expiresAtMs: (c2.exp + 60) * 1000,
    });
    expect(fetchCalls).toBe(2);

    // Known key within cooldown triggers no extra fetch.
    const c3 = claim();
    expect(await verifier.verify(await signJwt(key1, c3))).toEqual({
      ok: true,
      email: OWNER_EMAIL,
      sub: "user-1",
      exp: c3.exp,
      expiresAtMs: (c3.exp + 60) * 1000,
    });
    expect(fetchCalls).toBe(2);

    // After 10m TTL, next verify refreshes JWKS.
    nowMs += 10 * 60_000 + 1;
    const c4 = claim();
    expect(await verifier.verify(await signJwt(key2, c4))).toEqual({
      ok: true,
      email: OWNER_EMAIL,
      sub: "user-1",
      exp: c4.exp,
      expiresAtMs: (c4.exp + 60) * 1000,
    });
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

describe("CF Access stream expiration and managed IPC health probe", () => {
  it("chains > 0x7fff_ffff ms delays without overflow and supports clean cancellation", () => {
    const timers: Array<{ fn: () => void; delay: number; cleared: boolean }> = [];
    const setSpy = spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void, delay?: number) => {
      const entry = { fn, delay: delay ?? 0, cleared: false };
      timers.push(entry);
      return entry as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout);
    const clearSpy = spyOn(globalThis, "clearTimeout").mockImplementation(((handle?: ReturnType<typeof setTimeout>) => {
      const entry = handle as unknown as { cleared?: boolean } | undefined;
      if (entry) entry.cleared = true;
    }) as typeof clearTimeout);
    try {
      let nowMs = 1_000_000;
      let fired = 0;
      const stop = scheduleCfAccessExpiry(nowMs + 0x7fff_ffff + 500, () => {
        fired += 1;
      }, () => nowMs);

      expect(fired).toBe(0);
      expect(timers).toHaveLength(1);
      expect(timers[0]!.delay).toBe(0x7fff_ffff);

      nowMs += 0x7fff_ffff;
      timers[0]!.fn();
      expect(fired).toBe(0);
      expect(timers).toHaveLength(2);
      expect(timers[1]!.delay).toBe(500);

      nowMs += 500;
      timers[1]!.fn();
      expect(fired).toBe(1);
      stop();

      let cancelledFired = 0;
      const cancel = scheduleCfAccessExpiry(nowMs + 100, () => {
        cancelledFired += 1;
      }, () => nowMs);
      cancel();
      expect(timers.at(-1)!.cleared).toBe(true);
      timers.at(-1)!.fn();
      expect(cancelledFired).toBe(0);
    } finally {
      setSpy.mockRestore();
      clearSpy.mockRestore();
    }
  });

  it("closes upgraded WebSocket connections and /api/machines/events SSE streams when JWT exp + skew passes", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "ovis-cf-expiry-"));
    const key = await generateRsaKey("exp-kid");
    const verifier = createCfAccessVerifier(testConfig(), {
      fetch: async () => Response.json({ keys: [key.publicJwk] }),
    });
    const server = createServer({
      port: 0,
      hostname: "127.0.0.1",
      stateDir,
      system: null,
      cfAccess: { verifier, publicOrigin: PUBLIC_ORIGIN },
    });
    const baseUrl = `http://127.0.0.1:${server.port}`;
    try {
      const shortClaims = () => {
        const nowSec = Date.now() / 1000;
        return {
          iss: ISSUER,
          aud: AUD,
          email: OWNER_EMAIL,
          sub: "expiring-owner",
          iat: Math.floor(nowSec) - 10,
          exp: nowSec - 60 + 0.25,
        };
      };
      const wsJwt = await signJwt(key, shortClaims());
      const RuntimeSocket = WebSocket as unknown as new (url: string, options: { headers: Record<string, string> }) => WebSocket;
      const ws = new RuntimeSocket(`ws://127.0.0.1:${server.port}/ws`, {
        headers: {
          "cf-access-jwt-assertion": wsJwt,
          origin: PUBLIC_ORIGIN,
        },
      });
      const wsOutcome = await new Promise<{ opened: boolean; code: number }>((resolve, reject) => {
        let opened = false;
        const deadline = setTimeout(() => reject(new Error("WebSocket did not close on JWT expiry within 5s")), 5_000);
        ws.addEventListener("open", () => { opened = true; }, { once: true });
        ws.addEventListener("close", (event) => {
          clearTimeout(deadline);
          resolve({ opened, code: event.code });
        }, { once: true });
        ws.addEventListener("error", () => {
          clearTimeout(deadline);
          reject(new Error("WebSocket errored before closing on JWT expiry"));
        }, { once: true });
      });
      expect(wsOutcome.opened).toBe(true);
      expect(wsOutcome.code).toBe(1008);

      const sseJwt = await signJwt(key, shortClaims());
      const sseRes = await fetch(`${baseUrl}/api/machines/events`, {
        headers: { "cf-access-jwt-assertion": sseJwt },
      });
      expect(sseRes.status).toBe(200);
      expect(sseRes.headers.get("content-type")).toBe("text/event-stream");
      const reader = sseRes.body!.getReader();
      let deadline: ReturnType<typeof setTimeout> | undefined;
      try {
        const ended = await Promise.race([
          (async () => {
            while (true) {
              const { done } = await reader.read();
              if (done) return "ended" as const;
            }
          })(),
          new Promise<"timeout">((resolve) => {
            deadline = setTimeout(() => resolve("timeout"), 5_000);
          }),
        ]);
        expect(ended).toBe("ended");
      } finally {
        if (deadline !== undefined) clearTimeout(deadline);
        await reader.cancel().catch(() => undefined);
      }
    } finally {
      server.stop();
      rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("answers managed IPC bridge-health-probe while keeping /api/health?scope=bridge 401 without JWT", async () => {
    const subStateDir = mkdtempSync(join(tmpdir(), "ovis-managed-ipc-"));
    const bootId = randomUUID();
    const ipcAnswers: Array<{ type?: string; boot_id?: string; runtime?: string; runtime_ok?: boolean }> = [];
    let notifyAnswer: (() => void) | null = null;
    const child = Bun.spawn([process.execPath, join(import.meta.dir, "index.ts")], {
      cwd: join(import.meta.dir, ".."),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        HOST: "127.0.0.1",
        PORT: "0",
        OVIS_MANAGED: "1",
        OVIS_BOOT_ID: bootId,
        OVIS_RUNTIME: "herdr",
        OVIS_STATE_DIR: subStateDir,
        HERDR_SOCKET: join(subStateDir, "missing-herdr.sock"),
        OVIS_CF_ACCESS_TEAM_DOMAIN: TEAM_DOMAIN,
        OVIS_CF_ACCESS_AUD: AUD,
        OVIS_CF_ACCESS_ALLOWED_EMAILS: OWNER_EMAIL,
        OVIS_PUBLIC_ORIGIN: PUBLIC_ORIGIN,
      },
      ipc(message) {
        if (message && typeof message === "object" && (message as { type?: unknown }).type === "bridge-health-answer") {
          ipcAnswers.push(message as { type?: string; boot_id?: string; runtime?: string; runtime_ok?: boolean });
          notifyAnswer?.();
          notifyAnswer = null;
        }
      },
    });
    try {
      const reader = child.stdout.getReader();
      const decoder = new TextDecoder();
      let output = "";
      let port: number | null = null;
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline && port === null) {
        const readPromise = reader.read();
        const chunk = await Promise.race([
          readPromise,
          new Promise<{ done: true; value: undefined }>((resolve) =>
            setTimeout(() => resolve({ done: true, value: undefined }), Math.max(1, deadline - Date.now()))),
        ]);
        if (chunk.value) {
          output += decoder.decode(chunk.value, { stream: true });
          const match = /Ovis listening on http:\/\/127\.0\.0\.1:(\d+)/.exec(output);
          if (match) port = Number(match[1]);
        }
        if (chunk.done) break;
      }
      reader.releaseLock();
      expect(port).not.toBeNull();

      const answered = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Timed out waiting for bridge-health-answer IPC")), 5_000);
        notifyAnswer = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      child.send({ type: "bridge-health-probe" });
      await answered;

      expect(ipcAnswers).toEqual([
        {
          type: "bridge-health-answer",
          boot_id: bootId,
          runtime: "herdr",
          runtime_ok: false,
        },
      ]);

      const unauthBridgeHealth = await fetch(`http://127.0.0.1:${port}/api/health?scope=bridge`);
      expect(unauthBridgeHealth.status).toBe(401);
    } finally {
      child.kill("SIGKILL");
      await child.exited.catch(() => undefined);
      rmSync(subStateDir, { recursive: true, force: true });
    }
  });
});
