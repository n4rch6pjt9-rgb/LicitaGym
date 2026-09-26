import { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { hashPayload } from "./hash.ts";

export type UpsertResult = "novo" | "alterado" | "inalterado" | "erro";

export type HistoryFieldsContext = { rowId: string };

export type HistoryFieldsOption =
  | Record<string, unknown>
  | ((ctx: HistoryFieldsContext) => Record<string, unknown>);

const TABLES_WITH_ATIVO = new Set([
  "contratacoes_atas",
  "contratacoes_contratos",
  "contratacoes_editais",
  "pca_itens",
  "pca_planos",
]);

function resolveHistoryFields(
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
    reactivateOnUnchanged?: boolean;
  },
): Promise<UpsertResult> {
  const now = new Date().toISOString();
  const payloadHash = await hashPayload(row);
  const fullRow = {
    ...row,
    payload_hash: payloadHash,
    updated_at: now,
    last_synced_at: now,
    ...(options?.lastSeenSyncId ? { last_seen_sync_id: options.lastSeenSyncId } : {}),
  };

  if (options?.historyTable) {
    let historyQuery = client.from(table).select("*").limit(1);
    for (const [k, v] of Object.entries(uniqueKey)) {
      historyQuery = historyQuery.eq(k, v);
    }
    const { data: existingHistory, error: historyReadError } = await historyQuery.maybeSingle();
    if (historyReadError) throw historyReadError;
    return await upsertExistingRow(
      client,
      table,
      row,
      uniqueKey,
      fullRow,
      payloadHash,
      now,
      options,
      existingHistory as Record<string, unknown> | null,
    );
  }

  let query = client.from(table).select("id, payload_hash").limit(1);
  for (const [k, v] of Object.entries(uniqueKey)) {
    query = query.eq(k, v);
  }
  const { data: existing, error: readError } = await query.maybeSingle();
  if (readError) throw readError;

  return await upsertExistingRow(
    client,
    table,
    row,
    uniqueKey,
    fullRow,
    payloadHash,
    now,
    options,
    existing as Record<string, unknown> | null,
  );
}

async function upsertExistingRow<T extends Record<string, unknown>>(
  client: SupabaseClient,
  table: string,
  _row: T,
  _uniqueKey: Record<string, unknown>,
  fullRow: Record<string, unknown>,
  payloadHash: string,
  now: string,
  options: {
    historyTable?: string;
    historyFields?: HistoryFieldsOption;
    syncRunId?: string;
    lastSeenSyncId?: string;
    reactivateOnUnchanged?: boolean;
  } | undefined,
  existing: Record<string, unknown> | null,
): Promise<UpsertResult> {
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

  const existingId = String(existing.id);
  const existingPayloadHash = String(existing.payload_hash);
  const shouldReactivate = options?.reactivateOnUnchanged === true &&
    TABLES_WITH_ATIVO.has(table);

  if (existingPayloadHash === payloadHash) {
    const touchPayload: Record<string, unknown> = {
      last_synced_at: now,
      ...(options?.lastSeenSyncId ? { last_seen_sync_id: options.lastSeenSyncId } : {}),
    };
    if (shouldReactivate) {
      touchPayload.ativo = true;
    }
    const { error: touchError } = await client.from(table).update(touchPayload).eq("id", existingId);
    if (touchError) return "erro";
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
