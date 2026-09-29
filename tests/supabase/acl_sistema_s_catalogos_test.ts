import { assertEquals } from "jsr:@std/assert@1";

const MIGRATION = "./supabase/migrations/20260929130000_acl_sistema_s_catalogos.sql";
const ACL_CHECK = "./supabase/tests/sistema_s_catalogos_acl_check.sql";

const OBJETOS = [
  "public.fornecedores",
  "public.catalogo_documentos",
  "public.catalogo_produtos",
  "public.catalogo_chunks",
  "public.fontes_externas",
  "public.licitacao_escopo_decisao",
  "public.v_fornecedor_participacoes",
  "public.v_oportunidades_externas",
];

/** Corpo do bloco `revoke all on table ... from anon, authenticated, PUBLIC;`. */
function blocoRevokeTabelas(sql: string): string {
  const m = sql.match(/revoke all on table([\s\S]*?)from anon, authenticated, PUBLIC;/);
  return m?.[1] ?? "";
}

Deno.test("migration ACL Sistema S revoga anon/authenticated/PUBLIC em todas as tabelas e views", async () => {
  const sql = await Deno.readTextFile(MIGRATION);
  const bloco = blocoRevokeTabelas(sql);
  for (const obj of OBJETOS) {
    assertEquals(bloco.includes(obj), true, `${obj} fora do revoke`);
  }
});

Deno.test("migration ACL Sistema S deixa authenticated só com SELECT (+ INSERT em licitacao_escopo_decisao)", async () => {
  const sql = await Deno.readTextFile(MIGRATION);
  assertEquals(/grant select on table[\s\S]*?to authenticated;/.test(sql), true);
  assertEquals(sql.includes("grant insert on table public.licitacao_escopo_decisao to authenticated;"), true);
  assertEquals(/grant (all|update|delete|truncate)[^;]*to authenticated/i.test(sql), false);
  assertEquals(/grant [^;]*to [^;]*\banon\b/i.test(sql), false);
});

Deno.test("migration ACL Sistema S fecha sequences e match_catalogo_chunks para anon", async () => {
  const sql = await Deno.readTextFile(MIGRATION);
  assertEquals(/revoke all on sequence[\s\S]*?from anon, authenticated, PUBLIC;/.test(sql), true);
  assertEquals(
    sql.includes("revoke execute on function public.match_catalogo_chunks(vector, int, text, text) from PUBLIC, anon;"),
    true,
  );
  assertEquals(sql.includes("to service_role;"), true);
});

Deno.test("script supabase/tests/sistema_s_catalogos_acl_check.sql cobre os mesmos objetos", async () => {
  const sql = await Deno.readTextFile(ACL_CHECK);
  for (const obj of OBJETOS) {
    assertEquals(sql.includes(`'${obj}'`), true, `${obj} fora do ACL check`);
  }
  assertEquals(sql.includes("has_table_privilege('anon'"), true);
  assertEquals(sql.includes("has_sequence_privilege('anon'"), true);
  assertEquals(sql.includes("has_function_privilege('anon'"), true);
  assertEquals(sql.includes("TRUNCATE"), true);
});
