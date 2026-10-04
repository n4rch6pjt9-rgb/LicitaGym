import { fetchWithTimeout, PermanentHttpError, withRetry } from "../pncp/retry.ts";
import type { RequestBudget } from "../pncp/retry.ts";
import type { ComprasGovPage } from "./material-types.ts";
import { UnifiedHttpClient } from "../http-client/index.ts";

const BASE_URL = "https://dadosabertos.compras.gov.br";
/**
 * Swagger Dados Abertos: tamanhoPagina 10–500.
 * O sync CATMAT e a árvore usam 100 (regra do projeto). O teto 500 continua
 * disponível para quem passar o tamanho na chamada.
 */
export const COMPRAS_GOV_PAGE_SIZE = { min: 10, max: 500, default: 100 } as const;
const PAGE_DELAY_MS = 350;
const PDM_REQUEST_DELAY_MS = 250;

export type MaterialListParams = Record<string, string | number | boolean | undefined>;

export function clampComprasGovPageSize(tamanhoPagina?: number): number {
  const { min, max, default: fallback } = COMPRAS_GOV_PAGE_SIZE;
  const size = tamanhoPagina ?? fallback;
  return Math.max(min, Math.min(size, max));
}

function buildUrl(path: string, params: MaterialListParams): string {
  const url = new URL(path, BASE_URL);
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") continue;
    url.searchParams.set(key, String(value));
  }
  return url.toString();
}

async function fetchPage<T>(path: string, params: MaterialListParams): Promise<{
  status: number;
  body: ComprasGovPage<T>;
  elapsedMs: number;
}> {
  const url = buildUrl(path, params);
  const started = Date.now();
  const response = await withRetry(async () => {
    try {
      const res = await fetchWithTimeout(url, {
        headers: { Accept: "application/json" },
      }, 60_000);
      if (res.status === 429 || res.status >= 500) {
        await res.body?.cancel();
        throw new Error(`Compras.gov HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ""}`);
      }
      if (res.status >= 400 && res.status < 500) {
        await res.body?.cancel();
        throw new PermanentHttpError(
          `Compras.gov HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ""}`,
        );
      }
      if (!res.ok) {
        await res.body?.cancel();
        throw new Error(`Compras.gov HTTP ${res.status}`);
      }
      return res;
    } catch (error) {
      if (error instanceof DOMException && error.name === "TimeoutError") {
        throw new Error("Compras.gov timeout (60s)");
      }
      throw error;
    }
  }, 6, 2_500);
  const text = await response.text();
  const body = text.trim() ? JSON.parse(text) as ComprasGovPage<T> : {
    resultado: [],
    totalRegistros: 0,
    totalPaginas: 0,
    paginasRestantes: 0,
  };
  return { status: response.status, body, elapsedMs: Date.now() - started };
}

export type ComprasGovFetchOptions = {
  syncRunId?: string;
  onHeartbeat?: () => Promise<void>;
  budget?: RequestBudget;
};

/** HTTP 200 com JSON que não é página do Compras.gov. Não é lista vazia. */
export class EnvelopeComprasGovInvalidoError extends Error {
  constructor(path: string) {
    super(`Envelope Compras.gov inválido em ${path}`);
    this.name = "EnvelopeComprasGovInvalidoError";
  }
}

/**
 * `resultado` tem de ser array e `paginasRestantes` número.
 * `{}` (corpo vazio no getJson) não vira zero itens.
 */
export function exigirEnvelopeComprasGov(body: unknown, path: string): void {
  if (!body || typeof body !== "object") throw new EnvelopeComprasGovInvalidoError(path);
  const page = body as { resultado?: unknown; paginasRestantes?: unknown };
  if (!Array.isArray(page.resultado)) throw new EnvelopeComprasGovInvalidoError(path);
  if (typeof page.paginasRestantes !== "number" || !Number.isFinite(page.paginasRestantes)) {
    throw new EnvelopeComprasGovInvalidoError(path);
  }
}

export class ComprasGovMaterialClient {
  private httpClient?: UnifiedHttpClient;

  constructor(httpClient?: UnifiedHttpClient) {
    this.httpClient = httpClient;
  }

  withHttpClient(client: UnifiedHttpClient): this {
    this.httpClient = client;
    return this;
  }

  async fetchPage<T>(
    path: string,
    params: MaterialListParams,
    options?: ComprasGovFetchOptions,
  ): Promise<{
    status: number;
    body: ComprasGovPage<T>;
    elapsedMs: number;
  }> {
    if (this.httpClient) {
      const url = buildUrl(path, params);
      return this.httpClient.getJson<ComprasGovPage<T>>(url, {
        headers: { Accept: "application/json" },
      }, {
        budget: options?.budget,
        syncRunId: options?.syncRunId,
        endpoint: path,
        parametros: params,
        onHeartbeat: options?.onHeartbeat,
      });
    }
    return fetchPage<T>(path, params);
  }

  async fetchAllPages<T>(
    path: string,
    baseParams: MaterialListParams,
    options?: { maxPaginas?: number; paginaInicial?: number; tamanhoPagina?: number } & ComprasGovFetchOptions,
  ): Promise<{ pages: ComprasGovPage<T>[]; items: T[] }> {
    const maxPaginas = options?.maxPaginas ?? 500;
    const paginaInicial = options?.paginaInicial ?? 1;
    const tamanhoPagina = clampComprasGovPageSize(options?.tamanhoPagina);
    const pages: ComprasGovPage<T>[] = [];
    const items: T[] = [];
    let pagina = paginaInicial;
    let paginasRestantes = 1;

    while (paginasRestantes > 0 && pagina < paginaInicial + maxPaginas) {
      const { body } = await this.fetchPage<T>(path, {
        ...baseParams,
        pagina,
        tamanhoPagina,
      }, options);
      exigirEnvelopeComprasGov(body, path);
      pages.push(body);
      items.push(...body.resultado);
      paginasRestantes = body.paginasRestantes;
      if (body.resultado.length === 0) break;
      pagina++;
      if (paginasRestantes > 0) {
        if (options?.onHeartbeat) await options.onHeartbeat();
        await new Promise((r) => setTimeout(r, PAGE_DELAY_MS));
      }
    }

    return { pages, items };
  }

  consultarGrupoMaterial(params: MaterialListParams, options?: ComprasGovFetchOptions) {
    return this.fetchPage("/modulo-material/1_consultarGrupoMaterial", params, options);
  }

  consultarClasseMaterial(params: MaterialListParams, options?: ComprasGovFetchOptions) {
    return this.fetchPage("/modulo-material/2_consultarClasseMaterial", params, options);
  }

  fetchPdms(params: MaterialListParams, options?: { maxPaginas?: number; tamanhoPagina?: number } & ComprasGovFetchOptions) {
    return this.fetchAllPages("/modulo-material/3_consultarPdmMaterial", params, options);
  }

  fetchItens(params: MaterialListParams, options?: { maxPaginas?: number; tamanhoPagina?: number } & ComprasGovFetchOptions) {
    return this.fetchAllPages("/modulo-material/4_consultarItemMaterial", params, options);
  }

  async fetchNaturezasDespesa(codigoPdm: number, options?: { maxPaginas?: number; tamanhoPagina?: number } & ComprasGovFetchOptions) {
    await new Promise((r) => setTimeout(r, PDM_REQUEST_DELAY_MS));
    return await this.fetchAllPages("/modulo-material/5_consultarMaterialNaturezaDespesa", {
      codigoPdm,
    }, options);
  }

  async fetchUnidadesFornecimento(codigoPdm: number, options?: { maxPaginas?: number; tamanhoPagina?: number } & ComprasGovFetchOptions) {
    await new Promise((r) => setTimeout(r, PDM_REQUEST_DELAY_MS));
    return await this.fetchAllPages("/modulo-material/6_consultarMaterialUnidadeFornecimento", {
      codigoPdm,
    }, options);
  }

  async fetchCaracteristicas(codigoItem: number, options?: { maxPaginas?: number } & ComprasGovFetchOptions) {
    await new Promise((r) => setTimeout(r, PDM_REQUEST_DELAY_MS));
    return await this.fetchAllPages("/modulo-material/7_consultarMaterialCaracteristicas", {
      codigoItem,
    }, options);
  }
}
