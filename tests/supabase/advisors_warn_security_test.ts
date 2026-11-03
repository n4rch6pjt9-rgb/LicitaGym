import { assert, assertEquals } from "jsr:@std/assert@1";

const MIGRATION =
  "./supabase/migrations/20261004120000_advisors_warn_security.sql";

const FUNCOES_SEARCH_PATH_VAZIO = [
  "public.update_updated_at_column()",
  "public.taxonomia_bloco(text)",
];

const MATCH = [
  "public.match_legislacao_embeddings(vector,double precision,integer)",
  "public.match_licitacao_chunks(vector,integer,text,text)",
  "public.match_licitacao_chunks_v2(vector,integer,text,text,boolean)",
  "public.match_catalogo_chunks(vector,integer,text,text)",
];

/** SQL sem comentários de linha, para os asserts não casarem com o cabeçalho. */
async function sqlSemComentarios(path: string): Promise<string> {
  return (await Deno.readTextFile(path)).replace(/--[^\n]*/g, "");
}

Deno.test("migration advisors: revoga a MV catmat_item_completo de anon e authenticated", async () => {
  const sql = await sqlSemComentarios(MIGRATION);
  assert(
    /revoke all on table public\.catmat_item_completo from public, anon, authenticated;/.test(
      sql,
    ),
    "revoke da MV ausente",
  );
  assertEquals(
    /grant [^;]*catmat_item_completo[^;]*to (authenticated|anon)\b/i.test(sql),
    false,
    "a MV não pode voltar a ter grant para anon ou authenticated",
  );
  assert(
    sql.includes("grant all on table public.catmat_item_completo to service_role;"),
    "service_role sem ALL na MV",
  );
});

Deno.test("migration advisors: search_path vazio nas duas funções e public, extensions nas match_*", async () => {
  const sql = await sqlSemComentarios(MIGRATION);
  for (const fn of FUNCOES_SEARCH_PATH_VAZIO) {
    const trecho = `alter function ${fn} set search_path = '';`;
    assert(sql.includes(trecho), `${fn} sem set search_path = ''`);
  }
  assert(
    sql.includes("set search_path = public, extensions"),
    "match_* sem search_path = public, extensions",
  );
  for (const fn of MATCH) {
    assert(sql.includes(`'${fn}'`), `${fn} fora da lista match_*`);
  }
});

Deno.test("migration advisors: não move a extensão vector (alter extension ausente)", async () => {
  const sql = await sqlSemComentarios(MIGRATION);
  assertEquals(/alter\s+extension/i.test(sql), false);
});
