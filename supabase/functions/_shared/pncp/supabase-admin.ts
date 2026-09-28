import { createClient, SupabaseClient } from "npm:@supabase/supabase-js@2";

export function createServiceClient(): SupabaseClient {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) {
    throw new Error("SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY são obrigatórios");
  }
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export async function storeSourceRecord(
  client: SupabaseClient,
  input: {
    syncRunId?: string;
    resourceType: string;
    endpoint: string;
    requestHash: string;
    contentHash: string;
    payload: unknown;
  },
) {
  const { data, error } = await client.schema("private").from("source_record").upsert(
    {
      sync_run_id: input.syncRunId ?? null,
      resource_type: input.resourceType,
      endpoint: input.endpoint,
      request_hash: input.requestHash,
      content_hash: input.contentHash,
      payload: input.payload,
      fetched_at: new Date().toISOString(),
    },
    { onConflict: "endpoint,request_hash,content_hash", ignoreDuplicates: true },
  ).select("id").maybeSingle();
  if (error) throw error;
  return data?.id ?? null;
}

export async function finishSyncRun(
  client: SupabaseClient,
  runId: string,
  stats: {
    status: string;
    totalRecebidos?: number;
    totalNovos?: number;
    totalAtualizados?: number;
    totalInalterados?: number;
    totalErros?: number;
    erroPrincipal?: string;
    paginaAtual?: number;
    totalPaginas?: number;
    parametros?: Record<string, unknown>;
  },
) {
  const patch: Record<string, unknown> = {
    status: stats.status,
    total_recebidos: stats.totalRecebidos,
    total_novos: stats.totalNovos,
    total_atualizados: stats.totalAtualizados,
    total_inalterados: stats.totalInalterados,
    total_erros: stats.totalErros,
    erro_principal: stats.erroPrincipal ?? null,
    pagina_atual: stats.paginaAtual,
    finalizada_em: new Date().toISOString(),
  };
  if (stats.totalPaginas !== undefined) patch.total_paginas = stats.totalPaginas;
  if (stats.parametros !== undefined) patch.parametros = stats.parametros;
  const { error } = await client.schema("private").from("pncp_sync_run").update(patch).eq("id", runId);
  if (error) throw error;
}

export async function updateSyncHeartbeat(
  client: SupabaseClient,
  runId: string,
  extra?: {
    continuation?: Record<string, unknown>;
    paginaAtual?: number;
    baseParametros?: Record<string, unknown>;
  },
): Promise<void> {
  const patch: Record<string, unknown> = {
    last_heartbeat_at: new Date().toISOString(),
  };
  if (extra?.paginaAtual !== undefined) {
    patch.pagina_atual = extra.paginaAtual;
  }
  if (extra?.continuation !== undefined) {
    if (extra.baseParametros) {
      patch.parametros = {
        ...extra.baseParametros,
        continuation: extra.continuation,
      };
    } else {
      const { data: current } = await client.schema("private")
        .from("pncp_sync_run")
        .select("parametros")
        .eq("id", runId)
        .maybeSingle();
      const currentParams = (current?.parametros as Record<string, unknown>) ?? {};
      patch.parametros = {
        ...currentParams,
        continuation: extra.continuation,
      };
    }
  }
  await client.schema("private").from("pncp_sync_run").update(patch).eq("id", runId);
}

export async function logSyncRequest(
  client: SupabaseClient,
  input: {
    syncRunId: string;
    endpoint: string;
    parametros: Record<string, unknown>;
    pagina?: number;
    statusHttp?: number;
    tempoRespostaMs?: number;
    respostaHash?: string;
    erro?: string;
    tentativa?: number;
    host?: string;
    retryAfterSeconds?: number;
  },
) {
  const { error } = await client.schema("private").from("pncp_sync_request").insert({
    sync_run_id: input.syncRunId,
    endpoint: input.endpoint,
    parametros: input.parametros,
    pagina: input.pagina,
    status_http: input.statusHttp,
    tempo_resposta_ms: input.tempoRespostaMs,
    resposta_hash: input.respostaHash,
    erro: input.erro,
    tentativa: input.tentativa ?? 1,
    host: input.host,
    retry_after_seconds: input.retryAfterSeconds,
  });
  if (error) throw error;
}
