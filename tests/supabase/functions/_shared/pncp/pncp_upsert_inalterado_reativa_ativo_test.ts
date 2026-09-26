/**
 * Regression: upsertByHash "inalterado" must set ativo=true and surface update errors.
 * Without this, a new sync after inactivateNotSeen leaves stale rows inactive forever.
 */
import { assertEquals } from "jsr:@std/assert@1";
import { hashPayload } from "../../../../../supabase/functions/_shared/pncp/hash.ts";
import { upsertByHash } from "../../../../../supabase/functions/_shared/pncp/upsert.ts";

type UpdateCall = { table: string; payload: Record<string, unknown>; id: string };

function fakeClient(opts: {
  existing: Record<string, unknown> | null;
  updateError?: { message: string } | null;
}) {
  const updates: UpdateCall[] = [];
  const client = {
    from(table: string) {
      return {
        select(_cols: string) {
          return {
            limit(_n: number) {
              return {
                eq(_k: string, _v: unknown) {
                  return this;
                },
                async maybeSingle() {
                  return { data: opts.existing, error: null };
                },
              };
            },
          };
        },
        update(payload: Record<string, unknown>) {
          return {
            eq(_k: string, id: string) {
              updates.push({ table, payload, id: String(id) });
              return Promise.resolve({
                error: opts.updateError ?? null,
              });
            },
          };
        },
        insert(_row: Record<string, unknown>) {
          return {
            select(_cols: string) {
              return {
                async single() {
                  return { data: { id: "new" }, error: null };
                },
              };
            },
          };
        },
      };
    },
  };
  return { client: client as never, updates };
}

Deno.test("inalterado: reativa ativo=true e carimba last_seen_sync_id", async () => {
  const row = { numero_controle_pncp: "x-1-000001/2026", objeto: "piso" };
  const payloadHash = await hashPayload(row);
  const { client, updates } = fakeClient({
    existing: { id: "row-1", payload_hash: payloadHash, ativo: false },
  });

  const result = await upsertByHash(client, "contratacoes_editais", {
    numero_controle_pncp: row.numero_controle_pncp,
  }, row, { lastSeenSyncId: "chain-abc", reactivateOnUnchanged: true });

  assertEquals(result, "inalterado");
  assertEquals(updates.length, 1);
  assertEquals(updates[0].id, "row-1");
  assertEquals(updates[0].payload.ativo, true);
  assertEquals(updates[0].payload.last_seen_sync_id, "chain-abc");
  assertEquals(typeof updates[0].payload.last_synced_at, "string");
  // Must not rewrite business payload on unchanged hash
  assertEquals(updates[0].payload.objeto, undefined);
  assertEquals(updates[0].payload.payload_hash, undefined);
});

Deno.test("inalterado: update com erro → 'erro' (não finge sucesso)", async () => {
  const row = { numero_controle_pncp: "x-1-000002/2026", objeto: "grama" };
  const payloadHash = await hashPayload(row);
  const { client, updates } = fakeClient({
    existing: { id: "row-2", payload_hash: payloadHash, ativo: false },
    updateError: { message: "permission denied" },
  });

  const result = await upsertByHash(client, "contratacoes_editais", {
    numero_controle_pncp: row.numero_controle_pncp,
  }, row, { lastSeenSyncId: "chain-xyz", reactivateOnUnchanged: true });

  assertEquals(result, "erro");
  assertEquals(updates.length, 1);
  assertEquals(updates[0].payload.ativo, true);
});

Deno.test("inalterado: tabela sem coluna ativo ignora reativação e não envia campo ativo no touch", async () => {
  const row = { codigo: "n-1", descricao: "natureza" };
  const payloadHash = await hashPayload(row);
  const { client, updates } = fakeClient({
    existing: { id: "row-3", payload_hash: payloadHash },
  });

  const result = await upsertByHash(client, "catmat_pdm_naturezas_despesa", {
    codigo: row.codigo,
  }, row, { lastSeenSyncId: "sync-123", reactivateOnUnchanged: true });

  assertEquals(result, "inalterado");
  assertEquals(updates.length, 1);
  assertEquals(updates[0].payload.ativo, undefined);
  assertEquals(updates[0].payload.last_seen_sync_id, "sync-123");
  assertEquals(typeof updates[0].payload.last_synced_at, "string");
});
