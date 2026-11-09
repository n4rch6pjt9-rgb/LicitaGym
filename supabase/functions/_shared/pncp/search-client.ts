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

/** Item do índice de busca (`/api/search/`). Campos em snake_case; ver docs/pncp/schemas-consultas-pncp.md, seção 6. */
export type BuscaPncpItem = Record<string, unknown> & { numero_controle_pncp?: unknown };

/** Detalhe da oportunidade (caminho interativo): 2 tentativas só para queda de conexão, 5 s cada (spec 0049). */
export const BUSCA_DETALHE = { tentativas: 2, attemptTimeoutMs: 5_000 } as const;
const BUSCA_EDITAL_TAM_PAGINA = 10;
/** Janela da busca: pagina × tam_pagina ≤ 10000; 500 é o maior valor sem ganho medido acima. */
const BUSCA_ATA_TAM_PAGINA = 500;
const CONTROLE_PNCP_RE = /^\d{14}-\d+-\d+\/\d{4}$/;

/** `{ total, items[] }`; items não-array, item não-objeto ou total acima da página lançam (erro não é vazio). */
function envelopeDaBusca(body: unknown, tamPagina: number): BuscaPncpItem[] {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("Busca PNCP: envelope inesperado");
  }
  const { items, total } = body as { items?: unknown; total?: unknown };
  if (!Array.isArray(items) || items.some((it) => !it || typeof it !== "object" || Array.isArray(it))) {
    throw new Error("Busca PNCP: envelope sem lista de itens");
  }
  const totalN = Number(total);
  if (!Number.isFinite(totalN)) throw new Error("Busca PNCP: envelope sem total");
  if (totalN > items.length) {
    throw new Error(`Busca PNCP: ${totalN} resultados, só ${items.length} na página de ${tamPagina}`);
  }
  return items as BuscaPncpItem[];
}

/** Conexão derrubada sem resposta HTTP (TypeError do fetch). HTTP, timeout e erro de envelope não contam. */
function quedaDeConexao(err: unknown): boolean {
  if (err instanceof RetryableHttpError || err instanceof PermanentHttpError || err instanceof BudgetExhaustedError) {
    return false;
  }
  if (!(err instanceof Error)) return false;
  if (/timeout|aborted/i.test(err.message)) return false;
  return err instanceof TypeError || /connection|conex|reset|closed/i.test(err.message);
}

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

  /**
   * Edital da compra no índice de busca (spec 0049, K-1), casado pelo `numero_controle_pncp` exato. `null` = a busca
   * respondeu e não há edital com esse controle. Falha (HTTP, envelope, conexão) lança: erro não é vazio.
   */
  async buscarCompraPorControle(controle: string): Promise<BuscaPncpItem | null> {
    const items = await this.buscarPorControle(controle, "edital", BUSCA_EDITAL_TAM_PAGINA);
    return items.find((it) => it.numero_controle_pncp === controle) ?? null;
  }

  /**
   * Atas da compra no índice de busca: itens `ata` cujo controle é `{controle da compra}-{seqAta}`. Lista vazia = a
   * busca respondeu sem ata. `total` acima do que veio na página lança (lista cortada não parece completa).
   */
  async buscarAtasDaCompra(controle: string): Promise<BuscaPncpItem[]> {
    const items = await this.buscarPorControle(controle, "ata", BUSCA_ATA_TAM_PAGINA);
    return items.filter((it) => typeof it.numero_controle_pncp === "string" && it.numero_controle_pncp.startsWith(`${controle}-`));
  }

  /**
   * GET /api/search/?q="<controle>" (frase exata; sem aspas o texto é tokenizado e traz outras compras). Até
   * BUSCA_DETALHE.tentativas só para queda de conexão sem HTTP (medido em 09/11/2026: ~63 % das conexões caem e a
   * mesma URL responde na tentativa seguinte). HTTP 5xx/4xx não repete: o detalhe é caminho interativo e o host passa
   * pelo lease de pncp.gov.br, compartilhado com os coletores.
   */
  private async buscarPorControle(
    controle: string,
    tipo: "edital" | "ata",
    tamPagina: number,
  ): Promise<BuscaPncpItem[]> {
    if (!CONTROLE_PNCP_RE.test(controle)) {
      throw new Error("Número de controle PNCP fora do formato para a busca");
    }
    if (!this.httpClient) {
      throw new Error("PncpSearchClient sem httpClient: a busca do detalhe passa pelo lease do host");
    }
    const url = new URL(this.baseUrl.endsWith("/") ? this.baseUrl : `${this.baseUrl}/`);
    url.searchParams.set("q", `"${controle}"`);
    url.searchParams.set("tipos_documento", tipo);
    url.searchParams.set("ordenacao", "-data");
    url.searchParams.set("pagina", "1");
    url.searchParams.set("tam_pagina", String(tamPagina));

    let ultimoErro: unknown;
    for (let tentativa = 1; tentativa <= BUSCA_DETALHE.tentativas; tentativa++) {
      try {
        const res = await this.httpClient.getJson<unknown>(url, { headers: { Accept: "application/json" } }, {
          endpoint: "/api/search/",
          parametros: { tipos_documento: tipo },
          maxAttempts: 1,
          attemptTimeoutMs: BUSCA_DETALHE.attemptTimeoutMs,
        });
        return envelopeDaBusca(res.body, tamPagina);
      } catch (err) {
        ultimoErro = err;
        if (!quedaDeConexao(err)) throw err;
      }
    }
    throw ultimoErro;
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
