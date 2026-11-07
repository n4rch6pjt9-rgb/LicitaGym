import { assert, assertEquals, assertThrows } from "jsr:@std/assert@1";
import {
  gerarSeedSql,
  lerFeriados,
  lerPlanilha,
  lerRegimes,
  MARCA_FIM,
  MARCA_INICIO,
} from "../../../scripts/import-spec.ts";

const PLANILHA = "./specs/nexor_spec.xlsx";
const MIGRATION = "./supabase/migrations/20261107180000_nexor_feriados_regimes.sql";

const wb = lerPlanilha(PLANILHA);

Deno.test("import-spec: 18 feriados nacionais (2026 e 2027), todos com lei", () => {
  const f = lerFeriados(wb);
  assertEquals(f.length, 18);
  assertEquals(new Set(f.map((x) => x.data)).size, 18);
  assertEquals(f.filter((x) => x.data.startsWith("2026-")).length, 9);
  assertEquals(f.filter((x) => x.data.startsWith("2027-")).length, 9);
  assert(f.every((x) => /^Lei \d/.test(x.fundamento)), "feriado sem lei no fundamento");
});

Deno.test("import-spec: feriados usados nos testes de prazo da 0041", () => {
  const datas = new Set(lerFeriados(wb).map((x) => x.data));
  for (const d of ["2026-10-12", "2026-12-25", "2027-01-01"]) assert(datas.has(d), `falta ${d}`);
});

Deno.test("import-spec: 5 regimes da Padrao_Lei", () => {
  assertEquals(lerRegimes(wb).map((r) => r.id), [
    "lei_14133",
    "lei_13303",
    "sistema_s_sesc_senac",
    "sistema_s_sesi_senai",
    "lei_14981",
  ]);
});

Deno.test("import-spec: bloco da migration é o que o script gera da planilha (sem drift)", () => {
  const sql = Deno.readTextFileSync(MIGRATION);
  const i = sql.indexOf(MARCA_INICIO);
  const j = sql.indexOf(MARCA_FIM);
  assert(i >= 0 && j > i, "marcas do bloco gerado não encontradas na migration");
  const naMigration = sql.slice(i, j + MARCA_FIM.length).replaceAll("\r\n", "\n");
  assertEquals(naMigration, gerarSeedSql(lerFeriados(wb), lerRegimes(wb)));
});

Deno.test("import-spec: seed é idempotente (on conflict nas chaves primárias)", () => {
  const sql = gerarSeedSql(lerFeriados(wb), lerRegimes(wb));
  assert(sql.includes("on conflict (data) do update"));
  assert(sql.includes("on conflict (id) do update"));
});

Deno.test("import-spec: aspas simples são escapadas", () => {
  const sql = gerarSeedSql([{ data: "2026-01-01", nome: "D'Ávila", fundamento: "Lei 1/2000" }], []);
  assert(sql.includes("'D''Ávila'"));
});

Deno.test("import-spec: aba ausente dá erro, nunca lista vazia", () => {
  const vazio = { SheetNames: [], Sheets: {} } as unknown as Parameters<typeof lerFeriados>[0];
  assertThrows(() => lerFeriados(vazio), Error, "Documentacao_Edital");
  assertThrows(() => lerRegimes(vazio), Error, "Padrao_Lei");
});
