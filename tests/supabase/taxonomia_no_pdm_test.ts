import { assertEquals } from "jsr:@std/assert@1";

const MIGRATION = "./supabase/migrations/20260930110000_taxonomia_no_pdm.sql";
const DICIONARIO = "./services/coletor-externo/coletor/data/dicionario-aparelhos-v0.3.json";

type No = { slug: string; pdm_catmat?: number[] | null };

Deno.test("taxonomia_no_pdm: a carga da migration é exatamente o pdm_catmat do dicionário de aparelhos", async () => {
  const dic = JSON.parse(await Deno.readTextFile(DICIONARIO)) as { versao: string; nos: No[] };
  const esperado = new Set<string>();
  // O nó-balde fora_escopo fica de fora de propósito (ver cabeçalho da migration)
  for (const n of dic.nos) {
    if (n.slug === "fora_escopo") continue;
    for (const p of n.pdm_catmat ?? []) esperado.add(`${n.slug}|${Number(p)}`);
  }

  const sql = await Deno.readTextFile(MIGRATION);
  const carregado = new Set<string>();
  for (const m of sql.matchAll(/\('([a-z0-9_]+)', (\d+), '([\d.]+)'\)/g)) {
    assertEquals(m[3], dic.versao, "versão do dicionário na carga");
    carregado.add(`${m[1]}|${m[2]}`);
  }

  const faltando = [...esperado].filter((x) => !carregado.has(x));
  const sobrando = [...carregado].filter((x) => !esperado.has(x));
  assertEquals(faltando, [], "pares do dicionário fora da migration (nova versão do dicionário pede nova migration)");
  assertEquals(sobrando, [], "pares na migration que não estão no dicionário");
  assertEquals(carregado.size, 180);
  assertEquals([...carregado].some((x) => x.startsWith("fora_escopo|")), false);
});

Deno.test("licitacoes_ids_por_catmat ganha os motivos de taxonomia sem perder os anteriores", async () => {
  const sql = await Deno.readTextFile(MIGRATION);
  for (const trecho of ["por_codigo", "por_texto_item", "por_texto_objeto", "por_taxonomia", "por_taxonomia_objeto", "'taxonomia'", "'taxonomia_objeto'"]) {
    assertEquals(sql.includes(trecho), true, trecho);
  }
  assertEquals(sql.includes("revoke all on table public.taxonomia_no_pdm from anon, authenticated, PUBLIC;"), true);
  assertEquals(/grant [^;]*taxonomia_no_pdm[^;]*to authenticated/.test(sql), true);
  // Linhas antigas só têm o JSONB; licitacoes_externas não tem o JSONB
  assertEquals(sql.includes("coalesce(li.no_taxonomia, li.taxonomia->>'no_taxonomia')"), true);
  assertEquals(sql.includes("le.taxonomia"), false);
});
