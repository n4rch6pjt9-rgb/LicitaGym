import { assertEquals } from "jsr:@std/assert@1";
import { FakePostgrest } from "./_fake_postgrest.ts";
import { upsertByHash } from "../../../../../supabase/functions/_shared/pncp/upsert.ts";
import { hashPayload } from "../../../../../supabase/functions/_shared/pncp/hash.ts";

const RUN = "00000000-0000-4000-8000-000000000001";
const row = (titulo: string) => ({
  id_pca_pncp: "CHK-UPSERT-HISTORICO/2026",
  ano_exercicio: 2026, orgao_cnpj: "99000001000101", titulo,
});
const chave = { id_pca_pncp: row("v1").id_pca_pncp };
const options = {
  historyTable: "pca_alteracoes",
  historyFields: ({ rowId }: { rowId: string }) => ({ pca_plano_id: rowId }),
  syncRunId: RUN,
};

Deno.test("upsert historico: falha apos UPDATE retorna erro e preserva evento anterior", async () => {
  const db = new FakePostgrest();
  assertEquals(await upsertByHash(db as never, "pca_planos", chave, row("v1"), options), "novo");
  const historicoAnterior = structuredClone(db.rows("pca_alteracoes"));
  db.falhas.push({ table: "pca_alteracoes", op: "insert" });
  const result = await upsertByHash(db as never, "pca_planos", chave, row("v2"), options);
  assertEquals(result, "erro");
  // Este caminho tem duas requisicoes: reportar erro nao desfaz o UPDATE confirmado.
  assertEquals(db.rows("pca_planos")[0].titulo, "v2");
  assertEquals(db.rows("pca_planos")[0].payload_hash, await hashPayload(row("v2")));
  assertEquals(db.rows("pca_alteracoes"), historicoAnterior);
});
Deno.test("upsert historico: sucesso de INSERT e UPDATE mantem eventos e hashes", async () => {
  const db = new FakePostgrest();
  assertEquals(await upsertByHash(db as never, "pca_planos", chave, row("v1"), options), "novo");
  const antes = structuredClone(db.rows("pca_planos")[0]);
  assertEquals(await upsertByHash(db as never, "pca_planos", chave, row("v2"), options), "alterado");
  assertEquals(db.rows("pca_alteracoes").length, 2);
  const [insert, update] = db.rows("pca_alteracoes");
  assertEquals(insert.tipo_operacao, "insert");
  assertEquals(update.tipo_operacao, "update");
  assertEquals(update.pca_plano_id, antes.id);
  assertEquals(update.dados_anteriores, antes);
  assertEquals(update.payload_hash_anterior, await hashPayload(row("v1")));
  assertEquals(update.payload_hash_novo, await hashPayload(row("v2")));
  assertEquals(update.sync_run_id, RUN);
});
Deno.test("upsert sem historico: consumidores sem historyTable mantem sucesso", async () => {
  const db = new FakePostgrest();
  db.falhas.push({ table: "pca_alteracoes", op: "insert" });
  assertEquals(await upsertByHash(db as never, "pca_planos", chave, row("v1")), "novo");
  assertEquals(await upsertByHash(db as never, "pca_planos", chave, row("v2")), "alterado");
  assertEquals(await upsertByHash(db as never, "pca_planos", chave, row("v2")), "inalterado");
  assertEquals(db.rows("pca_alteracoes"), []);
});
