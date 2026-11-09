import { assertEquals, assertMatch, assertRejects } from "jsr:@std/assert@1";
import { FakePcaPostgrest } from "./_shared/pncp/_fake_pca_atomico.ts";
import { persistirLoteAtomico, type UnidadePcaAtomica } from "../../../supabase/functions/_shared/pncp/pca-atomico.ts";
const RUN = "00000000-0000-4000-8000-000000000001";
const plano = (n: number): UnidadePcaAtomica => ({
  tabela: "pca_planos",
  chave: { id_pca_pncp: "simulado-" + n },
  linha: { id_pca_pncp: "simulado-" + n, ano_exercicio: 2026, orgao_cnpj: "99000001000101", payload_hash: "hash-" + n },
});

Deno.test("fake RPC PCA: UUID, historico completo e uma chamada HTTP", async () => {
  const db = new FakePcaPostgrest();
  const [r] = await persistirLoteAtomico(db as never, [plano(1)], RUN);
  assertMatch(r.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/);
  assertEquals(r.resultado, "novo");
  assertEquals(db.rows("pca_alteracoes")[0].dados_novos, db.rows("pca_planos")[0]);
  assertEquals(db.rows("pca_alteracoes")[0].sync_run_id, RUN);
  assertEquals(db.chamadas, 1);
  assertEquals(db.porOperacao, { "pca_persistir_lote_atomico.rpc": 1 });
});
Deno.test("fake RPC PCA: falha no historico reverte entidade", async () => {
  const db = new FakePcaPostgrest();
  db.falhas = [{ table: "pca_alteracoes", op: "insert" }];
  await assertRejects(() => persistirLoteAtomico(db as never, [plano(1)], RUN), Error, "falha injetada");
  assertEquals(db.rows("pca_planos"), []);
  assertEquals(db.rows("pca_alteracoes"), []);
});
Deno.test("fake RPC PCA: segunda unidade rejeitada reverte primeira e historico", async () => {
  const db = new FakePcaPostgrest();
  await persistirLoteAtomico(db as never, [plano(1)], RUN);
  const antes = structuredClone([...db.tables]);
  db.falhaLinha = (t, row) => t === "pca_planos" && row.id_pca_pncp === "simulado-3";
  await assertRejects(() => persistirLoteAtomico(db as never, [plano(2), plano(3)], RUN), Error, "linha rejeitada");
  assertEquals([...db.tables], antes);
});
Deno.test("fake RPC PCA: clone preserva RPC, replay e IDs estaveis", async () => {
  const db = new FakePcaPostgrest();
  const [primeiro] = await persistirLoteAtomico(db as never, [plano(1)], RUN);
  const copy = db.clone();
  const [replay] = await persistirLoteAtomico(copy as never, [plano(1)], RUN);
  assertEquals(replay, { id: primeiro.id, resultado: "inalterado" });
  assertEquals(copy.rows("pca_alteracoes").length, 1);
  const outro = new FakePcaPostgrest();
  const [independente] = await persistirLoteAtomico(outro as never, [plano(1)], RUN);
  assertEquals(independente.id, primeiro.id);
});
Deno.test("fake RPC PCA: reativacao com falha reverte; sucesso grava evento", async () => {
  const db = new FakePcaPostgrest();
  await persistirLoteAtomico(db as never, [plano(1)], RUN);
  db.rows("pca_planos")[0].ativo = false;
  const antes = structuredClone([...db.tables]);
  const entrada = plano(1);
  entrada.linha.payload_hash = "hash-novo";
  db.falhas = [{ table: "pca_alteracoes", op: "insert" }];
  await assertRejects(() => persistirLoteAtomico(db as never, [entrada], RUN), Error, "falha injetada");
  assertEquals([...db.tables], antes);
  db.falhas = [];
  const [r] = await persistirLoteAtomico(db as never, [entrada], RUN);
  assertEquals(r.resultado, "alterado");
  assertEquals(db.rows("pca_planos")[0].ativo, true);
  assertEquals(db.rows("pca_alteracoes").at(-1)?.tipo_operacao, "reativacao");
});
