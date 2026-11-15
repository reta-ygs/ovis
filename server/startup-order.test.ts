import { expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testCfAccess } from "./cf-access.fake.ts";
import { createServer } from "./index.ts";
import { TailnetIdentitySource } from "./tailscale.ts";

// The order createServer starts things in, where it matters. createCore's own order is told in its
// comment (server/core/server-core.ts); this pins the one between it and the HTTP side that once broke.

it("proves the sidecar synchronously and never invokes TailnetIdentitySource", async () => {
  const access = testCfAccess();
  const stateDir = mkdtempSync(join(tmpdir(), "ovis-startup-"));
  const namedOwner = process.env["OVIS_TAILSCALE_OWNER"];
  delete process.env["OVIS_TAILSCALE_OWNER"];
  const steps: string[] = [];
  const server = createServer({
    port: 0, hostname: "127.0.0.1", stateDir, machines: false, cfAccess: access.cfAccess,
    sidecar: () => { steps.push("probe"); return false; },
    tailnet: new TailnetIdentitySource(async () => { steps.push("identity read"); return null; }),
  });
  try {
    expect(steps).toEqual(["probe"]);
    const health = await fetch(`http://127.0.0.1:${server.port}/api/health?scope=bridge`, { headers: access.headers() });
    expect(health.status).toBe(200);
    expect(steps).toEqual(["probe"]);
  } finally {
    server.stop();
    if (namedOwner !== undefined) process.env["OVIS_TAILSCALE_OWNER"] = namedOwner;
    rmSync(stateDir, { recursive: true, force: true });
  }
});
