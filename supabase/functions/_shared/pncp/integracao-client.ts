import { withRetry } from "./retry.ts";
import { type UnifiedFetchOptions, UnifiedHttpClient } from "../http-client/index.ts";

const DEFAULT_BASE = "https://pncp.gov.br/api/pncp/v1";

/** Cliente API integração — NÃO inclui /usuarios (CLA-40). */
export class PncpIntegracaoClient {
  private httpClient?: UnifiedHttpClient;

  constructor(
    private baseUrl = Deno.env.get("PNCP_INTEGRACAO_BASE") ?? DEFAULT_BASE,
    httpClient?: UnifiedHttpClient,
  ) {
    this.httpClient = httpClient;
  }

  withHttpClient(client: UnifiedHttpClient): this {
    this.httpClient = client;
    return this;
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = { Accept: "application/json" };
    const token = Deno.env.get("PNCP_INTEGRACAO_TOKEN")?.trim();
    if (token) headers.Authorization = `Bearer ${token}`;
    return headers;
  }

  async getJson<T = unknown>(path: string): Promise<T> {
    const url = `${this.baseUrl.replace(/\/+$/, "")}${path}`;
    if (this.httpClient) {
      const res = await this.httpClient.getJson<T>(url, { headers: this.headers() }, {
        endpoint: path,
      });
      return res.body;
    }
    const response = await withRetry(async () => {
      const res = await fetch(url, { headers: this.headers() });
      if (res.status === 429 || res.status >= 500) {
        throw new Error(`PNCP integração HTTP ${res.status}`);
      }
      return res;
    });
    return (await response.json()) as T;
  }

  /**
   * GET com status: 204 e 404 chegam a quem chama (getJson perde o status e devolve {} no 204).
   * `options` vai para o UnifiedHttpClient (orçamento, timeout por tentativa, telemetria por syncRunId).
   */
  async getJsonComStatus<T = unknown>(
    path: string,
    options: UnifiedFetchOptions = {},
  ): Promise<{ status: number; body: T | null }> {
    const url = `${this.baseUrl.replace(/\/+$/, "")}${path}`;
    if (this.httpClient) {
      const res = await this.httpClient.getJson<T>(url, { headers: this.headers() }, {
        endpoint: path,
        devolver4xx: true,
        ...options,
      });
      return { status: res.status, body: res.status === 204 ? null : res.body };
    }
    const response = await withRetry(async () => {
      const res = await fetch(url, { headers: this.headers() });
      if (res.status === 429 || res.status >= 500) {
        throw new Error(`PNCP integração HTTP ${res.status}`);
      }
      return res;
    });
    if (response.status === 204) return { status: 204, body: null };
    const text = await response.text();
    if (!text.trim()) return { status: response.status, body: {} as T };
    try {
      return { status: response.status, body: JSON.parse(text) as T };
    } catch (error) {
      if (response.status < 400) throw error;
      return { status: response.status, body: text as T };
    }
  }

  /** Página de itens do plano, com status (spec 0012: 204 = fim, não erro). */
  async getPcaItensPagina(
    cnpj: string,
    ano: number,
    sequencial: number,
    pagina: number,
    tamanhoPagina: number,
    options: UnifiedFetchOptions = {},
  ) {
    const params = new URLSearchParams({ pagina: String(pagina), tamanhoPagina: String(tamanhoPagina) });
    return this.getJsonComStatus(
      `/orgaos/${normalizeIntegracaoCnpj(cnpj)}/pca/${ano}/${sequencial}/itens?${params}`,
      { ...options, pagina },
    );
  }

  /** Quantidade de itens do plano (todas as categorias): confere que a leitura paginada não foi truncada. */
  async getPcaItensQuantidade(cnpj: string, ano: number, sequencial: number, options: UnifiedFetchOptions = {}) {
    return this.getJsonComStatus(
      `/orgaos/${normalizeIntegracaoCnpj(cnpj)}/pca/${ano}/${sequencial}/itens/quantidade`,
      options,
    );
  }

  async getOrgao(cnpj: string) {
    return this.getJson(`/orgaos/${cnpj}`);
  }

  async getCatalogos() {
    return this.getJson("/catalogos");
  }

  async getCategoriaItemPcas() {
    return this.getJson("/categoriaItemPcas");
  }

  async getIrp(cnpj: string, ano: number, sequencial: number) {
    return this.getJson(`/orgaos/${cnpj}/irp/${ano}/${sequencial}`);
  }

  async getPca(cnpj: string, ano: number, sequencial: number) {
    return this.getJson(`/orgaos/${normalizeIntegracaoCnpj(cnpj)}/pca/${ano}/${sequencial}`);
  }

  async getPcaItens(
    cnpj: string,
    ano: number,
    sequencial: number,
    pagina = 1,
    tamanhoPagina = 50,
  ) {
    const params = new URLSearchParams({
      pagina: String(pagina),
      tamanhoPagina: String(tamanhoPagina),
    });
    return this.getJson(
      `/orgaos/${normalizeIntegracaoCnpj(cnpj)}/pca/${ano}/${sequencial}/itens?${params}`,
    );
  }
}

function normalizeIntegracaoCnpj(cnpj: string): string {
  return cnpj.replace(/\D/g, "");
}
