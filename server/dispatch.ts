import { machineFailure, machineLayoutReason } from "./machine-profile.ts";
import { handleWorkspaceRequest } from "./workspace-routes.ts";
import { connectionData, type createCore, type SocketData } from "./core/index.ts";
import type { ClientConnectionLog } from "./client-connection-log.ts";
import type { RequestLog } from "./request-log.ts";
import { handlePaneRequest } from "./pane-routes.ts";
import { handleIntegrationsRequest } from "./integrations-routes.ts";
import type { OrderSequence } from "./order-sequence.ts";
import type { DevicePairedEvent, DeviceRemovedEvent, HealthAuth, RelayPairingsEvent, RemoteAccess, RemotePairingsEvent, SecuritySummary, SessionSnapshot } from "../shared/protocol.ts";
import { bindScope, cameThroughProxy, isLoopbackAddress, type Access } from "./access.ts";
import { scheduleCfAccessExpiry, type CfAccessVerifier } from "./cf-access.ts";
import type { DeviceMatch, DeviceStore } from "./devices.ts";
import { handlePreferencesRequest, type PreferenceStore } from "./preferences.ts";
import { handleSeenRequest, type SeenStore } from "./seen.ts";
import { badRequest, errorResponse, jsonResponse, readJsonObject, setRequestRoute, wordedHeaders, wordHerdrFailures } from "./http.ts";
import { serveStatic } from "./static.ts";
import { compressResponse } from "./compress.ts";
import { handleTasksRequest } from "./tasks-routes.ts";
import { handlePlanRequest } from "./plan-routes.ts";
import { handleArtifactsRequest } from "./claude-artifacts.ts";
import { handleBtwRequest } from "./omp-btw.ts";
import { paneTranscript } from "./conversation.ts";
import { ConversationUnavailable } from "./conversation-shared.ts";
import type { ShellAgentLocator } from "./shell-agent.ts";
import { handleAgentsRequest } from "./agents-routes.ts";
import type { AgentDetector } from "./agent-catalog-detect.ts";
import { handleAgentCatalogRequest } from "./agent-catalog-routes.ts";
import { type AgentInstaller, INSTALL_PATH } from "./agent-catalog-install.ts";
import { textEditAllowed } from "./file-edit.ts";
import { handleFileRequest } from "./file-routes.ts";
import { BACKGROUND_AGENT_PATH, handleBackgroundAgentRequest } from "./background-agent.ts";
import { paneGet, ping } from "./herdr/client.ts";
import { version } from "../package.json";
import { RUNTIME_MOVE_ROUTE } from "./runtime-move.ts";
import type { MoveService } from "./runtime-move-service.ts";
import { handlePushRequest } from "./push.ts";
import { handlePromptRequest, type OpenCodePromptState } from "./prompt.ts";
import type { ApprovalHub } from "./approvals/hub.ts";
import type { AcpChildren } from "./acp/children.ts";
import { attachableIdentity } from "./pty/sidecar.ts";
import { runtime } from "./herdr-core/runtime.ts";
import { handleUpdateRequest } from "./update-api.ts";
import { handleHerdrUpdateRequest } from "./herdr-update.ts";
import type { LocalConfirms } from "./account/local-confirm.ts";
import type { RecoveryReleases } from "./account/recovery.ts";
import type { PendingRedemption, PendingRedemptions } from "./account/pending.ts";
import type { KeyProofPairings } from "./account/key-proof.ts";
import type { lockRoutes } from "./account/lock-routes.ts";
import type { LockSignal } from "./lock-boundary.ts";
import type { AccountMailbox } from "./account/mailbox.ts";
import type { AccountHolds } from "./account/holds.ts";
import type { SafetyLog } from "./account/safety-log.ts";
import type { CatchUpGate } from "./account/catch-up-gate.ts";
import type { accountRowsFor } from "./account/account-devices.ts";
import type { AccountIntroductions } from "./account/introductions.ts";
import type { ListFollow } from "./account/list-follow.ts";
import type { AccountWitness } from "./account/witness.ts";
import type { JoinNotices } from "./join-notices.ts";
import type { TailnetNodes } from "./tailnet-nodes.ts";
import type { RelayService } from "./relay/service.ts";
import { handleTelemetryRequest } from "./telemetry.ts";
import { handleStatuslineRequest, handleUsageRequest } from "./usage.ts";
import { handleSystemRequest, type SystemSampler } from "./system-stats.ts";
import { handleUserFontsRequest } from "./user-fonts.ts";
import { USER_FONTS_PATH } from "../shared/user-fonts.ts";
import type { UsageAccountList } from "./usage-account-list.ts";
import { handleVoiceRequest } from "./voice.ts";
import { handleMemoryRequest } from "./memory/routes.ts";
import { BRIDGE_PROTOCOL } from "../shared/machines.ts";
import { handleMachineRequest, nonCanonicalPath, type EventStreamBudget } from "./machine-api.ts";
import { handleSessionHistoryRequest, handleSessionResumeRequest, SESSION_HISTORY_PATH, SESSION_RESUME_PATH } from "./session-history-routes.ts";
import type { PiSessionReader } from "./pi-session-metadata.ts";
import type { HerdrSidebarConfig } from "./herdr-sidebar.ts";
import { readHerdrUi } from "./herdr-ui.ts";
import type { RelayReceiptIds } from "./machine-relay.ts";
import { sameOrigin } from "./machine-security.ts";
import { handlePluginRequest } from "./plugin-routes.ts";
import type { createServer } from "./index.ts";
import type { TailnetIdentity, TailnetNode } from "./tailscale.ts";
import type { CLIProxyRoutes } from "./cliproxy-routes.ts";
import type { UsageLoginService } from "./usage-login.ts";
import type { UsageService } from "./usage.ts";
import type { VoiceService } from "./voice.ts";
import type { MemoryStore } from "./memory/store.ts";

type PortalStartup = { ok: true } | { ok: false; error: unknown };

export interface RequestServices {
  readonly runtimeMove: MoveService | null;
  readonly relay: RelayService;
  readonly relayReceiptIds: RelayReceiptIds;
  readonly options: NonNullable<Parameters<typeof createServer>[0]>;
  readonly hostname: string;
  readonly token: string;
  readonly bridgeToken: string;
  readonly bootId: string;
  readonly devices: DeviceStore;
  /** the joins no window of this PC has seen yet (server/join-notices.ts) */
  readonly joins: JoinNotices;
  readonly accountMailbox: AccountMailbox;
  readonly accountIntroductions: AccountIntroductions;
  readonly accountHolds: AccountHolds;
  /** the account safety log; null while OVIS_ACCOUNT_OPENS_ALL is off */
  readonly safetyLog: SafetyLog | null;
  /** Step 2 (S2-27): the wait after a start for rows not paired at this PC; null with the release flag off. */
  readonly catchUp: CatchUpGate | null;
  checkAccountFreshness(): void;
  /** Step 2 (S2-25): the account-joined rows of this PC's relay identity; null with the release flag off. */
  readonly accountRows: ReturnType<typeof accountRowsFor> | null;
  /** This PC following its account's signed list (server/account/list-follow.ts); null with the release flag off. */
  readonly accountList: ListFollow | null;
  /** For how long this PC has let each key of its account in (server/account/witness.ts); null with the release flag off. */
  readonly accountWitness: AccountWitness | null;
  /** On a server that follows no list (Step 2 off): looks whether another Ovis on this folder pinned the PC, and then closes this server's account part. Null on a server that follows its list itself. */
  readonly pinWatch: (() => void) | null;
  readonly preferences: PreferenceStore;
  readonly herdrSidebar: HerdrSidebarConfig;
  /** `loginPath`: the request states a Tailscale login, so the PC's own login must be known, not merely cached as unknown */
  readonly identityOf: (grantPath: boolean, host: string | null, loginPath?: boolean) => Promise<TailnetIdentity>;
  readonly serveOnly: boolean;
  /** the tailnet nodes this PC keeps out (server/tailnet-nodes.ts), and the WhoIs read that names a request's node */
  readonly tailnetNodes: TailnetNodes;
  readonly whoisNode: (address: string) => Promise<TailnetNode | null>;
  readonly portalGuards: () => { tokenSet: boolean; serveOnly: boolean };
  readonly shellAgents: ShellAgentLocator;
  readonly agentDetector: AgentDetector;
  readonly agentOffered: (kind: string) => Promise<boolean>;
  readonly agentInstaller: AgentInstaller;
  readonly openCodeState: OpenCodePromptState;
  readonly approvals: ApprovalHub;
  /** the agents this server drives over ACP (server/acp/children.ts); null off this PC's herdr-core */
  readonly acp: AcpChildren | null;
  readonly cliProxyRoutes: CLIProxyRoutes;
  readonly usageLogin: UsageLoginService;
  readonly usage: UsageService;
  readonly usageAccounts: UsageAccountList;
  readonly systemSampler: SystemSampler | null;
  /** the state folder's fonts/, served to every device that may read this PC (server/user-fonts.ts) */
  readonly fontsDir: string;
  readonly voice: VoiceService;
  /** Settings → Memory's notes for agents (server/memory/store.ts) */
  readonly memory: MemoryStore;
  readonly browserSnapshot: <S extends SessionSnapshot>(snapshot: S) => S;
  readonly core: ReturnType<typeof createCore>;
  readonly seen: SeenStore;
  readonly piReader: PiSessionReader;
  readonly orderSequence: OrderSequence;
  readonly clientConnectionLog: ClientConnectionLog;
  readonly requestLog: RequestLog;
  /** acts waiting for this PC's screen (server/account/local-confirm.ts); only with the Step 2 release flag */
  readonly localConfirms?: LocalConfirms;
  /** releases `ovis recover` made since this start (server/account/recovery.ts); only with the release flag */
  readonly recoveryReleases?: RecoveryReleases;
  /** devices waiting for this PC's screen to approve their key (server/account/pending.ts); only with the release flag */
  readonly pendingRedemptions?: PendingRedemptions;
  /** pairings that prove their key and wait for this PC's screen (server/account/key-proof.ts); Linux with the flag only */
  readonly keyProofPairings?: KeyProofPairings;
  /**
   * Opens this PC's local confirm page in a browser on its own desktop, as `ovis confirm` does, so its port stays in no
   * answer (R8). False when no page listens or there is no desktop to open it on.
   */
  readonly openConfirmPage?: () => Promise<boolean>;
  /** the tailscale CLI /api/access reads and POST /api/access/tailscale/serve runs; unset, the one this PC has */
  readonly tailscaleBinary?: string | null | undefined;
  /** puts a waiting key on this PC's screen */
  readonly askScreenForKey?: (entry: PendingRedemption) => void;
  /** /api/account/lock and /unlock (server/account/lock-routes.ts); only with the release flag */
  readonly lockRoutes?: ReturnType<typeof lockRoutes>;
  /** fired when the screen's approval writes a lock: what it no longer lets in ends (T46) */
  readonly lockSignal?: LockSignal;
  readonly portalStartupResult: PortalStartup | undefined;
  readonly portalStartup: Promise<PortalStartup>;
  readonly cfAccess: { readonly verifier: CfAccessVerifier; readonly publicOrigin: string };
}

export interface ServerContext {
  requestIP(request: Request): { address: string } | null;
  timeout(request: Request, seconds: number): void;
  upgrade(request: Request, options: { headers?: HeadersInit; data: SocketData }): boolean;
  readonly port: number | undefined;
  /** `serverId`: the relay identity the device signed in to, which a `link` must name (docs/account.md). */
  readonly peer: { kind: "socket" } | { kind: "relay"; device: DeviceMatch; sessionId: string; serverId: string; key: string };
  readonly services: RequestServices;
  readonly relayBodyBudget?: EventStreamBudget;
  /**
   * The request came in on the machine profile's owner socket (`<state folder>/serve.sock`): set by the
   * server for that listener alone, never read from the request. Only there is a local owner of the profile.
   */
  readonly ownerSocket?: boolean;
  /**
   * The request came to the opt-in LAN HTTPS listener (server/lan-https.ts), from a private IPv4 peer:
   * it gets in only with the token or a paired device, never as an open install, by the bridge token,
   * and its wrong tokens share one budget with every other peer there.
   */
  readonly lanHttps?: boolean;
}

function matchesPrefix(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`);
}

function disabledPolicyResponse(method: string, path: string): Response | null {
  const blocked = matchesPrefix(path, "/api/auth")
    || matchesPrefix(path, "/api/access/tailscale")
    || matchesPrefix(path, "/api/devices")
    || matchesPrefix(path, "/api/portal")
    || matchesPrefix(path, "/api/relay")
    || matchesPrefix(path, "/api/account")
    || matchesPrefix(path, "/api/bridge")
    || matchesPrefix(path, "/api/runtime")
    || RUNTIME_MOVE_ROUTE.test(path)
    || matchesPrefix(path, INSTALL_PATH)
    || matchesPrefix(path, "/api/alerts/webhook")
    || ((matchesPrefix(path, "/api/updates") || matchesPrefix(path, "/api/herdr/update"))
      && !["GET", "HEAD", "OPTIONS"].includes(method));
  if (!blocked) return null;
  setRequestRoute(path);
  return jsonResponse(
    { error: { code: "disabled_by_policy", message: "Disabled by security policy" } },
    403,
    { "cache-control": "no-store" },
  );
}

/** The routes that read or write files and folders on this disk (or run git and gh in them) for a pane, a workspace or a picker. */
const OTHER_MACHINE_FILES = /^\/api\/(?:fs\/|pane\/(?:files|docs|image)$|workspace\/(?:diff\/|git\/|directories$|pr(?:$|\/)))/;

export async function handleRequest(request: Request, ctx: ServerContext): Promise<Response | undefined> {
  const { options, hostname, bootId, preferences, herdrSidebar, shellAgents, agentDetector, agentOffered, agentInstaller, openCodeState, approvals, acp, cliProxyRoutes, usageLogin, usage, voice, browserSnapshot, core, seen, piReader, orderSequence, requestLog, portalStartupResult, portalStartup, cfAccess } = ctx.services;
  const { sidecar, serialize, push, omo, claudeAgents, opencodeAgents, plans, clientSnapshot, machines, broadcastAll, collector, queueFirstMessage, askFirstMessage } = core;
  return requestLog.handle(request, async (headers) => {
  if (options.profile === "machine") wordHerdrFailures(machineFailure, machineLayoutReason);
  const startup = portalStartupResult ?? await portalStartup;
  if (!startup.ok) {
    setRequestRoute("startup");
    return compressResponse(request, errorResponse(startup.error));
  }
  return compressResponse(request, await (async (): Promise<Response | undefined> => {
  const url = new URL(request.url);
  let { pathname } = url;
  if (ctx.peer.kind !== "socket" || ctx.lanHttps === true) {
    setRequestRoute("peer-refusal");
    return new Response("forbidden", { status: 403 });
  }
  const verified = await cfAccess.verifier.verify(request.headers.get("cf-access-jwt-assertion"));
  if (!verified.ok) {
    setRequestRoute("auth-refusal");
    return pathname === "/ws"
      ? new Response("unauthorized", { status: 401 })
      : jsonResponse({ error: { code: "cf_access_required", message: "Cloudflare Access authentication required" } }, 401, { "cache-control": "no-store" });
  }
  const publicOrigin = cfAccess.publicOrigin;
  const access: Access = { level: "full", via: "tailscale", role: "drive", login: verified.email };
  const bridgeAuthorized = false;
  const readOnly = false;
  const loginOwner = `${access.via}:${verified.email}`;
  const client = verified.email;
  const ip = ctx.requestIP(request);
  const loopback = ip !== null && isLoopbackAddress(ip.address);
  const forwarded = cameThroughProxy(request.headers);
  const requestHost = request.headers.get("host");
  void loopback;

  const mutating = !["GET", "HEAD", "OPTIONS"].includes(request.method);
  if (pathname.startsWith("/api/") && mutating && !sameOrigin(request, publicOrigin)) {
    setRequestRoute("origin-refusal");
    return jsonResponse({ error: { code: "invalid_origin", message: "Use controls from this app" } }, 403);
  }
  if (pathname.startsWith("/api/") && nonCanonicalPath(pathname)) return jsonResponse({ error: { code: "not_found", message: "not found" } }, 404);
  const disabledEarly = disabledPolicyResponse(request.method, pathname);
  if (disabledEarly) return disabledEarly;

  const textEdit = /^\/api\/(?:machines\/[^/]+\/)?fs\/text$/.test(pathname);
  if (textEdit && !textEditAllowed(access, bridgeAuthorized, pathname.startsWith("/api/machines/"))) {
    setRequestRoute("drive-refusal");
    return jsonResponse({ error: { code: "drive_only", message: "Only a device that drives this PC can edit its files" } }, 403);
  }

  if (pathname.startsWith("/api/")) ctx.timeout(request, 60);

  if (options.localFiles === false && OTHER_MACHINE_FILES.test(pathname)) {
    setRequestRoute(pathname);
    return jsonResponse({ error: { code: "unsupported", message: "Files on another machine of herdr-core are not reachable from Ovis yet" } }, 501);
  }

  if (pathname === "/api/machines" || pathname.startsWith("/api/machines/")) {
    if (!machines) return jsonResponse({ error: { code: "bridge_only", message: "Manage PCs on the connection server" } }, 404);
    if (pathname.startsWith("/api/machines/local/")) {
      if (!sameOrigin(request, publicOrigin) || (request.method !== "GET" && request.headers.get("x-herdr-machine") !== "1")) return jsonResponse({ error: { code: "invalid_origin", message: "Use PC controls from this app" } }, 403);
      pathname = pathname.replace("/api/machines/local/", "/api/");
      if (nonCanonicalPath(pathname)) return jsonResponse({ error: { code: "not_found", message: "not found" } }, 404);
      const disabledLocal = disabledPolicyResponse(request.method, pathname);
      if (disabledLocal) return disabledLocal;
      if (!/^\/api\/(session|agents|agent-catalog$|agent-catalog\/sign-in$|integrations|pane\/|workspace\/|worktree\/|tab\/|layout\/ratio$|agent\/(?:rename|commands)$|plugins\/actions$|plugin\/action$|sessions\/(?:history|resume)$)/.test(pathname)) return badRequest("invalid_route", "Unknown PC endpoint");
      url.pathname = pathname;
    } else {
      ctx.timeout(request, pathname === "/api/machines/events" ? 0 : 80);
      const pairings = { subscribe: (listener: (event: DevicePairedEvent | DeviceRemovedEvent | RelayPairingsEvent | RemotePairingsEvent) => void) => {
        listener({ type: "relay-pairings", pairings: [] });
        return () => {};
      } };
      const response = await handleMachineRequest(
        request,
        machines,
        pathname === "/api/machines/events" ? (end) => scheduleCfAccessExpiry(verified.expiresAtMs, end) : undefined,
        preferences,
        readOnly,
        herdrSidebar,
        seen,
        pairings,
        ctx.relayBodyBudget,
        true,
        publicOrigin,
      );
      response.headers.set("cache-control", "no-store");
      return response;
    }
  }
  if (pathname === "/ws") {
    setRequestRoute(pathname);
    if (!sameOrigin(request, publicOrigin)) return new Response("invalid origin", { status: 403 });
    const machineId = url.searchParams.get("machine_id");
    if (machineId && machineId !== "local") {
      return new Response("forbidden", { status: 403 });
    }
    const useMachineEvents = machines && process.env["OVIS_MACHINE_EVENTS_WS"] !== "0";
    const machineEvents = useMachineEvents ? {
      manager: machines, preferences, herdrSidebar, seen,
      pairings: { subscribe: (listener: (event: DevicePairedEvent | DeviceRemovedEvent | RelayPairingsEvent | RemotePairingsEvent) => void) => {
        listener({ type: "relay-pairings", pairings: [] });
        return () => {};
      } },
    } : undefined;
    const upgraded = ctx.upgrade(request, {
      headers,
      data: connectionData({
        machineEvents,
        deviceId: undefined,
        readOnly,
        watchAccessExpiry: (close) => scheduleCfAccessExpiry(verified.expiresAtMs, close),
      }),
    });
    if (upgraded) return undefined;
    return new Response("websocket upgrade required", { status: 426 });
  }

  if (pathname === "/api/updates" || pathname.startsWith("/api/updates/")) {
    return handleUpdateRequest(request, pathname, undefined);
  }
  if (pathname === "/api/herdr/update") {
    setRequestRoute(pathname);
    return handleHerdrUpdateRequest(request, undefined);
  }
  if (pathname === "/api/connection-diagnostics") { setRequestRoute(pathname); return clientConnectionLogHandle(ctx, request, client); }
  if (pathname === "/api/telemetry") { setRequestRoute(pathname); return handleTelemetryRequest(request, options.telemetry); }
  if (pathname === "/api/preferences") { setRequestRoute(pathname); return handlePreferencesRequest(request, preferences); }
  if (pathname === "/api/seen") { setRequestRoute(pathname); return handleSeenRequest(request, seen); }

  if (pathname === "/api/system") { setRequestRoute(pathname); return handleSystemRequest(request, ctx.services.systemSampler); }
  if (pathname === USER_FONTS_PATH || pathname.startsWith(`${USER_FONTS_PATH}/`)) return handleUserFontsRequest(request, pathname, ctx.services.fontsDir, url.search);
  if (pathname === "/api/usage") { setRequestRoute(pathname); return handleUsageRequest(request, url, ctx.services.usageAccounts); }
  if (pathname === "/api/usage/accounts") { setRequestRoute(pathname); return ctx.services.usageAccounts.handle(request); }
  if (pathname === "/api/usage/statusline") { setRequestRoute(pathname); return handleStatuslineRequest(request, usage); }
  if (pathname === "/api/usage/login") { setRequestRoute(pathname); ctx.timeout(request, 30); return usageLogin.handle(request, collector.trackPane, loginOwner); }
  if (pathname === "/api/usage/login/prompt" || pathname === "/api/usage/login/code" || pathname === "/api/usage/login/cancel") { setRequestRoute(pathname); return usageLogin.handlePrompt(request, readOnly, loginOwner); }
  if (pathname === "/api/cliproxy" || pathname.startsWith("/api/cliproxy/")) { ctx.timeout(request, 60); return cliProxyRoutes.handle(request); }
  if (pathname === "/api/voice" || pathname.startsWith("/api/voice/")) { ctx.timeout(request, 120); return handleVoiceRequest(request, pathname, voice); }
  // Settings → Memory: every change is a person's on a screen; the bridge token never reaches it (not a bridge path)
  if (pathname === "/api/memory" || pathname.startsWith("/api/memory/")) {
    return handleMemoryRequest(request, url, ctx.services.memory, { readOnly, by: "cloudflare-access" });
  }

  if (pathname === "/api/push" || pathname.startsWith("/api/push/")) {
    try {
      const answered = await handlePushRequest(request, pathname, push, null, []);
      if (answered) return answered;
    } catch (error) {
      return errorResponse(error);
    }
  }

  if (pathname === "/api/health") {
    setRequestRoute(pathname);
    const auth: HealthAuth = { required: false, authenticated: true, via: access.via, role: access.role };
    const security: SecuritySummary = {
      token_configured: false,
      pairing_gate: "closed",
      bind_scope: bindScope(hostname),
      observed_ingress: "proxy",
      public_exposure: "unknown",
    };
    const securityHeaders: Record<string, string> = { "cache-control": "no-store" };
    const relay = { relay: ctx.services.relay.status() };
    if (url.searchParams.get("scope") === "bridge") {
      return jsonResponse({ ok: true, auth, bridge_protocol: BRIDGE_PROTOCOL, ...relay, security, web_ui: { boot_id: bootId }, runtime: runtime(), ...(options.launchAccepted ? { accepted: options.launchAccepted() } : {}) }, 200, securityHeaders);
    }
    const herdr_core = options.herdrCoreFacts?.();
    try {
      const info = await ping();
      const herdr = attachableIdentity(info, sidecar);
      return jsonResponse({ ok: true, herdr, auth, version, ...relay, security, ...(herdr_core ? { herdr_core } : {}),
        web_ui: { boot_id: bootId, revision: process.env["OVIS_REVISION"] ?? null } }, 200, securityHeaders);
    } catch (error) {
      return errorResponse(error);
    }
  }

  if (pathname === "/api/herdr-ui") {
    if (request.method !== "GET") return badRequest("method_not_allowed", "use GET");
    return jsonResponse(readHerdrUi(options.herdrConfigPath), 200, { "cache-control": "no-store" });
  }

  if (pathname === "/api/access") {
    setRequestRoute(pathname);
    if (request.method !== "GET") return badRequest("method_not_allowed", "use GET");
    return jsonResponse({
      port: ctx.port ?? 0,
      tailscale: { state: "missing", dns_name: null, serving_url: null, serve_command: null, serve_url: null },
    } satisfies RemoteAccess, 200, { "cache-control": "no-store" });
  }

  if (pathname === "/api/session") {
    setRequestRoute(pathname);
    try {
      const snapshot = await clientSnapshot();
      return jsonResponse({ snapshot: browserSnapshot(snapshot) }, 200, wordedHeaders());
    } catch (error) {
      return errorResponse(error);
    }
  }

  const agentsResponse = await handleAgentsRequest(request, pathname, shellAgents, agentOffered);
  if (agentsResponse) return agentsResponse;

  const installResponse = await agentInstaller.handle(request, pathname);
  if (installResponse) return installResponse;
  const catalogResponse = await handleAgentCatalogRequest(request, pathname, agentDetector, undefined, readOnly);
  if (catalogResponse) return catalogResponse;

  const integrationsResponse = await handleIntegrationsRequest(request, pathname);
  if (integrationsResponse) return integrationsResponse;

  const filesResponse = await handleFileRequest(request, url, pathname, { bridgeAuthorized, requestHost, forwarded, client, access });
  if (filesResponse) return filesResponse;

  const workspaceResponse = await handleWorkspaceRequest(request, url, pathname, ctx, broadcastAll, { ask: askFirstMessage, queue: queueFirstMessage }, () => {
    const receipt = orderSequence.moved();
    void machines?.refreshLocal();
    return receipt;
  }, shellAgents, options.localFiles !== false);
  if (workspaceResponse) return workspaceResponse;

  const pluginResponse = await handlePluginRequest(request, url, pathname, options);
  if (pluginResponse) return pluginResponse;

  const paneResponse = await handlePaneRequest(request, url, pathname, options);
  if (paneResponse) return paneResponse;

  const tasksResponse = await handleTasksRequest(request, url, pathname, { omo, claudeAgents, opencodeAgents });
  if (tasksResponse) return tasksResponse;

  if (pathname === BACKGROUND_AGENT_PATH) {
    return handleBackgroundAgentRequest(request, url, { paneGet, omoPane: (paneId) => omo.sessionOf(paneId) !== null, claudeAgents, opencodeAgents, read: options.backgroundAgentRead });
  }

  const planResponse = await handlePlanRequest(request, url, pathname, { omo, claudeAgents, plans });
  if (planResponse) return planResponse;

  const artifactsResponse = await handleArtifactsRequest(request, url, pathname, { claudeAgents });
  if (artifactsResponse) return artifactsResponse;

  const btwResponse = await handleBtwRequest(request, url, pathname, {
    transcript: (paneId) => paneTranscript(paneId, options.codexHome, undefined, options.devinDbPath, options.opencodeDb, options.hermesHome, options.grokHome, options.museData).then(
      (found) => found.source === "omp-transcript" ? found.path : null,
      (error: unknown) => { if (error instanceof ConversationUnavailable) return null; throw error; },
    ),
  });
  if (btwResponse) return btwResponse;

  if (pathname === SESSION_HISTORY_PATH) {
    setRequestRoute(SESSION_HISTORY_PATH);
    return handleSessionHistoryRequest(request, url, { readOnly, stores: { codexHome: options.codexHome, opencodeDb: options.opencodeDb, hermesHome: options.hermesHome, piReader } });
  }

  if (pathname === SESSION_RESUME_PATH) {
    setRequestRoute(SESSION_RESUME_PATH);
    return handleSessionResumeRequest(request, { readOnly, stores: { codexHome: options.codexHome, opencodeDb: options.opencodeDb, hermesHome: options.hermesHome }, holdOpen: (seconds) => ctx.timeout(request, seconds) });
  }

  if (acp && (pathname === "/api/pane/turn/cancel" || pathname === "/api/pane/turn/release" || pathname === "/api/pane/turn/cancel-children")) {
    setRequestRoute(pathname);
    if (request.method !== "POST") return badRequest("method_not_allowed", "Use POST.");
    const body = await readJsonObject(request);
    if (body instanceof Response) return body;
    if (typeof body.pane_id !== "string") return badRequest("missing_pane_id", "pane_id is required.");
    if (pathname.endsWith("/cancel-children")) {
      // every ACP child the pane started gets the same hold as its own Stop; one a person holds already keeps its hold
      // (a new one would cancel the turn that person started), and one that cannot take it is named
      let children;
      try { children = await acp.childrenOf(body.pane_id); } catch (error) { return errorResponse(error); }
      const tried = await Promise.allSettled(children.map(async child => {
        if (!child.client.connected || !child.client.session) throw new Error("not connected");
        if (child.client.holdGeneration !== null) return { pane_id: child.terminal, child_id: child.id, generation: child.client.holdGeneration };
        return { pane_id: child.terminal, child_id: child.id, generation: await child.client.hold(child.client.session) };
      }));
      return jsonResponse({
        ok: true,
        held: tried.flatMap(outcome => outcome.status === "fulfilled" ? [outcome.value] : []),
        failed: children.filter((_, index) => tried[index]?.status === "rejected").map(child => child.terminal),
      });
    }
    const child = acp.forPane(body.pane_id);
    if (!child?.client.connected || !child.client.session) return badRequest("unavailable", "No connected ACP child.");
    const cancel = pathname.endsWith("/cancel");
    if (!cancel && (body.child_id !== child.id || !Number.isSafeInteger(body.generation))) return badRequest("hold_changed", "The child and hold generation are required.");
    try {
      if (cancel) return jsonResponse({ ok: true, child_id: child.id, generation: await child.client.hold(child.client.session) });
      const receipt = await child.client.request("_keeper/release", { sessionId: child.client.session, generation: body.generation });
      if (!receipt || typeof receipt !== "object" || !("released" in receipt && receipt.released === true)) return badRequest("unavailable", "No keeper receipt.");
      return jsonResponse({ ok: true, child_id: child.id, ...receipt });
    } catch { return badRequest("hold_changed", "The keeper could not confirm that operation."); }
  }
  if (pathname.startsWith("/api/pane/prompt")) {
    try {
      const response = await handlePromptRequest(request, url, { serialize, codexHome: options.codexHome, claudeTranscript: (paneId) => claudeAgents.sessionOf(paneId)?.path ?? null, readOnly, openCodeStateDir: options.openCodeStateDir, openCodeState, approvals, ...(acp ? { acp } : {}), onAnswered: () => options.telemetry?.tally("prompt_answers") });
      if (response) return response;
    } catch (error) {
      return errorResponse(error);
    }
  }

  if (pathname.startsWith("/api/")) {
    return jsonResponse({ error: { code: "not_found", message: `unknown endpoint ${pathname}` } }, 404);
  }

  setRequestRoute("static");
  return serveStatic(pathname, request.headers.get("accept-encoding"), publicOrigin);
  })());
  });
}

function clientConnectionLogHandle(ctx: ServerContext, request: Request, client: string): Promise<Response> | Response {
  return ctx.services.clientConnectionLog.handle(request, client);
}
