import { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { gravarPaginaPcaEmLote, type LoteStats, selectIn } from "./pca-lote.ts";
import { BudgetExhaustedError } from "./retry.ts";
import { RateLimitPauseError } from "../http-client/index.ts";

/**
 * Sync do PCA por fila de planos (spec 0012, PR 2).
 *
 * Fase A, descoberta: a consulta `/pca/` por classe lista os planos e `dataAtualizacaoGlobalPCA`. Ela não serve para
 * itens: a paginação repete e pula itens (medido em 09/10/2026). Os planos novos ou alterados vão para
 * `private.pca_plano_fila`. A fase A não grava plano nem item: se gravasse o cabeçalho antes dos itens, uma carga que
 * falhasse depois deixaria a data já atualizada e o plano nunca voltaria para a fila.
 *
 * Fase B, carga: tira planos da fila e lê os itens pela integração por plano (`/orgaos/{cnpj}/pca/{ano}/{seq}/itens`),
 * que é completa. Grava cabeçalho + itens do escopo em lote e inativa os itens do escopo daquele plano que não vieram.
 */

type Row = Record<string, unknown>;

/** Lê todas as linhas de uma consulta paginando por faixa (o PostgREST corta em max-rows). Para em página vazia. */
async function lerTudo(
  consulta: (de: number, ate: number) => PromiseLike<{ data: unknown; error: unknown }>,
): Promise<Row[]> {
  const out: Row[] = [];
  for (let de = 0;;) {
    const { data, error } = await consulta(de, de + 999);
    if (error) throw error;
    const pagina = (data ?? []) as Row[];
    if (pagina.length === 0) return out;
    out.push(...pagina);
    de += pagina.length;
  }
}

export type Rotina = "incremental" | "backfill" | "reconciliacao";
export const ROTINAS: Rotina[] = ["incremental", "backfill", "reconciliacao"];

export type PlanoDescoberto = {
  id_pca_pncp: string;
  orgao_cnpj: string;
  ano: number;
  sequencial: number;
  data_atualizacao_fonte: string | null;
  /** cabeçalho do plano como veio da consulta, sem itens */
  plano: Row;
};

/** idPcaPncp = {CNPJ14}-{segmento}-{sequencial6}/{ano} */
const ID_PCA = /^(\d{14})-\d+-(\d{1,6})\/(\d{4})$/;

export function planoDaConsulta(raw: Row): PlanoDescoberto | null {
  const id = String(raw.idPcaPncp ?? "").trim();
  const m = ID_PCA.exec(id);
  if (!m) return null;
  const { itens: _itens, ...cabecalho } = raw;
  return {
    id_pca_pncp: id,
    orgao_cnpj: m[1],
    sequencial: Number(m[2]),
    ano: Number(m[3]),
    data_atualizacao_fonte: raw.dataAtualizacaoGlobalPCA ? String(raw.dataAtualizacaoGlobalPCA) : null,
    plano: cabecalho,
  };
}

/** Data da fonte vem sem fuso ("2026-09-21T11:31:57"); o banco grava como UTC. */
function instante(v: unknown): number | null {
  if (v == null || v === "") return null;
  const s = String(v);
  const comFuso = /([zZ]|[+-]\d{2}:?\d{2})$/.test(s) ? s : `${s}Z`;
  const t = Date.parse(comFuso);
  return Number.isFinite(t) ? t : null;
}

export interface ConsultaPca {
  fetchPcaPage(
    ano: number,
    pagina: number,
    codigo: string,
    tamanhoPagina?: number,
  ): Promise<{ status: number; body: unknown }>;
}

export type Descoberta = {
  planos: Map<string, PlanoDescoberto>;
  /** todas as páginas de todas as classes lidas sem erro */
  completo: boolean;
  paginas: number;
  linhas: number;
  pares_distintos: number;
  erro: string | null;
};

/** Fase A: lê as páginas da consulta por classe até o fim ou até o prazo. Erro de página encerra como incompleta. */
export async function descobrirPlanos(
  consulta: ConsultaPca,
  opts: { ano: number; classes: string[]; tamanhoPagina: number; prazoEsgotado: () => boolean },
): Promise<Descoberta> {
  const res: Descoberta = {
    planos: new Map(),
    completo: false,
    paginas: 0,
    linhas: 0,
    pares_distintos: 0,
    erro: null,
  };
  const pares = new Set<string>();
  try {
    for (const codigo of opts.classes) {
      for (let pagina = 1;; pagina++) {
        if (opts.prazoEsgotado()) {
          res.erro = "prazo esgotado na descoberta";
          return res;
        }
        const { status, body } = await consulta.fetchPcaPage(opts.ano, pagina, codigo, opts.tamanhoPagina);
        res.paginas++;
        if (status === 204) break; // fim válido, sem conteúdo
        const obj = (body && typeof body === "object" ? body : null) as Row | null;
        if (status >= 400 || !obj || !Array.isArray(obj.data)) {
          throw new Error(`consulta /pca/ classe ${codigo} página ${pagina}: HTTP ${status} ou envelope sem data[]`);
        }
        for (const raw of obj.data as Row[]) {
          const p = planoDaConsulta(raw);
          if (!p) continue;
          res.planos.set(p.id_pca_pncp, p);
          for (const item of (Array.isArray(raw.itens) ? raw.itens : []) as Row[]) {
            res.linhas++;
            pares.add(`${p.id_pca_pncp}|${item.numeroItem}`);
          }
        }
        if (Number(obj.paginasRestantes ?? 0) <= 0) break;
      }
    }
    res.completo = true;
  } catch (error) {
    if (error instanceof BudgetExhaustedError || error instanceof RateLimitPauseError) throw error;
    res.erro = error instanceof Error ? error.message : String(error);
  } finally {
    res.pares_distintos = pares.size;
  }
  return res;
}

type ItemFila = {
  id_pca_pncp: string;
  orgao_cnpj: string;
  ano: number;
  sequencial: number;
  motivo: "novo" | "alterado" | "backfill" | "reconciliacao" | "ausente";
  plano: Row | null;
  data_atualizacao_fonte: string | null;
  chain_id: string;
};

async function enfileirar(client: SupabaseClient, itens: ItemFila[]): Promise<number> {
  let total = 0;
  for (let i = 0; i < itens.length; i += 500) {
    const { data, error } = await client.schema("private").rpc("pca_fila_enfileirar", {
      p_itens: itens.slice(i, i + 500),
    });
    if (error) throw error;
    total += Number(data ?? 0);
  }
  return total;
}

/**
 * Decide o que entra na fila. incremental: plano novo, com `dataAtualizacaoGlobalPCA` maior que a gravada, sem data
 * gravada ou inativo. backfill/reconciliacao: todos os descobertos.
 */
export async function enfileirarDescobertos(
  client: SupabaseClient,
  descoberta: Descoberta,
  rotina: Rotina,
  chainId: string,
): Promise<{ enfileirados: number; novos: number; alterados: number; sem_mudanca: number }> {
  const out = { enfileirados: 0, novos: 0, alterados: 0, sem_mudanca: 0 };
  const planos = [...descoberta.planos.values()];
  if (planos.length === 0) return out;
  const banco = new Map(
    (await selectIn(client, "pca_planos", "id, id_pca_pncp, data_atualizacao_origem, ativo", "id_pca_pncp",
      planos.map((p) => p.id_pca_pncp)))
      .map((r) => [String(r.id_pca_pncp), r]),
  );
  const fila: ItemFila[] = [];
  for (const p of planos) {
    const atual = banco.get(p.id_pca_pncp);
    let motivo: ItemFila["motivo"] | null;
    if (rotina !== "incremental") {
      motivo = rotina;
    } else if (!atual) {
      motivo = "novo";
    } else {
      const fonte = instante(p.data_atualizacao_fonte);
      const gravada = instante(atual.data_atualizacao_origem);
      motivo = atual.ativo === false || gravada == null || (fonte != null && fonte > gravada) ? "alterado" : null;
    }
    if (!motivo) {
      out.sem_mudanca++;
      continue;
    }
    if (motivo === "novo") out.novos++;
    else if (motivo === "alterado") out.alterados++;
    fila.push({ ...p, motivo, chain_id: chainId });
  }
  out.enfileirados = await enfileirar(client, fila);
  return out;
}

/** Depois de descoberta completa: atualiza o contador de ausência e, na reconciliação, enfileira os ausentes. */
export async function tratarAusentes(
  client: SupabaseClient,
  descoberta: Descoberta,
  opts: { ano: number; classes: string[]; rotina: Rotina; chainId: string },
): Promise<{ ausentes_2_ou_mais: number; enfileirados: number }> {
  const { data, error } = await client.schema("private").rpc("pca_marcar_descoberta", {
    p_ano: opts.ano,
    p_vistos: [...descoberta.planos.keys()],
    p_classes: opts.classes,
  });
  if (error) throw error;
  const ausentes = Number(data ?? 0);
  if (opts.rotina !== "reconciliacao" || ausentes === 0) return { ausentes_2_ou_mais: ausentes, enfileirados: 0 };

  const linhas = await lerTudo((de, ate) =>
    client.from("pca_planos").select("id, id_pca_pncp")
      .eq("ano_exercicio", opts.ano).eq("ativo", true).gte("descoberta_ausente_seguidas", 2)
      .order("id").range(de, ate)
  );
  const fila: ItemFila[] = [];
  for (const r of linhas) {
    const m = ID_PCA.exec(String(r.id_pca_pncp));
    if (!m) continue;
    fila.push({
      id_pca_pncp: String(r.id_pca_pncp),
      orgao_cnpj: m[1],
      sequencial: Number(m[2]),
      ano: Number(m[3]),
      motivo: "ausente",
      plano: null,
      data_atualizacao_fonte: null,
      chain_id: opts.chainId,
    });
  }
  return { ausentes_2_ou_mais: ausentes, enfileirados: await enfileirar(client, fila) };
}

export interface IntegracaoPca {
  getPcaItens(cnpj: string, ano: number, sequencial: number, pagina: number, tamanhoPagina: number): Promise<unknown>;
}

/** A integração aceitou 2000 por página na medição de 09/10 (plano de 1.800 itens numa página). */
export const TAMANHO_PAGINA_INTEGRACAO = 2000;
const MAX_PAGINAS_PLANO = 20;

/** Lê todos os itens do plano pela integração. Resposta que não é array é erro, nunca "plano sem itens". */
export async function lerItensPlano(integracao: IntegracaoPca, cnpj: string, ano: number, sequencial: number) {
  const itens: Row[] = [];
  for (let pagina = 1; pagina <= MAX_PAGINAS_PLANO; pagina++) {
    const res = await integracao.getPcaItens(cnpj, ano, sequencial, pagina, TAMANHO_PAGINA_INTEGRACAO);
    if (!Array.isArray(res)) throw new Error(`integração ${cnpj}/${ano}/${sequencial} página ${pagina}: resposta não é lista`);
    itens.push(...(res as Row[]));
    if (res.length < TAMANHO_PAGINA_INTEGRACAO) return itens;
  }
  throw new Error(`integração ${cnpj}/${ano}/${sequencial}: mais de ${MAX_PAGINAS_PLANO} páginas`);
}

/**
 * Item da integração no formato da consulta, que é o que o normalizador lê. Nomes que mudam (medido em 09/10/2026 no
 * plano do Galeão, com valores iguais): quantidade → quantidadeEstimada, descricao → descricaoItem,
 * nomeClassificacao → nomeClassificacaoCatalogo. Os demais campos têm o mesmo nome.
 */
export function itemIntegracaoParaConsulta(item: Row): Row {
  const { quantidade, descricao, nomeClassificacao, ...resto } = item;
  return {
    ...resto,
    quantidadeEstimada: quantidade ?? null,
    descricaoItem: descricao ?? null,
    nomeClassificacaoCatalogo: nomeClassificacao ?? null,
  };
}

async function inativarItensAusentes(
  client: SupabaseClient,
  idPcaPncp: string,
  numerosVindos: Set<number>,
  classes: string[],
): Promise<number> {
  const { data: plano, error } = await client.from("pca_planos").select("id").eq("id_pca_pncp", idPcaPncp)
    .maybeSingle();
  if (error) throw error;
  if (!plano) return 0;
  const ativos = (await selectIn(client, "pca_itens", "id, numero_item, ativo", "pca_plano_id",
    [(plano as Row).id], { column: "classe_material_servico", values: classes }))
    .filter((r) => r.ativo !== false && !numerosVindos.has(Number(r.numero_item)));
  for (let i = 0; i < ativos.length; i += 100) {
    const { error: e2 } = await client.from("pca_itens").update({ ativo: false })
      .in("id", ativos.slice(i, i + 100).map((r) => r.id));
    if (e2) throw e2;
  }
  return ativos.length;
}

async function inativarPlano(client: SupabaseClient, idPcaPncp: string): Promise<number> {
  const { data: plano, error } = await client.from("pca_planos").select("id").eq("id_pca_pncp", idPcaPncp)
    .maybeSingle();
  if (error) throw error;
  if (!plano) return 0;
  const { error: e1 } = await client.from("pca_itens").update({ ativo: false }).eq("pca_plano_id", (plano as Row).id);
  if (e1) throw e1;
  const { error: e2 } = await client.from("pca_planos").update({ ativo: false }).eq("id", (plano as Row).id);
  if (e2) throw e2;
  return 1;
}

export type FilaStats = LoteStats & {
  planos_feitos: number;
  planos_erro: number;
  itens_inativados: number;
  planos_inativados: number;
};

async function marcarFila(client: SupabaseClient, linha: Row, ok: boolean, erro: string | null) {
  const patch: Row = ok
    ? { status: "feito", erro: null, processado_em: new Date().toISOString(), atualizado_em: new Date().toISOString() }
    : {
      status: "erro",
      erro: (erro ?? "erro").slice(0, 500),
      tentativas: Number(linha.tentativas ?? 0) + 1,
      atualizado_em: new Date().toISOString(),
    };
  const { error } = await client.schema("private").from("pca_plano_fila").update({ ...patch, chain_id: linha.chain_id })
    .eq("id", linha.id);
  if (error) throw error;
}

/**
 * Fase B: processa planos da fila até `limite` ou até o prazo. Um plano por vez, 1 requisição por plano na
 * integração (mais páginas só acima de 2.000 itens). Plano com erro não inativa nada.
 */
export async function processarFila(
  client: SupabaseClient,
  integracao: IntegracaoPca,
  opts: { classes: string[]; limite: number; prazoEsgotado: () => boolean; runId: string },
): Promise<FilaStats> {
  const stats: FilaStats = {
    recebidos: 0,
    novos: 0,
    alterados: 0,
    inalterados: 0,
    erros: 0,
    planos_feitos: 0,
    planos_erro: 0,
    itens_inativados: 0,
    planos_inativados: 0,
  };
  const classes = new Set(opts.classes.map(String));
  let processados = 0;
  while (processados < opts.limite && !opts.prazoEsgotado()) {
    const { data, error } = await client.schema("private").rpc("pca_fila_reservar", {
      p_limite: Math.min(5, opts.limite - processados),
      p_max_tentativas: 5,
    });
    if (error) throw error;
    const reservados = (data ?? []) as Row[];
    if (reservados.length === 0) break;

    for (let i = 0; i < reservados.length; i++) {
      const linha = reservados[i];
      if (opts.prazoEsgotado()) {
        // devolve o que foi reservado e não processado; próxima invocação pega
        for (const resto of reservados.slice(i)) {
          await client.schema("private").from("pca_plano_fila").update({ status: "pendente" }).eq("id", resto.id);
        }
        return stats;
      }
      processados++;
      try {
        const todos = await lerItensPlano(
          integracao,
          String(linha.orgao_cnpj),
          Number(linha.ano),
          Number(linha.sequencial),
        );
        const escopo = todos.filter((it) => classes.has(String(it.classificacaoSuperiorCodigo ?? "")));
        if (linha.motivo === "ausente") {
          // Ausente em 2 descobertas seguidas: só inativa se a integração confirmar que não há item do escopo.
          if (escopo.length === 0) stats.planos_inativados += await inativarPlano(client, String(linha.id_pca_pncp));
          await marcarFila(client, linha, true, null);
          stats.planos_feitos++;
          continue;
        }
        if (!linha.plano || typeof linha.plano !== "object") throw new Error("fila sem cabeçalho do plano");
        const r = await gravarPaginaPcaEmLote(
          client,
          [{ ...(linha.plano as Row), itens: escopo.map(itemIntegracaoParaConsulta) }],
          { ano: Number(linha.ano), runId: opts.runId },
        );
        stats.recebidos += r.recebidos;
        stats.novos += r.novos;
        stats.alterados += r.alterados;
        stats.inalterados += r.inalterados;
        stats.erros += r.erros;
        if (r.erros > 0) {
          await marcarFila(client, linha, false, `${r.erros} erro(s) na gravação em lote`);
          stats.planos_erro++;
          continue;
        }
        stats.itens_inativados += await inativarItensAusentes(
          client,
          String(linha.id_pca_pncp),
          new Set(escopo.map((it) => Number(it.numeroItem))),
          opts.classes,
        );
        await marcarFila(client, linha, true, null);
        stats.planos_feitos++;
      } catch (error) {
        if (error instanceof BudgetExhaustedError || error instanceof RateLimitPauseError) {
          // pausa de cota: não é falha do plano; volta para a fila sem gastar tentativa
          for (const resto of reservados.slice(i)) {
            await client.schema("private").from("pca_plano_fila").update({ status: "pendente" }).eq("id", resto.id);
          }
          throw error;
        }
        stats.erros++;
        stats.planos_erro++;
        await marcarFila(client, linha, false, error instanceof Error ? error.message : String(error));
      }
    }
  }
  return stats;
}

/** Planos ainda abertos e que a reserva ainda pode pegar (pendente, processando ou erro com tentativas). */
export async function contarAbertos(client: SupabaseClient): Promise<number> {
  const linhas = await lerTudo((de, ate) =>
    client.schema("private").from("pca_plano_fila").select("id, status, tentativas")
      .in("status", ["pendente", "processando", "erro"]).order("id").range(de, ate)
  );
  return linhas.filter((r) => r.status !== "erro" || Number(r.tentativas) < 5).length;
}
