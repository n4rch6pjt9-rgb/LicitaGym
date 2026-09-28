import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { corsHeaders, jsonResponse, validateCronAuth } from "../_shared/http.ts";
import {
  clampConsultaPageSize,
  formatPncpDate,
  PncpConsultaClient,
} from "../_shared/pncp/consulta-client.ts";
import { acquireSyncLock, loadPendingSlices } from "../_shared/pncp/lock.ts";
import {
  DateSlice,
  mayInactivateNotSeen,
  PAGE_HARD_CAP,
  PageFetchError,
  rootSlices,
  runCappedDateSync,
  syncTerminalStatus,
} from "../_shared/pncp/pagination-budget.ts";
import { BudgetExhaustedError } from "../_shared/pncp/retry.ts";
import { RateLimitPauseError, UnifiedHttpClient } from "../_shared/http-client/index.ts";
import { hashPayload, sha256Hex } from "../_shared/pncp/hash.ts";
import { normalizeEdital } from "../_shared/pncp/normalize.ts";
import {
  createServiceClient,
  finishSyncRun,
  logSyncRequest,
  storeSourceRecord,
  updateSyncHeartbeat,
} from "../_shared/pncp/supabase-admin.ts";
import { inactivateNotSeen, upsertByHash } from "../_shared/pncp/upsert.ts";
import {
  isNationalPncpSyncEnabled,
  nationalPncpSyncGate,
} from "../_shared/pncp/licitagym-scope-gate.ts";

const MODALIDADES = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];

type SyncBody = {
  data_inicial?: string;
  data_final?: string;
  modalidade?: number;
  modo?: "incremental" | "completo";
  usar_atualizacao?: boolean;
  async?: boolean;
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return jsonResponse({ error: "Use POST" }, 405);
  if (!validateCronAuth(req)) return jsonResponse({ error: "Unauthorized" }, 401);
  if (!isNationalPncpSyncEnabled()) {
    return nationalPncpSyncGate("contratacoes-editais");
  }

  const url = new URL(req.url);
  const body = (await req.json().catch(() => ({}))) as SyncBody;
  const isAsync = url.searchParams.get("async") === "1" || body.async === true;

  const hoje = new Date();
  const hasManualDates = Boolean(body.data_inicial) || Boolean(body.data_final);
  const dataFinal = body.data_final ?? formatPncpDate(hoje);
  const dataInicial = body.data_inicial ?? formatPncpDate(
    new Date(hoje.getTime() - 2 * 86400000), // Default incremental window: 2 days
  );
  const modalidades = body.modalidade ? [body.modalidade] : MODALIDADES;

  const lockKey = hasManualDates
    ? `contratacoes-editais:manual:${dataInicial}:${dataFinal}`
    : "contratacoes-editais:padrao";

  const isManual = lockKey.includes(":manual:") || hasManualDates;

  const client = createServiceClient();
  const httpClient = new UnifiedHttpClient({
    supabaseClient: client,
    telemetryLogger: (t) => logSyncRequest(client, t),
  });
  const consulta = new PncpConsultaClient(undefined, {}, httpClient);

  const { runId, alreadyRunning, continuation: inheritedContinuation } = await acquireSyncLock(
    client,
    lockKey,
    "contratacoes_editais",
    body,
  );

  if (alreadyRunning) {
    return jsonResponse({ status: "already_running", sync_id: runId });
  }

  const executeSync = async (): Promise<Response> => {
    const stats = { novos: 0, alterados: 0, inalterados: 0, erros: 0, recebidos: 0 };
    const tamanhoPagina = clampConsultaPageSize("contratacoes");
    let chainId = runId;
    let pendingSlices: DateSlice[] = [];
    let pagesFetchedTotal = 0;

    try {
      const prior = await loadPendingSlices(client, lockKey, runId, inheritedContinuation);
      const slices = prior?.slices ?? rootSlices(dataInicial, dataFinal, modalidades);
      chainId = prior?.chainId ?? runId;
      pendingSlices = slices;

      // Run novo sem herança grava as fatias planejadas no primeiro heartbeat
      if (!prior) {
        await updateSyncHeartbeat(client, runId, {
          paginaAtual: slices[0]?.nextPage ?? 1,
          continuation: {
            pending: slices,
            pagesFetched: 0,
            chain_id: chainId,
          },
          baseParametros: body,
        });
      }

      const result = await runCappedDateSync({
        cap: PAGE_HARD_CAP,
        slices,
        fetchPage: async (slice, pagina) => {
          const modalidade = slice.modalidade;
          if (modalidade === undefined) {
            throw new Error("fatia de edital sem modalidade");
          }
          const fetchOpts = {
            syncRunId: runId,
            pagina,
            parametros: {
              dataInicial: slice.dataInicial,
              dataFinal: slice.dataFinal,
              modalidade,
            },
            onHeartbeat: async () => {
              await updateSyncHeartbeat(client, runId, {
                paginaAtual: pagina,
                continuation: {
                  pending: pendingSlices,
                  pagesFetched: pagesFetchedTotal,
                  chain_id: chainId,
                },
                baseParametros: body,
              });
            },
          };
          const fetched = body.usar_atualizacao
            ? await consulta.fetchContratacoesAtualizacao({
              dataInicial: slice.dataInicial,
              dataFinal: slice.dataFinal,
              codigoModalidadeContratacao: modalidade,
              pagina,
              tamanhoPagina,
            }, fetchOpts)
            : await consulta.fetchContratacoesPublicacao({
              dataInicial: slice.dataInicial,
              dataFinal: slice.dataFinal,
              codigoModalidadeContratacao: modalidade,
              pagina,
              tamanhoPagina,
            }, fetchOpts);
          const pagination = consulta.extractPagination(fetched.body, pagina);
          return {
            paginasRestantes: pagination.paginasRestantes,
            status: fetched.status,
            elapsedMs: fetched.elapsedMs,
            body: fetched.body,
          };
        },
        onPage: async (slice, pagina, page) => {
          const modalidade = slice.modalidade;
          const endpoint = body.usar_atualizacao
            ? `/contratacoes/atualizacao?modalidade=${modalidade}&pagina=${pagina}`
            : `/contratacoes/publicacao?modalidade=${modalidade}&pagina=${pagina}`;
          const respostaHash = await sha256Hex(JSON.stringify(page.body));

          await storeSourceRecord(client, {
            syncRunId: runId,
            resourceType: "contratacoes_editais",
            endpoint,
            requestHash: await hashPayload({
              dataInicial: slice.dataInicial,
              dataFinal: slice.dataFinal,
              modalidade,
              pagina,
            }),
            contentHash: respostaHash,
            payload: page.body,
          });

          const list = consulta.extractList(page.body);
          for (const raw of list) {
            const row = normalizeEdital(raw as Record<string, unknown>);
            if (!row.orgao_cnpj || !row.ano || !row.sequencial) continue;
            stats.recebidos++;

            const upsert = await upsertByHash(
              client,
              "contratacoes_editais",
              { orgao_cnpj: row.orgao_cnpj, ano: row.ano, sequencial: row.sequencial },
              row,
              { syncRunId: runId, lastSeenSyncId: chainId, reactivateOnUnchanged: true },
            );
            if (upsert === "novo") stats.novos++;
            else if (upsert === "alterado") stats.alterados++;
            else if (upsert === "inalterado") stats.inalterados++;
            else stats.erros++;
          }
        },
        onHeartbeat: async (pendingQueue, pagesFetched) => {
          pendingSlices = pendingQueue;
          pagesFetchedTotal = pagesFetched;
          await updateSyncHeartbeat(client, runId, {
            paginaAtual: pendingQueue[0]?.nextPage ?? 1,
            continuation: {
              pending: pendingQueue,
              pagesFetched,
              chain_id: chainId,
            },
            baseParametros: body,
          });
        },
      });

      pendingSlices = result.pending;
      pagesFetchedTotal = result.pagesFetched;

      // Status resolution: manual always fails when interrupted; automatic with slices is incompleta
      const terminal = syncTerminalStatus(result.pending, stats.erros);
      const status = isManual && result.pending.length > 0 ? "falhou" : terminal;

      if (mayInactivateNotSeen(body.modo, status)) {
        await inactivateNotSeen(client, "contratacoes_editais", chainId);
      }

      await finishSyncRun(client, runId, {
        status,
        totalRecebidos: stats.recebidos,
        totalNovos: stats.novos,
        totalAtualizados: stats.alterados,
        totalInalterados: stats.inalterados,
        totalErros: stats.erros,
        erroPrincipal: (status === "incompleta" || (isManual && result.pending.length > 0))
          ? `checkpoint: ${result.pending.length} fatias pendentes`
          : undefined,
        paginaAtual: result.pending[0]?.nextPage,
        parametros: {
          ...body,
          continuation: {
            pending: result.pending,
            pagesFetched: result.pagesFetched,
            chain_id: chainId,
          },
        },
      });

      return jsonResponse({
        sync_id: runId,
        chain_id: chainId,
        status,
        paginas_buscadas: result.pagesFetched,
        fatias_pendentes: result.pending.length,
        ...stats,
      });
    } catch (error) {
      const isResumable = error instanceof BudgetExhaustedError ||
                          error instanceof RateLimitPauseError ||
                          error instanceof PageFetchError;
      const pending = error instanceof PageFetchError ? error.pending : pendingSlices;
      const status = isManual ? "falhou" : (isResumable && pending && pending.length > 0 ? "incompleta" : "falhou");
      const message = error instanceof Error ? error.message : String(error);

      await finishSyncRun(client, runId, {
        status,
        erroPrincipal: message,
        totalRecebidos: stats.recebidos,
        totalNovos: stats.novos,
        totalAtualizados: stats.alterados,
        totalInalterados: stats.inalterados,
        totalErros: stats.erros,
        paginaAtual: pending?.[0]?.nextPage,
        parametros: {
          ...body,
          continuation: {
            pending: pending ?? [],
            pagesFetched: pagesFetchedTotal,
            chain_id: chainId,
          },
        },
      });
      return jsonResponse({ error: message, sync_id: runId, status }, 500);
    }
  };

  if (isAsync) {
    const edgeRuntime = (globalThis as unknown as { EdgeRuntime?: { waitUntil?: (promise: Promise<unknown>) => void } }).EdgeRuntime;
    if (typeof edgeRuntime?.waitUntil === "function") {
      edgeRuntime.waitUntil(executeSync());
    } else {
      executeSync().catch((err) => console.error(`[async contratacoes-editais ${runId}] Error:`, err));
    }
    return jsonResponse({ status: "accepted", sync_id: runId }, 202);
  }

  return await executeSync();
});
