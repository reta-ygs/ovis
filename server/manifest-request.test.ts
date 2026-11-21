import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:http";

import { testCfAccess, type TestCfFixture } from "./cf-access.fake.ts";
import { createServer } from "./index.ts";

const dist = join(import.meta.dir, "..", "dist");
const standIn = !existsSync(join(dist, "index.html"));

describe("GET /manifest.webmanifest", () => {
  let server: ReturnType<typeof createServer>;
  let stateDir: string;
  let access: TestCfFixture;
  const previous = process.env["OVIS_APP_NAME"];

  beforeAll(async () => {
    access = await testCfAccess();
    if (standIn) {
      mkdirSync(dist, { recursive: true });
      writeFileSync(join(dist, "index.html"), "<html>fixture shell</html>");
      writeFileSync(join(dist, "manifest.webmanifest"), JSON.stringify({ name: "herdr", short_name: "herdr", id: "/", start_url: "/", scope: "/" }));
    }
    stateDir = mkdtempSync(join(tmpdir(), "herdr-manifest-http-"));
    server = createServer({ port: 0, hostname: "127.0.0.1", stateDir, machines: false, sidecar: false, cfAccess: access.cfAccess });
  });
  afterEach(() => {
    if (previous === undefined) delete process.env["OVIS_APP_NAME"]; else process.env["OVIS_APP_NAME"] = previous;
  });
  afterAll(() => {
    server.stop();
    rmSync(stateDir, { recursive: true, force: true });
    if (standIn) rmSync(dist, { recursive: true, force: true });
  });

  const get = (headers: Record<string, string> = {}) => new Promise<{ status: number; cache: string | undefined; json: Record<string, unknown> }>((resolve, reject) => {
    request({ host: "127.0.0.1", port: server.port, path: "/manifest.webmanifest", headers: access.headers(headers) }, res => {
      let text = "";
      res.on("data", chunk => { text += String(chunk); });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, cache: res.headers["cache-control"], json: JSON.parse(text) as Record<string, unknown> }));
    }).on("error", reject).end();
  });

  it("names the configured public origin, and keeps revalidating", async () => {
    delete process.env["OVIS_APP_NAME"];
    const answer = await get();
    expect(answer.status).toBe(200);
    expect(answer.cache).toBe("no-cache");
    expect(answer.json["related_applications"]).toEqual([{ platform: "webapp", id: `${access.publicOrigin}/` }]);
  });

  it("holds the id and the name together under OVIS_APP_NAME", async () => {
    process.env["OVIS_APP_NAME"] = "laptop";
    const answer = await get();
    expect(answer.json["name"]).toBe("laptop");
    expect(answer.json["related_applications"]).toEqual([{ platform: "webapp", id: `${access.publicOrigin}/` }]);
  });

  it("keeps the configured public origin even if Host or X-Forwarded-Proto differ", async () => {
    delete process.env["OVIS_APP_NAME"];
    const answer = await get({ Host: "pc.tailnet.ts.net", "X-Forwarded-Proto": "https" });
    expect(answer.json["related_applications"]).toEqual([{ platform: "webapp", id: `${access.publicOrigin}/` }]);
  });
});
