import { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { jsonResponse } from "../_shared/http.ts";
import { acquireSyncLock } from "../_shared/pncp/lock.ts";
import { finishSyncRun, updateSyncHeartbeat } from "../_shared/pncp/supabase-admin.ts";
import {
  type ConsultaPca,
  descobrirPlanos,
  enfileirarDescobertos,
  type IntegracaoPca,
  type PosicaoDescoberta,
  processarFila,
  type Rotina,
  ROTINAS,
  situacaoFila,
  tratarAusentes,
} from "../_shared/pncp/pca-fila.ts";
import { BudgetExhaustedError, createRequestBudget } from "../_shared/pncp/retry.ts";
import { RateLimitPauseError } from "../_shared/http-client/index.ts";

/**
 * Orçamento de relógio por invocação (spec 0012: fatias cronometradas). O teto deixa margem para fechar a execução
 * dentro do limite de parede da Edge Function (150 s, docs/pncp/cron-sync-jobs.md).
 */
const ORCAMENTO_PADRAO_MS = 90_000;
const ORCAMENTO_MAX_MS = 120_000;
/** Folga do orçamento das requisições além do prazo de começar trabalho novo (a última requisição termina). */
const FOLGA_REQUISICAO_MS = 15_000;
const LIMITE_PLANOS_PADRAO = 60;

/** Valor numérico do body/env dentro de [min, max]; ausente ou inválido usa o padrão. */
function limitar(v: unknown, padrao: number, min: number, max: number): number {
  const n = Number(v);
  return v == null || v === "" || !Number.isFinite(n) ? padrao : Math.min(Math.max(n, min), max);
}

export type RotinaBody = {
  rotina?: string;
  somente_retomada?: boolean;
  orcamento_ms?: number;
  limite_planos?: number;
  async?: boolean;
};

/** Guardado em pncp_sync_run.parametros.continuation e herdado pela próxima execução do mesmo lock. */
type ContinuacaoFila = {
  rotina: Rotina;
  classes: string[];
  descoberta?: PosicaoDescoberta | null;
};

/**
 * Sync do PCA por fila (spec 0012, PR 2). `rotina`:
 * - incremental: descoberta → enfileira novos/alterados → carga da fila;
 * - backfill: descoberta → enfileira todos → carga da fila;
 * - reconciliacao: descoberta → enfileira todos e os ausentes em 2 descobertas seguidas → carga da fila.
 * `somente_retomada`: retoma a descoberta que parou no meio (se houver) e a carga da fila (cron de continuação).
 */
export async function handleRotinaFila(params: {
  client: SupabaseClient;
  consulta: ConsultaPca;
  integracao: IntegracaoPca;
  body: RotinaBody;
  ano: number;
  classes: string[];
  tamanhoPagina: number;
  isAsync: boolean;
}): Promise<Response> {
  const { client, consulta, integracao, body, ano, tamanhoPagina } = params;
  if (!ROTINAS.includes(body.rotina as Rotina)) {
    return jsonResponse({ error: `rotina inválida: use ${ROTINAS.join(", ")}` }, 400);
  }
  const somenteRetomada = body.somente_retomada === true;
  const orcamentoMs = limitar(
    body.orcamento_ms ?? Deno.env.get("PCA_FILA_ORCAMENTO_MS"),
    ORCAMENTO_PADRAO_MS,
    10_000,
    ORCAMENTO_MAX_MS,
  );
  const limitePlanos = limitar(
    body.limite_planos ?? Deno.env.get("PCA_FILA_LIMITE_PLANOS"),
    LIMITE_PLANOS_PADRAO,
    1,
    500,
  );
  const lockKey = `pca-fila:${ano}`;

  // Continuação sem nada a fazer (fila vazia e nenhuma execução incompleta para retomar): não abre execução.
  if (somenteRetomada) {
    const { abertos } = await situacaoFila(client, ano);
    const { data: pendente, error } = await client.schema("private").from("pncp_sync_run").select("id")
      .eq("lock_key", lockKey).eq("status", "incompleta").limit(1).maybeSingle();
    if (error) throw error;
    if (abertos === 0 && !pendente) {
      return jsonResponse({ status: "ignorado", motivo: "fila vazia e nada para retomar", ano });
    }
  }

  const inicio = Date.now();
  const prazoEsgotado = () => Date.now() - inicio > orcamentoMs;
  // Orçamento das requisições (consulta e integração): para no prazo + folga, nunca no limite de parede.
  const budget = createRequestBudget(orcamentoMs + FOLGA_REQUISICAO_MS, inicio);

  // Um lock por ano para todas as rotinas: descoberta e carga nunca rodam duas vezes ao mesmo tempo. A execução
  // incompleta anterior passa a continuation (posição da descoberta, rotina e classes).
  const { runId, alreadyRunning, continuation } = await acquireSyncLock(client, lockKey, "pca", { ...body, ano });
  if (alreadyRunning) return jsonResponse({ status: "already_running", sync_id: runId });

  const herdada = (continuation && typeof continuation === "object" ? continuation : null) as ContinuacaoFila | null;
  const rotina: Rotina = herdada?.rotina && somenteRetomada ? herdada.rotina : body.rotina as Rotina;
  const classes = herdada?.classes?.length && somenteRetomada ? herdada.classes : params.classes;

  const executar = async (): Promise<Response> => {
    const resumo: Record<string, unknown> = { sync_id: runId, rotina, ano, classes, somente_retomada: somenteRetomada };
    const continuacao: ContinuacaoFila = { rotina, classes, descoberta: null };
    let erroPrincipal: string | undefined;
    const heartbeat = () =>
      updateSyncHeartbeat(client, runId, {
        continuation: continuacao as unknown as Record<string, unknown>,
        baseParametros: { ...body, ano },
      });
    try {
      // Descoberta: nova (rotina) ou retomada (continuação com posição pendente). Continuação sem posição: só a carga.
      const posicao = somenteRetomada ? herdada?.descoberta ?? null : { classe_idx: 0, pagina: 1 };
      if (posicao) {
        const desc = await descobrirPlanos(consulta, {
          ano,
          classes,
          tamanhoPagina,
          prazoEsgotado,
          inicio: posicao,
          http: { budget, syncRunId: runId },
        });
        continuacao.descoberta = desc.retomar_de;
        if (desc.erro) erroPrincipal = `descoberta: ${desc.erro}`.slice(0, 500);
        resumo.descoberta = {
          completo: desc.completo,
          retomada: posicao.classe_idx !== 0 || posicao.pagina !== 1,
          retomar_de: desc.retomar_de,
          paginas: desc.paginas,
          planos: desc.planos.size,
          linhas: desc.linhas,
          pares_distintos: desc.pares_distintos,
          // A mensagem completa fica em pncp_sync_run.erro_principal; a resposta só diz que houve erro.
          erro: desc.erro ? "descoberta_incompleta" : null,
        };
        resumo.fila = await enfileirarDescobertos(client, desc, rotina, { chainId: runId, classes });
        // Contador de ausência só com descoberta completa numa execução só: página que falhou não prova que o plano
        // sumiu, e uma descoberta retomada não viu as páginas da execução anterior.
        if (desc.completo) resumo.ausentes = await tratarAusentes(client, desc, { ano, classes, rotina, chainId: runId });
        await heartbeat();
      }

      const carga = await processarFila(client, integracao, {
        ano,
        limite: limitePlanos,
        prazoEsgotado,
        runId,
        http: { budget },
        aoTerminarPlano: heartbeat,
      });
      resumo.carga = carga;
      const fila = await situacaoFila(client, ano);
      resumo.fila_abertos = fila.abertos;
      resumo.fila_esgotados = fila.esgotados;

      // Pendência (fila aberta ou descoberta a retomar): incompleta, o cron de continuação segue de onde parou.
      // Plano que esgotou as tentativas ou erro de carga: concluída com erros (aparece na saúde do PR 3).
      const pendente = fila.abertos > 0 || continuacao.descoberta != null;
      const status = pendente
        ? "incompleta"
        : (carga.erros > 0 || fila.esgotados > 0 || erroPrincipal ? "concluida_com_erros" : "concluida");
      await finishSyncRun(client, runId, {
        status,
        totalRecebidos: carga.recebidos,
        totalNovos: carga.novos,
        totalAtualizados: carga.alterados,
        totalInalterados: carga.inalterados,
        totalErros: carga.erros,
        erroPrincipal,
        parametros: { ...body, ano, resumo, ...(pendente ? { continuation: continuacao } : {}) },
      });
      return jsonResponse({ status, ...resumo });
    } catch (error) {
      const mensagem = error instanceof Error ? error.message : String(error);
      const pausa = error instanceof BudgetExhaustedError || error instanceof RateLimitPauseError;
      // Pausa de cota ou fim do orçamento: a fila guarda o progresso e a continuation segue. Outro erro: falhou.
      await finishSyncRun(client, runId, {
        status: pausa ? "incompleta" : "falhou",
        erroPrincipal: mensagem.slice(0, 500),
        parametros: { ...body, ano, resumo, ...(pausa ? { continuation: continuacao } : {}) },
      }).catch((e) =>
        console.error(JSON.stringify({
          evento: "pca_fila_finish_falhou",
          runId,
          erro: e instanceof Error ? e.message : String(e),
        }))
      );
      // A mensagem fica só em pncp_sync_run.erro_principal: não sai na resposta HTTP.
      return jsonResponse({ status: pausa ? "incompleta" : "falhou", sync_id: runId, rotina, ano }, pausa ? 202 : 500);
    }
  };

  if (params.isAsync) {
    const edgeRuntime = (globalThis as unknown as { EdgeRuntime?: { waitUntil?: (p: Promise<unknown>) => void } })
      .EdgeRuntime;
    if (typeof edgeRuntime?.waitUntil === "function") {
      edgeRuntime.waitUntil(executar());
      return jsonResponse({ status: "aceito", sync_id: runId, rotina, ano }, 202);
    }
  }
  return await executar();
}
