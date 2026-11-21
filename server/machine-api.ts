import { subscribeMachineEvents } from "./machine-events.ts";
import { wireMachine, wireMachineEvent, type WireMachine } from "../shared/compact-agents.ts";
import type { DevicePairedEvent, DeviceRemovedEvent, MachineRoster, PendingRedemptionsEvent, RelayPairingsEvent, RemotePairingsEvent } from "../shared/machines.ts";
import type { AgentRowTokens } from "../shared/pane-tokens.ts";
import type { SharedPreferences } from "../shared/preferences.ts";
import type { SeenFinish } from "../shared/seen.ts";
import type { MachineManager } from "./machines.ts";
import { sameOrigin } from "./machine-security.ts";
import { jsonResponse, setRequestRoute } from "./http.ts";
import { withoutHiddenTokens } from "./herdr-sidebar.ts";

const fail = (code: string, message: string, status: number) => jsonResponse({ error: { code, message } }, status, { "cache-control": "no-store" });

/**
 * How far one browser's machine events may fall behind before its stream is ended (it reconnects and
 * reads the roster afresh). Counted in bytes, not frames: a burst of status changes from 20 or more
 * agents queues more small frames than a frame count allowed before the browser has read any.
 * A frame larger than this (the roster of thousands of panes) is let through on top of it while it
 * is still queued, never afterwards, so a stream opening with one does not end at its next frame.
 */
export const MACHINE_EVENTS_QUEUE_BYTES = 4 * 1024 * 1024;
export const MACHINE_EVENTS_TOTAL_BYTES = 32 * 1024 * 1024;
export const MACHINE_EVENTS_STALL_MS = 30_000;
export const MACHINE_EVENTS_CEILING_BYTES = 64 * 1024 * 1024;
export const machineEventsClock = {
  now: (): number => performance.now(),
  heartbeat: (send: () => void): ReturnType<typeof setInterval> => setInterval(send, 15_000),
};

export interface EventStreamBudget {
  reserve(bytes: number): boolean;
  release(bytes: number): void;
}

interface EventsQueue { queued: () => number; taken: () => number; drop: () => void; told: number; seenTaken: number; movedAt: number }
const observe = (queue: EventsQueue, now: number): void => {
  const taken = queue.taken();
  if (taken !== queue.seenTaken || queue.queued() === 0) { queue.seenTaken = taken; queue.movedAt = now; }
};
const eventsQueues = new Set<EventsQueue>();
let toldTotal = 0;
const forgetQueue = (queue: EventsQueue): void => {
  if (!eventsQueues.delete(queue)) return;
  toldTotal -= queue.told;
  queue.told = 0;
};
export const machineEventsQueuedBytes = (): number => {
  let total = 0;
  for (const queue of eventsQueues) total += queue.queued();
  return total;
};

/**
 * A PC route whose answer can take longer than the proxy's usual 75 s: a worktree's creation waits on
 * git and then an agent's start, and a resume on the agent's start and then the check of its store.
 */
// runtime/move/install waits 200 s here: that PC holds the request up to 180 s (dispatch.ts), so an install that ends late is still told
export const slowMachinePath = (path: string): boolean => path === "worktree/create" || path === "sessions/resume" || path === "runtime/move/install";

/**
 * A path no route is spelled as: an empty segment (`//`, or a trailing `/`) or an encoded separator.
 * Path checks match the canonical spelling, and the PC proxy drops empty segments before it
 * forwards, so such a path must be no route at all rather than "some other route".
 */
export const nonCanonicalPath = (pathname: string): boolean => pathname.includes("//") || (pathname.length > 1 && pathname.endsWith("/")) || /%2f|%5c/i.test(pathname);
export const MACHINE_PROXY_PATH = /^(?:session|sessions\/(?:history|resume)|agents|agent-catalog(?:\/(?:install|sign-in))?|integrations|system|usage\/statusline|pane\/(?:read|scroll|find|selection|conversation(?:\/image|\/tool-output)?|summary|commands|files|docs|omo-tasks|background-agent|plan|artifacts|btw|prompt|prompt\/answer|input|keys|close|rename|image|split|zoom|swap|move|resize|clear|focus)|workspace\/(?:create|rename|move|close|directories|diff\/files|diff\/file|diff\/refs|git\/log|git\/branches|git\/show|pr|pr\/log|pr\/merge)|worktree\/(?:create|list|inventory|open|remove)|tab\/(?:create|rename|close|move|move-to-workspace)|layout\/ratio|agent\/(?:rename|commands)|plugins\/actions|plugin\/action|fs\/(?:stat|file|favicon|text))$/;



export async function handleMachineRequest(request: Request, manager: MachineManager, onRevoke?: (close: () => void) => () => void,
  preferences?: { get(): SharedPreferences; subscribe(listener: (preferences: SharedPreferences) => void): () => void }, _readOnly = false,
  herdrSidebar?: { get(): AgentRowTokens | null; subscribe(listener: (agents: AgentRowTokens | null) => void): () => void },
  seen?: { list(): SeenFinish[]; subscribe(listener: (finish: SeenFinish) => void): () => void },
  pairings?: { subscribe(listener: (event: DevicePairedEvent | DeviceRemovedEvent | RelayPairingsEvent | RemotePairingsEvent | PendingRedemptionsEvent) => void): () => void },
  relayBudget?: EventStreamBudget,
  _owner = false,
  expectedOrigin?: string): Promise<Response> {
  const url = new URL(request.url);
  if (!sameOrigin(request, expectedOrigin)) return fail("invalid_origin", "Use PC controls from this app", 403);
  if (!["GET", "HEAD"].includes(request.method) && request.headers.get("x-herdr-machine") !== "1") return fail("invalid_machine_request", "Use PC controls from this app", 403);
  if (nonCanonicalPath(url.pathname)) return fail("not_found", "not found", 404);
  const parts = url.pathname.slice("/api/machines".length).split("/").filter(Boolean);
  try {
    if (!parts.length && request.method === "GET") {
      setRequestRoute("/api/machines");
      const asked = url.searchParams.getAll("verify_source_boot");
      // as the machine events tell it, for every answer below: without the token values herdr's rows hide
      // (withoutHiddenTokens), and without a PC's own agent_refs (wireMachine)
      const shown = () => withoutHiddenTokens(herdrSidebar?.get() ?? null, manager.list()).map((machine) => wireMachine(machine, false));
      if (asked.length === 0) {
        if (url.searchParams.get("compact_agents") !== "1") return jsonResponse({ machines: shown() } satisfies MachineRoster);
        return jsonResponse({ machines: shown().map((machine) => wireMachine(machine, true)) } satisfies { machines: WireMachine[] });
      }
      if (asked.length > 1 || asked[0] === "") return fail("invalid_query", "verify_source_boot names one PC", 400);
      const machineId = asked[0]!;
      if (machineId !== "local") return fail("disabled_by_policy", "Remote machine management is disabled on this server", 403);
      const proof = await manager.verifySourceBoot(machineId, request.signal);
      if ("refused" in proof) {
        const response = fail("source_unverified", proof.refused === "interval" ? "This PC's server was asked a moment ago; ask again shortly" : "This PC's server could not be verified now", 503);
        response.headers.set("cache-control", "no-store");
        if (proof.refused === "interval") response.headers.set("retry-after", "1");
        return response;
      }
      return jsonResponse({ machines: shown(), verified_source_boot: { machine_id: machineId, boot_id: proof.boot_id } } satisfies MachineRoster, 200, { "cache-control": "no-store" });
    }
    if (parts[0] === "events" && parts.length === 1 && request.method === "GET") {
      setRequestRoute("/api/machines/events");
      let stop: (() => void) | undefined;
      let unwatchDevice: (() => void) | undefined;
      let heartbeat: ReturnType<typeof setInterval> | undefined;
      let close = () => {};
      let drop = () => {};
      let queue: EventsQueue | undefined;
      let charged = 0;
      let accountTaken = () => {};
      const aborted = () => drop();
      const cleanup = () => {
        stop?.(); unwatchDevice?.(); clearInterval(heartbeat);
        request.signal.removeEventListener("abort", aborted);
        if (queue) forgetQueue(queue);
        relayBudget?.release(charged);
        charged = 0;
      };
      const encoder = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          let closed = false;
          close = () => { if (closed) return; closed = true; cleanup(); try { controller.close(); } catch {} };
          // fallen behind, refused or gone: an error, not a close, so what waits is dropped instead of still delivered
          drop = () => { if (closed) return; closed = true; cleanup(); try { controller.error(new Error("machine events: stream ended")); } catch {} };
          // a revoked device that keeps up gets a clean end; one with a backlog waiting is not reading it, so that is dropped
          unwatchDevice = onRevoke?.(() => { if ((queue?.queued() ?? 0) > 0) drop(); else close(); });
          if (closed) return;
          const queued = () => MACHINE_EVENTS_QUEUE_BYTES - (controller.desiredSize ?? MACHINE_EVENTS_QUEUE_BYTES);
          accountTaken = () => {
            if (!relayBudget || closed) return;
            const remaining = Math.max(0, queued());
            relayBudget.release(charged - remaining);
            charged = remaining;
          };
          let written = 0;
          const large: { end: number; bytes: number }[] = [];
          const largeQueued = (): number => {
            const left = written - queued();
            while (large.length > 0 && large[0]!.end <= left) large.shift();
            return large.reduce((most, frame) => Math.max(most, frame.bytes), 0);
          };
          const own: EventsQueue = { queued, taken: () => written - queued(), drop, told: 0, seenTaken: 0, movedAt: machineEventsClock.now() };
          queue = own;
          eventsQueues.add(own);
          const retell = (): void => { const now = queued(); toldTotal += now - own.told; own.told = now; };
          const stalled = (other: EventsQueue, now: number): boolean => other.told > 0 && now - other.movedAt >= MACHINE_EVENTS_STALL_MS;
          const send = (text: string) => {
            if (closed) return;
            accountTaken();
            if (relayBudget) {
              const size = Buffer.byteLength(text);
              if (!relayBudget.reserve(size)) { drop(); return; }
              charged += size;
            }
            const bytes = encoder.encode(text);
            const now = machineEventsClock.now();
            retell();
            observe(own, now);
            const counted = bytes.byteLength > MACHINE_EVENTS_QUEUE_BYTES ? Math.min(bytes.byteLength, largeQueued()) : bytes.byteLength;
            if (own.told - largeQueued() + counted > MACHINE_EVENTS_QUEUE_BYTES) { drop(); return; }
            if (toldTotal + bytes.byteLength > MACHINE_EVENTS_TOTAL_BYTES) {
              toldTotal = 0;
              for (const other of eventsQueues) { other.told = other.queued(); toldTotal += other.told; observe(other, now); }
              while (toldTotal + bytes.byteLength > MACHINE_EVENTS_TOTAL_BYTES) {
                let most: EventsQueue | undefined;
                for (const other of eventsQueues) if (stalled(other, now) && (most === undefined || other.told > most.told)) most = other;
                if (most === undefined) break;
                most.drop();
                if (most === own) return;
              }
              if (toldTotal + bytes.byteLength > MACHINE_EVENTS_CEILING_BYTES && toldTotal - own.told > 0) { drop(); return; }
            }
            try { controller.enqueue(bytes); } catch { drop(); return; }
            written += bytes.byteLength;
            if (bytes.byteLength > MACHINE_EVENTS_QUEUE_BYTES) large.push({ end: written, bytes: bytes.byteLength });
            retell();
          };
          stop = subscribeMachineEvents({ manager, preferences, herdrSidebar, seen, pairings },
            (event) => send(`data: ${JSON.stringify(wireMachineEvent(event, url.searchParams.get("compact_agents") === "1"))}\n\n`));
          if (closed) { cleanup(); return; }
          heartbeat = machineEventsClock.heartbeat(() => send(": heartbeat\n\n"));
          request.signal.addEventListener("abort", aborted, { once: true });
          if (request.signal.aborted) aborted();
        },
        pull() { accountTaken(); },
        cancel() { close(); },
      }, new ByteLengthQueuingStrategy({ highWaterMark: MACHINE_EVENTS_QUEUE_BYTES }));
      return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-store", "x-accel-buffering": "no" } });
    }
    if (parts[0] === "settings" && parts.length === 1) {
      setRequestRoute("/api/machines/settings");
      if (request.method === "GET") return jsonResponse(manager.settings());
      if (request.method !== "PATCH") return fail("method_not_allowed", "Use GET or PATCH", 405);
      return fail("disabled_by_policy", "Remote machine management is disabled on this server", 403);
    }
    setRequestRoute("/api/machines/disabled");
    return fail("disabled_by_policy", "Remote machine management is disabled on this server", 403);
  } catch (e) { return fail("machine_request_failed", e instanceof Error ? e.message : String(e), 400); }
}
