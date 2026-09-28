import { withRetry } from "./retry.ts";
import { UnifiedHttpClient } from "../http-client/index.ts";

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
