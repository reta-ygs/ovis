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
import { badRequest, errorResponse, jsonResponse, setRequestRoute } from "./http.ts";
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
import { attachableIdentity } from "./pty/sidecar.ts";
import { runtime } from "./herdr-core/runtime.ts";
import { handleUpdateRequest } from "./update-api.ts";
import { handleHerdrUpdateRequest } from "./herdr-update.ts";
import type { AccountMailbox } from "./account/mailbox.ts";
import type { AccountHolds } from "./account/holds.ts";
import type { AccountIntroductions } from "./account/introductions.ts";
import type { RelayService } from "./relay/service.ts";
import { handleTelemetryRequest } from "./telemetry.ts";
import { handleStatuslineRequest, handleUsageRequest } from "./usage.ts";
import { handleSystemRequest, type SystemSampler } from "./system-stats.ts";
import { handleUserFontsRequest } from "./user-fonts.ts";
import { USER_FONTS_PATH } from "../shared/user-fonts.ts";
import type { UsageAccountList } from "./usage-account-list.ts";
import { handleVoiceRequest } from "./voice.ts";
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
import type { TailnetIdentity } from "./tailscale.ts";
import type { CLIProxyRoutes } from "./cliproxy-routes.ts";
import type { UsageLoginService } from "./usage-login.ts";
import type { UsageService } from "./usage.ts";
import type { VoiceService } from "./voice.ts";

type PortalStartup = { ok: true } | { ok: false; error: unknown };

/** Per-server services shared by socket requests and other dispatch callers. */
export interface RequestServices {
  /** the move of herdr's session to herdr-core, where the runtime can be switched from here */
  readonly runtimeMove: MoveService | null;
  readonly relay: RelayService;
  readonly relayReceiptIds: RelayReceiptIds;
  readonly options: NonNullable<Parameters<typeof createServer>[0]>;
  readonly hostname: string;
  readonly token: string;
  readonly bridgeToken: string;
  readonly bootId: string;
  readonly devices: DeviceStore;
  readonly accountMailbox: AccountMailbox;
  readonly accountIntroductions: AccountIntroductions;
  readonly accountHolds: AccountHolds;
  readonly preferences: PreferenceStore;
  readonly herdrSidebar: HerdrSidebarConfig;
  /** `loginPath`: the request states a Tailscale login, so the PC's own login must be known, not merely cached as unknown */
  readonly identityOf: (grantPath: boolean, host: string | null, loginPath?: boolean) => Promise<TailnetIdentity>;
  readonly serveOnly: boolean;
  readonly portalGuards: () => { tokenSet: boolean; serveOnly: boolean };
  readonly shellAgents: ShellAgentLocator;
  readonly agentDetector: AgentDetector;
  readonly agentOffered: (kind: string) => Promise<boolean>;
  readonly agentInstaller: AgentInstaller;
  readonly openCodeState: OpenCodePromptState;
  readonly cliProxyRoutes: CLIProxyRoutes;
  readonly usageLogin: UsageLoginService;
  readonly usage: UsageService;
  readonly usageAccounts: UsageAccountList;
  readonly systemSampler: SystemSampler | null;
  /** the state folder's fonts/, served to every device that may read this PC (server/user-fonts.ts) */
  readonly fontsDir: string;
  readonly voice: VoiceService;
  readonly browserSnapshot: <S extends SessionSnapshot>(snapshot: S) => S;
  readonly core: ReturnType<typeof createCore>;
  readonly seen: SeenStore;
  readonly piReader: PiSessionReader;
  readonly orderSequence: OrderSequence;
  readonly clientConnectionLog: ClientConnectionLog;
  readonly requestLog: RequestLog;
  readonly portalStartupResult: PortalStartup | undefined;
  readonly portalStartup: Promise<PortalStartup>;
  readonly cfAccess: { readonly verifier: CfAccessVerifier; readonly publicOrigin: string };
}

/** The transport operations a request needs; peer kinds are extended with relay authentication. */
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
  const { options, hostname, bootId, preferences, herdrSidebar, shellAgents, agentDetector, agentOffered, agentInstaller, openCodeState, cliProxyRoutes, usageLogin, usage, voice, browserSnapshot, core, seen, piReader, orderSequence, requestLog, portalStartupResult, portalStartup, cfAccess } = ctx.services;
  const { sidecar, serialize, push, omo, claudeAgents, opencodeAgents, plans, clientSnapshot, machines, broadcastAll, collector, queueFirstMessage } = core;
  return requestLog.handle(request, async (headers) => {
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
      return jsonResponse({ snapshot: browserSnapshot(snapshot) });
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

  const workspaceResponse = await handleWorkspaceRequest(request, url, pathname, ctx, broadcastAll, queueFirstMessage, () => {
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

  if (pathname.startsWith("/api/pane/prompt")) {
    try {
      const response = await handlePromptRequest(request, url, { serialize, codexHome: options.codexHome, claudeTranscript: (paneId) => claudeAgents.sessionOf(paneId)?.path ?? null, readOnly, openCodeStateDir: options.openCodeStateDir, openCodeState, onAnswered: () => options.telemetry?.tally("prompt_answers") });
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
