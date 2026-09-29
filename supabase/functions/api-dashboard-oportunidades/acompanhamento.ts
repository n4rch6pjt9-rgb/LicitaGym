import { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { errorDetail, jsonResponse } from "../_shared/http.ts";
import { buildEditalUrl, buildPncpEditalUrl } from "../_shared/edital-url.ts";
import { UnifiedHttpClient } from "../_shared/http-client/index.ts";
import type {
  AcompanhamentoActionParams,
  AcompanhamentoResponse,
  AcompanhamentoSection,
  ArquivoAcompanhamento,
  AtaAcompanhamento,
  CompraMetadata,
  HistoricoEvento,
  ItemAcompanhamento,
  ItemResultado,
} from "./types.ts";

export interface DashboardOportunidadesClientContext {
  getClient?: () => SupabaseClient;
  requireAuth?: (req: Request) => Promise<Response | null> | Response | null;
  httpClient?: UnifiedHttpClient;
}

export interface PncpKey {
  cnpj: string;
  ano: number;
  sequencial: number;
  numeroControlePncp?: string;
}

const PNCP_CONTROLE_EXTENDED_RE = /^(\d{14})-(\d+)-(\d+)\/(\d{4})$/;
const PNCP_CONTROLE_SIMPLE_RE = /^(\d{14})-(\d+)\/(\d{4})$/;

/**
 * Resolve a chave PNCP (cnpj, ano, sequencial) a partir dos dados da linha.
 * Prioriza colunas existentes (numero_controle_pncp, codigo_externo, id_externo),
 * e como fallback avalia campos em `raw` server-side, sem nunca expor `raw` ao cliente.
 */
export function resolvePncpKey(row: Record<string, unknown> | null | undefined): PncpKey | null {
  if (!row || typeof row !== "object") return null;

  const raw = (row.raw && typeof row.raw === "object") ? (row.raw as Record<string, unknown>) : {};
  const fonte = String(row.fonte ?? raw.fonte ?? "").trim().toLowerCase();

  // Candidatos a identificador de controle PNCP
  const controleCandidates = [
    row.numero_controle_pncp,
    row.codigo_externo,
    row.id_externo,
    raw.numero_controle_pncp,
    raw.numeroControlePNCP,
    raw.numeroControlePncp,
    raw.numeroControlePNCPCompra,
    raw.numeroControlePncpCompra,
  ];

  for (const cand of controleCandidates) {
    if (cand === undefined || cand === null) continue;
    const val = String(cand).trim();

    const mExt = val.match(PNCP_CONTROLE_EXTENDED_RE);
    if (mExt) {
      const cnpj = mExt[1];
      const seq = parseInt(mExt[3], 10);
      const ano = parseInt(mExt[4], 10);
      if (cnpj.length === 14 && ano > 1900 && seq > 0) {
        return { cnpj, ano, sequencial: seq, numeroControlePncp: val };
      }
    }

    const mSim = val.match(PNCP_CONTROLE_SIMPLE_RE);
    if (mSim) {
      const cnpj = mSim[1];
      const seq = parseInt(mSim[2], 10);
      const ano = parseInt(mSim[3], 10);
      if (cnpj.length === 14 && ano > 1900 && seq > 0) {
        return { cnpj, ano, sequencial: seq, numeroControlePncp: val };
      }
    }
  }

  // Fallback: busca por campos separados de CNPJ, ano e sequencial
  const cnpjCandidate = row.orgao_cnpj ?? raw.orgao_cnpj ?? raw.cnpjOrgao ??
    (raw.orgaoEntidade as Record<string, unknown>)?.cnpj;
  const cnpjClean = String(cnpjCandidate ?? "").replace(/\D/g, "");

  const anoCandidate = raw.ano ?? raw.anoCompra;
  const anoNum = Number(anoCandidate);

  const seqCandidate = raw.numero_sequencial ?? raw.sequencial ?? raw.sequencialCompra;
  const seqNum = Number(seqCandidate);

  if (cnpjClean.length === 14 && Number.isInteger(anoNum) && anoNum > 1900 && Number.isInteger(seqNum) && seqNum > 0) {
    return {
      cnpj: cnpjClean,
      ano: anoNum,
      sequencial: seqNum,
      numeroControlePncp: `${cnpjClean}-1-${String(seqNum).padStart(6, "0")}/${anoNum}`,
    };
  }

  // Se a fonte for declarada explicitamente como não-PNCP (ex: sestsenat, comprasnet, etc) e não tem chave PNCP
  if (fonte && fonte !== "pncp") {
    return null;
  }

  return null;
}

/**
 * Constrói a url_acompanhamento para o Comprasnet a partir de linkSistemaOrigem.
 * Revalida: protocolo https, host exato cnetmobile.estaleiro.serpro.gov.br e
 * parâmetro compra com exatamente 17 dígitos (UASG 6 + Mod 2 + Num 5 + Ano 4).
 */
export function buildAcompanhamentoUrl(linkSistemaOrigem: unknown): string | null {
  if (typeof linkSistemaOrigem !== "string") return null;
  const trimmed = linkSistemaOrigem.trim();
  if (!trimmed.toLowerCase().startsWith("https://")) return null;

  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "https:") return null;
    const hostname = parsed.hostname.toLowerCase();
    if (hostname !== "cnetmobile.estaleiro.serpro.gov.br") return null;

    const idCompra = parsed.searchParams.get("compra");
    if (!idCompra || !/^\d{17}$/.test(idCompra.trim())) return null;

    return `https://cnetmobile.estaleiro.serpro.gov.br/comprasnet-web/public/landing?destino=acompanhamento-compra&compra=${idCompra.trim()}`;
  } catch {
    return null;
  }
}

// -----------------------------------------------------------------------------
// Cache em memória (TTL de 5 minutos)
// -----------------------------------------------------------------------------

interface CacheEntry {
  expiresAt: number;
  data: AcompanhamentoResponse;
}

const acompanhamentoCache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_CACHE_ENTRIES = 200;

export function getCachedAcompanhamento(key: string): AcompanhamentoResponse | null {
  const entry = acompanhamentoCache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    acompanhamentoCache.delete(key);
    return null;
  }
  return entry.data;
}

export function setCachedAcompanhamento(key: string, data: AcompanhamentoResponse): void {
  if (acompanhamentoCache.size >= MAX_CACHE_ENTRIES) {
    const now = Date.now();
    for (const [k, v] of acompanhamentoCache.entries()) {
      if (now > v.expiresAt) acompanhamentoCache.delete(k);
    }
    if (acompanhamentoCache.size >= MAX_CACHE_ENTRIES) {
      const firstKey = acompanhamentoCache.keys().next().value;
      if (firstKey) acompanhamentoCache.delete(firstKey);
    }
  }
  acompanhamentoCache.set(key, {
    expiresAt: Date.now() + CACHE_TTL_MS,
    data,
  });
}

export function clearAcompanhamentoCache(): void {
  acompanhamentoCache.clear();
}

/**
 * Concorrência limitada para execução paralela de tarefas assíncronas.
 */
async function mapConcurrent<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let index = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (index < items.length) {
      const i = index++;
      results[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return results;
}

// -----------------------------------------------------------------------------
// Clientes e Normalizadores de Endpoints PNCP
// -----------------------------------------------------------------------------

async function fetchCompraMetadata(
  httpClient: UnifiedHttpClient,
  cnpj: string,
  ano: number,
  seq: number,
): Promise<AcompanhamentoSection<CompraMetadata>> {
  const url = `https://pncp.gov.br/api/consulta/v1/orgaos/${cnpj}/compras/${ano}/${seq}`;
  try {
    const res = await httpClient.getJson<Record<string, unknown>>(url, {
      headers: { Accept: "application/json" },
    }, {
      endpoint: "/api/consulta/v1/orgaos/{cnpj}/compras/{ano}/{seq}",
      attemptTimeoutMs: 20_000,
    });

    if (res.status === 204 || !res.body || typeof res.body !== "object") {
      return { dados: null, erro: "Compra não encontrada no PNCP" };
    }

    const b = res.body;
    const metadata: CompraMetadata = {
      situacao: (b.situacaoCompraNome as string) ?? null,
      situacaoCompraId: typeof b.situacaoCompraId === "number" ? b.situacaoCompraId : null,
      modalidade: (b.modalidadeNome as string) ?? null,
      modalidadeId: typeof b.modalidadeId === "number" ? b.modalidadeId : null,
      objeto: (b.objetoCompra as string) ?? (b.objeto as string) ?? null,
      valorEstimado: typeof b.valorTotalEstimado === "number"
        ? b.valorTotalEstimado
        : (b.valorTotalEstimado ? Number(b.valorTotalEstimado) : null),
      valorHomologado: typeof b.valorTotalHomologado === "number"
        ? b.valorTotalHomologado
        : (b.valorTotalHomologado ? Number(b.valorTotalHomologado) : null),
      datas: {
        publicacao: (b.dataPublicacaoPncp as string) ?? null,
        aberturaProposta: (b.dataAberturaProposta as string) ?? null,
        encerramentoProposta: (b.dataEncerramentoProposta as string) ?? null,
        inclusao: (b.dataInclusao as string) ?? null,
        atualizacao: (b.dataAtualizacaoGlobal as string) ?? (b.dataAtualizacao as string) ?? null,
      },
      linkSistemaOrigem: (b.linkSistemaOrigem as string) ?? null,
      numeroCompra: (b.numeroCompra as string) ?? null,
      processo: (b.processo as string) ?? null,
      srp: typeof b.srp === "boolean" ? b.srp : null,
      existeResultado: typeof b.existeResultado === "boolean" ? b.existeResultado : null,
      orgaoEntidade: b.orgaoEntidade ?? null,
      unidadeOrgao: b.unidadeOrgao ?? null,
    };

    return { dados: metadata, erro: null };
  } catch (err: unknown) {
    return { dados: null, erro: errorDetail(err) };
  }
}

async function fetchItensComResultados(
  httpClient: UnifiedHttpClient,
  cnpj: string,
  ano: number,
  seq: number,
): Promise<AcompanhamentoSection<ItemAcompanhamento[]> & { total: number }> {
  const allItems: ItemAcompanhamento[] = [];
  const tamanhoPagina = 50;
  let pagina = 1;
  const maxPaginas = 30;

  try {
    while (pagina <= maxPaginas) {
      const url = `https://pncp.gov.br/api/pncp/v1/orgaos/${cnpj}/compras/${ano}/${seq}/itens?pagina=${pagina}&tamanhoPagina=${tamanhoPagina}`;
      const res = await httpClient.getJson<unknown>(url, {
        headers: { Accept: "application/json" },
      }, {
        endpoint: "/api/pncp/v1/orgaos/{cnpj}/compras/{ano}/{seq}/itens",
        pagina,
        attemptTimeoutMs: 20_000,
      });

      if (res.status === 204 || !res.body) break;

      let pageItems: Array<Record<string, unknown>> = [];
      if (Array.isArray(res.body)) {
        pageItems = res.body as Array<Record<string, unknown>>;
      } else if (res.body && typeof res.body === "object") {
        const obj = res.body as Record<string, unknown>;
        if (Array.isArray(obj.data)) pageItems = obj.data as Array<Record<string, unknown>>;
        else if (Array.isArray(obj.resultado)) pageItems = obj.resultado as Array<Record<string, unknown>>;
      }

      if (pageItems.length === 0) break;

      for (const it of pageItems) {
        allItems.push({
          numeroItem: Number(it.numeroItem),
          descricao: (it.descricao as string) ?? null,
          quantidade: typeof it.quantidade === "number" ? it.quantidade : (it.quantidade ? Number(it.quantidade) : null),
          unidade: (it.unidadeMedida as string) ?? (it.unidade as string) ?? null,
          valorUnitarioEstimado: typeof it.valorUnitarioEstimado === "number"
            ? it.valorUnitarioEstimado
            : (it.valorUnitarioEstimado ? Number(it.valorUnitarioEstimado) : null),
          situacaoCompraItemNome: (it.situacaoCompraItemNome as string) ?? null,
          temResultado: Boolean(it.temResultado),
          resultados: [],
        });
      }

      if (pageItems.length < tamanhoPagina) break;
      pagina++;
    }

    // Bounded concurrency ~5 para itens com resultado
    const itemsComResultado = allItems.filter((it) => it.temResultado);
    await mapConcurrent(itemsComResultado, 5, async (item) => {
      try {
        const resUrl = `https://pncp.gov.br/api/pncp/v1/orgaos/${cnpj}/compras/${ano}/${seq}/itens/${item.numeroItem}/resultados`;
        const resResult = await httpClient.getJson<unknown>(resUrl, {
          headers: { Accept: "application/json" },
        }, {
          endpoint: "/api/pncp/v1/orgaos/{cnpj}/compras/{ano}/{seq}/itens/{n}/resultados",
          attemptTimeoutMs: 20_000,
        });

        if (resResult.status === 204 || !resResult.body) {
          item.resultados = [];
          return;
        }

        let rawResultados: Array<Record<string, unknown>> = [];
        if (Array.isArray(resResult.body)) {
          rawResultados = resResult.body as Array<Record<string, unknown>>;
        } else if (resResult.body && typeof resResult.body === "object") {
          const obj = resResult.body as Record<string, unknown>;
          if (Array.isArray(obj.data)) rawResultados = obj.data as Array<Record<string, unknown>>;
        }

        item.resultados = rawResultados.map((r) => ({
          fornecedorCnpj: (r.niFornecedor as string) ?? (r.cnpj as string) ?? (r.fornecedorCnpj as string) ?? null,
          fornecedorNome: (r.nomeRazaoSocialFornecedor as string) ?? (r.fornecedorNome as string) ?? (r.nome as string) ?? null,
          valorUnitarioHomologado: typeof r.valorUnitarioHomologado === "number"
            ? r.valorUnitarioHomologado
            : (r.valorUnitarioHomologado ? Number(r.valorUnitarioHomologado) : null),
          quantidadeHomologada: typeof r.quantidadeHomologada === "number"
            ? r.quantidadeHomologada
            : (r.quantidadeHomologada ? Number(r.quantidadeHomologada) : null),
          dataResultado: (r.dataResultado as string) ?? null,
        }));
      } catch (err: unknown) {
        item.resultados = [];
        item.resultadosErro = errorDetail(err);
      }
    });

    return { dados: allItems, total: allItems.length, erro: null };
  } catch (err: unknown) {
    return { dados: allItems.length > 0 ? allItems : [], total: allItems.length, erro: errorDetail(err) };
  }
}

async function fetchAtas(
  httpClient: UnifiedHttpClient,
  cnpj: string,
  ano: number,
  seq: number,
): Promise<AcompanhamentoSection<AtaAcompanhamento[]> & { total: number }> {
  const atasList: AtaAcompanhamento[] = [];
  const tamanhoPagina = 50;
  let pagina = 1;
  const maxPaginas = 10;

  try {
    while (pagina <= maxPaginas) {
      const url = `https://pncp.gov.br/api/pncp/v1/orgaos/${cnpj}/compras/${ano}/${seq}/atas?pagina=${pagina}&tamanhoPagina=${tamanhoPagina}`;
      const res = await httpClient.getJson<unknown>(url, {
        headers: { Accept: "application/json" },
      }, {
        endpoint: "/api/pncp/v1/orgaos/{cnpj}/compras/{ano}/{seq}/atas",
        pagina,
        attemptTimeoutMs: 20_000,
      });

      if (res.status === 204 || !res.body) break;

      let pageAtas: Array<Record<string, unknown>> = [];
      let paginasRestantes = 0;

      if (Array.isArray(res.body)) {
        pageAtas = res.body as Array<Record<string, unknown>>;
      } else if (res.body && typeof res.body === "object") {
        const obj = res.body as Record<string, unknown>;
        if (Array.isArray(obj.data)) pageAtas = obj.data as Array<Record<string, unknown>>;
        paginasRestantes = typeof obj.paginasRestantes === "number" ? obj.paginasRestantes : 0;
      }

      if (pageAtas.length === 0) break;

      for (const a of pageAtas) {
        atasList.push({
          numero: (a.numeroAtaRegistroPreco as string) ?? (a.numero as string) ?? null,
          ano: typeof a.anoAta === "number" ? a.anoAta : (a.anoAta ? Number(a.anoAta) : null),
          vigenciaInicio: (a.dataVigenciaInicio as string) ?? null,
          vigenciaFim: (a.dataVigenciaFim as string) ?? null,
          dataAssinatura: (a.dataAssinatura as string) ?? null,
          cancelado: Boolean(a.cancelado),
          objeto: (a.objetoCompra as string) ?? (a.objeto as string) ?? null,
        });
      }

      if (paginasRestantes === 0 && pageAtas.length < tamanhoPagina) break;
      pagina++;
    }

    return { dados: atasList, total: atasList.length, erro: null };
  } catch (err: unknown) {
    const msg = errorDetail(err);
    if (/404/.test(msg)) {
      return { dados: [], total: 0, erro: null };
    }
    return { dados: [], total: 0, erro: msg };
  }
}

async function fetchHistorico(
  httpClient: UnifiedHttpClient,
  cnpj: string,
  ano: number,
  seq: number,
): Promise<AcompanhamentoSection<HistoricoEvento[]> & { total: number }> {
  const eventos: HistoricoEvento[] = [];
  const tamanhoPagina = 50;
  let pagina = 1;
  const maxPaginas = 30;

  try {
    while (pagina <= maxPaginas) {
      const url = `https://pncp.gov.br/api/pncp/v1/orgaos/${cnpj}/compras/${ano}/${seq}/historico?pagina=${pagina}&tamanhoPagina=${tamanhoPagina}`;
      const res = await httpClient.getJson<unknown>(url, {
        headers: { Accept: "application/json" },
      }, {
        endpoint: "/api/pncp/v1/orgaos/{cnpj}/compras/{ano}/{seq}/historico",
        pagina,
        attemptTimeoutMs: 20_000,
      });

      if (res.status === 204 || !res.body) break;

      let pageEvents: Array<Record<string, unknown>> = [];
      if (Array.isArray(res.body)) {
        pageEvents = res.body as Array<Record<string, unknown>>;
      } else if (res.body && typeof res.body === "object") {
        const obj = res.body as Record<string, unknown>;
        if (Array.isArray(obj.data)) pageEvents = obj.data as Array<Record<string, unknown>>;
      }

      if (pageEvents.length === 0) break;

      for (const ev of pageEvents) {
        eventos.push({
          data: (ev.logManutencaoDataInclusao as string) ?? (ev.data as string) ?? null,
          categoria: (ev.categoriaLogManutencaoNome as string) ??
            (ev.categoriaLogManutencao != null ? String(ev.categoriaLogManutencao) : null),
          tipo: (ev.tipoLogManutencaoNome as string) ??
            (ev.tipoLogManutencao != null ? String(ev.tipoLogManutencao) : null),
          item: ev.itemNumero != null ? Number(ev.itemNumero) : null,
          documentoTitulo: (ev.documentoTitulo as string) ?? null,
          justificativa: (ev.justificativa as string) ?? null,
        });
      }

      if (pageEvents.length < tamanhoPagina) break;
      pagina++;
    }

    return { dados: eventos, total: eventos.length, erro: null };
  } catch (err: unknown) {
    const msg = errorDetail(err);
    if (/404/.test(msg)) {
      return { dados: [], total: 0, erro: null };
    }
    return { dados: [], total: 0, erro: msg };
  }
}

async function fetchArquivos(
  httpClient: UnifiedHttpClient,
  cnpj: string,
  ano: number,
  seq: number,
): Promise<AcompanhamentoSection<ArquivoAcompanhamento[]> & { total: number }> {
  const arquivosList: ArquivoAcompanhamento[] = [];
  const url = `https://pncp.gov.br/api/pncp/v1/orgaos/${cnpj}/compras/${ano}/${seq}/arquivos`;

  try {
    const res = await httpClient.getJson<unknown>(url, {
      headers: { Accept: "application/json" },
    }, {
      endpoint: "/api/pncp/v1/orgaos/{cnpj}/compras/{ano}/{seq}/arquivos",
      attemptTimeoutMs: 20_000,
    });

    if (res.status === 204 || !res.body) {
      return { dados: [], total: 0, erro: null };
    }

    let rawList: Array<Record<string, unknown>> = [];
    if (Array.isArray(res.body)) {
      rawList = res.body as Array<Record<string, unknown>>;
    } else if (res.body && typeof res.body === "object") {
      const obj = res.body as Record<string, unknown>;
      if (Array.isArray(obj.data)) rawList = obj.data as Array<Record<string, unknown>>;
    }

    for (const arq of rawList) {
      const seqDoc = arq.sequencialDocumento != null ? Number(arq.sequencialDocumento) : null;
      const downloadUrl = (arq.url as string) ?? (arq.uri as string) ??
        (seqDoc ? `https://pncp.gov.br/pncp-api/v1/orgaos/${cnpj}/compras/${ano}/${seq}/arquivos/${seqDoc}` : null);

      arquivosList.push({
        titulo: (arq.titulo as string) ?? null,
        tipo: (arq.tipoDocumentoNome as string) ?? (arq.tipoDocumentoDescricao as string) ?? null,
        url: downloadUrl,
        sequencialDocumento: seqDoc,
      });
    }

    return { dados: arquivosList, total: arquivosList.length, erro: null };
  } catch (err: unknown) {
    const msg = errorDetail(err);
    if (/404/.test(msg)) {
      return { dados: [], total: 0, erro: null };
    }
    return { dados: [], total: 0, erro: msg };
  }
}

// -----------------------------------------------------------------------------
// Handler Principal da Ação `acompanhamento`
// -----------------------------------------------------------------------------

export async function handleAcompanhamento(
  params: AcompanhamentoActionParams,
  ctx?: DashboardOportunidadesClientContext,
  getDefaultClient?: () => SupabaseClient,
): Promise<Response> {
  try {
    const client = ctx?.getClient ? ctx.getClient() : (getDefaultClient ? getDefaultClient() : null);
    if (!client) {
      return jsonResponse({ error: "Cliente de banco indisponível" }, 500);
    }

    // 1. Busca a oportunidade por ID
    const { data, error } = await client
      .from("licitacoes_externas")
      .select("id, fonte, modulo, id_externo, codigo_externo, numero_processo, processo_norm, numero_edital, orgao_cnpj, linkSistemaOrigem, raw")
      .eq("id", params.id)
      .maybeSingle();

    if (error) {
      console.error("[api-dashboard-oportunidades] Erro ao buscar licitação em acompanhamento:", error);
      return jsonResponse({ error: "Falha ao consultar licitação" }, 500);
    }

    if (!data) {
      return jsonResponse({ error: "Licitação não encontrada", item: null }, 404);
    }

    const row = data as Record<string, unknown>;

    // 2. Resolve a chave PNCP
    const pncpKey = resolvePncpKey(row);
    if (!pncpKey) {
      // Linha que não é PNCP -> HTTP 200 com disponivel: false e razao
      return jsonResponse({
        disponivel: false,
        id: data.id,
        motivo: "Esta oportunidade não é de origem PNCP ou não possui chave de identificação PNCP.",
        razao: "Esta oportunidade não é de origem PNCP ou não possui chave de identificação PNCP.",
      });
    }

    // 3. Verifica Cache em memória (~5 minutos)
    const cacheKey = `${pncpKey.cnpj}/${pncpKey.ano}/${pncpKey.sequencial}`;
    const cached = getCachedAcompanhamento(cacheKey);
    if (cached) {
      return jsonResponse(cached, 200, {
        "Cache-Control": "private, max-age=300",
      });
    }

    // 4. Instancia cliente HTTP
    const httpClient = ctx?.httpClient ?? new UnifiedHttpClient({
      supabaseClient: typeof client.rpc === "function" ? client : null,
      hostLease: typeof client.rpc === "function" ? undefined : null,
    });

    // 5. Executa requisições em paralelo com tratamento individual de erros
    const [compraSettled, itensSettled, atasSettled, historicoSettled, arquivosSettled] =
      await Promise.allSettled([
        fetchCompraMetadata(httpClient, pncpKey.cnpj, pncpKey.ano, pncpKey.sequencial),
        fetchItensComResultados(httpClient, pncpKey.cnpj, pncpKey.ano, pncpKey.sequencial),
        fetchAtas(httpClient, pncpKey.cnpj, pncpKey.ano, pncpKey.sequencial),
        fetchHistorico(httpClient, pncpKey.cnpj, pncpKey.ano, pncpKey.sequencial),
        fetchArquivos(httpClient, pncpKey.cnpj, pncpKey.ano, pncpKey.sequencial),
      ]);

    const compraSection: AcompanhamentoSection<CompraMetadata> = compraSettled.status === "fulfilled"
      ? compraSettled.value
      : { dados: null, erro: errorDetail(compraSettled.reason) };

    const itensSection: AcompanhamentoSection<ItemAcompanhamento[]> & { total: number } =
      itensSettled.status === "fulfilled"
        ? itensSettled.value
        : { dados: [], total: 0, erro: errorDetail(itensSettled.reason) };

    const atasSection: AcompanhamentoSection<AtaAcompanhamento[]> & { total: number } =
      atasSettled.status === "fulfilled"
        ? atasSettled.value
        : { dados: [], total: 0, erro: errorDetail(atasSettled.reason) };

    const historicoSection: AcompanhamentoSection<HistoricoEvento[]> & { total: number } =
      historicoSettled.status === "fulfilled"
        ? historicoSettled.value
        : { dados: [], total: 0, erro: errorDetail(historicoSettled.reason) };

    const arquivosSection: AcompanhamentoSection<ArquivoAcompanhamento[]> & { total: number } =
      arquivosSettled.status === "fulfilled"
        ? arquivosSettled.value
        : { dados: [], total: 0, erro: errorDetail(arquivosSettled.reason) };

    // 6. Deriva url_edital e url_acompanhamento
    const urlEdital = buildEditalUrl(row) ?? buildPncpEditalUrl(pncpKey.cnpj, pncpKey.ano, pncpKey.sequencial);
    const rawLinkOrigem = compraSection.dados?.linkSistemaOrigem ??
      (row.linkSistemaOrigem as string | null) ??
      ((row.raw as Record<string, unknown> | null)?.linkSistemaOrigem as string | null);
    const urlAcompanhamento = buildAcompanhamentoUrl(rawLinkOrigem);

    const payload: AcompanhamentoResponse = {
      disponivel: true,
      id: data.id,
      pncp: {
        cnpj: pncpKey.cnpj,
        ano: pncpKey.ano,
        sequencial: pncpKey.sequencial,
        numero_controle_pncp: pncpKey.numeroControlePncp ??
          `${pncpKey.cnpj}-1-${String(pncpKey.sequencial).padStart(6, "0")}/${pncpKey.ano}`,
      },
      url_edital: urlEdital,
      url_acompanhamento: urlAcompanhamento,
      compra: compraSection,
      itens: itensSection,
      atas: atasSection,
      historico: historicoSection,
      arquivos: arquivosSection,
    };

    // 7. Salva no cache em memória
    setCachedAcompanhamento(cacheKey, payload);

    return jsonResponse(payload, 200, {
      "Cache-Control": "private, max-age=300",
    });
  } catch (err: unknown) {
    console.error("[api-dashboard-oportunidades] Exceção em acompanhamento:", err);
    return jsonResponse({ error: "Erro interno no servidor" }, 500);
  }
}
