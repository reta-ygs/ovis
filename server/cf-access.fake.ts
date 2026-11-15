import { createSign, generateKeyPairSync } from "node:crypto";
import {
  createCfAccessVerifier,
  type CfAccessConfig,
  type CfAccessVerifier,
} from "./cf-access.ts";
import { jsonResponse } from "./http.ts";

export const TEST_CF_TEAM_DOMAIN = "test-team.cloudflareaccess.com";
export const TEST_CF_ISSUER = `https://${TEST_CF_TEAM_DOMAIN}`;
export const TEST_CF_AUD = "a".repeat(64);
export const TEST_CF_OWNER_EMAIL = "reta428@gmail.com";
export const TEST_CF_PUBLIC_ORIGIN = "https://ovis.reta.dev";

export interface TestCfFixture {
  readonly publicOrigin: string;
  readonly verifier: CfAccessVerifier;
  readonly cfAccess: { readonly verifier: CfAccessVerifier; readonly publicOrigin: string };
  readonly jwt: string;
  headers: (extra?: Record<string, string>) => Record<string, string>;
  originHeaders: (extra?: Record<string, string>) => Record<string, string>;
}

let cached: TestCfFixture | null = null;

function toBase64Url(input: string | Uint8Array): string {
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : input;
  return Buffer.from(bytes).toString("base64url");
}

export function testCfAccess(): TestCfFixture {
  if (cached) return cached;
  const kid = "test-fake-kid";
  const { publicKey, privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
  });
  const publicJwk = { ...publicKey.export({ format: "jwk" }), kid, use: "sig", alg: "RS256" };
  const cfg: CfAccessConfig = {
    teamDomain: TEST_CF_TEAM_DOMAIN,
    issuer: TEST_CF_ISSUER,
    aud: TEST_CF_AUD,
    allowedEmails: new Set([TEST_CF_OWNER_EMAIL]),
    publicOrigin: TEST_CF_PUBLIC_ORIGIN,
    certsUrl: `${TEST_CF_ISSUER}/cdn-cgi/access/certs`,
  };
  const verifier = createCfAccessVerifier(cfg, {
    fetch: async () => jsonResponse({ keys: [publicJwk] }),
  });
  const nowSec = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT", kid };
  const payload = {
    iss: TEST_CF_ISSUER,
    aud: [TEST_CF_AUD],
    email: TEST_CF_OWNER_EMAIL,
    sub: "test-owner-sub",
    iat: nowSec - 60,
    nbf: nowSec - 60,
    exp: nowSec + 86_400,
  };
  const signingInput = `${toBase64Url(JSON.stringify(header))}.${toBase64Url(JSON.stringify(payload))}`;
  const signer = createSign("RSA-SHA256");
  signer.update(signingInput);
  signer.end();
  const sig = signer.sign(privateKey);
  const jwt = `${signingInput}.${sig.toString("base64url")}`;
  const headers = (extra: Record<string, string> = {}) => ({
    "cf-access-jwt-assertion": jwt,
    ...extra,
  });
  const originHeaders = (extra: Record<string, string> = {}) => ({
    "cf-access-jwt-assertion": jwt,
    origin: TEST_CF_PUBLIC_ORIGIN,
    ...extra,
  });
  cached = {
    publicOrigin: TEST_CF_PUBLIC_ORIGIN,
    verifier,
    cfAccess: { verifier, publicOrigin: TEST_CF_PUBLIC_ORIGIN },
    jwt,
    headers,
    originHeaders,
  };
  return cached;
}
