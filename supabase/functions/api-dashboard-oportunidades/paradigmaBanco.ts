// Detalhe (action=acompanhamento) da licitação do Paradigma (Sistema S), lido só do banco. Spec 0061, K-1.
//
// O portal Paradigma não tem API para o Dashboard: o coletor (services/coletor-externo/coletor/paradigma.py e
// documentos_paradigma.py) grava itens, resultados, lances e documentos, e esta resposta mostra o que ele gravou,
// sem nenhuma chamada ao portal nem ao PNCP.
//
// Formato do K-4 da spec 0029: cada seção traz `origem: "banco"` e `gravado_em`. Seção sem linha gravada volta com
// `erro` explícito e `dados: null`, nunca lista vazia (o front distingue "não publicado/não coletado" de "nada").
//
// `gravado_em` por seção (ISO; null = desconhecido, nunca inventado):
// - compra e itens: `licitacoes_externas.ingestao_em`, a última passada do coletor que gravou o processo; os itens são
//   gravados na mesma passada (licitacao_itens não tem coluna de data mantida: updated_at fica no default);
// - resultados: maior `created_at` de licitacao_resultados (quando o resultado foi gravado pela primeira vez);
// - histórico: maior `updated_at` de licitacao_lances (o coletor envia a cada upsert);
// - arquivos: maior `last_seen_at` dos documentos listados (a última passada que os viu no portal).
//
// Nunca sai: `raw`, `storage_uri` (caminho no Storage) nem mensagem de erro do PostgREST.
import { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { jsonResponse } from "../_shared/http.ts";
import { buildEditalUrl, PARADIGMA_MURAL } from "../_shared/edital-url.ts";
import { lerLinhas } from "./copiaLocal.ts";
import type {
  AcompanhamentoParadigmaResponse,
  ArquivoParadigma,
  CompraParadigma,
  ItemAcompanhamento,
  ItemResultado,
  LanceHistorico,
  ResultadoParadigma,
  SecaoBanco,
} from "./types.ts";

/**
 * Fontes do coletor Paradigma (`FONTES` em coletor/paradigma.py): os murais conhecidos mais `sescrj` (sem mural
 * público no caminho padrão). O teste confere que toda fonte do coletor está aqui.
 */
export const FONTES_PARADIGMA: ReadonlySet<string> = new Set([...Object.keys(PARADIGMA_MURAL), "sescrj"]);

export function ehFonteParadigma(fonte: unknown): boolean {
  return typeof fonte === "string" && FONTES_PARADIGMA.has(fonte.trim().toLowerCase());
}

/** Arquivo do "Resumo do processo" (documentos_paradigma.py, ARQUIVO_RESUMO). */
export const ARQUIVO_RESUMO = "resumo_processo.html";

// Marcadores de "vazio" do Paradigma (coletor/portal.py: _NULO e _INT_NULO).
const NULO_TEXTO = "\u0013\u0012\u0012\u0013";
const NULO_INT = -2147483648;
const DATA_RE = /\/Date\((-?\d+)(?:[+-]\d{4})?\)\//;

/** '/Date(ms)/' do Paradigma em ISO UTC; data zerada (ms <= 0, como o MinValue do .NET) e marcador de nulo = null. */
export function dataParadigma(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const m = v.match(DATA_RE);
  if (!m) return null;
  const ms = Number(m[1]);
  if (!Number.isFinite(ms) || ms <= 0) return null;
  return new Date(ms).toISOString();
}

function texto(v: unknown): string | null {
  if (typeof v !== "string" || v === NULO_TEXTO) return null;
  const t = v.trim();
  return t === "" ? null : t;
}

function numero(v: unknown): number | null {
  if (v === null || v === undefined || v === "" || typeof v === "boolean" || v === NULO_INT) return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function objeto(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};
}

function maiorData(linhas: Record<string, unknown>[], coluna: string): string | null {
  let maior: string | null = null;
  let maiorMs = -Infinity;
  for (const l of linhas) {
    const v = l[coluna];
    if (typeof v !== "string" || v.trim() === "") continue;
    const ms = Date.parse(v);
    if (Number.isFinite(ms) && ms > maiorMs) {
      maior = v;
      maiorMs = ms;
    }
  }
  return maior;
}

function secaoComDados<T>(dados: T[], gravadoEm: string | null): SecaoBanco<T[]> {
  return { dados, total: dados.length, erro: null, origem: "banco", gravado_em: gravadoEm };
}

function secaoComErro<T>(erro: string): SecaoBanco<T[]> {
  return { dados: null, total: 0, erro, origem: "banco", gravado_em: null };
}

const FALHA_LEITURA = "Falha ao ler do banco; tente de novo.";

export const COLUNAS_ITENS_PARADIGMA =
  "numero_item,descricao,quantidade,unidade_medida,valor_unitario_estimado,situacao,catalogo_codigo_item," +
  "material_ou_servico,raw";
export const COLUNAS_RESULTADOS_PARADIGMA =
  "numero_item,sequencial_resultado,fornecedor_nome,fornecedor_cnpj,ranking,vencedor,valor_proposta," +
  "valor_unitario_homologado,quantidade_homologada,marca,modelo,situacao,data_resultado,created_at";
export const COLUNAS_LANCES_PARADIGMA =
  "id,numero_item,data_lance,valor,moeda,fornecedor_nome,fornecedor_cnpj,marca,modelo,posicao,vencedor,updated_at";
/** Sem storage_uri e sem raw: o caminho no Storage nunca vai para o navegador (a URL assinada é o K-2). */
export const COLUNAS_DOCUMENTOS_PARADIGMA =
  "id,secao,nome_original,arquivo_origem,data_documento,mime_type,status_processamento,removido_do_portal_em," +
  "last_seen_at";

function resultadoDaLinha(l: Record<string, unknown>): ResultadoParadigma | null {
  const numeroItem = numero(l.numero_item);
  if (numeroItem === null) return null;
  return {
    numeroItem,
    fornecedorCnpj: texto(l.fornecedor_cnpj),
    fornecedorNome: texto(l.fornecedor_nome),
    valorUnitarioHomologado: numero(l.valor_unitario_homologado),
    quantidadeHomologada: numero(l.quantidade_homologada),
    dataResultado: texto(l.data_resultado),
    ranking: numero(l.ranking),
    vencedor: l.vencedor === true,
    valorProposta: numero(l.valor_proposta),
    marca: texto(l.marca),
    modelo: texto(l.modelo),
    situacao: texto(l.situacao),
  };
}

/** Vencedor primeiro, depois a posição (sem posição por último), por item. */
function ordenarResultados(rs: ResultadoParadigma[]): ResultadoParadigma[] {
  const pos = (r: ResultadoParadigma) => r.ranking ?? Number.MAX_SAFE_INTEGER;
  return [...rs].sort((a, b) =>
    a.numeroItem - b.numeroItem || Number(b.vencedor) - Number(a.vencedor) || pos(a) - pos(b)
  );
}

function itemDaLinha(l: Record<string, unknown>, resultados: ResultadoParadigma[]): ItemAcompanhamento | null {
  const numeroItem = numero(l.numero_item);
  if (numeroItem === null || !Number.isInteger(numeroItem)) return null;
  const raw = objeto(l.raw);
  const mos = l.material_ou_servico;
  const doItem: ItemResultado[] = resultados.filter((r) => r.numeroItem === numeroItem).map((r) => ({
    fornecedorCnpj: r.fornecedorCnpj,
    fornecedorNome: r.fornecedorNome,
    valorUnitarioHomologado: r.valorUnitarioHomologado,
    quantidadeHomologada: r.quantidadeHomologada,
    dataResultado: r.dataResultado,
  }));
  return {
    numeroItem,
    descricao: texto(l.descricao),
    quantidade: numero(l.quantidade),
    unidade: texto(l.unidade_medida),
    valorUnitarioEstimado: numero(l.valor_unitario_estimado),
    situacaoCompraItemNome: texto(l.situacao),
    temResultado: doItem.length > 0,
    resultados: doItem,
    // Código do produto no catálogo da própria entidade, não CATMAT: catalogoId fica nulo.
    catalogoCodigoItem: texto(l.catalogo_codigo_item),
    catalogoId: null,
    catalogoNome: null,
    materialOuServico: mos === "M" || mos === "S" ? mos : null,
    // Do registro do item no mural (PesquisarProcessoDetalheItemProduto), como o portal publica.
    melhorLance: numero(raw.dVlMelhorLanceMoedaVencedor) ?? numero(raw.dVlMelhorLanceMoedaProcesso),
    marcaVencedor: texto(raw.sDsMarca),
    modeloVencedor: texto(raw.sDsModelo),
  };
}

function lanceDaLinha(l: Record<string, unknown>): LanceHistorico | null {
  const numeroItem = numero(l.numero_item);
  if (numeroItem === null) return null;
  return {
    numeroItem,
    data: texto(l.data_lance),
    valor: numero(l.valor),
    moeda: texto(l.moeda),
    fornecedorNome: texto(l.fornecedor_nome),
    fornecedorCnpj: texto(l.fornecedor_cnpj),
    marca: texto(l.marca),
    modelo: texto(l.modelo),
    posicao: numero(l.posicao),
    vencedor: l.vencedor === true,
    origem: "portal_oficial",
  };
}

/** Ordem de data e hora; lance sem data por último; empate pelo id da linha (ordem de gravação). */
function ordenarLances(linhas: Record<string, unknown>[]): Record<string, unknown>[] {
  const ms = (l: Record<string, unknown>) => {
    const t = typeof l.data_lance === "string" ? Date.parse(l.data_lance) : NaN;
    return Number.isFinite(t) ? t : Number.POSITIVE_INFINITY;
  };
  return [...linhas].sort((a, b) => ms(a) - ms(b) || (numero(a.id) ?? 0) - (numero(b.id) ?? 0));
}

function arquivoDaLinha(l: Record<string, unknown>): ArquivoParadigma {
  const resumo = l.arquivo_origem === ARQUIVO_RESUMO;
  return {
    documentoId: numero(l.id),
    titulo: texto(l.nome_original),
    tipo: resumo ? "resumo" : "anexo",
    // Sem link direto: o arquivo abre pela URL assinada (K-2, action=documento_url).
    url: null,
    mimeType: texto(l.mime_type),
    dataDocumento: texto(l.data_documento),
    status: texto(l.status_processamento),
  };
}

/** Documentos do processo não removidos do portal: o resumo primeiro, depois os anexos por data e id. */
function arquivosDoProcesso(linhas: Record<string, unknown>[]): Record<string, unknown>[] {
  const doProcesso = linhas.filter((l) => l.secao === "processo" && !l.removido_do_portal_em);
  const chave = (l: Record<string, unknown>) => {
    const t = typeof l.data_documento === "string" ? Date.parse(l.data_documento) : NaN;
    return Number.isFinite(t) ? t : Number.POSITIVE_INFINITY;
  };
  return doProcesso.sort((a, b) =>
    Number(b.arquivo_origem === ARQUIVO_RESUMO) - Number(a.arquivo_origem === ARQUIVO_RESUMO) ||
    chave(a) - chave(b) || (numero(a.id) ?? 0) - (numero(b.id) ?? 0)
  );
}

function compraDaLinha(row: Record<string, unknown>): CompraParadigma {
  const raw = objeto(row.raw);
  return {
    situacao: texto(raw.sDsSituacao),
    fase: texto(raw.sDsFase) ?? texto(row.fase),
    modalidade: texto(raw.sNmModalidadeTipo) ?? texto(raw.sNmModalidade),
    objeto: texto(raw.sDsObjeto),
    numeroProcesso: texto(row.numero_processo),
    numeroEdital: texto(row.numero_edital),
    datasProcesso: {
      inicio: dataParadigma(raw.tDtInicial),
      fim: dataParadigma(raw.tDtFinal),
      publicacao: dataParadigma(raw.tDtPublicacao),
      aberturaSessao: dataParadigma(raw.tDtAberturaSessao),
      homologacao: dataParadigma(raw.tDtHomologacao),
      finalizacao: dataParadigma(raw.tDtFinalizacao),
    },
  };
}

/** Lê uma tabela da licitação; null = falha (a mensagem do banco vai só para o log). */
async function ler(
  client: SupabaseClient,
  tabela: string,
  colunas: string,
  licitacaoId: number,
  ordem: string,
): Promise<Record<string, unknown>[] | null> {
  try {
    return await lerLinhas(client, tabela, colunas, licitacaoId, ordem);
  } catch (err: unknown) {
    console.warn(`[api-dashboard-oportunidades] leitura de ${tabela} falhou:`, err);
    return null;
  }
}

/**
 * Monta a resposta do acompanhamento da licitação do Paradigma a partir do banco. `row` já foi lida e o acesso do
 * usuário (empresa ativa) já foi conferido por quem chama.
 */
export async function acompanhamentoParadigmaDoBanco(
  client: SupabaseClient,
  row: Record<string, unknown>,
): Promise<AcompanhamentoParadigmaResponse> {
  const id = Number(row.id);
  const fonte = String(row.fonte ?? "").trim().toLowerCase();
  const ingestaoEm = texto(row.ingestao_em);

  const [itensL, resultadosL, lancesL, documentosL] = await Promise.all([
    ler(client, "licitacao_itens", COLUNAS_ITENS_PARADIGMA, id, "numero_item"),
    ler(client, "licitacao_resultados", COLUNAS_RESULTADOS_PARADIGMA, id, "numero_item"),
    ler(client, "licitacao_lances", COLUNAS_LANCES_PARADIGMA, id, "id"),
    ler(client, "licitacao_documentos", COLUNAS_DOCUMENTOS_PARADIGMA, id, "id"),
  ]);

  // Resultados
  let resultados: SecaoBanco<ResultadoParadigma[]>;
  let resultadosDados: ResultadoParadigma[] = [];
  if (resultadosL === null) {
    resultados = secaoComErro(FALHA_LEITURA);
  } else {
    resultadosDados = ordenarResultados(
      resultadosL.map(resultadoDaLinha).filter((r): r is ResultadoParadigma => r !== null),
    );
    resultados = resultadosDados.length > 0
      ? secaoComDados(resultadosDados, maiorData(resultadosL, "created_at"))
      : secaoComErro("Nenhum resultado gravado para este processo (o portal não publicou ou ainda não foi coletado).");
  }

  // Itens (com os resultados de cada um; falha nos resultados vira resultadosErro no item)
  let itens: SecaoBanco<ItemAcompanhamento[]>;
  if (itensL === null) {
    itens = secaoComErro(FALHA_LEITURA);
  } else {
    const dados = itensL
      .map((l) => itemDaLinha(l, resultadosDados))
      .filter((i): i is ItemAcompanhamento => i !== null)
      .sort((a, b) => a.numeroItem - b.numeroItem);
    if (resultadosL === null) for (const i of dados) i.resultadosErro = FALHA_LEITURA;
    itens = dados.length > 0
      ? secaoComDados(dados, ingestaoEm)
      : secaoComErro("Nenhum item gravado para este processo (ainda não coletado).");
  }

  // Histórico: a disputa (todos os lances), em ordem de data e hora
  let historico: SecaoBanco<LanceHistorico[]>;
  if (lancesL === null) {
    historico = secaoComErro(FALHA_LEITURA);
  } else {
    const dados = ordenarLances(lancesL).map(lanceDaLinha).filter((l): l is LanceHistorico => l !== null);
    historico = dados.length > 0
      ? secaoComDados(dados, maiorData(lancesL, "updated_at"))
      : secaoComErro("Nenhum lance gravado para este processo (o portal não publicou ou ainda não foi coletado).");
  }

  // Arquivos: documentos do processo, resumo primeiro
  let arquivos: SecaoBanco<ArquivoParadigma[]>;
  if (documentosL === null) {
    arquivos = secaoComErro(FALHA_LEITURA);
  } else {
    const linhas = arquivosDoProcesso(documentosL);
    arquivos = linhas.length > 0
      ? secaoComDados(linhas.map(arquivoDaLinha), maiorData(linhas, "last_seen_at"))
      : secaoComErro("Nenhum documento gravado para este processo (ainda não coletado).");
  }

  const compraDados = compraDaLinha(row);
  return {
    disponivel: true,
    id: row.id as number | string,
    origem: "banco",
    fonte,
    pncp: null,
    url_edital: buildEditalUrl(row),
    url_acompanhamento: PARADIGMA_MURAL[fonte] ?? null,
    fase: compraDados.fase,
    compra: { dados: compraDados, erro: null, origem: "banco", gravado_em: ingestaoEm },
    itens,
    resultados,
    historico,
    arquivos,
  };
}

/** Resposta sem seção em erro pode ficar 1 min no navegador; com erro, no-store (o "tentar de novo" chega aqui). */
export function respostaParadigma(payload: AcompanhamentoParadigmaResponse): Response {
  const completo = [payload.itens, payload.resultados, payload.historico, payload.arquivos].every((s) => s.erro === null);
  return jsonResponse(payload, 200, { "Cache-Control": completo ? "private, max-age=60" : "no-store" });
}
