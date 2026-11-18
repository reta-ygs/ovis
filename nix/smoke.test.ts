import { expect, test } from "bun:test";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const root = process.env["OVIS_PACKAGE_ROOT"];
if (!root) throw new Error("OVIS_PACKAGE_ROOT is required");
const app = join(root, "share/ovis");
const entry = join(root, "bin/ovis-server");

async function launch(env: Record<string, string | undefined>) {
  const child = Bun.spawn([entry, "serve"], {
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const timeout = setTimeout(() => child.kill("SIGKILL"), 5000);
  try {
    const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    expect(code).toBe(1);
    return stderr;
  } finally {
    clearTimeout(timeout);
    child.kill();
  }
}

test("installed launcher fails closed without authentication configuration", async () => {
  const env = { ...process.env };
  delete env["OVIS_CF_ACCESS_TEAM_DOMAIN"];
  expect(await launch(env)).toContain("OVIS_CF_ACCESS_TEAM_DOMAIN");
});

test("installed launcher refuses a public bind", async () => {
  expect(await launch({ ...process.env, HOST: "0.0.0.0" })).toContain("loopback");
});

test("installed launcher serves from an unrelated directory without a live runtime", async () => {
  const child = Bun.spawn([entry, "serve"], {
    cwd: process.env["TMPDIR"],
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: "0",
      OVIS_CF_ACCESS_TEAM_DOMAIN: "fixture.cloudflareaccess.com",
      OVIS_CF_ACCESS_AUD: "a".repeat(64),
      OVIS_CF_ACCESS_ALLOWED_EMAILS: "owner@example.com",
      OVIS_PUBLIC_ORIGIN: "https://ovis.example.com",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const errors = new Response(child.stderr).text();
  const timeout = setTimeout(() => child.kill("SIGKILL"), 12000);
  try {
    let output = "";
    let address: string | undefined;
    const decoder = new TextDecoder();
    const reader = child.stdout.getReader();
    try {
      while (!address) {
        const { done, value } = await reader.read();
        if (done) break;
        output += decoder.decode(value, { stream: true });
        address = output.match(/Ovis listening on (http:\/\/127\.0\.0\.1:\d+)/)?.[1];
      }
    } finally {
      reader.releaseLock();
    }
    if (!address) throw new Error(`Server did not become ready: ${output}\n${await errors}`);
    for (const path of ["/", "/api/health", "/api/updates"]) {
      const response = await fetch(`${address}${path}`, { signal: AbortSignal.timeout(2000) });
      expect(response.status).toBe(401);
      await response.body?.cancel();
    }
  } finally {
    child.kill("SIGTERM");
    await child.exited;
    await errors;
    clearTimeout(timeout);
  }
});

test("installed assets load from an unrelated working directory", async () => {
  const { serveStatic } = await import(pathToFileURL(join(app, "server/static.ts")).href);
  for (const path of ["/", "/sw.js", "/manifest.webmanifest"]) {
    const response = await serveStatic(path);
    expect(response.status).toBe(200);
    expect((await response.text()).length).toBeGreaterThan(0);
  }
  const html = await (await serveStatic("/")).text();
  const asset = html.match(/src="(\/assets\/[^\"]+\.js)"/);
  expect(asset).not.toBeNull();
  const response = await serveStatic(asset![1], "br");
  expect(response.status).toBe(200);
  expect(response.headers.get("content-encoding")).toBe("br");
});

test("Nix-managed serving does not offer in-app updates", async () => {
  const { handleUpdateRequest } = await import(pathToFileURL(join(app, "server/update-api.ts")).href);
  const response = await handleUpdateRequest(new Request("http://localhost/api/updates"), "/api/updates");
  expect(await response.json()).toMatchObject({ managed: false, auto_update: false });
  const install = await handleUpdateRequest(new Request("http://localhost/api/updates/install", {
    method: "POST",
    headers: { "x-herdr-update": "1" },
  }), "/api/updates/install");
  expect(install.status).toBe(409);
});
