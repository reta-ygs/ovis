import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testCfAccess, type TestCfFixture } from "./cf-access.fake.ts";
import { createServer, type ServerInstance } from "./index.ts";

/** An isolated bridge configured with Cloudflare Access and the public proxy origin. */
describe("secure WebSocket proxy origin contract", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "herdr-wss-origin-"));
  let bridge: ServerInstance;
  let access: TestCfFixture;
  beforeAll(async () => {
    access = await testCfAccess();
    bridge = createServer({
      port: 0,
      hostname: "127.0.0.1",
      stateDir,
      machines: false,
      cfAccess: { verifier: access.verifier, publicOrigin: "https://proxy.example.test" },
    });
  });
  afterAll(() => { bridge?.stop(); rmSync(stateDir, { recursive: true, force: true }); });

  async function connect(origin: string, forwardedProto = "wss"): Promise<boolean> {
    const RuntimeSocket = WebSocket as unknown as new (url: string, options: { headers: Record<string, string> }) => WebSocket;
    const ws = new RuntimeSocket(`ws://127.0.0.1:${bridge.port}/ws`, { headers: access.headers({
      host: "proxy.example.test", origin,
      "x-forwarded-proto": forwardedProto, "sec-fetch-site": "same-origin",
    }) });
    try {
      return await new Promise<boolean>((resolve, reject) => {
        const deadline = setTimeout(() => reject(new Error("upgrade did not settle within 5 seconds")), 5_000);
        ws.addEventListener("open", () => { clearTimeout(deadline); resolve(true); }, { once: true });
        ws.addEventListener("error", () => { clearTimeout(deadline); resolve(false); }, { once: true });
      });
    } finally { ws.close(); }
  }

  it("upgrades the same HTTPS browser Origin behind Traefik, with no terminal attach", async () => {
    expect(await connect("https://proxy.example.test")).toBe(true);
    expect(await connect("https://proxy.example.test", "https")).toBe(true);
  });
  it("still refuses cross-origin hosts, nonmatching ports and plaintext browser Origins", async () => {
    expect(await connect("https://other.example.test")).toBe(false);
    expect(await connect("https://proxy.example.test:8443")).toBe(false);
    expect(await connect("http://proxy.example.test")).toBe(false);
  });
});
