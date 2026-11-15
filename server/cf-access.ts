import { isLoopbackHost } from "./access.ts";

export interface CfAccessConfig {
  readonly teamDomain: string;
  readonly issuer: string;
  readonly aud: string;
  readonly allowedEmails: ReadonlySet<string>;
  readonly publicOrigin: string;
  readonly certsUrl: string;
}

export type CfAccessVerifyResult =
  | { readonly ok: true; readonly email: string; readonly sub: string; readonly exp: number; readonly expiresAtMs: number }
  | { readonly ok: false; readonly reason: string };

export interface CfAccessVerifier {
  verify(assertion: string | null | undefined): Promise<CfAccessVerifyResult>;
}

const LOOPBACK_BIND_HOSTS = new Set(["127.0.0.1", "::1", "[::1]", "localhost"]);
const TEAM_LABEL_RE = /^[a-z0-9-]+$/i;
const AUD_RE = /^[0-9a-f]{64}$/i;
const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;
const MAX_ASSERTION_LENGTH = 16 * 1024;
const MAX_KID_LENGTH = 128;
const JWKS_TTL_MS = 10 * 60_000;
const REFRESH_COOLDOWN_MS = 60_000;
const JWKS_FETCH_TIMEOUT_MS = 5_000;
const CLOCK_SKEW_SEC = 60;

export function assertLoopbackBindHost(host: string): void {
  if (!LOOPBACK_BIND_HOSTS.has(host)) {
    throw new Error(
      `OVIS security policy requires HOST to be a loopback address (127.0.0.1, ::1, or localhost); got ${JSON.stringify(host)}`,
    );
  }
}

function normalizeTeamDomain(raw: string | undefined): string {
  const value = raw?.trim();
  if (!value) {
    throw new Error("OVIS_CF_ACCESS_TEAM_DOMAIN is required");
  }
  const withoutSuffix = value.toLowerCase().endsWith(".cloudflareaccess.com")
    ? value.slice(0, -".cloudflareaccess.com".length)
    : value;
  if (!TEAM_LABEL_RE.test(withoutSuffix)) {
    throw new Error("OVIS_CF_ACCESS_TEAM_DOMAIN must be <team> or <team>.cloudflareaccess.com");
  }
  return `${withoutSuffix.toLowerCase()}.cloudflareaccess.com`;
}

function normalizeAud(raw: string | undefined): string {
  const value = raw?.trim();
  if (!value || !AUD_RE.test(value)) {
    throw new Error("OVIS_CF_ACCESS_AUD must be a 64-character hex Audience tag");
  }
  return value.toLowerCase();
}

function normalizeAllowedEmails(raw: string | undefined): ReadonlySet<string> {
  const emails = (raw ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);
  if (emails.length === 0) {
    throw new Error("OVIS_CF_ACCESS_ALLOWED_EMAILS must contain at least one email address");
  }
  for (const email of emails) {
    if (!/^[^\s@]+@[^\s@]+$/.test(email)) {
      throw new Error(`Invalid email in OVIS_CF_ACCESS_ALLOWED_EMAILS: ${email}`);
    }
  }
  return new Set(emails);
}

function normalizePublicOrigin(env: Record<string, string | undefined>): string {
  const raw = env["OVIS_PUBLIC_ORIGIN"]?.trim();
  if (!raw) {
    throw new Error("OVIS_PUBLIC_ORIGIN is required");
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("OVIS_PUBLIC_ORIGIN must be a valid URL origin");
  }
  if (parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new Error("OVIS_PUBLIC_ORIGIN must be an origin without path, query, fragment, or credentials");
  }
  if (parsed.protocol === "https:") {
    return parsed.origin;
  }
  if (
    env["OVIS_ALLOW_HTTP_LOOPBACK_ORIGIN"] === "1"
    && parsed.protocol === "http:"
    && isLoopbackHost(parsed.hostname)
  ) {
    return parsed.origin;
  }
  throw new Error("OVIS_PUBLIC_ORIGIN must use https://");
}

export function loadCfAccessConfig(env: Record<string, string | undefined> = process.env): CfAccessConfig {
  const teamDomain = normalizeTeamDomain(env["OVIS_CF_ACCESS_TEAM_DOMAIN"]);
  const issuer = `https://${teamDomain}`;
  return {
    teamDomain,
    issuer,
    aud: normalizeAud(env["OVIS_CF_ACCESS_AUD"]),
    allowedEmails: normalizeAllowedEmails(env["OVIS_CF_ACCESS_ALLOWED_EMAILS"]),
    publicOrigin: normalizePublicOrigin(env),
    certsUrl: `${issuer}/cdn-cgi/access/certs`,
  };
}

function decodeBase64Url(segment: string): Uint8Array | null {
  if (!segment || !BASE64URL_RE.test(segment)) return null;
  try {
    const buf = Buffer.from(segment, "base64url");
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  } catch {
    return null;
  }
}

function decodeJsonObject(bytes: Uint8Array): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    const proto = Object.getPrototypeOf(parsed);
    if (proto !== Object.prototype && proto !== null) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function audienceMatches(claim: unknown, expectedAud: string): boolean {
  if (typeof claim === "string") {
    return claim.toLowerCase() === expectedAud;
  }
  if (Array.isArray(claim)) {
    return claim.some((entry) => typeof entry === "string" && entry.toLowerCase() === expectedAud);
  }
  return false;
}

export function createCfAccessVerifier(
  config: CfAccessConfig,
  deps: { fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>; now?: () => number } = {},
): CfAccessVerifier {
  const fetchFn = deps.fetch ?? globalThis.fetch;
  const now = deps.now ?? (() => Date.now());

  let cachedKeys = new Map<string, CryptoKey>();
  let fetchedAtMs = -Infinity;
  let lastForcedRefreshMs = -Infinity;
  let inFlightRefresh: Promise<void> | null = null;

  async function refreshJwks(): Promise<void> {
    if (inFlightRefresh) return inFlightRefresh;
    inFlightRefresh = (async () => {
      const response = await fetchFn(config.certsUrl, {
        method: "GET",
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(JWKS_FETCH_TIMEOUT_MS),
      });
      if (!response.ok) {
        throw new Error(`JWKS fetch failed with HTTP ${response.status}`);
      }
      const body: unknown = await response.json();
      if (typeof body !== "object" || body === null || !Array.isArray((body as { keys?: unknown }).keys)) {
        throw new Error("JWKS payload missing keys array");
      }
      const nextKeys = new Map<string, CryptoKey>();
      for (const item of (body as { keys: unknown[] }).keys) {
        if (typeof item !== "object" || item === null || Array.isArray(item)) continue;
        const jwk = item as Record<string, unknown>;
        if (jwk["kty"] !== "RSA") continue;
        if (jwk["alg"] !== undefined && jwk["alg"] !== "RS256") continue;
        if (jwk["use"] !== undefined && jwk["use"] !== "sig") continue;
        if (typeof jwk["kid"] !== "string" || jwk["kid"].length === 0 || jwk["kid"].length > MAX_KID_LENGTH) continue;
        if (typeof jwk["n"] !== "string" || typeof jwk["e"] !== "string") continue;
        try {
          const imported = await crypto.subtle.importKey(
            "jwk",
            { kty: "RSA", n: jwk["n"], e: jwk["e"], alg: "RS256", ext: true },
            { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
            false,
            ["verify"],
          );
          nextKeys.set(jwk["kid"], imported);
        } catch {
          /* skip malformed individual JWK */
        }
      }
      if (nextKeys.size === 0) {
        throw new Error("JWKS contained no usable RS256 verification keys");
      }
      cachedKeys = nextKeys;
      fetchedAtMs = now();
    })().finally(() => {
      inFlightRefresh = null;
    });
    return inFlightRefresh;
  }

  async function resolveKey(kid: string): Promise<CryptoKey | null> {
    if (cachedKeys.size === 0 || now() - fetchedAtMs >= JWKS_TTL_MS) {
      await refreshJwks();
    }
    const existing = cachedKeys.get(kid);
    if (existing) return existing;
    if (now() - fetchedAtMs >= REFRESH_COOLDOWN_MS && now() - lastForcedRefreshMs >= REFRESH_COOLDOWN_MS) {
      lastForcedRefreshMs = now();
      await refreshJwks();
      return cachedKeys.get(kid) ?? null;
    }
    return null;
  }

  return {
    async verify(assertion: string | null | undefined): Promise<CfAccessVerifyResult> {
      const token = assertion?.trim() ?? "";
      if (!token) return { ok: false, reason: "missing_assertion" };
      if (token.length > MAX_ASSERTION_LENGTH) return { ok: false, reason: "assertion_too_large" };

      const parts = token.split(".");
      if (parts.length !== 3) return { ok: false, reason: "invalid_jwt_format" };
      const [headerPart, payloadPart, sigPart] = parts as [string, string, string];

      const headerBytes = decodeBase64Url(headerPart);
      const payloadBytes = decodeBase64Url(payloadPart);
      const sigBytes = decodeBase64Url(sigPart);
      if (!headerBytes || !payloadBytes || !sigBytes || sigBytes.byteLength === 0) {
        return { ok: false, reason: "invalid_base64url" };
      }

      const header = decodeJsonObject(headerBytes);
      if (!header) return { ok: false, reason: "invalid_header" };
      if (header["alg"] !== "RS256") return { ok: false, reason: "unsupported_alg" };
      const kid = header["kid"];
      if (typeof kid !== "string" || kid.length === 0 || kid.length > MAX_KID_LENGTH) {
        return { ok: false, reason: "invalid_kid" };
      }

      let key: CryptoKey | null;
      try {
        key = await resolveKey(kid);
      } catch {
        return { ok: false, reason: "jwks_unavailable" };
      }
      if (!key) return { ok: false, reason: "unknown_kid" };

      const signingInput = new TextEncoder().encode(`${headerPart}.${payloadPart}`);
      let signatureValid = false;
      try {
        signatureValid = await crypto.subtle.verify(
          "RSASSA-PKCS1-v1_5",
          key,
          new Uint8Array(sigBytes),
          signingInput,
        );
      } catch {
        signatureValid = false;
      }
      if (!signatureValid) return { ok: false, reason: "invalid_signature" };

      const payload = decodeJsonObject(payloadBytes);
      if (!payload) return { ok: false, reason: "invalid_payload" };
      if (payload["iss"] !== config.issuer) return { ok: false, reason: "invalid_issuer" };
      if (!audienceMatches(payload["aud"], config.aud)) return { ok: false, reason: "invalid_audience" };

      const nowSec = Math.floor(now() / 1000);
      const exp = payload["exp"];
      if (typeof exp !== "number" || !Number.isFinite(exp) || nowSec >= exp + CLOCK_SKEW_SEC) {
        return { ok: false, reason: "token_expired" };
      }
      const nbf = payload["nbf"];
      if (nbf !== undefined && (typeof nbf !== "number" || !Number.isFinite(nbf) || nowSec + CLOCK_SKEW_SEC < nbf)) {
        return { ok: false, reason: "token_not_yet_valid" };
      }
      const iat = payload["iat"];
      if (typeof iat !== "number" || !Number.isFinite(iat) || nowSec + CLOCK_SKEW_SEC < iat) {
        return { ok: false, reason: "invalid_iat" };
      }

      const rawEmail = payload["email"];
      if (typeof rawEmail !== "string") return { ok: false, reason: "missing_email" };
      const email = rawEmail.trim().toLowerCase();
      if (!config.allowedEmails.has(email)) return { ok: false, reason: "email_not_allowed" };

      const sub = typeof payload["sub"] === "string" ? payload["sub"] : "";
      const expiresAtMs = (exp + CLOCK_SKEW_SEC) * 1000;
      return { ok: true, email, sub, exp, expiresAtMs };
    },
  };
}

const MAX_TIMEOUT_MS = 0x7fff_ffff;

/** Runs `onExpire` once `expiresAtMs` is reached, chaining <= 2^31-1 ms timers so long TTLs cannot overflow. */
export function scheduleCfAccessExpiry(
  expiresAtMs: number,
  onExpire: () => void,
  now: () => number = () => Date.now(),
): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const arm = () => {
    if (stopped) return;
    const remaining = expiresAtMs - now();
    const delay = !Number.isFinite(remaining) || remaining <= 0 ? 0 : Math.min(remaining, MAX_TIMEOUT_MS);
    timer = setTimeout(() => {
      timer = undefined;
      if (stopped) return;
      const left = expiresAtMs - now();
      if (!Number.isFinite(left) || left <= 0) {
        stopped = true;
        onExpire();
        return;
      }
      arm();
    }, delay);
  };
  arm();
  return () => {
    stopped = true;
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  };
}
