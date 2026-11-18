import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = process.env["OVIS_PACKAGE_ROOT"];
if (!root) throw new Error("OVIS_PACKAGE_ROOT is required");
const entry = join(root, "bin/ovis-server");
const fixture = mkdtempSync(join(tmpdir(), "ovis-nix-smoke-"));
const origin = "https://ovis.example.com";
const env = {
  ...process.env,
  HOME: join(fixture, "home"),
  XDG_CONFIG_HOME: join(fixture, "config"),
  OVIS_STATE_DIR: join(fixture, "state"),
  HERDR_SOCKET: join(fixture, "no-herdr.sock"),
  OVIS_RUNTIME: "herdr",
  OVIS_ACCOUNT_SERVICE_URL: "off",
  OVIS_MANAGED: "1",
  HERDR_WEB_MANAGED: "1",
  HOST: "127.0.0.1",
  PORT: "0",
  OVIS_CF_ACCESS_TEAM_DOMAIN: "fixture.cloudflareaccess.com",
  OVIS_CF_ACCESS_AUD: "a".repeat(64),
  OVIS_CF_ACCESS_ALLOWED_EMAILS: "owner@example.com",
  OVIS_PUBLIC_ORIGIN: origin,
  OVIS_TEST_JWKS_FILE: join(fixture, "jwks.json"),
  BUN_OPTIONS: `--preload=${join(import.meta.dir, "jwks-fixture.ts")}`,
};
let child: Bun.Subprocess<"ignore", "pipe", "pipe"> | undefined;
let errors: Promise<string> | undefined;
let address = "";
let assertion: string;

beforeAll(async () => {
  const key = await crypto.subtle.generateKey({
    name: "RSASSA-PKCS1-v1_5",
    modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]),
    hash: "SHA-256",
  }, true, ["sign", "verify"]);
  const kid = "nix-smoke";
  await Bun.write(env.OVIS_TEST_JWKS_FILE, JSON.stringify({
    keys: [{ ...await crypto.subtle.exportKey("jwk", key.publicKey), kid, alg: "RS256", use: "sig" }],
  }));
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: "RS256", kid })).toString("base64url");
  const claims = Buffer.from(JSON.stringify({
    iss: "https://fixture.cloudflareaccess.com",
    aud: env.OVIS_CF_ACCESS_AUD,
    email: env.OVIS_CF_ACCESS_ALLOWED_EMAILS,
    sub: "nix-smoke-owner",
    iat: now - 10,
    exp: now + 3600,
  })).toString("base64url");
  const payload = `${header}.${claims}`;
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key.privateKey, new TextEncoder().encode(payload));
  assertion = `${payload}.${Buffer.from(signature).toString("base64url")}`;

  child = Bun.spawn([entry, "serve"], { cwd: fixture, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  errors = new Response(child.stderr).text();
  const timeout = setTimeout(() => child?.kill("SIGKILL"), 10000);
  let output = "";
  const decoder = new TextDecoder();
  const reader = child.stdout.getReader();
  try {
    while (!address) {
      const { done, value } = await reader.read();
      if (done) throw new Error(`Server did not become ready: ${output}\n${await errors}`);
      output += decoder.decode(value, { stream: true });
      const match = output.match(/Ovis listening on (http:\/\/127\.0\.0\.1:\d+)/);
      if (match) address = match[1]!;
    }
  } finally {
    reader.releaseLock();
    clearTimeout(timeout);
  }
});

afterAll(async () => {
  try {
    if (child) {
      const timeout = setTimeout(() => child?.kill("SIGKILL"), 5000);
      try {
        child.kill("SIGTERM");
        const code = await child.exited;
        await errors;
        expect(code).toBe(0);
        expect(child.signalCode).toBeNull();
      } finally {
        clearTimeout(timeout);
      }
    }
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

function request(path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("cf-access-jwt-assertion", assertion);
  return fetch(`${address}${path}`, { ...init, headers, signal: AbortSignal.timeout(5000) });
}

async function rejectedLaunch(overrides: Record<string, string | undefined>) {
  const process = Bun.spawn([entry, "serve"], {
    cwd: fixture,
    env: { ...env, ...overrides },
    stdin: "ignore",
    stdout: "ignore",
    stderr: "pipe",
  });
  const timeout = setTimeout(() => process.kill("SIGKILL"), 5000);
  try {
    const [code, stderr] = await Promise.all([process.exited, new Response(process.stderr).text()]);
    expect(code).toBe(1);
    return stderr;
  } finally {
    clearTimeout(timeout);
    process.kill();
  }
}

test("installed launcher fails closed without authentication configuration", async () => {
  expect(await rejectedLaunch({ OVIS_CF_ACCESS_TEAM_DOMAIN: undefined })).toContain("OVIS_CF_ACCESS_TEAM_DOMAIN");
});

test("installed launcher refuses a public bind", async () => {
  expect(await rejectedLaunch({ HOST: "0.0.0.0" })).toContain("loopback");
});

test("installed launcher protects static, health, and update routes", async () => {
  for (const path of ["/", "/api/health", "/api/updates"]) {
    const response = await fetch(`${address}${path}`, { signal: AbortSignal.timeout(5000) });
    expect(response.status).toBe(401);
    await response.body?.cancel();
  }
  const invalid = assertion.slice(0, assertion.lastIndexOf(".") + 1) + Buffer.alloc(256).toString("base64url");
  const response = await fetch(`${address}/api/updates`, {
    headers: { "cf-access-jwt-assertion": invalid },
    signal: AbortSignal.timeout(5000),
  });
  expect(response.status).toBe(401);
  await response.body?.cancel();
});

test("installed assets have their own types and contents instead of an HTML fallback", async () => {
  const shell = await request("/");
  expect(shell.status).toBe(200);
  expect(shell.headers.get("content-type")).toBe("text/html; charset=utf-8");
  const html = await shell.text();
  expect(html).toContain("<!doctype html>");

  const worker = await request("/sw.js");
  expect(worker.status).toBe(200);
  expect(worker.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
  const script = await worker.text();
  expect(script).toContain('self.addEventListener("fetch"');
  expect(script).toMatch(/const BUILD = "[0-9a-f]{12}";/);

  const manifest = await request("/manifest.webmanifest");
  expect(manifest.status).toBe(200);
  expect(manifest.headers.get("content-type")).toBe("application/manifest+json; charset=utf-8");
  expect(await manifest.json()).toMatchObject({ start_url: "/", display: "standalone" });

  const asset = html.match(/src="(\/assets\/[^\"]+\.js)"/);
  expect(asset).not.toBeNull();
  const response = await request(asset![1]!, { headers: { "accept-encoding": "br" } });
  expect(response.status).toBe(200);
  expect(response.headers.get("content-encoding")).toBe("br");
  await response.body?.cancel();
});

test("installed update routes report unmanaged status and refuse authenticated mutations", async () => {
  const response = await request("/api/updates");
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ managed: false, auto_update: false });
  for (const action of ["check", "install", "cancel"]) {
    const denied = await request(`/api/updates/${action}`, {
      method: "POST",
      headers: { origin, "x-herdr-update": "1" },
    });
    expect(denied.status).toBe(403);
    expect(await denied.json()).toMatchObject({ error: { code: "disabled_by_policy" } });
  }
});

test("packaged Rust PTY runs the command before its control pipe closes", async () => {
  const binary = process.env["OVIS_PTY_SIDECAR_BIN"];
  if (!binary) throw new Error("OVIS_PTY_SIDECAR_BIN is required");
  const host = Bun.spawn([binary, "80", "24", process.execPath, "-e", 'process.stdout.write("ovis-pty-smoke")'], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  const timeout = setTimeout(() => host.kill("SIGKILL"), 5000);
  try {
    const [code, output, stderr] = await Promise.all([
      host.exited,
      new Response(host.stdout).text(),
      new Response(host.stderr).text(),
    ]);
    expect(code).toBe(0);
    expect(host.signalCode).toBeNull();
    expect(stderr).toBe("");
    expect(output).toContain("ovis-pty-smoke");
  } finally {
    host.stdin.end();
    host.kill();
    await host.exited;
    clearTimeout(timeout);
  }
});
