import { SupabaseClient } from "npm:@supabase/supabase-js@2";
import {
  DateSlice,
  pendingFromPriorRun,
  resolveContinuationChainId,
} from "./pagination-budget.ts";

/** Edge timeout / cliente cancelado — libera lock preso em `executando`. */
export const STALE_LOCK_MS = 3 * 60 * 1000;

export type PendingContinuation = {
  slices: DateSlice[];
  chainId: string;
};

export async function acquireSyncLock(
  client: SupabaseClient,
  lockKey: string,
  resourceType: string,
  parametros: Record<string, unknown> = {},
): Promise<{
  runId: string;
  alreadyRunning: boolean;
  continuation?: unknown;
  retomadaDeId?: string | null;
}> {
  // If Supabase client has RPC available, use the atomic private.acquire_sync_lock RPC.
  // A função vive no schema `private` (exposto no PostgREST); `client.rpc` sozinho
  // mira `public` e falha com PGRST202. Por isso a chamada passa por schema("private").
  const privateClient = typeof client.schema === "function" ? client.schema("private") : null;
  if (privateClient && typeof privateClient.rpc === "function") {
    const { data, error } = await privateClient.rpc("acquire_sync_lock", {
      p_lock_key: lockKey,
      p_resource_type: resourceType,
      p_parametros: parametros,
    });
    if (error) throw error;
    const res = data as {
      already_running: boolean;
      run_id: string;
      continuation?: unknown;
      retomada_de_id?: string | null;
    };
    return {
      runId: res.run_id,
      alreadyRunning: res.already_running,
      continuation: res.continuation,
      retomadaDeId: res.retomada_de_id,
    };
  }

  // Fallback for mock clients in test harnesses that don't mock rpc
  const { data: existing } = await client.schema("private")
    .from("pncp_sync_run")
    .select("id, iniciada_em")
    .eq("lock_key", lockKey)
    .eq("status", "executando")
    .maybeSingle();

  if (existing?.id) {
    const started = Date.parse(String(existing.iniciada_em ?? ""));
    const ageMs = Number.isFinite(started) ? Date.now() - started : STALE_LOCK_MS + 1;
    if (ageMs < STALE_LOCK_MS) {
      return { runId: existing.id as string, alreadyRunning: true };
    }
    await client.schema("private").from("pncp_sync_run").update({
      status: "falhou",
      erro_principal: "lock expirado (executando stale)",
      finalizada_em: new Date().toISOString(),
    }).eq("id", existing.id);
  }

  const { data, error } = await client.schema("private")
    .from("pncp_sync_run")
    .insert({
      resource_type: resourceType,
      lock_key: lockKey,
      parametros,
      status: "executando",
    })
    .select("id")
    .single();

  if (error) throw error;
  return { runId: data.id as string, alreadyRunning: false };
}

export async function loadPendingSlices(
  client: SupabaseClient,
  lockKey: string,
  currentRunId: string,
  inheritedContinuation?: unknown,
): Promise<PendingContinuation | null> {
  // If continuation was already returned atomically by acquire_sync_lock RPC
  if (inheritedContinuation && typeof inheritedContinuation === "object") {
    const cont = inheritedContinuation as { pending?: unknown; chain_id?: unknown };
    if (Array.isArray(cont.pending) && cont.pending.length > 0) {
      return {
        slices: cont.pending as DateSlice[],
        chainId: typeof cont.chain_id === "string" ? cont.chain_id : currentRunId,
      };
    }
  }

  const selectPrior = () =>
    client.schema("private")
      .from("pncp_sync_run")
      .select("id, status, parametros")
      .eq("lock_key", lockKey)
      .neq("id", currentRunId);

  const toContinuation = (
    prior: { id: string; status: string; parametros: unknown } | null,
  ): PendingContinuation | null => {
    const slices = pendingFromPriorRun(prior);
    if (!slices || !prior) return null;
    return {
      slices,
      chainId: resolveContinuationChainId(prior, currentRunId),
    };
  };

  const { data: latest, error } = await selectPrior()
    .order("iniciada_em", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  if (!latest) return null;
  if (latest.status === "concluida" || latest.status === "concluida_com_erros") {
    return null;
  }
  if (latest.status === "incompleta") return toContinuation(latest);

  const { data: incomplete, error: incompleteError } = await selectPrior()
    .eq("status", "incompleta")
    .order("iniciada_em", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (incompleteError) throw incompleteError;
  return toContinuation(incomplete);
}

export async function resolveIdempotency(
  client: SupabaseClient,
  key: string,
  rota: string,
  parametrosHash: string,
): Promise<{ hit: boolean; syncRunId?: string; resposta?: unknown }> {
  const { data } = await client.schema("private")
    .from("idempotency_key")
    .select("sync_run_id, status, resposta")
    .eq("idempotency_key", key)
    .eq("rota", rota)
    .maybeSingle();

  if (!data) return { hit: false };
  if (data.status === "concluida") {
    return { hit: true, resposta: data.resposta };
  }
  if (data.status === "executando" && data.sync_run_id) {
    return { hit: true, syncRunId: data.sync_run_id as string };
  }
  return { hit: false };
}
