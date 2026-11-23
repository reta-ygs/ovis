import { expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleRequest } from "./dispatch.ts";
import { createServer } from "./index.ts";
import { testCfAccess } from "./cf-access.fake.ts";
import { TailnetNodes, tailnetNodeGate } from "./tailnet-nodes.ts";
import { TailnetIdentitySource } from "./tailscale.ts";

it("a paired direct peer on the tailnet is associated with its StableNodeID", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "astra-direct-peer-"));
  const cf = testCfAccess();
  let lookups = 0;
  const tailnet = new TailnetIdentitySource(async () => null, async () => {
    lookups++;
    return JSON.stringify({ Node: { StableID: "nPhone", ComputedName: "Phone" } });
  });
  try {
    const app = createServer({ stateDir, port: 0, hostname: "127.0.0.1", machines: false, sidecar: false, cfAccess: cf.cfAccess, tailnet });
    try {
      const rows = app.context.services.devices;
      const paired = rows.pair(rows.startPairing().code, "Phone", "drive")!;
      const row = rows.match(paired.token)!;
      const url = "http://fixture.test/api/health?scope=bridge";
      const context = { ...app.context, requestIP: () => ({ address: "100.64.0.9" }), timeout() {} };
      const cookie = { cookie: `ovis_device=${paired.token}` };
      expect((await handleRequest(new Request(url, { headers: cookie }), context))?.status).toBe(401);
      expect((await handleRequest(new Request(url, { headers: cf.headers(cookie) }), context))?.status).toBe(200);
      expect(lookups).toBe(0);
      expect(rows.tailnetRowsOf("nPhone")).toEqual([]);

      await tailnetNodeGate({ level: "full", via: "device", role: "drive", device: row }, {
        address: "100.64.0.9", owner: null, nodes: new TailnetNodes(stateDir), rows, whois: (address) => tailnet.node(address),
      });
      expect(rows.tailnetRowsOf("nPhone")).toContain(row.id);
    } finally { app.stop(); }
  } finally { rmSync(stateDir, { recursive: true, force: true }); }
});
