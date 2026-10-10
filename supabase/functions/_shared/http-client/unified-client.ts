import { SupabaseClient } from "npm:@supabase/supabase-js@2";
import {
  BudgetExhaustedError,
  fetchWithTimeout,
  parseRetryAfterMs,
  PermanentHttpError,
  type RequestBudget,
  RetryableHttpError,
} from "../pncp/retry.ts";

/** Default timeout per individual attempt: 20 seconds (configurable via env). */
export const DEFAULT_ATTEMPT_TIMEOUT_MS = Number(
  Deno.env.get("HTTP_ATTEMPT_TIMEOUT_MS") || 20_000,
);

/** Headroom margin (10s) before edge wall clock to allow safe suspension and database write. */
export const SAFE_EDGE_MARGIN_MS = 10_000;

/** Error thrown when rate-limit wait or cooldown exceeds the remaining edge budget. */
export class RateLimitPauseError extends Error {
  readonly waitMs: number;
  readonly host: string;

  constructor(host: string, waitMs: number) {
    super(`Rate limit pause for host ${host} (${waitMs}ms exceeds remaining budget)`);
    this.name = "RateLimitPauseError";
    this.host = host;
    this.waitMs = waitMs;
  }
}

export type SlotAcquisitionResult = {
  allowed: boolean;
  reason?: string;
  wait_ms?: number;
};

export type HostLeaseRpc = {
  acquireSlot: (host: string, maxWaitMs?: number) => Promise<SlotAcquisitionResult>;
  reportRateLimit: (host: string, cooldownSeconds: number) => Promise<void>;
};

export type UnifiedFetchOptions = {
  budget?: RequestBudget;
  syncRunId?: string;
  endpoint?: string;
  pagina?: number;
  parametros?: Record<string, unknown>;
  onHeartbeat?: () => Promise<void>;
  maxAttempts?: number;
  maxTimeoutRetries?: number;
  attemptTimeoutMs?: number;
  /** Devolve 4xx (exceto 429) a quem chama, com o corpo, em vez de lançar PermanentHttpError (para arquivar a resposta). */
  devolver4xx?: boolean;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  validateResponse?: (res: Response) => Promise<void> | void;
};

/**
 * Creates default HostLeaseRpc implementation backed by Supabase private RPCs.
 */
export function createSupabaseHostLease(client: SupabaseClient): HostLeaseRpc {
  // acquire_http_slot / report_http_rate_limit existem só em `private`;
  // `client.rpc` direto mira `public` (PGRST202) e desligava o lease silenciosamente.
  // Resolvido por chamada (lazy) para não tocar no client/mocks no construtor.
  const privateRpc = () => client.schema("private");
  return {
    async acquireSlot(host: string, maxWaitMs = 10_000): Promise<SlotAcquisitionResult> {
      const { data, error } = await privateRpc().rpc("acquire_http_slot", {
        p_host: host,
        p_max_wait_ms: maxWaitMs,
      });
      if (error) {
        console.warn(`[acquire_http_slot] RPC error on host ${host}: ${error.message}`);
        return { allowed: true, wait_ms: 0 };
      }
      return data as SlotAcquisitionResult;
    },
    async reportRateLimit(host: string, cooldownSeconds: number): Promise<void> {
      const { error } = await privateRpc().rpc("report_http_rate_limit", {
        p_host: host,
        p_cooldown_seconds: cooldownSeconds,
      });
      if (error) {
        console.warn(`[report_http_rate_limit] RPC error on host ${host}: ${error.message}`);
      }
    },
  };
}

export type TelemetryLogger = (telemetry: {
  syncRunId: string;
  endpoint: string;
  parametros: Record<string, unknown>;
  pagina?: number;
  statusHttp?: number;
  tempoRespostaMs?: number;
  respostaHash?: string;
  erro?: string;
  tentativa?: number;
  host?: string;
  retryAfterSeconds?: number;
}) => Promise<void>;

export class UnifiedHttpClient {
  private hostLease: HostLeaseRpc | null;
  private supabaseClient: SupabaseClient | null;
  private telemetryLogger: TelemetryLogger | null;

  constructor(options: {
    supabaseClient?: SupabaseClient | null;
    hostLease?: HostLeaseRpc | null;
    telemetryLogger?: TelemetryLogger | null;
  } = {}) {
    this.supabaseClient = options.supabaseClient ?? null;
    this.hostLease = options.hostLease ?? (this.supabaseClient ? createSupabaseHostLease(this.supabaseClient) : null);
    this.telemetryLogger = options.telemetryLogger ?? null;
  }

  setHostLease(lease: HostLeaseRpc | null): void {
    this.hostLease = lease;
  }

  setTelemetryLogger(logger: TelemetryLogger | null): void {
    this.telemetryLogger = logger;
  }

  /**
   * Fetches an external URL with:
   * 1. Rate-limit lease acquisition per host (`private.acquire_http_slot`)
   * 2. Host-wide rate-limit reporting on 429 (`private.report_http_rate_limit`)
   * 3. Configurable attempt timeout (default 20s) and at most 1 timeout retry
   * 4. Heartbeat notifications before sleeps/waits
   * 5. Budget verification (immediate RateLimitPauseError if sleep exceeds budget)
   * 6. Telemetry recording of all attempts (including 429 and 5xx)
   */
  async fetchWithRateLimit(
    url: string | URL,
    init: RequestInit = {},
    options: UnifiedFetchOptions = {},
  ): Promise<Response> {
    const targetUrl = typeof url === "string" ? new URL(url) : url;
    const host = targetUrl.hostname;
    const nowFn = options.now ?? Date.now;
    const sleepFn = options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
    const budget = options.budget;
    const attemptTimeoutMs = options.attemptTimeoutMs ?? DEFAULT_ATTEMPT_TIMEOUT_MS;
    const maxAttempts = options.maxAttempts ?? 3;
    const maxTimeoutRetries = options.maxTimeoutRetries ?? 1;

    let attempt = 0;
    let timeoutRetries = 0;
    let lastError: Error | undefined;

    while (attempt < maxAttempts) {
      attempt++;

      // 1. Coordinate with distributed lease for this host before sending request
      if (this.hostLease) {
        while (true) {
          const slot = await this.hostLease.acquireSlot(host);
          const waitMs = slot.wait_ms ?? 0;
          if (!slot.allowed) {
            if (budget) {
              const rem = budget.remainingMs(nowFn());
              if (waitMs + attemptTimeoutMs + SAFE_EDGE_MARGIN_MS > rem) {
                throw new RateLimitPauseError(host, waitMs);
              }
            }
            if (options.onHeartbeat) await options.onHeartbeat();
            await sleepFn(Math.max(waitMs, 500));
            continue;
          }

          if (waitMs > 0) {
            if (budget) {
              const rem = budget.remainingMs(nowFn());
              if (waitMs + attemptTimeoutMs + SAFE_EDGE_MARGIN_MS > rem) {
                throw new RateLimitPauseError(host, waitMs);
              }
            }
            if (options.onHeartbeat) await options.onHeartbeat();
            await sleepFn(waitMs);
          }
          break;
        }
      }

      // Verify remaining budget for this attempt
      if (budget) {
        const rem = budget.remainingMs(nowFn());
        if (rem <= SAFE_EDGE_MARGIN_MS) {
          throw new BudgetExhaustedError();
        }
      }

      const startedAt = nowFn();
      let response: Response | undefined;
      let attemptStatus: number | undefined;
      let attemptErrorMsg: string | undefined;
      let retryAfterSec: number | undefined;

      try {
        const effectiveTimeout = budget
          ? Math.min(attemptTimeoutMs, Math.max(1, budget.attemptTimeoutMs(attemptTimeoutMs, nowFn())))
          : attemptTimeoutMs;

        if (effectiveTimeout <= 0) {
          throw new BudgetExhaustedError();
        }

        response = await fetchWithTimeout(targetUrl, init, effectiveTimeout);
        attemptStatus = response.status;

        if (response.status === 429) {
          await response.body?.cancel().catch(() => {});
          const retryAfterMs = parseRetryAfterMs(response.headers.get("Retry-After"), nowFn());
          const retrySeconds = retryAfterMs != null ? Math.ceil(retryAfterMs / 1000) : 5;
          retryAfterSec = retrySeconds;

          // Notify global host lease of 429
          if (this.hostLease) {
            await this.hostLease.reportRateLimit(host, retrySeconds);
          }

          throw new RetryableHttpError(`HTTP 429 on ${host}`, retryAfterMs);
        }

        if (response.status >= 500) {
          await response.body?.cancel().catch(() => {});
          throw new RetryableHttpError(`HTTP ${response.status} on ${host}`, null);
        }

        if (response.status >= 400 && !options.devolver4xx) {
          await response.body?.cancel().catch(() => {});
          throw new PermanentHttpError(`HTTP ${response.status} on ${host}`);
        }

        if (options.validateResponse) {
          await options.validateResponse(response);
        }

        // Telemetry for successful attempt (if enabled)
        if (this.telemetryLogger && options.syncRunId) {
          await this.telemetryLogger({
            syncRunId: options.syncRunId,
            endpoint: options.endpoint ?? targetUrl.pathname,
            parametros: options.parametros ?? {},
            pagina: options.pagina,
            statusHttp: response.status,
            tempoRespostaMs: nowFn() - startedAt,
            tentativa: attempt,
            host,
          }).catch((err) => console.warn(`Telemetry error: ${err}`));
        }

        return response;
      } catch (err: unknown) {
        const elapsed = nowFn() - startedAt;
        if (err instanceof PermanentHttpError || err instanceof BudgetExhaustedError || err instanceof RateLimitPauseError) {
          if (this.telemetryLogger && options.syncRunId) {
            await this.telemetryLogger({
              syncRunId: options.syncRunId,
              endpoint: options.endpoint ?? targetUrl.pathname,
              parametros: options.parametros ?? {},
              pagina: options.pagina,
              statusHttp: attemptStatus,
              tempoRespostaMs: elapsed,
              erro: (err as Error).message,
              tentativa: attempt,
              host,
              retryAfterSeconds: retryAfterSec,
            }).catch(() => {});
          }
          throw err;
        }

        lastError = err instanceof Error ? err : new Error(String(err));
        attemptErrorMsg = lastError.message;
        const isTimeout = /timeout|aborted/i.test(lastError.message);

        if (this.telemetryLogger && options.syncRunId) {
          await this.telemetryLogger({
            syncRunId: options.syncRunId,
            endpoint: options.endpoint ?? targetUrl.pathname,
            parametros: options.parametros ?? {},
            pagina: options.pagina,
            statusHttp: attemptStatus,
            tempoRespostaMs: elapsed,
            erro: attemptErrorMsg,
            tentativa: attempt,
            host,
            retryAfterSeconds: retryAfterSec,
          }).catch(() => {});
        }

        if (isTimeout) {
          if (timeoutRetries >= maxTimeoutRetries) {
            if (budget) throw new BudgetExhaustedError();
            throw lastError;
          }
          timeoutRetries++;
        }

        if (attempt >= maxAttempts) {
          throw lastError;
        }

        // Calculate backoff
        let waitMs = 1000 * Math.pow(2, attempt - 1);
        if (err instanceof RetryableHttpError && err.retryAfterMs != null) {
          waitMs = Math.max(waitMs, err.retryAfterMs);
        }

        if (budget) {
          const rem = budget.remainingMs(nowFn());
          if (waitMs + attemptTimeoutMs + SAFE_EDGE_MARGIN_MS > rem) {
            if (err instanceof RetryableHttpError && err.retryAfterMs != null) {
              throw new RateLimitPauseError(host, waitMs);
            }
            throw new BudgetExhaustedError();
          }
        }

        if (options.onHeartbeat) await options.onHeartbeat();
        await sleepFn(waitMs);
      }
    }

    throw lastError ?? new Error(`Request failed after ${maxAttempts} attempts`);
  }

  async getJson<T = unknown>(
    url: string | URL,
    init: RequestInit = {},
    options: UnifiedFetchOptions & {
      validateBody?: (bodyText: string, status: number) => Promise<void> | void;
    } = {},
  ): Promise<{ status: number; body: T; elapsedMs: number }> {
    const started = (options.now ?? Date.now)();
    const res = await this.fetchWithRateLimit(url, {
      ...init,
      headers: {
        Accept: "application/json",
        ...(init.headers ?? {}),
      },
    }, options);

    if (res.status === 204) {
      return { status: 204, body: {} as T, elapsedMs: (options.now ?? Date.now)() - started };
    }

    const text = await res.text();
    if (options.validateBody) {
      await options.validateBody(text, res.status);
    }

    if (!text.trim()) {
      return { status: res.status, body: {} as T, elapsedMs: (options.now ?? Date.now)() - started };
    }

    let body: T;
    try {
      body = JSON.parse(text) as T;
    } catch (error) {
      // 4xx devolvido (devolver4xx) pode vir em HTML ou texto: o corpo segue como texto para ser arquivado.
      if (res.status < 400) throw error;
      body = text as T;
    }
    const elapsedMs = (options.now ?? Date.now)() - started;
    return { status: res.status, body, elapsedMs };
  }
}
