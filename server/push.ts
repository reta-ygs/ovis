import { isLoopbackHost } from "./access.ts";
import { cleanLine, isDivider, parsedByPublicPrompt } from "./dialogs/shared.ts";
import { jsonResponse, setRequestRoute } from "./http.ts";
import {
  type AlertKind,
  type AlertPrefs,
  ENDED_NOTIFICATION_BODY,
  ERROR_NOTIFICATION_BODY,
  PERMISSION_NOTIFICATION_BODY,
  paneNotificationTag,
  statusNotificationBody,
} from "../shared/notify-policy.ts";
import type {
  AgentStatus,
  DevicePairedEvent,
  HerdrPane,
  InteractivePrompt,
  PushAction,
  PushDeliveryFailure,
  PushPayload,
  PushSubscriptionStatus,
} from "../shared/protocol.ts";
import type { AlertWebhook } from "./alert-webhook.ts";

export { defaultStateDir } from "./update-state.ts";

export const PUSH_EXTRA_KEYS = "push-keys.json";
const ACTION_LABEL_MAX = 24;
const PROMPT_SUMMARY_LINES = 4;
const PROMPT_SUMMARY_MAX = 300;

export interface AlertTiming {
  short: number;
  long: number;
  longTurn: number;
}

export const DEFAULT_ALERT_TIMING: AlertTiming = { short: 10_000, long: 60_000, longTurn: 60_000 };

export interface PushSubscriptionRecord {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  alerts?: AlertPrefs;
  device_id?: string | null;
  browser_keys?: string[];
}

export type PushDelivery = { ok: true } | { ok: false; status: number | null; gone: boolean };

export function classifyFailure(status: number | null): PushDeliveryFailure {
  if (status === null) return "network";
  if (status === 404 || status === 410) return "gone";
  if (status === 401 || status === 403) return "key-mismatch";
  if (status === 429) return "throttled";
  if (status >= 500) return "server";
  return "rejected";
}

export interface PushService {
  publicKey(): string;
  parse(value: unknown): PushSubscriptionRecord | null;
  subscribe(subscription: PushSubscriptionRecord, alerts?: AlertPrefs, deviceId?: string | null, browserKeys?: readonly string[]): void;
  revokeDevice(id: string): void;
  unsubscribe(endpoint: string): void;
  retired(endpoint: string): boolean;
  sendTest(endpoint: string): Promise<PushDelivery | null>;
  status(subscription: PushSubscriptionRecord, owner: string | null | undefined): PushSubscriptionStatus | null;
  devicePaired(event: DevicePairedEvent, origin?: readonly string[]): Promise<void>;
  seed(panes: readonly HerdrPane[], machineId?: string, machineName?: string, serverId?: string): void;
  resync(panes: readonly HerdrPane[], newer: ReadonlySet<string>, machineId?: string): void;
  assume(paneId: string, status: AgentStatus, machineId?: string): void;
  gone(panes: readonly HerdrPane[], newer: ReadonlySet<string>, machineId?: string): void;
  closed(paneId: string, machineId?: string): void;
  moved(from: string, to: string, machineId?: string): void;
  firstStatus(paneId: string, created: AgentStatus, status: AgentStatus, machineId?: string): Promise<void>;
  onStatus(paneId: string, status: AgentStatus, machineId?: string): Promise<void>;
  onEnded(paneId: string, machineId?: string): Promise<void>;
  onFailed(paneId: string, machineId?: string): Promise<void>;
  mutesChanged(): void;
  settled(): Promise<void>;
}

export interface PushServiceOptions {
  stateDir: string;
  subject?: string;
  lookupPane?: (paneId: string) => Promise<{ title: string; agent_kind?: string } | undefined>;
  lookupPrompt?: (paneId: string, signal: AbortSignal) => Promise<{ prompt: InteractivePrompt; screen?: string } | null>;
  canAnswer?: (deviceId: string | null | undefined) => boolean;
  localName?: string;
  serverId?: () => string | undefined;
  timing?: Partial<AlertTiming>;
  now?: () => number;
  canDeliver?: (deviceId: string | null | undefined) => boolean;
  inUse?: () => boolean;
  muted?: (machineId: string, paneId: string) => boolean;
  loopbackHttp?: boolean;
  onAlertDelivered?: () => void;
  webhook?: Pick<AlertWebhook, "prefs" | "wants" | "generation" | "send">;
}

function decodedLength(value: unknown): number {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+=*$/.test(value)) return -1;
  return Buffer.from(value, "base64url").length;
}

export function normalizeEndpoint(endpoint: string): string {
  try {
    const url = new URL(endpoint);
    url.hash = "";
    return url.href;
  } catch {
    return endpoint;
  }
}

export function parseSubscription(value: unknown, options: { loopbackHttp?: boolean } = {}): PushSubscriptionRecord | null {
  if (typeof value !== "object" || value === null) return null;
  const { endpoint, keys } = value as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } };
  if (typeof endpoint !== "string") return null;
  try {
    const url = new URL(endpoint);
    const loopbackHttp = options.loopbackHttp === true && url.protocol === "http:" && isLoopbackHost(url.hostname);
    if (url.protocol !== "https:" && !loopbackHttp) return null;
  } catch {
    return null;
  }
  if (decodedLength(keys?.p256dh) !== 65 || decodedLength(keys?.auth) !== 16) return null;
  return { endpoint, keys: { p256dh: keys!.p256dh as string, auth: keys!.auth as string } };
}

export function statusMessage(paneId: string, title: string, status: AgentStatus, kind: AlertKind = status === "blocked" ? "input" : "done"): PushPayload {
  return { pane_id: paneId, title, body: kind === "permission" ? PERMISSION_NOTIFICATION_BODY : statusNotificationBody(status), tag: paneNotificationTag(paneId), kind };
}

export function promptActions(prompt: InteractivePrompt | null, screen?: string): PushAction[] | null {
  if (!prompt || (prompt.kind !== "approval" && prompt.kind !== "question")) return null;
  if (screen === undefined || !shownWhole(prompt, screen) || parsedByPublicPrompt.get(prompt)?.ompQuestionCut) return null;
  if (prompt.multi_select || prompt.custom_option_index !== null || prompt.queued !== undefined || prompt.checks_with_text) return null;
  if (prompt.steps !== undefined || prompt.answers !== undefined || prompt.can_step_back || prompt.can_step_next) return null;
  if (prompt.options.length === 0 || prompt.options.length > 2) return null;
  if (prompt.options.some((option) => option.label.trim() === "" || option.label.length > ACTION_LABEL_MAX || option.description)) return null;
  return prompt.options.map((option, index) => ({ option_index: index, label: option.label.trim() }));
}

export function shownWhole(prompt: InteractivePrompt, screen: string): boolean {
  const lines = screen.split("\n").map(cleanLine).filter((line) => line !== "");
  const body = (prompt.body ?? "").split("\n").map((line) => line.trim()).filter((line) => line !== "");
  const question = prompt.question.trim();
  const at = lines.lastIndexOf(question);
  if (at < 0) return false;
  if (!prompt.options.every((option, index) => lines[at + 1 + index]?.includes(option.label.trim()))) return false;
  const start = at - body.length;
  if (start < 1 || !body.every((line, index) => lines[start + index] === line)) return false;
  const over = lines[start - 1]!;
  return over === prompt.title.trim() || isDivider(over);
}

export function promptSummary(prompt: InteractivePrompt): string | null {
  const body = (prompt.body ?? "").split("\n");
  if (body.length > PROMPT_SUMMARY_LINES) return null;
  const head = prompt.title.trim() === prompt.question.trim() ? [prompt.question] : [prompt.title, prompt.question];
  const text = [...head, ...body].map((line) => line.trim()).filter((line) => line !== "").join("\n");
  return text.length > PROMPT_SUMMARY_MAX ? null : text;
}

export function endedMessage(paneId: string, title: string): PushPayload {
  return { pane_id: paneId, title, body: ENDED_NOTIFICATION_BODY, tag: paneNotificationTag(paneId), kind: "ended" };
}

export function failedMessage(paneId: string, title: string): PushPayload {
  return { pane_id: paneId, title, body: ERROR_NOTIFICATION_BODY, tag: paneNotificationTag(paneId), kind: "error" };
}

/**
 * Disabled no-op Web Push service: stores no VAPID keys or subscriptions,
 * creates no background timers, and makes no outbound push requests.
 */
export function createPushService(_options: PushServiceOptions): PushService {
  return {
    publicKey: () => "",
    parse: () => null,
    subscribe: () => {},
    revokeDevice: () => {},
    unsubscribe: () => {},
    retired: () => false,
    sendTest: async () => null,
    status: () => null,
    devicePaired: async () => {},
    seed: () => {},
    resync: () => {},
    assume: () => {},
    gone: () => {},
    closed: () => {},
    moved: () => {},
    firstStatus: async () => {},
    onStatus: async () => {},
    onEnded: async () => {},
    onFailed: async () => {},
    mutesChanged: () => {},
    settled: async () => {},
  };
}

const KNOWN_PUSH_PATHS = new Set(["/api/push", "/api/push/subscribe", "/api/push/test", "/api/push/status"]);

export async function handlePushRequest(
  _request: Request,
  pathname: string,
  _push: PushService,
  _deviceId: string | null | undefined,
  _browserKeys: readonly string[] = [],
): Promise<Response | null> {
  if (!KNOWN_PUSH_PATHS.has(pathname)) return null;
  setRequestRoute(pathname);
  return jsonResponse(
    { error: { code: "disabled_by_policy", message: "Web Push is disabled on this server" } },
    404,
    { "cache-control": "no-store" },
  );
}
