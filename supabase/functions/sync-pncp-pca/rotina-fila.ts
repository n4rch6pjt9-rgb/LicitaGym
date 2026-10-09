import { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { jsonResponse } from "../_shared/http.ts";
import { acquireSyncLock } from "../_shared/pncp/lock.ts";
import { finishSyncRun, updateSyncHeartbeat } from "../_shared/pncp/supabase-admin.ts";
import {
  type ConsultaPca,
  contarAbertos,
  descobrirPlanos,
  enfileirarDescobertos,
  type IntegracaoPca,
  processarFila,
  type Rotina,
  ROTINAS,
  tratarAusentes,
} from "../_shared/pncp/pca-fila.ts";
import { BudgetExhaustedError } from "../_shared/pncp/retry.ts";
import { RateLimitPauseError } from "../_shared/http-client/index.ts";

/** Orçamento de relógio por invocação (spec 0012: fatias cronometradas). */
const ORCAMENTO_PADRAO_MS = 120_000;
const LIMITE_PLANOS_PADRAO = 60;

export type RotinaBody = {
  rotina?: string;
  somente_retomada?: boolean;
  orcamento_ms?: number;
  limite_planos?: number;
  async?: boolean;
};

/**
 * Sync do PCA por fila (spec 0012, PR 2). `rotina`:
 * - incremental: descoberta → enfileira novos/alterados → carga da fila;
 * - backfill: descoberta → enfileira todos → carga da fila;
 * - reconciliacao: descoberta → enfileira todos e os ausentes em 2 descobertas seguidas → carga da fila.
 * `somente_retomada`: só a carga da fila (cron de continuação).
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
  const { client, consulta, integracao, body, ano, classes, tamanhoPagina } = params;
  if (!ROTINAS.includes(body.rotina as Rotina)) {
    return jsonResponse({ error: `rotina inválida: use ${ROTINAS.join(", ")}` }, 400);
  }
  const rotina = body.rotina as Rotina;
  const somenteRetomada = body.somente_retomada === true;
  const orcamentoMs = Number(body.orcamento_ms ?? Deno.env.get("PCA_FILA_ORCAMENTO_MS") ?? ORCAMENTO_PADRAO_MS);
  const limitePlanos = Number(body.limite_planos ?? Deno.env.get("PCA_FILA_LIMITE_PLANOS") ?? LIMITE_PLANOS_PADRAO);
  const inicio = Date.now();
  const prazoEsgotado = () => Date.now() - inicio > orcamentoMs;

  // Um lock por ano para todas as rotinas: descoberta e carga nunca rodam duas vezes ao mesmo tempo.
  const { runId, alreadyRunning } = await acquireSyncLock(client, `pca-fila:${ano}`, "pca", { ...body, ano });
  if (alreadyRunning) return jsonResponse({ status: "already_running", sync_id: runId });

  const executar = async (): Promise<Response> => {
    const resumo: Record<string, unknown> = { sync_id: runId, rotina, ano, classes, somente_retomada: somenteRetomada };
    try {
      let descobertaIncompleta = false;
      if (!somenteRetomada) {
        const desc = await descobrirPlanos(consulta, { ano, classes, tamanhoPagina, prazoEsgotado });
        descobertaIncompleta = !desc.completo;
        resumo.descoberta = {
          completo: desc.completo,
          paginas: desc.paginas,
          planos: desc.planos.size,
          linhas: desc.linhas,
          pares_distintos: desc.pares_distintos,
          erro: desc.erro,
        };
        resumo.fila = await enfileirarDescobertos(client, desc, rotina, runId);
        // Contador de ausência só com descoberta completa: página que falhou não prova que o plano sumiu.
        if (desc.completo) resumo.ausentes = await tratarAusentes(client, desc, { ano, classes, rotina, chainId: runId });
        await updateSyncHeartbeat(client, runId, { paginaAtual: desc.paginas, baseParametros: body as Record<string, unknown> });
      }

      const carga = await processarFila(client, integracao, { classes, limite: limitePlanos, prazoEsgotado, runId });
      resumo.carga = carga;
      const abertos = await contarAbertos(client);
      resumo.fila_abertos = abertos;

      // Fila com planos abertos: incompleta, o cron de continuação (somente_retomada) segue de onde parou.
      const status = abertos > 0
        ? "incompleta"
        : (carga.erros > 0 || descobertaIncompleta ? "concluida_com_erros" : "concluida");
      await finishSyncRun(client, runId, {
        status,
        totalRecebidos: carga.recebidos,
        totalNovos: carga.novos,
        totalAtualizados: carga.alterados,
        totalInalterados: carga.inalterados,
        totalErros: carga.erros,
        erroPrincipal: descobertaIncompleta ? String((resumo.descoberta as Record<string, unknown>).erro ?? "") : undefined,
        parametros: { ...body, ano, resumo },
      });
      return jsonResponse({ status, ...resumo });
    } catch (error) {
      const mensagem = error instanceof Error ? error.message : String(error);
      const pausa = error instanceof BudgetExhaustedError || error instanceof RateLimitPauseError;
      // Pausa de cota: a fila guarda o progresso; não é falha. Outro erro: falhou, com a mensagem.
      await finishSyncRun(client, runId, {
        status: pausa ? "incompleta" : "falhou",
        erroPrincipal: mensagem.slice(0, 500),
        parametros: { ...body, ano, resumo },
      }).catch(() => undefined);
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
