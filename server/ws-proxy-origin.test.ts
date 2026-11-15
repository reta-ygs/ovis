import { describe, expect, it } from "bun:test";
import { sameOrigin, canSendSecret } from "./machine-security.ts";

function upgrade(headers: Record<string, string> = {}, path = "/ws", method = "GET"): Request {
  return new Request(`http://public.example${path}`, { method, headers: {
    origin: "https://public.example", "sec-fetch-site": "same-origin",
    "x-forwarded-proto": "wss", upgrade: "websocket", connection: "Upgrade", ...headers,
  } });
}

describe("fail-closed WebSocket and request origin", () => {
  const EXPECTED = "https://public.example";

  it("matches browser Origin against expectedOrigin and fails closed when omitted", () => {
    expect(sameOrigin(upgrade())).toBe(false);
    expect(sameOrigin(upgrade(), EXPECTED)).toBe(true);
    expect(sameOrigin(upgrade({ upgrade: "WebSocket", connection: "keep-alive, uPgRaDe" }), EXPECTED)).toBe(true);
    expect(sameOrigin(upgrade({ origin: "https://public.example:443" }), EXPECTED)).toBe(true);
  });
  it("refuses different hosts, ports, schemes, cross-site requests and forwarded-host overrides", () => {
    for (const origin of ["https://other.example", "https://public.example:8443", "http://public.example", "null"]) {
      expect(sameOrigin(upgrade({ origin }), EXPECTED)).toBe(false);
    }
    expect(sameOrigin(upgrade({ "sec-fetch-site": "cross-site" }), EXPECTED)).toBe(false);
    expect(sameOrigin(upgrade({ "sec-fetch-site": "same-site" }), EXPECTED)).toBe(false);
    expect(sameOrigin(upgrade({ origin: "https://other.example", "x-forwarded-host": "other.example" }), EXPECTED)).toBe(false);
  });
  it("requires an Origin header for WebSocket upgrades and mutating HTTP requests", () => {
    const noOrigin = (path: string, method = "GET", headers: Record<string, string> = {}) => {
      const request = new Request(`http://public.example${path}`, { method, headers: { "sec-fetch-site": "same-origin", ...headers } });
      return request;
    };
    expect(sameOrigin(noOrigin("/api/session"), EXPECTED)).toBe(true);
    expect(sameOrigin(noOrigin("/api/pane/close", "POST"), EXPECTED)).toBe(false);
    expect(sameOrigin(noOrigin("/ws"), EXPECTED)).toBe(false);
    expect(sameOrigin(noOrigin("/api/session", "GET", { upgrade: "websocket" }), EXPECTED)).toBe(false);
  });
  it("preserves matching and mismatching nondefault request ports", () => {
    const headers = new Headers(upgrade().headers);
    headers.set("origin", "https://public.example:9443");
    expect(sameOrigin(new Request("http://public.example:9443/ws", { headers }), "https://public.example:9443")).toBe(true);
    headers.set("origin", "https://public.example:8443");
    expect(sameOrigin(new Request("http://public.example:9443/ws", { headers }), "https://public.example:9443")).toBe(false);
  });
  it("keeps ordinary HTTP(S) proxy checks and secret-input rules unchanged", () => {
    expect(sameOrigin(upgrade({ "x-forwarded-proto": "https" }), EXPECTED)).toBe(true);
    expect(sameOrigin(upgrade({ "x-forwarded-proto": "http", origin: "http://public.example" }), "http://public.example")).toBe(true);
    expect(canSendSecret(upgrade({}, "/api/pane/secret", "POST"))).toBe(false);
  });
});
