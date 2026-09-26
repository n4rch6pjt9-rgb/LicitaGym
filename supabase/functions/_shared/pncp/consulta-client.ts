import {
  BudgetExhaustedError,
  createRequestBudget,
  DEFAULT_FETCH_TIMEOUT_MS,
  EmptyBodyAnomalyError,
  fetchWithTimeout,
  parseRetryAfterMs,
  PermanentHttpError,
  type RequestBudget,
  RetryableHttpError,
  type WithRetryOptions,
  withRetry,
} from "./retry.ts";

const DEFAULT_BASE = "https://pncp.gov.br/api/consulta/v1";

/** Health probe considered degraded above this latency. */
export const PNCP_HEALTH_SLOW_MS = 15_000;

/** Limites documentados em contract-matrix.md, schemas-consultas-pncp.md (probe 2026-09-19). */
export const CONSULTA_PAGE_SIZE = {
  contratacoes: { min: 10, max: 50, default: 50 },
  /** PCA exige mínimo 20 na prática (400 abaixo disso). */
  pca: { min: 20, max: 500, default: 500 },
  atasContratos: { min: 10, max: 500, default: 500 },
  instrumentosCobranca: { min: 10, max: 100, default: 100 },
} as const;

export type ConsultaPage<T> = {
  data: T[];
  pagina: number;
  paginasRestantes: number;
  totalRegistros: number;
  raw: unknown;
};

export type ConsultaGetOptions = {
  budget?: RequestBudget;
};

export function clampConsultaPageSize(
  kind: keyof typeof CONSULTA_PAGE_SIZE,
  tamanhoPagina?: number,
): number {
  const { min, max, default: fallback } = CONSULTA_PAGE_SIZE[kind];
  const size = tamanhoPagina ?? fallback;
  return Math.max(min, Math.min(size, max));
}

export class PncpConsultaClient {
  private budget: RequestBudget | undefined;
  private readonly retryOverrides: Pick<
    WithRetryOptions,
    "sleep" | "now" | "random"
  >;

  constructor(
    private baseUrl = Deno.env.get("PNCP_CONSULTA_BASE") ?? DEFAULT_BASE,
    retryOverrides: Pick<WithRetryOptions, "sleep" | "now" | "random"> = {},
  ) {
    this.retryOverrides = retryOverrides;
  }

  /** Bind a request-scoped Edge deadline for all subsequent calls. */
  withBudget(budget: RequestBudget): this {
    this.budget = budget;
    return this;
  }

  clearBudget(): this {
    this.budget = undefined;
    return this;
  }

  private buildUrl(
    path: string,
    params: Record<string, string | number | undefined>,
  ): string {
    const url = new URL(`${this.baseUrl.replace(/\/+$/, "")}${path}`);
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== "") {
        url.searchParams.set(k, String(v));
      }
    }
    return url.toString();
  }

  /**
   * 204 → empty válido.
   * 200 + corpo vazio → EmptyBodyAnomalyError (retry once; never treat as empty).
   */
  private async parseBody<T>(response: Response): Promise<T> {
    if (response.status === 204) return {} as T;
    const text = await response.text();
    if (!text.trim()) {
      if (response.status === 200) {
        throw new EmptyBodyAnomalyError();
      }
      return {} as T;
    }
    return JSON.parse(text) as T;
  }

  async getJson<T = unknown>(
    path: string,
    params: Record<string, string | number | undefined> = {},
    options: ConsultaGetOptions = {},
  ): Promise<{ status: number; body: T; elapsedMs: number }> {
    const url = this.buildUrl(path, params);
    const started = Date.now();
    const budget = options.budget ?? this.budget;

    const { status, body } = await withRetry(
      async () => {
        const timeoutMs = budget
          ? budget.attemptTimeoutMs(DEFAULT_FETCH_TIMEOUT_MS)
          : DEFAULT_FETCH_TIMEOUT_MS;
        if (timeoutMs <= 0) throw new BudgetExhaustedError();
        try {
          const res = await fetchWithTimeout(url, {
            headers: { Accept: "application/json" },
          }, timeoutMs);
          if (res.status === 429 || res.status >= 500) {
            await res.body?.cancel();
            const retryAfterMs = res.status === 429
              ? parseRetryAfterMs(res.headers.get("Retry-After"))
              : null;
            throw new RetryableHttpError(
              `PNCP consulta HTTP ${res.status}`,
              retryAfterMs,
            );
          }
          if (res.status >= 400) {
            await res.body?.cancel();
            throw new PermanentHttpError(`PNCP consulta HTTP ${res.status}`);
          }
          const parsed = await this.parseBody<T>(res);
          return { status: res.status, body: parsed };
        } catch (error) {
          if (error instanceof BudgetExhaustedError) throw error;
          if (
            error instanceof PermanentHttpError ||
            error instanceof RetryableHttpError
          ) {
            throw error;
          }
          if (
            (error instanceof DOMException &&
              (error.name === "TimeoutError" || error.name === "AbortError")) ||
            (error instanceof Error && /timeout/i.test(error.message))
          ) {
            throw new RetryableHttpError(
              `PNCP consulta timeout (${timeoutMs}ms)`,
              null,
            );
          }
          throw error;
        }
      },
      {
        budget,
        maxAttempts: 3,
        maxTimeoutRetries: 1,
        maxEmptyBodyRetries: 1,
        ...this.retryOverrides,
      },
    );

    return { status, body, elapsedMs: Date.now() - started };
  }

  extractList(body: unknown): unknown[] {
    if (Array.isArray(body)) return body;
    if (body && typeof body === "object") {
      const obj = body as Record<string, unknown>;
      for (const key of ["data", "content", "itens", "resultado"]) {
        if (Array.isArray(obj[key])) return obj[key] as unknown[];
      }
    }
    return [];
  }

  extractPagination(
    body: unknown,
    pagina: number,
  ): Omit<ConsultaPage<unknown>, "data" | "raw"> {
    const obj = (body && typeof body === "object" ? body : {}) as Record<
      string,
      unknown
    >;
    return {
      pagina: Number(obj.numeroPagina ?? obj.pagina ?? pagina),
      paginasRestantes: Number(obj.paginasRestantes ?? 0),
      totalRegistros: Number(obj.totalRegistros ?? 0),
    };
  }

  async fetchPcaPage(
    anoPca: number,
    pagina: number,
    codigoClassificacaoSuperior: string,
    tamanhoPagina?: number,
  ) {
    return this.getJson("/pca/", {
      anoPca,
      pagina,
      codigoClassificacaoSuperior,
      tamanhoPagina: clampConsultaPageSize("pca", tamanhoPagina),
    });
  }

  /** Probe barato: totalRegistros no escopo da classe (Fase 2 do plano PCA). */
  async probePcaClassificacao(
    anoPca: number,
    codigoClassificacaoSuperior: string,
  ) {
    const tamanhoPagina = clampConsultaPageSize("pca", 20);
    const result = await this.getJson("/pca/", {
      anoPca,
      pagina: 1,
      codigoClassificacaoSuperior,
      tamanhoPagina,
    });
    const pagination = this.extractPagination(result.body, 1);
    return {
      ...result,
      total_registros: pagination.totalRegistros,
      paginas_restantes: pagination.paginasRestantes,
    };
  }

  /**
   * Health-check leve antes de carga pesada.
   * GET /v1/atas janela 1 dia, tamanhoPagina=10.
   */
  async probePncpHealth(options: ConsultaGetOptions = {}): Promise<{
    status: "ok" | "PNCP_DEGRADADO";
    elapsedMs: number;
    detalhe?: string;
  }> {
    const end = new Date();
    const start = new Date(end);
    start.setUTCDate(start.getUTCDate() - 1);
    const started = Date.now();
    try {
      const result = await this.getJson("/atas", {
        dataInicial: formatPncpDate(start),
        dataFinal: formatPncpDate(end),
        pagina: 1,
        tamanhoPagina: 10,
      }, options);
      const elapsedMs = Date.now() - started;
      if (result.status >= 400 || elapsedMs > PNCP_HEALTH_SLOW_MS) {
        return {
          status: "PNCP_DEGRADADO",
          elapsedMs,
          detalhe: result.status >= 400
            ? `HTTP ${result.status}`
            : `slow ${elapsedMs}ms`,
        };
      }
      return { status: "ok", elapsedMs };
    } catch (error) {
      if (error instanceof BudgetExhaustedError) {
        throw error;
      }
      return {
        status: "PNCP_DEGRADADO",
        elapsedMs: Date.now() - started,
        detalhe: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async fetchContratacoesPublicacao(params: {
    dataInicial: string;
    dataFinal: string;
    codigoModalidadeContratacao: number;
    pagina: number;
    tamanhoPagina?: number;
  }) {
    const { tamanhoPagina, ...rest } = params;
    return this.getJson("/contratacoes/publicacao", {
      ...rest,
      tamanhoPagina: clampConsultaPageSize("contratacoes", tamanhoPagina),
    });
  }

  async fetchContratacoesAtualizacao(params: {
    dataInicial: string;
    dataFinal: string;
    codigoModalidadeContratacao: number;
    pagina: number;
    tamanhoPagina?: number;
  }) {
    const { tamanhoPagina, ...rest } = params;
    return this.getJson("/contratacoes/atualizacao", {
      ...rest,
      tamanhoPagina: clampConsultaPageSize("contratacoes", tamanhoPagina),
    });
  }

  async fetchContratacoesProposta(params: {
    dataFinal: string;
    codigoModalidadeContratacao: number;
    pagina: number;
    tamanhoPagina?: number;
  }) {
    const { tamanhoPagina, ...rest } = params;
    return this.getJson("/contratacoes/proposta", {
      ...rest,
      tamanhoPagina: clampConsultaPageSize("contratacoes", tamanhoPagina),
    });
  }

  async fetchInstrumentosCobrancaInclusao(params: {
    dataInicial: string;
    dataFinal: string;
    pagina: number;
    tamanhoPagina?: number;
  }) {
    const { tamanhoPagina, ...rest } = params;
    return this.getJson("/instrumentoscobranca/inclusao", {
      ...rest,
      tamanhoPagina: clampConsultaPageSize(
        "instrumentosCobranca",
        tamanhoPagina,
      ),
    });
  }

  async fetchAtas(params: {
    dataInicial: string;
    dataFinal: string;
    pagina: number;
    tamanhoPagina?: number;
  }) {
    const { tamanhoPagina, ...rest } = params;
    return this.getJson("/atas", {
      ...rest,
      tamanhoPagina: clampConsultaPageSize("atasContratos", tamanhoPagina),
    });
  }

  async fetchContratos(params: {
    dataInicial: string;
    dataFinal: string;
    pagina: number;
    tamanhoPagina?: number;
  }) {
    const { tamanhoPagina, ...rest } = params;
    return this.getJson("/contratos", {
      ...rest,
      tamanhoPagina: clampConsultaPageSize("atasContratos", tamanhoPagina),
    });
  }

  async fetchPcaAtualizacao(params: {
    dataInicio: string;
    dataFim: string;
    pagina: number;
    tamanhoPagina?: number;
    cnpj?: string;
    codigoUnidade?: string;
  }) {
    const { tamanhoPagina, ...rest } = params;
    return this.getJson("/pca/atualizacao", {
      ...rest,
      tamanhoPagina: clampConsultaPageSize("pca", tamanhoPagina),
    });
  }

  async fetchAtasAtualizacao(params: {
    dataInicial: string;
    dataFinal: string;
    pagina: number;
    tamanhoPagina?: number;
  }) {
    const { tamanhoPagina, ...rest } = params;
    return this.getJson("/atas/atualizacao", {
      ...rest,
      tamanhoPagina: clampConsultaPageSize("atasContratos", tamanhoPagina),
    });
  }

  async fetchContratosAtualizacao(params: {
    dataInicial: string;
    dataFinal: string;
    pagina: number;
    tamanhoPagina?: number;
  }) {
    const { tamanhoPagina, ...rest } = params;
    return this.getJson("/contratos/atualizacao", {
      ...rest,
      tamanhoPagina: clampConsultaPageSize("atasContratos", tamanhoPagina),
    });
  }
}

export function formatPncpDate(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}${m}${day}`;
}

export { BudgetExhaustedError, createRequestBudget };
