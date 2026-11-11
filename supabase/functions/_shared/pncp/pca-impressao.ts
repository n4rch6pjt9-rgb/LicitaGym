import { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { enfileirar, inativarAusenteNoEscopo, type ItemFila, type OpcoesHttp } from "./pca-fila.ts";

/**
 * Spec 0056, camada 1: impressão digital de cada plano, lida por órgão em
 * `GET /v1/orgaos/{cnpj}/pca/{ano}/consolidado/unidades` (PlanoContratacaoOrgaoDTO, OpenAPI de 09/10/2026).
 *
 * - Entra na fila de carga (motivo `impressao`) só o plano sem impressão anterior ou com `dataAtualizacao`,
 *   `quantidade` ou `valorTotal` diferente.
 * - 404 na página 1 é erro do órgão (a mensagem da API é "CNPJ do Órgão/Entidade inválido." mesmo para CNPJ válido);
 *   404 numa página depois de uma página cheia é o fim da lista (medido em 11/11/2026).
 * - Plano gravado que não veio numa leitura completa do órgão: na primeira vez, aviso `pca_removido` "a confirmar";
 *   na segunda leitura seguida, inativa os itens do escopo (e o plano, se não sobrar item ativo). P-4.
 * - Exceção na requisição (429, 5xx depois das tentativas, orçamento) é pausa: a leitura para sem marcar o órgão.
 */

type Row = Record<string, unknown>;

export const TAMANHO_PAGINA_IMPRESSAO = 50;
/** 50 × 40 = 2.000 planos por órgão; acima disso a leitura é tratada como erro do órgão (não medido). */
const MAX_PAGINAS_IMPRESSAO = 40;
const PAGINA_BANCO = 1000;

export interface IntegracaoImpressao {
  getPcaConsolidadoUnidades(
    cnpj: string,
    ano: number,
    pagina: number,
    tamanhoPagina: number,
    options?: OpcoesHttp,
  ): Promise<{ status: number; body: unknown }>;
}

export type PlanoImpresso = {
  orgao_cnpj: string;
  ano: number;
  sequencial: number;
  codigo_unidade: string | null;
  quantidade: number | null;
  valor_total: number | null;
  data_atualizacao: string | null;
  data_atualizacao_global: string | null;
  numero_controle_pncp: string;
  cabecalho: Row;
};

export type ImpressaoStats = {
  orgaos_lidos: number;
  orgaos_erro: number;
  planos_lidos: number;
  enfileirados: number;
  removidos_a_confirmar: number;
  itens_inativados: number;
  planos_inativados: number;
  /** Requisição lançou (cota, 5xx, orçamento): a rotina parou e o órgão não foi marcado. */
  pausa: string | null;
  /** Órgãos que ficaram para o próximo disparo (limite, prazo ou pausa). */
  restantes: number;
};

const texto = (v: unknown) => (v == null || String(v).trim() === "" ? null : String(v).trim());
const numero = (v: unknown) => (v == null || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));

/** Cabeçalho no formato da consulta /v1/pca/, que é o que a carga normaliza (normalizePcaPlano). */
export function cabecalhoDaImpressao(l: Row): Row {
  return {
    idPcaPncp: texto(l.numeroControlePNCP),
    orgaoEntidadeCnpj: texto(l.cnpj),
    anoPca: numero(l.anoPca),
    codigoUnidade: texto(l.codigoUnidade),
    nomeUnidade: texto(l.nomeUnidade),
    orgaoEntidadeRazaoSocial: texto(l.razaoSocial),
    dataPublicacaoPNCP: texto(l.dataPublicacaoPncp),
    dataAtualizacaoGlobalPCA: texto(l.dataAtualizacaoGlobalPCA),
  };
}

function mensagemDoCorpo(body: unknown): string {
  if (body && typeof body === "object" && "message" in body) return `: ${String((body as Row).message)}`;
  return typeof body === "string" && body.trim() ? `: ${body.trim().slice(0, 200)}` : "";
}

/**
 * Lê todas as páginas do órgão. Devolve `ok: false` quando a lista não pode ser tomada como completa (404 ou outro
 * status na página 1, linha sem sequencial ou sem número de controle, lista longa demais).
 */
export async function lerImpressaoOrgao(
  integracao: IntegracaoImpressao,
  cnpj: string,
  ano: number,
  http: OpcoesHttp = {},
): Promise<{ ok: true; planos: PlanoImpresso[] } | { ok: false; erro: string }> {
  const planos: PlanoImpresso[] = [];
  const vistos = new Set<number>();
  for (let pagina = 1; pagina <= MAX_PAGINAS_IMPRESSAO; pagina++) {
    const { status, body } = await integracao.getPcaConsolidadoUnidades(
      cnpj,
      ano,
      pagina,
      TAMANHO_PAGINA_IMPRESSAO,
      http,
    );
    // Só se chega à página > 1 depois de uma página cheia: 404/204 aqui é o fim da lista.
    if (pagina > 1 && (status === 404 || status === 204)) return { ok: true, planos };
    if (status !== 200 || !Array.isArray(body)) {
      return { ok: false, erro: `consolidado/unidades página ${pagina}: HTTP ${status}${mensagemDoCorpo(body)}` };
    }
    for (const l of body as Row[]) {
      const sequencial = numero(l?.sequencialPca);
      const controle = texto(l?.numeroControlePNCP);
      if (sequencial === null || !Number.isInteger(sequencial) || sequencial <= 0 || !controle) {
        return { ok: false, erro: `consolidado/unidades página ${pagina}: linha sem sequencialPca ou numeroControlePNCP` };
      }
      if (vistos.has(sequencial)) {
        return { ok: false, erro: `consolidado/unidades página ${pagina}: sequencial ${sequencial} repetido` };
      }
      vistos.add(sequencial);
      planos.push({
        orgao_cnpj: cnpj,
        ano,
        sequencial,
        codigo_unidade: texto(l.codigoUnidade),
        quantidade: numero(l.quantidade),
        valor_total: numero(l.valorTotal),
        data_atualizacao: texto(l.dataAtualizacao),
        data_atualizacao_global: texto(l.dataAtualizacaoGlobalPCA),
        numero_controle_pncp: controle,
        cabecalho: cabecalhoDaImpressao(l),
      });
    }
    if (body.length < TAMANHO_PAGINA_IMPRESSAO) return { ok: true, planos };
  }
  return { ok: false, erro: `consolidado/unidades: mais de ${MAX_PAGINAS_IMPRESSAO} páginas` };
}

function mesmoInstante(a: unknown, b: unknown): boolean {
  if (a == null || b == null) return a == null && b == null;
  const x = Date.parse(String(a));
  const y = Date.parse(String(b));
  return Number.isFinite(x) && Number.isFinite(y) ? x === y : String(a) === String(b);
}

function mesmoNumero(a: unknown, b: unknown): boolean {
  const x = numero(a);
  const y = numero(b);
  return x === null || y === null ? x === y : Math.abs(x - y) < 0.005;
}

/** Plano sem impressão anterior ou com data, quantidade ou valor diferente (CA-4). */
export function planoMudou(anterior: Row | undefined, lido: PlanoImpresso): boolean {
  return !anterior || (anterior.quantidade == null && anterior.data_atualizacao == null) ||
    !mesmoInstante(anterior.data_atualizacao, lido.data_atualizacao) ||
    !mesmoNumero(anterior.quantidade, lido.quantidade) ||
    !mesmoNumero(anterior.valor_total, lido.valor_total);
}

/** CNPJs distintos dos planos gravados no ano. */
async function orgaosDoAno(client: SupabaseClient, ano: number): Promise<string[]> {
  const cnpjs = new Set<string>();
  for (let de = 0;; de += PAGINA_BANCO) {
    const { data, error } = await client.from("pca_planos").select("orgao_cnpj").eq("ano_exercicio", ano)
      .order("orgao_cnpj").range(de, de + PAGINA_BANCO - 1);
    if (error) throw error;
    const linhas = (data ?? []) as Row[];
    for (const r of linhas) if (r.orgao_cnpj) cnpjs.add(String(r.orgao_cnpj));
    if (linhas.length < PAGINA_BANCO) break;
  }
  return [...cnpjs];
}

/** Início do dia em Brasília (UTC-3, sem horário de verão desde 2019), em ISO. */
function inicioDoDiaBrasilia(agora = new Date()): number {
  const local = new Date(agora.getTime() - 3 * 3600_000);
  return Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()) + 3 * 3600_000;
}

/** Ordem de leitura: órgão nunca lido primeiro, depois a leitura mais antiga; quem já foi lido hoje fica de fora. */
async function ordenarOrgaos(client: SupabaseClient, ano: number, cnpjs: string[], pularLidosHoje: boolean) {
  const { data, error } = await client.schema("private").from("pca_impressao_orgao")
    .select("orgao_cnpj, lido_em").eq("ano", ano);
  if (error) throw error;
  const lidoEm = new Map(((data ?? []) as Row[]).map((r) => [String(r.orgao_cnpj), Date.parse(String(r.lido_em))]));
  const hoje = inicioDoDiaBrasilia();
  return cnpjs
    .filter((c) => !pularLidosHoje || !(Number(lidoEm.get(c)) >= hoje))
    .sort((a, b) => (lidoEm.get(a) ?? -Infinity) - (lidoEm.get(b) ?? -Infinity) || a.localeCompare(b));
}

async function registrarOrgao(client: SupabaseClient, linha: Row) {
  const { error } = await client.schema("private").from("pca_impressao_orgao")
    .upsert(linha, { onConflict: "orgao_cnpj,ano" });
  if (error) throw error;
}

/** Compara a leitura completa do órgão com a impressão anterior, grava a nova e enfileira o que mudou. */
async function processarOrgao(
  client: SupabaseClient,
  cnpj: string,
  planos: PlanoImpresso[],
  stats: ImpressaoStats,
  opts: { ano: number; classes: string[]; runId: string },
) {
  const { ano, classes, runId } = opts;
  const agora = new Date().toISOString();
  const { data: ant, error: eAnt } = await client.schema("private").from("pca_impressao_plano")
    .select("sequencial, quantidade, valor_total, data_atualizacao, ausente_leituras")
    .eq("orgao_cnpj", cnpj).eq("ano", ano);
  if (eAnt) throw eAnt;
  const anteriores = new Map(((ant ?? []) as Row[]).map((r) => [Number(r.sequencial), r]));

  const fila: ItemFila[] = planos.filter((p) => planoMudou(anteriores.get(p.sequencial), p)).map((p) => ({
    id_pca_pncp: p.numero_controle_pncp,
    orgao_cnpj: cnpj,
    ano,
    sequencial: p.sequencial,
    motivo: "impressao",
    plano: p.cabecalho,
    classes,
    data_atualizacao_fonte: p.data_atualizacao_global ?? p.data_atualizacao,
    chain_id: runId,
  }));

  // Ausentes: planos ativos gravados do órgão que não vieram nesta leitura completa.
  const { data: gravados, error: eGrav } = await client.from("pca_planos")
    .select("id, id_pca_pncp, numero_plano, ativo").eq("orgao_cnpj", cnpj).eq("ano_exercicio", ano);
  if (eGrav) throw eGrav;
  const lidos = new Set(planos.map((p) => p.sequencial));
  const ausentes = ((gravados ?? []) as Row[])
    .filter((p) => p.ativo !== false && numero(p.numero_plano) !== null && !lidos.has(Number(p.numero_plano)));

  const impressoes: Row[] = planos.map((p) => ({
    orgao_cnpj: cnpj,
    ano,
    sequencial: p.sequencial,
    codigo_unidade: p.codigo_unidade,
    quantidade: p.quantidade,
    valor_total: p.valor_total,
    data_atualizacao: p.data_atualizacao,
    data_atualizacao_global: p.data_atualizacao_global,
    numero_controle_pncp: p.numero_controle_pncp,
    ausente_leituras: 0,
    lido_em: agora,
    sync_run_id: runId,
  }));

  // Impressão antes da fila: a carga confere a quantidade lida com a impressão gravada (CA-5).
  for (let i = 0; i < impressoes.length; i += 500) {
    const { error } = await client.schema("private").from("pca_impressao_plano")
      .upsert(impressoes.slice(i, i + 500), { onConflict: "orgao_cnpj,ano,sequencial" });
    if (error) throw error;
  }
  if (fila.length > 0) stats.enfileirados += await enfileirar(client, fila);

  for (const p of ausentes) {
    const sequencial = Number(p.numero_plano);
    const anterior = anteriores.get(sequencial);
    const leituras = Number(anterior?.ausente_leituras ?? 0) + 1;
    if (leituras === 1) {
      const { error } = await client.from("pca_alteracoes").insert({
        pca_plano_id: p.id,
        tipo_operacao: "aviso",
        evento: "pca_removido",
        dados_novos: { situacao: "a_confirmar", id_pca_pncp: p.id_pca_pncp, orgao_cnpj: cnpj, sequencial },
        sync_run_id: runId,
      });
      if (error) throw error;
      stats.removidos_a_confirmar++;
    } else {
      const r = await inativarAusenteNoEscopo(client, String(p.id), classes);
      stats.itens_inativados += r.itens;
      if (r.plano) stats.planos_inativados++;
    }
    const { error } = await client.schema("private").from("pca_impressao_plano").upsert({
      orgao_cnpj: cnpj,
      ano,
      sequencial,
      ausente_leituras: leituras,
      lido_em: agora,
      sync_run_id: runId,
    }, { onConflict: "orgao_cnpj,ano,sequencial" });
    if (error) throw error;
  }

  await registrarOrgao(client, { orgao_cnpj: cnpj, ano, lido_em: agora, planos: planos.length, erro: null, sync_run_id: runId });
  stats.orgaos_lidos++;
  stats.planos_lidos += planos.length;
}

/**
 * Lê a impressão dos órgãos do ano (ou dos `orgaos` informados, na descoberta), um por vez, até o limite ou o prazo.
 * Órgão já lido hoje (Brasília) fica de fora da leitura diária: cada disparo do cron pega os que faltam.
 */
export async function executarImpressao(
  client: SupabaseClient,
  integracao: IntegracaoImpressao,
  opts: {
    ano: number;
    classes: string[];
    limiteOrgaos: number;
    prazoEsgotado: () => boolean;
    runId: string;
    orgaos?: string[];
    http?: OpcoesHttp;
  },
): Promise<ImpressaoStats> {
  const stats: ImpressaoStats = {
    orgaos_lidos: 0,
    orgaos_erro: 0,
    planos_lidos: 0,
    enfileirados: 0,
    removidos_a_confirmar: 0,
    itens_inativados: 0,
    planos_inativados: 0,
    pausa: null,
    restantes: 0,
  };
  const candidatos = opts.orgaos ?? await orgaosDoAno(client, opts.ano);
  const orgaos = await ordenarOrgaos(client, opts.ano, candidatos, opts.orgaos === undefined);
  let i = 0;
  for (; i < orgaos.length && i < opts.limiteOrgaos && !opts.prazoEsgotado(); i++) {
    const cnpj = orgaos[i];
    let leitura: Awaited<ReturnType<typeof lerImpressaoOrgao>>;
    try {
      leitura = await lerImpressaoOrgao(integracao, cnpj, opts.ano, { ...opts.http, syncRunId: opts.runId });
    } catch (error) {
      stats.pausa = `${cnpj}: ${error instanceof Error ? error.message : String(error)}`.slice(0, 500);
      break;
    }
    if (!leitura.ok) {
      await registrarOrgao(client, {
        orgao_cnpj: cnpj,
        ano: opts.ano,
        lido_em: new Date().toISOString(),
        erro: leitura.erro.slice(0, 500),
        sync_run_id: opts.runId,
      });
      stats.orgaos_erro++;
      continue;
    }
    await processarOrgao(client, cnpj, leitura.planos, stats, opts);
  }
  stats.restantes = orgaos.length - i;
  return stats;
}
