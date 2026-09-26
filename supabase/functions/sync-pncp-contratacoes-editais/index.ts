import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { corsHeaders, jsonResponse, validateCronAuth } from "../_shared/http.ts";
import {
  clampConsultaPageSize,
  formatPncpDate,
  PncpConsultaClient,
} from "../_shared/pncp/consulta-client.ts";
import { acquireSyncLock, loadPendingSlices } from "../_shared/pncp/lock.ts";
import {
  mayInactivateNotSeen,
  PAGE_HARD_CAP,
  PageFetchError,
  rootSlices,
  runCappedDateSync,
  syncTerminalStatus,
} from "../_shared/pncp/pagination-budget.ts";
import { hashPayload, sha256Hex } from "../_shared/pncp/hash.ts";
import { normalizeEdital } from "../_shared/pncp/normalize.ts";
import {
  createServiceClient,
  finishSyncRun,
  logSyncRequest,
  storeSourceRecord,
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
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return jsonResponse({ error: "Use POST" }, 405);
  if (!validateCronAuth(req)) return jsonResponse({ error: "Unauthorized" }, 401);
  if (!isNationalPncpSyncEnabled()) {
    return nationalPncpSyncGate("contratacoes-editais");
  }

  const body = (await req.json().catch(() => ({}))) as SyncBody;
  const hoje = new Date();
  const dataFinal = body.data_final ?? formatPncpDate(hoje);
  const dataInicial = body.data_inicial ?? formatPncpDate(
    new Date(hoje.getTime() - 7 * 86400000),
  );
  const modalidades = body.modalidade ? [body.modalidade] : MODALIDADES;
  const lockKey = `contratacoes-editais:${dataInicial}:${dataFinal}`;

  const client = createServiceClient();
  const consulta = new PncpConsultaClient();
  const { runId, alreadyRunning } = await acquireSyncLock(
    client,
    lockKey,
    "contratacoes_editais",
    body,
  );

  if (alreadyRunning) {
    return jsonResponse({ status: "already_running", sync_id: runId });
  }

  const stats = { novos: 0, alterados: 0, inalterados: 0, erros: 0, recebidos: 0 };
  const tamanhoPagina = clampConsultaPageSize("contratacoes");
  let chainId = runId;

  try {
    const prior = await loadPendingSlices(client, lockKey, runId);
    const slices = prior?.slices ?? rootSlices(dataInicial, dataFinal, modalidades);
    chainId = prior?.chainId ?? runId;
    const result = await runCappedDateSync({
      cap: PAGE_HARD_CAP,
      slices,
      fetchPage: async (slice, pagina) => {
        const modalidade = slice.modalidade;
        if (modalidade === undefined) {
          throw new Error("fatia de edital sem modalidade");
        }
        const fetched = body.usar_atualizacao
          ? await consulta.fetchContratacoesAtualizacao({
            dataInicial: slice.dataInicial,
            dataFinal: slice.dataFinal,
            codigoModalidadeContratacao: modalidade,
            pagina,
            tamanhoPagina,
          })
          : await consulta.fetchContratacoesPublicacao({
            dataInicial: slice.dataInicial,
            dataFinal: slice.dataFinal,
            codigoModalidadeContratacao: modalidade,
            pagina,
            tamanhoPagina,
          });
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

        await logSyncRequest(client, {
          syncRunId: runId,
          endpoint,
          parametros: {
            dataInicial: slice.dataInicial,
            dataFinal: slice.dataFinal,
            modalidade,
            pagina,
            tamanhoPagina,
          },
          pagina,
          statusHttp: page.status,
          tempoRespostaMs: page.elapsedMs,
          respostaHash,
        });

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
    });

    const status = syncTerminalStatus(result.pending, stats.erros);
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
      erroPrincipal: status === "incompleta"
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
    const pending = error instanceof PageFetchError ? error.pending : null;
    const status = pending && pending.length > 0 ? "incompleta" : "falhou";
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
      parametros: pending
        ? { ...body, continuation: { pending, chain_id: chainId } }
        : undefined,
    });
    return jsonResponse({ error: message, sync_id: runId, status }, 500);
  }
});
