import { assertEquals } from "jsr:@std/assert@1";

const MIGRATION = "./supabase/migrations/20260930120000_taxonomia_pisos.sql";
/** Carga vigente de taxonomia_no_pdm (pisos-0.2). A 20260930120000 segue valendo para exclusões e resolução. */
const MIGRATION_VIGENTE = "./supabase/migrations/20260930150000_taxonomia_pisos_v0_2.sql";
const TAXONOMIA = "./services/coletor-externo/coletor/data/taxonomia-pisos-v0.2.json";
const ESCOPO = "./supabase/functions/_shared/pncp/catmat-scope-resolver.ts";

type No = { slug: string; escopo: "IN" | "OUT"; pdm_catmat: number[] };

Deno.test("taxonomia de pisos: a carga da migration é exatamente o pdm_catmat dos nós IN do JSON", async () => {
  const tax = JSON.parse(await Deno.readTextFile(TAXONOMIA)) as { versao: string; nos: No[] };
  const esperado = new Set<string>();
  for (const n of tax.nos) {
    if (n.escopo === "OUT") assertEquals(n.pdm_catmat, [], `nó OUT ${n.slug} não aponta para PDM`);
    for (const p of n.pdm_catmat) esperado.add(`${n.slug}|${p}`);
  }

  const sql = await Deno.readTextFile(MIGRATION_VIGENTE);
  const carregado = new Set<string>();
  for (const m of sql.matchAll(/\('([a-z0-9_]+)', (\d+), '([a-z0-9.-]+)'\)/g)) {
    assertEquals(m[3], tax.versao, "versão da taxonomia na carga");
    carregado.add(`${m[1]}|${m[2]}`);
  }
  assertEquals([...esperado].filter((x) => !carregado.has(x)), [], "pares do JSON fora da migration");
  assertEquals([...carregado].filter((x) => !esperado.has(x)), [], "pares na migration que não estão no JSON");
  assertEquals(sql.includes("'piso_modular_pp'"), false, "o nó do concorrente não casa com PDM nenhum");
});

Deno.test("taxonomia de pisos: exclusões em tabela própria e respeitadas no casamento por texto", async () => {
  const sql = await Deno.readTextFile(MIGRATION);
  for (const trecho of [
    "create table if not exists public.catmat_pdm_exclusoes (",
    "references public.catmat_pdms(codigo_pdm) on delete cascade",
    "constraint catmat_pdm_exclusoes_codigo_pdm_padrao_key unique (codigo_pdm, padrao)",
    "alter table public.catmat_pdm_exclusoes enable row level security;",
    "create policy catmat_pdm_exclusoes_select on public.catmat_pdm_exclusoes for select to authenticated using (true);",
    "revoke all on table public.catmat_pdm_exclusoes from anon, authenticated, PUBLIC;",
    "grant select on table public.catmat_pdm_exclusoes to authenticated;",
    "revoke all on sequence public.catmat_pdm_exclusoes_id_seq from anon, authenticated, PUBLIC;",
    "from public.catmat_pdm_exclusoes x",
    "not exists (select 1 from exclusoes x",
    "por_taxonomia_objeto",
    "on conflict (codigo_pdm, padrao) do nothing",
  ]) {
    assertEquals(sql.includes(trecho), true, trecho);
  }
  // catmat_pdm_palavras não ganha coluna nova: views e consultas que leem os padrões não mudam de sentido
  assertEquals(/alter table public\.catmat_pdm_palavras/.test(sql), false, "catmat_pdm_palavras intocada");
  assertEquals(/\btipo\b/.test(sql), false, "sem coluna tipo");
  assertEquals(sql.includes("limit 20000"), false, "resolução sem truncamento");
  // 4 inclusões em catmat_pdm_palavras e 4 exclusões (10779 e 757) em catmat_pdm_exclusoes, só onde o PDM existe
  const blocoInc = sql.slice(sql.indexOf("insert into public.catmat_pdm_palavras"), sql.indexOf("insert into public.catmat_pdm_exclusoes"));
  const blocoExc = sql.slice(sql.indexOf("insert into public.catmat_pdm_exclusoes"), sql.indexOf("-- 4) Resolução"));
  assertEquals(blocoInc.match(/^\s+\((10779|12550), '/gm)?.length, 4);
  assertEquals(blocoExc.match(/^\s+\((10779|757), '/gm)?.length, 4);
  for (const b of [blocoInc, blocoExc]) assertEquals(b.includes("where exists (select 1 from public.catmat_pdms p"), true);
  assertEquals(sql.match(/not exists \(select 1 from exclusoes x/g)?.length, 2, "exclusão no item e no objeto");
  assertEquals(sql.includes("revoke execute on function public.licitacoes_ids_por_catmat(int[], int[], int[], int[], boolean) from PUBLIC, anon, authenticated;"), true);
});

Deno.test("taxonomia de pisos v0.2: a migration só materializa o PDM 9461; a lista de escopo é outra camada", async () => {
  const sql = await Deno.readTextFile(MIGRATION_VIGENTE);
  for (const trecho of [
    "insert into public.catmat_grupos (codigo_grupo, nome, status, payload_hash)",
    "on conflict (codigo_grupo) do nothing;",
    "values (93, 9320, 'ARTIGOS DE BORRACHA', true,",
    "on conflict (codigo_grupo, codigo_classe) do nothing;",
    "values (9461, 93, 9320, 'BORRACHA GRANULADA', true,",
    "on conflict (codigo_pdm) do nothing;",
    "('grama_sintetica', 18481, 'pisos-0.2')",
    "where exists (select 1 from public.catmat_pdms p where p.codigo_pdm = v.codigo_pdm)",
    "on conflict (codigo_pdm, padrao) do nothing;",
  ]) {
    assertEquals(sql.includes(trecho), true, trecho);
  }
  // só o PDM 9461 da classe 9320 entra (nada de sync da classe inteira)
  assertEquals(sql.match(/insert into public\.catmat_pdms/g)?.length, 1);
  // padrões: 6 para granulado (9461) e 1 para grama (18481)
  const bloco = sql.slice(sql.indexOf("insert into public.catmat_pdm_palavras"));
  assertEquals(bloco.match(/^\s+\(9461, '/gm)?.length, 6);
  assertEquals(bloco.match(/^\s+\(18481, '/gm)?.length, 1);
  // ACL e política intactas: a migration não mexe em grants nem na lista de classes do escopo
  assertEquals(/\b(grant|revoke|create policy|alter table)\b/i.test(sql), false, "sem mudança de ACL/esquema");
  const escopo = await Deno.readTextFile(ESCOPO);
  assertEquals(escopo.includes('classe: "9320"'), true, "9320 está na lista fixa como extensão curada");
  assertEquals(escopo.includes('classe: "7810"'), true, "7810 está na lista fixa como extensão curada");
});
