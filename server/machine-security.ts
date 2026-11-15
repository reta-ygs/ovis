import type { SshTarget } from "../shared/machines.ts";
import { validHerdrSocket } from "./herdr-discovery.ts";

export function shellQuote(value: string): string { return `'${value.replaceAll("'", "'\\''")}'`; }

export function validateTarget(value: unknown): SshTarget {
  if (!value || typeof value !== "object") throw new Error("SSH target is required");
  const v = value as Record<string, unknown>;
  // Pass a single destination argv, never options or shell syntax. IPv6 is allowed.
  if (typeof v.destination !== "string" || !/^[a-zA-Z0-9_][a-zA-Z0-9_.@:[\]-]{0,254}$/.test(v.destination)) throw new Error("Enter an SSH alias or user@hostname");
  if (v.port !== undefined && (!Number.isInteger(v.port) || Number(v.port) < 1 || Number(v.port) > 65535)) throw new Error("SSH port must be 1–65535");
  // a key on the web server: absolute (`/…`, or `C:\…` on a Windows one) or in its home (`~/…`)
  if (v.identity_file !== undefined && (typeof v.identity_file !== "string" || !/^(\/|~[\\/]|[A-Za-z]:[\\/])[^\r\n\0]{1,1024}$/.test(v.identity_file))) throw new Error("Key path must be absolute or start with ~/");
  if (v.session !== undefined && (typeof v.session !== "string" || !/^[a-zA-Z0-9_-]{1,64}$/.test(v.session))) throw new Error("Session names use letters, numbers, underscores and hyphens");
  if (v.herdr_socket !== undefined && !validHerdrSocket(v.herdr_socket)) throw new Error("The herdr socket must be an absolute path ending in /herdr.sock");
  if (v.start_new_herdr !== undefined && typeof v.start_new_herdr !== "boolean") throw new Error("Choose whether to start a new herdr on this PC");
  if (v.herdr_socket && v.start_new_herdr) throw new Error("Choose a running herdr or start a new one");
  if (v.own_ovis !== undefined && (typeof v.own_ovis !== "string" || !v.own_ovis.startsWith("/") || v.own_ovis.length > 4096 || /[\0\r\n]/.test(v.own_ovis))) throw new Error("Choose an Ovis server registered on this PC");
  if (v.own_ovis && (v.herdr_socket || v.start_new_herdr)) throw new Error("Choose Ovis, a running herdr, or a new herdr");
  return { destination: v.destination, ...(v.port === undefined ? {} : { port: Number(v.port) }), ...(v.identity_file ? { identity_file: String(v.identity_file) } : {}), ...(v.session ? { session: String(v.session) } : {}), ...(typeof v.herdr_socket === "string" ? { herdr_socket: v.herdr_socket } : {}), ...(typeof v.own_ovis === "string" ? { own_ovis: v.own_ovis } : {}), ...(v.start_new_herdr === true ? { start_new_herdr: true } : {}) };
}

export function sameOrigin(request: Request, expectedOrigin?: string): boolean {
  const site = request.headers.get("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") return false;
  const targetRaw = (expectedOrigin ?? process.env["OVIS_PUBLIC_ORIGIN"])?.trim();
  if (!targetRaw) return false;
  let normalizedTarget: string;
  try {
    normalizedTarget = new URL(targetRaw).origin;
  } catch {
    return false;
  }
  const origin = request.headers.get("origin");
  const { pathname } = new URL(request.url);
  const websocket = request.headers.get("upgrade")?.toLowerCase() === "websocket" || pathname === "/ws";
  const mutating = !["GET", "HEAD", "OPTIONS"].includes(request.method);
  if (!origin) return !(websocket || mutating);
  try {
    return new URL(origin).origin === normalizedTarget;
  } catch {
    return false;
  }
}
export function canSendSecret(request: Request): boolean {
  const url = new URL(request.url);
  return url.protocol === "https:" || request.headers.get("x-forwarded-proto") === "https" || ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
}
