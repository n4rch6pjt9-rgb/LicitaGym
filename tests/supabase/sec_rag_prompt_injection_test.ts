// Gate de CI para as migrations de segurança do RAG (PR #89).
// Estático (sem banco): o pr-quality roda deno test sem Postgres. A checagem em banco real continua em
// supabase/tests/sec_rag_prompt_injection_acl_check.sql (rodar com psql após aplicar as migrations).
import { assertEquals } from "jsr:@std/assert@1";

const MIG = "./supabase/migrations";
const BASELINE = `${MIG}/20260929180000_legislacao_rag_baseline.sql`;
const ACL_LOCK = `${MIG}/20260929180014_sec_rag_acl_lock.sql`;
const CLASSIFICACAO = `${MIG}/20260929183258_sec_rag_chunks_classificacao_insert.sql`;
const ACL_CHECK = "./supabase/tests/sec_rag_prompt_injection_acl_check.sql";
const IA_PY = "./services/coletor-externo/coletor/ia.py";

/** Lista TIPOS = [...] do indexador (fonte da verdade dos tipo_documento emitidos). */
async function tiposDoIndexador(): Promise<string[]> {
  const py = await Deno.readTextFile(IA_PY);
  const m = py.match(/TIPOS\s*=\s*\[([\s\S]*?)\]/);
  if (!m) throw new Error("TIPOS não encontrado em ia.py");
  return [...m[1].matchAll(/"([a-z_]+)"/g)].map((x) => x[1]);
}

Deno.test("baseline cria as tabelas do RAG antes da migration de ACL (replay em banco novo)", async () => {
  const sql = await Deno.readTextFile(BASELINE);
  for (const t of ["public.legislacao", "public.legislacao_embeddings", "public.consultas_log"]) {
    assertEquals(sql.includes(`create table if not exists ${t} (`), true, `${t} fora da baseline`);
  }
  assertEquals(BASELINE < ACL_LOCK, true, "baseline precisa vir antes da 20260929180014");
  // não pode reabrir a escrita que a migration seguinte fecha
  assertEquals(/create policy[^;]*for (insert|update|delete|all)/i.test(sql), false);
  assertEquals(/create or replace function/i.test(sql), false, "baseline não pode redefinir funções (apaga SET search_path)");
});

Deno.test("ACL lock deixa anon/authenticated só com SELECT na base normativa", async () => {
  const sql = await Deno.readTextFile(ACL_LOCK);
  assertEquals(
    sql.includes("revoke all on table public.legislacao, public.legislacao_embeddings from public, anon, authenticated;"),
    true,
  );
  assertEquals(/grant (all|insert|update|delete|truncate)[^;]*to [^;]*\b(anon|authenticated)\b/i.test(sql), false);
  assertEquals(sql.includes("user_id uuid not null references auth.users(id)"), true);
  assertEquals(/user_id uuid[^,]*default auth\.uid\(\)/i.test(sql), false);
});

Deno.test("classificação cobre todos os TIPOS emitidos pelo indexador", async () => {
  const sql = await Deno.readTextFile(CLASSIFICACAO);
  const corpo = sql.slice(sql.indexOf("private.classificar_tipo_documento"), sql.indexOf("private.trg_scan_chunk"));
  const semRegra = (await tiposDoIndexador()).filter((t) => t !== "esclarecimento" && !corpo.includes(`'${t}'`));
  assertEquals(semRegra, [], `TIPOS sem política explícita: ${semRegra.join(", ")}`);
  const parteInteressada = corpo.match(/when tipo in \(([^)]*)\)\s*then 'parte_interessada'/)?.[1] ?? "";
  for (const t of ["impugnacao", "recurso", "contrarrazoes", "proposta", "habilitacao"]) {
    assertEquals(parteInteressada.includes(`'${t}'`), true, `${t} deveria ser parte_interessada`);
  }
});

Deno.test("trigger classifica em INSERT e UPDATE de metadados; base64 rebaixa; v2 ignora embedding nulo", async () => {
  const sql = await Deno.readTextFile(CLASSIFICACAO);
  assertEquals(sql.includes("before insert or update of texto, metadados"), true);
  assertEquals(/'base64_longo'\)::boolean, false\);/.test(sql), true);
  assertEquals(sql.includes("where c.embedding is not null"), true);
  assertEquals(
    sql.includes("revoke all on function public.match_licitacao_chunks_v2(vector, integer, text, text, boolean) from public, anon, authenticated;"),
    true,
  );
});

Deno.test("checagem SQL cobre ACL, classificação e scanner", async () => {
  const sql = await Deno.readTextFile(ACL_CHECK);
  for (const trecho of [
    "has_table_privilege('anon'",
    "TRUNCATE",
    "has_function_privilege('anon'",
    "classificar_tipo_documento('impugnacao')",
    "INSERT OR UPDATE OF texto, metadados",
    "base64_longo",
    "EMBEDDING IS NOT NULL",
  ]) {
    assertEquals(sql.includes(trecho), true, `ACL check sem: ${trecho}`);
  }
});
