/**
 * POST /api/access/tailscale/serve and /open: this PC's own window alone has Ovis served on the tailnet, or the Tailscale
 * app opened; any other caller is refused before the CLI is run. The CLI here is a fake `tailscale` handed to the server
 * (never the one on PATH: a real `serve` would change this PC's tailnet), and it writes down every call it gets.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "./index.ts";
import { testCfAccess } from "./cf-access.fake.ts";
import { HTTPS_PORT_VARIABLE, openTailscaleApp, serveTailscale, tailscaleAppCommand } from "./tailscale.ts";

const TOKEN = "serve-token";
const DNS = "pc.example.ts.net";

interface Fake {
  bin: string;
  /** every call's arguments, the binary's own path first */
  calls(): string[][];
  /** the serve calls only */
  serves(): string[][];
}

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });

/**
 * A `tailscale` that answers `status --json` with `state`, `serve status --json` with the serve config written so far
 * (`existing` at first), and `serve --bg --https=<p> <target>` by adding that one listener, or, `refuse` set, by
 * writing it to stderr and exiting 1.
 */
function fakeTailscale({ state = "Running", existing = {}, refuse }: { state?: string; existing?: Record<string, string>; refuse?: string }): Fake {
  const dir = mkdtempSync(join(tmpdir(), "ovis-fake-tailscale-"));
  const bin = join(dir, "bin");
  const log = join(dir, "calls");
  const config = join(dir, "serve.json");
  const serveJson = (listeners: Record<string, string>) => JSON.stringify({
    TCP: Object.fromEntries(Object.keys(listeners).map((port) => [port, { HTTPS: true }])),
    Web: Object.fromEntries(Object.entries(listeners).map(([port, proxy]) => [`${DNS}:${port}`, { Handlers: { "/": { Proxy: proxy } } }])),
  });
  writeFileSync(config, serveJson(existing));
  mkdirSync(bin);
  const listeners = JSON.stringify(existing).replace(/'/g, "");
  writeFileSync(join(bin, "tailscale"), `#!/bin/sh
{ printf '%s\\037' "$0" "$@"; printf '\\n'; } >> '${log}'
if [ "$1" = status ]; then printf '%s' '${JSON.stringify({ BackendState: state, Self: { DNSName: `${DNS}.` } })}'; exit 0; fi
if [ "$1" = serve ] && [ "$2" = status ]; then cat '${config}'; exit 0; fi
if [ "$1" = serve ]; then
  ${refuse === undefined ? "" : `printf '%s\\n' '${refuse}' >&2; exit 1`}
  port=\${3#--https=}
  bun -e 'const [file, existing, port, target] = process.argv.slice(1); const l = { ...JSON.parse(existing), [port]: target };
    require("node:fs").writeFileSync(file, JSON.stringify({ TCP: Object.fromEntries(Object.keys(l).map((p) => [p, { HTTPS: true }])),
    Web: Object.fromEntries(Object.entries(l).map(([p, x]) => [\`${DNS}:\${p}\`, { Handlers: { "/": { Proxy: x } } }])) }))' '${config}' '${listeners}' "$port" "$4"
  exit 0
fi
exit 2
`, { mode: 0o755 });
  cleanups.push(() => { rmSync(dir, { recursive: true, force: true }); });
  const calls = () => existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean).map((line) => line.split("\x1f").slice(0, -1)) : [];
  return { bin: join(bin, "tailscale"), calls, serves: () => calls().filter((call) => call[1] === "serve" && call[2] !== "status") };
}

/** this PC's own Tailscale login: null where it is not known (no status read named it) */
function server(fake: Fake) {
  const stateDir = mkdtempSync(join(tmpdir(), "ovis-tailscale-serve-"));
  const path = process.env["PATH"];
  process.env["PATH"] = `${join(fake.bin, "..")}:${path ?? ""}`;
  cleanups.push(() => { if (path === undefined) delete process.env["PATH"]; else process.env["PATH"] = path; });
  const app = createServer({ port: 0, hostname: "127.0.0.1", stateDir, machines: false, sidecar: false, cfAccess: testCfAccess().cfAccess });
  cleanups.push(() => { app.stop(); rmSync(stateDir, { recursive: true, force: true }); });
  return app;
}

/** This PC's own window: the access token from loopback, no proxy (dispatch.ts ownWindow). */
const OWN = { authorization: `Bearer ${TOKEN}`, "x-herdr-machine": "1" };

async function post(app: { port: number }, path: string, headers: Record<string, string>) {
  const response = await fetch(`http://127.0.0.1:${app.port}${path}`, { method: "POST", headers });
  const text = await response.text();
  return { status: response.status, body: (text === "" ? {} : JSON.parse(text)) as { error?: { code?: string; operator?: boolean }; tailscale?: { serving_url?: string | null } } };
}

const withPorts = (value: string | undefined) => {
  const saved = process.env[HTTPS_PORT_VARIABLE];
  if (value === undefined) delete process.env[HTTPS_PORT_VARIABLE]; else process.env[HTTPS_PORT_VARIABLE] = value;
  cleanups.push(() => { if (saved === undefined) delete process.env[HTTPS_PORT_VARIABLE]; else process.env[HTTPS_PORT_VARIABLE] = saved; });
};

describe.skipIf(process.platform === "win32")("POST /api/access/tailscale/serve", () => {
  it("requires Cloudflare Access and refuses both controls even for an authenticated owner", async () => {
    withPorts(undefined);
    const fake = fakeTailscale({});
    const app = server(fake);
    for (const path of ["/api/access/tailscale/serve", "/api/access/tailscale/open"]) {
      expect((await post(app, path, OWN)).status).toBe(401);
      const refused = await post(app, path, testCfAccess().originHeaders(OWN));
      expect(refused.status).toBe(403);
      expect(refused.body.error?.code).toBe("disabled_by_policy");
    }
    expect(fake.calls()).toEqual([]);
  });

  it("the isolated helper runs exactly `serve --bg --https=<first free allowed> http://127.0.0.1:<port>`", async () => {
    withPorts(undefined);
    // another service already holds 443: it is left alone, and the next allowed port is taken
    const fake = fakeTailscale({ existing: { "443": "http://127.0.0.1:3000" } });
    const port = 17320;
    const serve = () => serveTailscale(port, undefined, fake.bin);
    expect(await serve()).toMatchObject({ ok: true, access: { tailscale: { serving_url: `https://${DNS}:8443` } } });
    expect(fake.serves()).toEqual([[fake.bin, "serve", "--bg", "--https=8443", `http://127.0.0.1:${port}`]]);
    // served already: a second press answers the address and runs nothing
    expect(await serve()).toMatchObject({ ok: true, access: { tailscale: { serving_url: `https://${DNS}:8443` } } });
    expect(fake.serves()).toHaveLength(1);
  });

  it("the isolated helper reports a missing binary without running the CLI", async () => {
    withPorts(undefined);
    const fake = fakeTailscale({});
    expect(await serveTailscale(17320, undefined, null)).toEqual({ ok: false, code: "tailscale_missing" });
    expect(fake.calls()).toEqual([]);
  });

  it("never takes a port OVIS_TAILSCALE_HTTPS_PORT does not allow, and runs nothing while Tailscale is off", async () => {
    withPorts("17317");
    const taken = fakeTailscale({ existing: { "17317": "http://127.0.0.1:3000" } });
    expect(await serveTailscale(17320, undefined, taken.bin)).toMatchObject({ ok: false, code: "tailscale_no_port" });
    expect(taken.serves()).toEqual([]);
    cleanups.splice(0).forEach((cleanup) => cleanup());
    withPorts(undefined);
    const off = fakeTailscale({ state: "NeedsLogin" });
    expect(await serveTailscale(17320, undefined, off.bin)).toMatchObject({ ok: false, code: "tailscale_not_running" });
    expect(off.serves()).toEqual([]);
  });

  it("a serve the CLI refuses answers tailscale_serve_refused, with the operator hint on Linux", async () => {
    withPorts(undefined);
    const fake = fakeTailscale({ refuse: "Access denied: serve config denied" });
    expect(await serveTailscale(17320, undefined, fake.bin)).toMatchObject({
      ok: false, code: "tailscale_serve_refused", operator: process.platform === "linux",
    });
  });

  it("opens no app where this PC has none (Linux)", async () => {
    if (process.platform !== "linux") return;
    expect(openTailscaleApp("linux")).toEqual({ ok: false, code: "tailscale_app_unavailable" });
  });
});

describe("tailscaleAppCommand", () => {
  it("opens the app on macOS and the GUI on Windows where it is installed, and nothing on Linux", () => {
    expect(tailscaleAppCommand("darwin")).toEqual(["open", "-a", "Tailscale"]);
    const gui = join("D:\\Apps", "Tailscale", "tailscale-ipn.exe");
    expect(tailscaleAppCommand("win32", { ProgramFiles: "D:\\Apps" }, (path) => path === gui)).toEqual([gui]);
    expect(tailscaleAppCommand("win32", { ProgramFiles: "D:\\Apps" }, () => false)).toBeNull();
    expect(tailscaleAppCommand("linux")).toBeNull();
  });
});
