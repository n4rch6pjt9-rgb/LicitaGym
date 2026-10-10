import { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { gravarItensDePlanoExistente, gravarPaginaPcaEmLote, type LoteStats, selectIn } from "./pca-lote.ts";
import { BudgetExhaustedError, type RequestBudget } from "./retry.ts";
import { RateLimitPauseError } from "../http-client/index.ts";

/**
 * Sync do PCA por fila de planos (spec 0012, PR 2).
 *
 * Fase A, descoberta: a consulta `/pca/` por classe lista os planos e `dataAtualizacaoGlobalPCA`. Ela não serve para
 * itens: a paginação repete e pula itens (medido em 09/10/2026). Os planos novos ou alterados vão para
 * `private.pca_plano_fila`, com as classes do escopo. A fase A não grava plano nem item: se gravasse o cabeçalho antes
 * dos itens, uma carga que falhasse depois deixaria a data já atualizada e o plano nunca voltaria para a fila.
 *
 * Fase B, carga: tira planos da fila e lê os itens pela integração por plano (`/orgaos/{cnpj}/pca/{ano}/{seq}/itens`),
 * conferindo o total com `/itens/quantidade`. Grava cabeçalho + itens do escopo em lote e inativa os itens do escopo
 * daquele plano que não vieram. Leitura que não fecha com a quantidade é erro: nada é inativado.
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

const ePausa = (e: unknown) => e instanceof BudgetExhaustedError || e instanceof RateLimitPauseError;

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

export type OpcoesHttp = { budget?: RequestBudget; syncRunId?: string };

export interface ConsultaPca {
  fetchPcaPage(
    ano: number,
    pagina: number,
    codigo: string,
    tamanhoPagina?: number,
    options?: OpcoesHttp,
  ): Promise<{ status: number; body: unknown }>;
}

/** Posição da descoberta para retomar (classe e página seguintes). */
export type PosicaoDescoberta = { classe_idx: number; pagina: number };

export type Descoberta = {
  planos: Map<string, PlanoDescoberto>;
  /** todas as páginas de todas as classes lidas sem erro, a partir da página 1 da primeira classe */
  completo: boolean;
  /** onde retomar quando não terminou; null quando terminou */
  retomar_de: PosicaoDescoberta | null;
  paginas: number;
  linhas: number;
  pares_distintos: number;
  erro: string | null;
};

/**
 * Fase A: lê as páginas da consulta por classe até o fim ou até o prazo. Erro de página, prazo ou pausa de cota
 * encerram como incompleta, com os planos já lidos e a posição para retomar (erro ≠ vazio: nada é "provado ausente").
 */
export async function descobrirPlanos(
  consulta: ConsultaPca,
  opts: {
    ano: number;
    classes: string[];
    tamanhoPagina: number;
    prazoEsgotado: () => boolean;
    inicio?: PosicaoDescoberta;
    http?: OpcoesHttp;
  },
): Promise<Descoberta> {
  const inicio = opts.inicio ?? { classe_idx: 0, pagina: 1 };
  const res: Descoberta = {
    planos: new Map(),
    completo: false,
    retomar_de: null,
    paginas: 0,
    linhas: 0,
    pares_distintos: 0,
    erro: null,
  };
  const pares = new Set<string>();
  let pos = { ...inicio };
  try {
    for (; pos.classe_idx < opts.classes.length; pos = { classe_idx: pos.classe_idx + 1, pagina: 1 }) {
      const codigo = opts.classes[pos.classe_idx];
      for (;; pos.pagina++) {
        if (opts.prazoEsgotado()) throw new Error("prazo esgotado na descoberta");
        const { status, body } = await consulta.fetchPcaPage(opts.ano, pos.pagina, codigo, opts.tamanhoPagina, {
          ...opts.http,
        });
        res.paginas++;
        if (status === 204) break; // fim válido, sem conteúdo
        const obj = (body && typeof body === "object" ? body : null) as Row | null;
        if (status >= 400 || !obj || !Array.isArray(obj.data)) {
          throw new Error(`consulta /pca/ classe ${codigo} página ${pos.pagina}: HTTP ${status} ou envelope sem data[]`);
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
    // Completo só se começou do início: retomada não cobre as páginas lidas pela invocação anterior.
    res.completo = inicio.classe_idx === 0 && inicio.pagina === 1;
  } catch (error) {
    res.retomar_de = { ...pos };
    res.erro = ePausa(error) ? "pausa de cota" : (error instanceof Error ? error.message : String(error));
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
  classes: string[];
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
  opts: { chainId: string; classes: string[] },
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
    fila.push({ ...p, motivo, classes: opts.classes, chain_id: opts.chainId });
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
      classes: opts.classes,
      data_atualizacao_fonte: null,
      chain_id: opts.chainId,
    });
  }
  return { ausentes_2_ou_mais: ausentes, enfileirados: await enfileirar(client, fila) };
}

export interface IntegracaoPca {
  getPcaItensPagina(
    cnpj: string,
    ano: number,
    sequencial: number,
    pagina: number,
    tamanhoPagina: number,
    options?: OpcoesHttp & { attemptTimeoutMs?: number },
  ): Promise<{ status: number; body: unknown }>;
  getPcaItensQuantidade(
    cnpj: string,
    ano: number,
    sequencial: number,
    options?: OpcoesHttp & { attemptTimeoutMs?: number },
  ): Promise<{ status: number; body: unknown }>;
}

/**
 * Página da integração. 2000 foi aceito na medição de 09/10 (plano de 1.800 itens numa página), mas o teto real do
 * servidor não foi medido. Por isso o fim da leitura não é decidido só pelo tamanho da página: o total lido tem de
 * fechar com `/itens/quantidade`.
 */
export const TAMANHO_PAGINA_INTEGRACAO = 2000;
/** Teto de segurança contra laço: 20 páginas de 2.000 = 40.000 itens num plano (o maior medido tinha 1.800). */
const MAX_PAGINAS_PLANO = 20;
/** Timeout por tentativa na integração (respostas medidas de 0,2 a 0,4 s; o orçamento corta antes, se precisar). */
const TIMEOUT_TENTATIVA_INTEGRACAO_MS = 30_000;

/**
 * Lê todos os itens do plano pela integração e confere com a quantidade. 204 = fim; HTTP ≥ 400, resposta que não é
 * lista ou total que não fecha = erro (nunca "plano sem itens").
 */
export async function lerItensPlano(
  integracao: IntegracaoPca,
  cnpj: string,
  ano: number,
  sequencial: number,
  http: OpcoesHttp = {},
) {
  const opcoes = { ...http, attemptTimeoutMs: TIMEOUT_TENTATIVA_INTEGRACAO_MS };
  const itens: Row[] = [];
  let terminou = false;
  for (let pagina = 1; pagina <= MAX_PAGINAS_PLANO && !terminou; pagina++) {
    const { status, body } = await integracao.getPcaItensPagina(
      cnpj,
      ano,
      sequencial,
      pagina,
      TAMANHO_PAGINA_INTEGRACAO,
      opcoes,
    );
    if (status === 204) break;
    if (status >= 400 || !Array.isArray(body)) {
      throw new Error(`integração ${cnpj}/${ano}/${sequencial} página ${pagina}: HTTP ${status} ou resposta não é lista`);
    }
    itens.push(...(body as Row[]));
    terminou = body.length < TAMANHO_PAGINA_INTEGRACAO;
  }
  const q = await integracao.getPcaItensQuantidade(cnpj, ano, sequencial, opcoes);
  const quantidade = Number(q.body);
  if (q.status !== 200 || !Number.isInteger(quantidade)) {
    throw new Error(`integração ${cnpj}/${ano}/${sequencial}: quantidade inválida (HTTP ${q.status})`);
  }
  if (quantidade !== itens.length) {
    throw new Error(`integração ${cnpj}/${ano}/${sequencial}: leitura incompleta (${itens.length} de ${quantidade})`);
  }
  return itens;
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

async function idDoPlano(client: SupabaseClient, idPcaPncp: string): Promise<string | null> {
  const { data, error } = await client.from("pca_planos").select("id").eq("id_pca_pncp", idPcaPncp).maybeSingle();
  if (error) throw error;
  return data ? String((data as Row).id) : null;
}

async function inativarItensAusentes(
  client: SupabaseClient,
  planoId: string,
  numerosVindos: Set<number>,
  classes: string[],
): Promise<number> {
  const ativos = (await selectIn(client, "pca_itens", "id, numero_item, ativo", "pca_plano_id", [planoId], {
    column: "classe_material_servico",
    values: classes,
  })).filter((r) => r.ativo !== false && !numerosVindos.has(Number(r.numero_item)));
  for (let i = 0; i < ativos.length; i += 100) {
    const { error } = await client.from("pca_itens").update({ ativo: false })
      .in("id", ativos.slice(i, i + 100).map((r) => r.id));
    if (error) throw error;
  }
  return ativos.length;
}

/**
 * Plano ausente sem item do escopo na integração: inativa só os itens das classes do escopo. O plano só é inativado se
 * não sobrar item ativo de outra classe (um plano com 7220 numa reconciliação só de 7830 continua ativo, com os itens
 * 7220). Se o plano continua ativo, o contador de ausência zera: ele não tem mais item do escopo, e a ausência
 * medida pela descoberta dessas classes não diz nada sobre as outras.
 */
async function inativarAusenteNoEscopo(
  client: SupabaseClient,
  planoId: string,
  classes: string[],
): Promise<{ itens: number; plano: boolean }> {
  const itens = await inativarItensAusentes(client, planoId, new Set(), classes);
  const { data, error } = await client.from("pca_itens").select("id")
    .eq("pca_plano_id", planoId).eq("ativo", true).limit(1);
  if (error) throw error;
  const restam = ((data ?? []) as Row[]).length > 0;
  const { error: e2 } = await client.from("pca_planos")
    .update(restam ? { descoberta_ausente_seguidas: 0 } : { ativo: false }).eq("id", planoId);
  if (e2) throw e2;
  return { itens, plano: !restam };
}

export type FilaStats = LoteStats & {
  planos_feitos: number;
  planos_erro: number;
  itens_inativados: number;
  planos_inativados: number;
};

async function marcarFila(client: SupabaseClient, linha: Row, ok: boolean, erro: string | null) {
  const agora = new Date().toISOString();
  const patch: Row = ok
    ? { status: "feito", erro: null, processado_em: agora, atualizado_em: agora }
    : {
      status: "erro",
      erro: (erro ?? "erro").slice(0, 500),
      tentativas: Number(linha.tentativas ?? 0) + 1,
      atualizado_em: agora,
    };
  // Sem chain_id no patch: um reenfileiramento durante o processamento pode ter gravado um chain_id mais novo.
  const { error } = await client.schema("private").from("pca_plano_fila").update(patch).eq("id", linha.id);
  if (error) throw error;
}

/**
 * Devolve para pendente o que foi reservado e não processado. Se a devolução falhar, a reserva recupera a linha
 * 'processando' depois de 15 min; a falha vai para o log em vez de sumir.
 */
async function devolverReservados(client: SupabaseClient, linhas: Row[]) {
  if (linhas.length === 0) return;
  const { error } = await client.schema("private").from("pca_plano_fila")
    .update({ status: "pendente", atualizado_em: new Date().toISOString() })
    .in("id", linhas.map((l) => l.id));
  if (error) {
    console.warn(JSON.stringify({ evento: "pca_fila_devolucao_falhou", linhas: linhas.length, erro: error.message }));
  }
}

/**
 * Fase B: processa planos da fila do ano até `limite` ou até o prazo. Um plano por vez: 1 requisição de itens (mais
 * páginas só acima de 2.000 itens) e 1 de quantidade. Plano com erro não inativa nada.
 */
export async function processarFila(
  client: SupabaseClient,
  integracao: IntegracaoPca,
  opts: {
    ano: number;
    limite: number;
    prazoEsgotado: () => boolean;
    runId: string;
    http?: OpcoesHttp;
    aoTerminarPlano?: () => Promise<void>;
  },
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
  let processados = 0;
  while (processados < opts.limite && !opts.prazoEsgotado()) {
    const { data, error } = await client.schema("private").rpc("pca_fila_reservar", {
      p_limite: Math.min(5, opts.limite - processados),
      p_max_tentativas: 5,
      p_ano: opts.ano,
    });
    if (error) throw error;
    const reservados = (data ?? []) as Row[];
    if (reservados.length === 0) break;

    for (let i = 0; i < reservados.length; i++) {
      const linha = reservados[i];
      if (opts.prazoEsgotado()) {
        await devolverReservados(client, reservados.slice(i));
        return stats;
      }
      processados++;
      const idPca = String(linha.id_pca_pncp);
      const classes = (Array.isArray(linha.classes) && linha.classes.length ? linha.classes : ["7830"]).map(String);
      const doEscopo = new Set(classes);
      try {
        const todos = await lerItensPlano(
          integracao,
          String(linha.orgao_cnpj),
          Number(linha.ano),
          Number(linha.sequencial),
          { ...opts.http, syncRunId: opts.runId },
        );
        const escopo = todos.filter((it) => doEscopo.has(String(it.classificacaoSuperiorCodigo ?? "")));
        const numeros = new Set(escopo.map((it) => Number(it.numeroItem)));

        let r: LoteStats;
        let planoId: string | null;
        if (linha.motivo === "ausente") {
          // Ausente em 2 descobertas seguidas. Sem item do escopo na integração: inativa os itens do escopo (e o plano,
          // se não sobrar item de outra classe). Com item: a consulta pulou o plano, então grava os itens no plano que
          // já existe e zera o contador.
          planoId = await idDoPlano(client, idPca);
          if (!planoId) {
            await marcarFila(client, linha, true, null);
            stats.planos_feitos++;
            continue;
          }
          if (escopo.length === 0) {
            const r0 = await inativarAusenteNoEscopo(client, planoId, classes);
            stats.itens_inativados += r0.itens;
            if (r0.plano) stats.planos_inativados++;
            await marcarFila(client, linha, true, null);
            stats.planos_feitos++;
            continue;
          }
          r = await gravarItensDePlanoExistente(client, planoId, escopo.map(itemIntegracaoParaConsulta), {
            runId: opts.runId,
          });
          const { error: e0 } = await client.from("pca_planos").update({ descoberta_ausente_seguidas: 0 })
            .eq("id", planoId);
          if (e0) throw e0;
        } else {
          if (!linha.plano || typeof linha.plano !== "object") throw new Error("fila sem cabeçalho do plano");
          r = await gravarPaginaPcaEmLote(
            client,
            [{ ...(linha.plano as Row), itens: escopo.map(itemIntegracaoParaConsulta) }],
            { ano: Number(linha.ano), runId: opts.runId },
          );
          planoId = await idDoPlano(client, idPca);
        }
        stats.recebidos += r.recebidos;
        stats.novos += r.novos;
        stats.alterados += r.alterados;
        stats.inalterados += r.inalterados;
        stats.erros += r.erros;
        if (r.erros > 0 || !planoId) {
          // O cabeçalho pode ter ficado com a data nova. Zera a data (o incremental reenfileira o plano mesmo se a fila
          // esgotar as tentativas) e o hash (a próxima gravação vê "alterado" e regrava a linha inteira, data inclusa;
          // com o hash antigo ela seria "inalterado" e a data ficaria nula para sempre).
          const { error: eReset } = await client.from("pca_planos")
            .update({ data_atualizacao_origem: null, payload_hash: "reprocessar" }).eq("id_pca_pncp", idPca);
          if (eReset) throw eReset;
          await marcarFila(client, linha, false, `${r.erros} erro(s) na gravação em lote`);
          stats.planos_erro++;
          continue;
        }
        stats.itens_inativados += await inativarItensAusentes(client, planoId, numeros, classes);
        await marcarFila(client, linha, true, null);
        stats.planos_feitos++;
      } catch (error) {
        if (ePausa(error)) {
          // pausa de cota ou fim do orçamento: não é falha do plano; volta para a fila sem gastar tentativa
          await devolverReservados(client, reservados.slice(i));
          throw error;
        }
        stats.erros++;
        stats.planos_erro++;
        await marcarFila(client, linha, false, error instanceof Error ? error.message : String(error));
      } finally {
        await opts.aoTerminarPlano?.();
      }
    }
  }
  return stats;
}

/** Planos do ano ainda abertos e que a reserva ainda pode pegar, e os que esgotaram as tentativas. */
export async function situacaoFila(client: SupabaseClient, ano: number): Promise<{ abertos: number; esgotados: number }> {
  const linhas = await lerTudo((de, ate) =>
    client.schema("private").from("pca_plano_fila").select("id, status, tentativas")
      .eq("ano", ano).in("status", ["pendente", "processando", "erro"]).order("id").range(de, ate)
  );
  const esgotados = linhas.filter((r) => r.status !== "pendente" && Number(r.tentativas) >= 5).length;
  return { abertos: linhas.length - esgotados, esgotados };
}
