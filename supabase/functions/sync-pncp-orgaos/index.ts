import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { corsHeaders, jsonResponse, validateCronAuth } from "../_shared/http.ts";
import { PncpIntegracaoClient } from "../_shared/pncp/integracao-client.ts";
import { acquireSyncLock } from "../_shared/pncp/lock.ts";
import {
  createServiceClient,
  finishSyncRun,
  logSyncRequest,
  storeSourceRecord,
} from "../_shared/pncp/supabase-admin.ts";
import { orgSyncClasses } from "../_shared/pncp/catmat-scope-resolver.ts";
import { hashPayload, sha256Hex } from "../_shared/pncp/hash.ts";
import {
  chunkValues,
  fetchAllByRange,
  POSTGREST_PAGE_SIZE,
} from "../_shared/pncp/postgrest-paginate.ts";
import { upsertByHash } from "../_shared/pncp/upsert.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return jsonResponse({ error: "Use POST" }, 405);
  if (!validateCronAuth(req)) return jsonResponse({ error: "Unauthorized" }, 401);

  const client = createServiceClient();
  const integracao = new PncpIntegracaoClient();
  const lockKey = "orgaos-sync";
  const { runId, alreadyRunning } = await acquireSyncLock(client, lockKey, "orgaos", {});

  if (alreadyRunning) {
    return jsonResponse({ status: "already_running", sync_id: runId });
  }

  const stats = {
    entidades_inseridas: 0,
    orgaos_inseridas: 0,
    unidades_inseridas: 0,
    erros: 0,
    pca_itens_lidos: 0,
    pca_planos_lidos: 0,
  };

  try {
    const classCodes = orgSyncClasses().map((classe) => Number(classe));
    const { rows: itemRows, pages: itemPages } = await fetchAllByRange<{
      pca_plano_id: string;
    }>(
      (from, to) =>
        client
          .from("pca_itens")
          .select("pca_plano_id")
          .in("codigo_classe_catmat", classCodes)
          .order("id")
          .range(from, to),
      { orderBy: "id" },
    );
    stats.pca_itens_lidos = itemRows.length;

    const planIds = [
      ...new Set(
        itemRows
          .map((row) => row.pca_plano_id as string)
          .filter((id) => typeof id === "string" && id.length > 0),
      ),
    ];

    const cnpjsSet = new Set<string>();
    for (const idChunk of chunkValues(planIds, POSTGREST_PAGE_SIZE)) {
      const { rows: planRows } = await fetchAllByRange<{ orgao_cnpj: string }>(
        (from, to) =>
          client
            .from("pca_planos")
            .select("orgao_cnpj")
            .in("id", idChunk)
            .order("id")
            .range(from, to),
        { orderBy: "id" },
      );
      stats.pca_planos_lidos += planRows.length;
      for (const row of planRows) {
        const cnpj = String(row.orgao_cnpj ?? "").trim();
        if (cnpj.length > 0) cnpjsSet.add(cnpj);
      }
    }

    const cnpjs = Array.from(cnpjsSet);
    for (const cnpj of cnpjs) {
      try {
        const orgaoData = await integracao.getOrgao(cnpj);
        const payload = orgaoData as Record<string, unknown>;

        const endpoint = `/orgaos/${cnpj}`;
        const requestHash = await hashPayload({ cnpj });
        const contentHash = await sha256Hex(JSON.stringify(payload));
        await storeSourceRecord(client, {
          syncRunId: runId,
          resourceType: "orgaos",
          endpoint,
          requestHash,
          contentHash,
          payload,
        });

        const entidadeResult = await upsertByHash(
          client,
          "entidades",
          { codigo_pncp: cnpj },
          {
            codigo_pncp: cnpj,
            cnpj: cnpj,
            cnpj_normalizado: cnpj.replace(/\D/g, ""),
            tipo: "orgao",
          },
          { syncRunId: runId },
        );

        if (entidadeResult === "erro") {
          stats.erros++;
          await logSyncRequest(client, {
            syncRunId: runId,
            endpoint: `/orgaos/${cnpj}`,
            parametros: { cnpj, tabela: "entidades" },
            erro: "upsert entidades failed",
          });
        } else {
          stats.entidades_inseridas++;
        }

        const entidadeIdResult = await client
          .from("entidades")
          .select("id")
          .eq("codigo_pncp", cnpj)
          .single();

        if (entidadeIdResult.error) {
          stats.erros++;
          await logSyncRequest(client, {
            syncRunId: runId,
            endpoint: `/orgaos/${cnpj}`,
            parametros: { cnpj, tabela: "entidades_select" },
            erro: entidadeIdResult.error.message,
          });
        } else if (entidadeIdResult.data && entidadeIdResult.data.id) {
          const entidadeId = entidadeIdResult.data.id;

          const orgaoResult = await upsertByHash(
            client,
            "orgaos",
            { entidade_id: entidadeId },
            {
              entidade_id: entidadeId,
              cnpj: cnpj,
            },
            { syncRunId: runId },
          );

          if (orgaoResult === "erro") {
            stats.erros++;
            await logSyncRequest(client, {
              syncRunId: runId,
              endpoint: `/orgaos/${cnpj}`,
              parametros: { cnpj, tabela: "orgaos" },
              erro: "upsert orgaos failed",
            });
          } else {
            stats.orgaos_inseridas++;
          }
        }
      } catch (error) {
        stats.erros++;
        await logSyncRequest(client, {
          syncRunId: runId,
          endpoint: `/orgaos/${cnpj}`,
          parametros: { cnpj },
          erro: error instanceof Error ? error.message : String(error),
        });
      }
    }

    await finishSyncRun(client, runId, {
      status: stats.erros > 0 ? "concluida_com_erros" : "concluida",
      totalRecebidos: cnpjs.length,
      totalErros: stats.erros,
      parametros: {
        ...stats,
        pca_itens_pages: itemPages,
        plan_id_count: planIds.length,
      },
    });
    return jsonResponse({
      status: stats.erros > 0 ? "concluida_com_erros" : "ok",
      stats,
      cnpjs_processados: cnpjs.length,
    }, stats.erros > 0 ? 500 : 200);
  } catch (error) {
    await finishSyncRun(client, runId, {
      status: "falhou",
      totalErros: stats.erros + 1,
      erroPrincipal: error instanceof Error ? error.message : String(error),
      parametros: stats,
    });
    return jsonResponse(
      { status: "error", erro: error instanceof Error ? error.message : String(error) },
      500,
    );
  }
});
