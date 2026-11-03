import { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { hashPayload } from "./hash.ts";

export type UpsertResult = "novo" | "alterado" | "inalterado" | "erro";

export type HistoryFieldsContext = { rowId: string };

export type HistoryFieldsOption =
  | Record<string, unknown>
  | ((ctx: HistoryFieldsContext) => Record<string, unknown>);

/** Resolve historyFields estático ou factory (plano/item em pca_alteracoes). */
export function resolveHistoryFields(
  historyFields: HistoryFieldsOption | undefined,
  rowId: string,
): Record<string, unknown> {
  if (!historyFields) return {};
  if (typeof historyFields === "function") {
    return historyFields({ rowId });
  }
  return historyFields;
}

export async function upsertByHash<T extends Record<string, unknown>>(
  client: SupabaseClient,
  table: string,
  uniqueKey: Record<string, unknown>,
  row: T,
  options?: {
    historyTable?: string;
    historyFields?: HistoryFieldsOption;
    syncRunId?: string;
    lastSeenSyncId?: string;
    /** Tabelas sem coluna last_synced_at (ex.: contratacoes_itens). */
    skipLastSynced?: boolean;
  },
): Promise<UpsertResult> {
  const now = new Date().toISOString();
  const payloadHash = await hashPayload(row);
  const fullRow = {
    ...row,
    payload_hash: payloadHash,
    updated_at: now,
    ...(options?.skipLastSynced ? {} : { last_synced_at: now }),
    ...(options?.lastSeenSyncId ? { last_seen_sync_id: options.lastSeenSyncId } : {}),
  };

  const selectColumns = options?.historyTable ? "*" : "id, payload_hash";
  let query = client.from(table).select(selectColumns).limit(1);
  for (const [k, v] of Object.entries(uniqueKey)) {
    query = query.eq(k, v);
  }
  const { data: existing, error: readError } = await query.maybeSingle();
  if (readError) throw readError;

  if (!existing) {
    const { data: inserted, error } = await client.from(table).insert(fullRow)
      .select("id").single();
    if (error) return "erro";
    if (options?.historyTable && inserted?.id) {
      await client.from(options.historyTable).insert({
        ...resolveHistoryFields(options.historyFields, inserted.id),
        tipo_operacao: "insert",
        dados_novos: fullRow,
        payload_hash_novo: payloadHash,
        sync_run_id: options.syncRunId,
      });
    }
    return "novo";
  }

  const existingId = existing.id as string;
  const existingPayloadHash = existing.payload_hash as string;

  if (existingPayloadHash === payloadHash) {
    if (!options?.skipLastSynced || options?.lastSeenSyncId) {
      await client.from(table).update({
        ...(options?.skipLastSynced ? {} : { last_synced_at: now }),
        ...(options?.lastSeenSyncId ? { last_seen_sync_id: options.lastSeenSyncId } : {}),
      }).eq("id", existingId);
    }
    return "inalterado";
  }

  const { error } = await client.from(table).update(fullRow).eq("id", existingId);
  if (error) return "erro";

  if (options?.historyTable) {
    await client.from(options.historyTable).insert({
      ...resolveHistoryFields(options.historyFields, existingId),
      tipo_operacao: "update",
      dados_anteriores: existing,
      dados_novos: fullRow,
      payload_hash_anterior: existingPayloadHash,
      payload_hash_novo: payloadHash,
      sync_run_id: options.syncRunId,
    });
  }
  return "alterado";
}

export async function inactivateNotSeen(
  client: SupabaseClient,
  table: string,
  syncRunId: string,
  filters: Record<string, unknown> = {},
) {
  let query = client.from(table).update({ ativo: false }).neq("last_seen_sync_id", syncRunId);
  for (const [k, v] of Object.entries(filters)) {
    query = query.eq(k, v);
  }
  const { error } = await query;
  if (error) throw error;
}
