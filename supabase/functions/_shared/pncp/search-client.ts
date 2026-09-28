import {
  BudgetExhaustedError,
  DEFAULT_FETCH_TIMEOUT_MS,
  fetchWithTimeout,
  parseRetryAfterMs,
  PermanentHttpError,
  type RequestBudget,
  RetryableHttpError,
  withRetry,
} from "./retry.ts";
import { UnifiedHttpClient } from "../http-client/index.ts";

const DEFAULT_SEARCH_BASE = "https://pncp.gov.br/api/search";

export type PcaOrgaoSearchItem = {
  orgao_cnpj?: string;
  orgao_nome?: string;
  ano?: string;
  item_url?: string;
  data_publicacao_pncp?: string;
  data_atualizacao_pncp?: string;
  valor_global?: number;
};

export type PcaSearchPeriodSummary = {
  ano: number;
  total_indexado: number;
  amostra: number;
  max_data_atualizacao: string | null;
  /** Mínimo dentro da amostra (não da base inteira). */
  min_data_publicacao_amostra: string | null;
  max_data_publicacao: string | null;
  orgaos_amostra: Array<{
    orgao_cnpj: string;
    orgao_nome: string;
    data_publicacao_pncp: string | null;
    data_atualizacao_pncp: string | null;
  }>;
};

/** PNCP devolve timestamps naive; tratar como UTC. */
export function parsePncpTimestamp(value: string | undefined): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  const hasOffset = /(?:Z|[+-]\d{2}:?\d{2})$/.test(trimmed);
  const normalized = hasOffset ? trimmed : `${trimmed}Z`;
  const t = Date.parse(normalized);
  return Number.isFinite(t) ? t : null;
}

function parseTs(value: string | undefined): number | null {
  return parsePncpTimestamp(value);
}

export class PncpSearchClient {
  private budget: RequestBudget | undefined;
  private httpClient?: UnifiedHttpClient;

  constructor(
    private baseUrl = Deno.env.get("PNCP_SEARCH_BASE") ?? DEFAULT_SEARCH_BASE,
    httpClient?: UnifiedHttpClient,
  ) {
    this.httpClient = httpClient;
  }

  withHttpClient(client: UnifiedHttpClient): this {
    this.httpClient = client;
    return this;
  }

  withBudget(budget: RequestBudget): this {
    this.budget = budget;
    return this;
  }

  clearBudget(): this {
    this.budget = undefined;
    return this;
  }

  async fetchPcaOrgaoPage(params: {
    pagina?: number;
    tamPagina?: number;
    ano?: number;
  }): Promise<{ items: PcaOrgaoSearchItem[]; total: number }> {
    const url = new URL(this.baseUrl);
    url.searchParams.set("q", "");
    url.searchParams.set("tipos_documento", "pcaorgao");
    url.searchParams.set("pagina", String(params.pagina ?? 1));
    url.searchParams.set("tam_pagina", String(params.tamPagina ?? 50));
    url.searchParams.set("ordenacao", "-data");
    if (params.ano) url.searchParams.set("anos", String(params.ano));

    if (this.httpClient) {
      const res = await this.httpClient.getJson<{ items?: PcaOrgaoSearchItem[]; total?: number }>(
        url,
        { headers: { Accept: "application/json" } },
        {
          budget: this.budget,
          endpoint: "/api/search",
          parametros: params,
        },
      );
      return {
        items: res.body.items ?? [],
        total: Number(res.body.total ?? 0),
      };
    }

    return await withRetry(
      async () => {
        const timeoutMs = this.budget
          ? this.budget.attemptTimeoutMs(DEFAULT_FETCH_TIMEOUT_MS)
          : DEFAULT_FETCH_TIMEOUT_MS;
        if (timeoutMs <= 0) throw new BudgetExhaustedError();
        try {
          const res = await fetchWithTimeout(url, {
            headers: { Accept: "application/json" },
          }, timeoutMs);
          if (res.status === 429 || res.status >= 500) {
            const retryAfterMs = res.status === 429
              ? parseRetryAfterMs(res.headers.get("Retry-After"))
              : null;
            throw new RetryableHttpError(
              `PNCP search HTTP ${res.status}`,
              retryAfterMs,
            );
          }
          if (!res.ok) {
            throw new PermanentHttpError(`PNCP search HTTP ${res.status}`);
          }
          const body = await res.json() as {
            items?: PcaOrgaoSearchItem[];
            total?: number;
          };
          return {
            items: body.items ?? [],
            total: Number(body.total ?? 0),
          };
        } catch (error) {
          if (error instanceof BudgetExhaustedError) throw error;
          if (error instanceof PermanentHttpError) throw error;
          if (error instanceof RetryableHttpError) throw error;
          if (
            (error instanceof DOMException &&
              (error.name === "TimeoutError" || error.name === "AbortError")) ||
            (error instanceof Error && /timeout/i.test(error.message))
          ) {
            throw new RetryableHttpError(
              `PNCP search timeout (${timeoutMs}ms)`,
              null,
            );
          }
          throw error;
        }
      },
      {
        budget: this.budget,
        maxAttempts: 3,
        // Timeout ≤ 1 retry only when a request budget is bound.
        maxTimeoutRetries: this.budget ? 1 : undefined,
      },
    );
  }

  /** Resume datas do índice Search — barato, ideal para decidir se roda carga anual. */
  async summarizePcaPeriod(
    ano: number,
    tamPagina = 50,
  ): Promise<PcaSearchPeriodSummary> {
    const { items, total } = await this.fetchPcaOrgaoPage({ ano, tamPagina });

    let maxAtualizacao: string | null = null;
    let maxAtualizacaoTs = -Infinity;
    let minPublicacao: string | null = null;
    let minPublicacaoTs = Infinity;
    let maxPublicacao: string | null = null;
    let maxPublicacaoTs = -Infinity;

    for (const item of items) {
      const atualTs = parseTs(item.data_atualizacao_pncp);
      if (atualTs !== null && atualTs > maxAtualizacaoTs) {
        maxAtualizacaoTs = atualTs;
        maxAtualizacao = item.data_atualizacao_pncp ?? null;
      }
      const pubTs = parseTs(item.data_publicacao_pncp);
      if (pubTs !== null && pubTs < minPublicacaoTs) {
        minPublicacaoTs = pubTs;
        minPublicacao = item.data_publicacao_pncp ?? null;
      }
      if (pubTs !== null && pubTs > maxPublicacaoTs) {
        maxPublicacaoTs = pubTs;
        maxPublicacao = item.data_publicacao_pncp ?? null;
      }
    }

    if (
      items.length > 0 &&
      maxAtualizacao &&
      items[0].data_atualizacao_pncp &&
      items[0].data_atualizacao_pncp !== maxAtualizacao
    ) {
      throw new Error(
        "ordenacao_inesperada: Search pcaorgao não ordenado por data_atualizacao",
      );
    }

    return {
      ano,
      total_indexado: total,
      amostra: items.length,
      max_data_atualizacao: maxAtualizacao,
      min_data_publicacao_amostra: minPublicacao,
      max_data_publicacao: maxPublicacao,
      orgaos_amostra: items.slice(0, 10).map((item) => ({
        orgao_cnpj: item.orgao_cnpj ?? "",
        orgao_nome: item.orgao_nome ?? "",
        data_publicacao_pncp: item.data_publicacao_pncp ?? null,
        data_atualizacao_pncp: item.data_atualizacao_pncp ?? null,
      })),
    };
  }
}
