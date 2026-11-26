import { emptyUsage, telemetrySurface, type InstallMethod, type TelemetryActive, type TelemetryChange, type TelemetryIngress, type TelemetryRuntime, type TelemetryStatus, type TelemetrySurface } from "../shared/telemetry.ts";
import { jsonResponse } from "./http.ts";

export const TELEMETRY_URL = "";
export const ACTIVE_URL = "";
export const NOTICE_GRACE_MS = 10 * 60_000;
export const USAGE_RESEND_MS = 60 * 60_000;

export interface VisitPane {
  agent: string | null | undefined;
  ovis?: boolean;
  version?: string | null;
}

type Env = Record<string, string | undefined>;

interface Timer {
  clear(): void;
}

export function telemetryBlocked(_env: Env): boolean {
  return true;
}

export function visitSurface(asked: string | null): TelemetrySurface | null | false {
  return asked === null ? null : telemetrySurface(asked) ?? false;
}

export function installMethod(_env: Env): InstallMethod {
  return "source";
}

/**
 * Disabled no-op telemetry implementation: never reads/writes disk state,
 * never starts timers, and never performs outbound network requests.
 */
export class Telemetry {
  private readonly nowFn: () => number;

  constructor(private readonly options: {
    stateDir: string;
    version: string;
    env: Env;
    fetch: typeof fetch;
    url?: string;
    activeUrl?: string;
    platform?: string;
    arch?: string;
    previousVersion?: () => string | null;
    runtime?: TelemetryRuntime;
    now?: () => number;
    noticeGraceMs?: number;
    setTimer?: (fn: () => void, ms: number) => Timer;
  }) {
    this.nowFn = options.now ?? (() => Date.now());
  }

  private disabledActive(): TelemetryActive {
    return {
      event: "active",
      day: new Date(this.nowFn()).toISOString().slice(0, 10),
      install_id: "00000000-0000-0000-0000-000000000000",
      version: this.options.version,
      os: this.options.platform ?? process.platform,
      arch: this.options.arch ?? process.arch,
      install_method: installMethod(this.options.env),
      harnesses: [],
      usage: emptyUsage(),
      runtime: this.options.runtime ?? "herdr",
    };
  }

  status(): TelemetryStatus {
    return {
      enabled: false,
      blocked_by_env: true,
      notice_seen: true,
      next: null,
      active: this.disabledActive(),
    };
  }

  change(_patch: TelemetryChange): TelemetryStatus {
    return this.status();
  }

  counting(): boolean {
    return false;
  }

  tally(_counter?: string): void {}

  paneStatus(_paneId: string, _status: string): void {}

  start(): void {}

  stop(): void {}

  active(
    agents: readonly VisitPane[] | Promise<readonly VisitPane[]>,
    _visit: { surface?: TelemetrySurface | null; ingress?: TelemetryIngress | null } = {},
  ): Promise<void> {
    Promise.resolve(agents).catch(() => {});
    return Promise.resolve();
  }

  report(): Promise<void> {
    return Promise.resolve();
  }
}

export async function handleTelemetryRequest(_request: Request, _telemetry?: Telemetry): Promise<Response> {
  return jsonResponse(
    { error: { code: "not_found", message: "This server sends no telemetry" } },
    404,
    { "cache-control": "no-store" },
  );
}
