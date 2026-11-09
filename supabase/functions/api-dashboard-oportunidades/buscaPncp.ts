// Spec 0049: busca do PNCP (/api/search/) como 2ª fonte do detalhe quando a Consulta e a /api/pncp/v1 caem.
//
// - `compra` (Resumo) e `atas` com erro e sem dados: vêm do índice de busca, com `origem: "busca_pncp"`,
//   `busca_atualizado_em` e o `erro` da 1ª fonte mantido. Sem casamento exato do controle: a seção fica como veio.
// - `itens` e `arquivos` da cópia local (#501): ganham `conferencia_busca`, comparando a atualização da compra no
//   índice com `licitacoes_externas.pncp_data_atualizacao`. A busca traz a `dataAtualizacao` da compra, não a global:
//   "compra sem mudança" não prova item sem mudança (o Dashboard diz isso).
// - Uma busca de edital (Resumo + conferência) e uma de atas por detalhe, só quando alguma seção precisa.
// - Nada é gravado. Datas sem offset da busca estão em horário de Brasília (medido em 09/11/2026).
import { errorDetail } from "../_shared/http.ts";
import { type BuscaPncpItem, PncpSearchClient } from "../_shared/pncp/search-client.ts";
import type { UnifiedHttpClient } from "../_shared/http-client/index.ts";
import type { AcompanhamentoSection, AtaAcompanhamento, CompraMetadata, ConferenciaBusca } from "./types.ts";

function texto(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v : null;
}

function numero(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function booleano(v: unknown): boolean | null {
  return typeof v === "boolean" ? v : null;
}

const NAIVE_RE = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})(?::(\d{2}))?(?:\.\d+)?$/;
const OFFSET_RE = /(?:Z|[+-]\d{2}:?\d{2})$/;

/**
 * Data da busca em ISO. Sem offset = horário de Brasília (UTC-3 fixo): `2026-07-15T08:00` →
 * `2026-07-15T08:00:00-03:00`, fração descartada. Só data (`YYYY-MM-DD`) e data com offset passam como vieram.
 * Vazio ou formato desconhecido = null.
 */
export function dataDaBusca(v: unknown): string | null {
  const s = texto(v)?.trim();
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  if (OFFSET_RE.test(s)) return Number.isFinite(Date.parse(s)) ? s : null;
  const m = NAIVE_RE.exec(s);
  if (!m) return null;
  const iso = `${m[1]}T${m[2]}:${m[3] ?? "00"}-03:00`;
  return Number.isFinite(Date.parse(iso)) ? iso : null;
}

/** Item `edital` da busca → Resumo da compra. O que a busca não traz fica null (processo, link do portal, inclusão). */
export function compraDaBusca(it: Record<string, unknown>): CompraMetadata {
  return {
    situacao: texto(it.situacao_nome),
    situacaoCompraId: numero(it.situacao_id),
    modalidade: texto(it.modalidade_licitacao_nome),
    modalidadeId: numero(it.modalidade_licitacao_id),
    objeto: texto(it.description),
    valorEstimado: numero(it.valor_total_estimado),
    valorHomologado: numero(it.valor_total_homologado),
    datas: {
      publicacao: dataDaBusca(it.data_publicacao_pncp),
      // no edital, data_inicio/fim_vigencia = abertura e encerramento de propostas (mesma leitura do coletor)
      aberturaProposta: dataDaBusca(it.data_inicio_vigencia),
      encerramentoProposta: dataDaBusca(it.data_fim_vigencia),
      inclusao: null,
      atualizacao: dataDaBusca(it.data_atualizacao_pncp),
    },
    linkSistemaOrigem: texto(it.link_sistema_origem),
    numeroCompra: texto(it.numero),
    processo: null,
    srp: booleano(it.srp),
    existeResultado: booleano(it.tem_resultado),
    orgaoEntidade: {
      cnpj: texto(it.orgao_cnpj),
      razaoSocial: texto(it.orgao_nome),
      esferaId: texto(it.esfera_id),
      poderId: texto(it.poder_id),
    },
    unidadeOrgao: {
      codigoUnidade: texto(it.unidade_codigo),
      nomeUnidade: texto(it.unidade_nome),
      municipioNome: texto(it.municipio_nome),
      codigoIbge: texto(it.codigo_ibge),
      ufSigla: texto(it.uf),
    },
  };
}

const TITULO_ATA_RE = /(\d+)\s*\/\s*(\d{4})\s*$/;

/** Item `ata` da busca. Número e ano saem do título ("Ata nº 85/2026"); sem o padrão, null. Sem fornecedor e valor. */
export function ataDaBusca(it: Record<string, unknown>): AtaAcompanhamento {
  const m = TITULO_ATA_RE.exec(texto(it.title) ?? "");
  return {
    numero: m ? m[1] : null,
    ano: m ? Number(m[2]) : null,
    vigenciaInicio: dataDaBusca(it.data_inicio_vigencia),
    vigenciaFim: dataDaBusca(it.data_fim_vigencia),
    dataAssinatura: dataDaBusca(it.data_assinatura),
    cancelado: it.cancelado === true,
    dataCancelamento: null,
    objeto: texto(it.description),
    permiteAdesao: booleano(it.permite_adesao),
  };
}

function instante(iso: string | null): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

/** Maior `data_atualizacao_pncp` (ISO -03:00) entre os itens; null quando nenhum tem data válida. */
function maisRecente(items: BuscaPncpItem[]): string | null {
  let melhor: string | null = null;
  for (const it of items) {
    const d = dataDaBusca(it.data_atualizacao_pncp);
    if (d && (melhor === null || (instante(d) ?? 0) > (instante(melhor) ?? 0))) melhor = d;
  }
  return melhor;
}

/** Atualização gravada pelo coletor (timestamptz do PostgREST) em ISO UTC; null quando falta ou é inválida. */
function gravadoEm(v: unknown): string | null {
  const s = texto(v);
  if (!s) return null;
  const t = Date.parse(s.replace(" ", "T").replace(/([+-]\d{2})$/, "$1:00"));
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

/**
 * Compara a atualização da compra no índice com a gravada. Segundos inteiros: a busca traz fração e o banco guarda
 * o segundo. `compra_mudou` = índice posterior ao gravado; null quando falta uma das duas.
 */
export function conferenciaDaBusca(edital: BuscaPncpItem, pncpDataAtualizacao: unknown): ConferenciaBusca {
  const pncp = dataDaBusca(edital.data_atualizacao_pncp);
  const gravado = gravadoEm(pncpDataAtualizacao);
  const tPncp = instante(pncp);
  const tGravado = instante(gravado);
  return {
    pncp_atualizado_em: pncp,
    gravado_em: gravado,
    compra_mudou: tPncp === null || tGravado === null
      ? null
      : Math.floor(tPncp / 1000) > Math.floor(tGravado / 1000),
  };
}

type Secao<T> = AcompanhamentoSection<T>;
type SecaoLista<T> = AcompanhamentoSection<T[]> & { total: number };

function falhouSemDados(secao: Secao<unknown>): boolean {
  return secao.erro !== null && (secao.dados === null || (Array.isArray(secao.dados) && secao.dados.length === 0));
}

export type SecoesComBusca<C, A, I, R> = {
  compra: Secao<C>;
  atas: SecaoLista<A>;
  itens: SecaoLista<I>;
  arquivos: SecaoLista<R>;
};

/**
 * Aplica a busca às seções que precisam (ver cabeçalho). Falha da busca não derruba o detalhe: a seção fica como
 * veio e o motivo vai para o log (o `erro` exibido continua o da 1ª fonte).
 */
export async function aplicarBuscaPncp<I, R>(
  secoes: SecoesComBusca<CompraMetadata, AtaAcompanhamento, I, R>,
  controle: string | null | undefined,
  pncpDataAtualizacao: unknown,
  httpClient: UnifiedHttpClient,
  busca: PncpSearchClient = new PncpSearchClient(undefined, httpClient),
): Promise<SecoesComBusca<CompraMetadata, AtaAcompanhamento, I, R>> {
  const precisaCompra = falhouSemDados(secoes.compra);
  const precisaAtas = falhouSemDados(secoes.atas);
  const precisaConferencia = secoes.itens.origem === "copia_local" || secoes.arquivos.origem === "copia_local";
  if (!controle || (!precisaCompra && !precisaAtas && !precisaConferencia)) return secoes;

  const [editalRes, atasRes] = await Promise.allSettled([
    precisaCompra || precisaConferencia ? busca.buscarCompraPorControle(controle) : Promise.resolve(null),
    precisaAtas ? busca.buscarAtasDaCompra(controle) : Promise.resolve(null),
  ]);
  if (editalRes.status === "rejected") {
    console.warn("[api-dashboard-oportunidades] busca PNCP (edital) falhou:", errorDetail(editalRes.reason));
  }
  if (atasRes.status === "rejected") {
    console.warn("[api-dashboard-oportunidades] busca PNCP (atas) falhou:", errorDetail(atasRes.reason));
  }
  const edital = editalRes.status === "fulfilled" ? editalRes.value : null;
  const atas = atasRes.status === "fulfilled" ? atasRes.value : null;

  let { compra, atas: secaoAtas, itens, arquivos } = secoes;
  if (precisaCompra && edital) {
    compra = {
      ...compra,
      dados: compraDaBusca(edital),
      origem: "busca_pncp",
      busca_atualizado_em: dataDaBusca(edital.data_atualizacao_pncp),
    };
  }
  // Atas: lista vazia é resposta válida da busca, mas não prova que a compra não tem ata enquanto a 1ª fonte está
  // fora; a seção só muda com ata encontrada.
  if (precisaAtas && atas && atas.length > 0) {
    secaoAtas = {
      ...secaoAtas,
      dados: atas.map(ataDaBusca),
      total: atas.length,
      origem: "busca_pncp",
      busca_atualizado_em: maisRecente(atas),
    };
  }
  if (precisaConferencia && edital) {
    const conferencia = conferenciaDaBusca(edital, pncpDataAtualizacao);
    if (itens.origem === "copia_local") itens = { ...itens, conferencia_busca: conferencia };
    if (arquivos.origem === "copia_local") arquivos = { ...arquivos, conferencia_busca: conferencia };
  }
  return { compra, atas: secaoAtas, itens, arquivos };
}
