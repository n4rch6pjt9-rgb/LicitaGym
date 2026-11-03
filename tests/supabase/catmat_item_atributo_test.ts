import { assertEquals } from "jsr:@std/assert@1";

const MIGRATION = "./supabase/migrations/20261004005000_catmat_item_atributo_ancoras.sql";
const PARSER = "./supabase/functions/_shared/compras-gov/descricao-parser.ts";

Deno.test("catmat_item_atributo: tabela, âncoras e ACL no padrão do catálogo; nada roda na migration", async () => {
  const sql = await Deno.readTextFile(MIGRATION);
  for (const trecho of [
    "create table if not exists public.catmat_item_atributo (",
    "references public.catmat_item_pdm (codigo_item) on delete cascade",
    "primary key (codigo_item, ordem)",
    "add column if not exists nome_item text generated always as (public.catmat_cabeca_descricao(descricao)) stored",
    "create table if not exists public.catmat_pdm_ancoras (",
    "constraint catmat_pdm_ancoras_pdm_ancora_key unique (codigo_pdm, ancora)",
    "create or replace view public.catmat_pdm_ancoras_nucleo\nwith (security_invoker = true) as",
    "create or replace function public.catmat_gerar_ancoras(p_aplicar boolean default false)",
    "alter table public.catmat_item_atributo enable row level security;",
    "alter table public.catmat_pdm_ancoras enable row level security;",
    "revoke all on table public.catmat_item_atributo, public.catmat_pdm_ancoras, public.catmat_pdm_ancoras_nucleo from anon, authenticated, PUBLIC;",
  ]) {
    assertEquals(sql.includes(trecho), true, trecho);
  }
  // as âncoras não viram regex em catmat_pdm_palavras (10+ consumidores aplicam todo padrão ativo a todo item)
  assertEquals(/(alter table|insert into|update) public\.catmat_pdm_palavras/.test(sql), false, "catmat_pdm_palavras intocada");
  // a migration só cria: geração e backfill rodam depois, com ok
  assertEquals(/select\s+public\.catmat_(gerar_ancoras|item_atributo_sincronizar)\s*\(/.test(sql), false, "sem execução na migration");
  // dry-run precisa caber em "begin read only": nada de tabela temporária
  assertEquals(/create temp/i.test(sql), false, "sem temp table");
});

Deno.test("catmat_item_atributo: o separador do parser TS é o mesmo da função SQL", async () => {
  const sql = await Deno.readTextFile(MIGRATION);
  const ts = await Deno.readTextFile(PARSER);
  const classe = "[A-ZÁÀÂÃÄÉÈÊËÍÌÎÏÓÒÔÕÖÚÙÛÜÇ0-9][A-ZÁÀÂÃÄÉÈÊËÍÌÎÏÓÒÔÕÖÚÙÛÜÇ0-9 /().ºª-]{0,80}:";
  assertEquals(ts.includes(classe), true, "TS");
  assertEquals(sql.split(classe).length - 1, 2, "SQL: cabeça e atributos");
});
