import { withRetry, fetchWithTimeout } from "./retry.ts";

const DEFAULT_BASE = "https://pncp.gov.br/api/pncp/v1";

/** Cliente API integração — NÃO inclui /usuarios (CLA-40). */
export class PncpIntegracaoClient {
  constructor(private baseUrl = Deno.env.get("PNCP_INTEGRACAO_BASE") ?? DEFAULT_BASE) {}

  private headers(): Record<string, string> {
    const headers: Record<string, string> = { Accept: "application/json" };
    const token = Deno.env.get("PNCP_INTEGRACAO_TOKEN")?.trim();
    if (token) headers.Authorization = `Bearer ${token}`;
    return headers;
  }

  async getJson<T = unknown>(path: string): Promise<T> {
    const url = `${this.baseUrl.replace(/\/+$/, "")}${path}`;
    const response = await withRetry(async () => {
      const res = await fetchWithTimeout(url, { headers: this.headers() }, 20_000);
      if (res.status === 429 || res.status >= 500) {
        throw new Error(`PNCP integração HTTP ${res.status}`);
      }
      return res;
    }, 2, 800);
    if (!response.ok) {
      const body = await response.text();
      throw new Error(
        `PNCP integração HTTP ${response.status} ${path}: ${body.slice(0, 200)}`,
      );
    }
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

  /**
   * Itens da compra/edital (Integração).
   * Probe 2026-09-20: Consulta `/orgaos/.../compras/.../itens` = 404;
   * Integração `GET /orgaos/{cnpj}/compras/{ano}/{seq}/itens` = 200 (array).
   * `catalogoCodigoItem` pode vir null — ainda assim persiste descrição/qtd/valor.
   */
  async getCompraItens(
    cnpj: string,
    ano: number,
    sequencial: number,
    pagina = 1,
    tamanhoPagina = 50,
  ): Promise<unknown> {
    const params = new URLSearchParams({
      pagina: String(pagina),
      tamanhoPagina: String(tamanhoPagina),
    });
    return this.getJson(
      `/orgaos/${normalizeIntegracaoCnpj(cnpj)}/compras/${ano}/${sequencial}/itens?${params}`,
    );
  }
}

function normalizeIntegracaoCnpj(cnpj: string): string {
  return cnpj.replace(/\D/g, "");
}
