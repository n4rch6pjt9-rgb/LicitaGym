// Gate de CI para as migrations de segurança do RAG (PR #89).
// Estático (sem banco): o pr-quality roda deno test sem Postgres. A checagem em banco real continua em
// supabase/tests/sec_rag_prompt_injection_acl_check.sql (rodar com psql após aplicar as migrations).
import { assertEquals } from "jsr:@std/assert@1";

const MIG = "./supabase/migrations";
const BASELINE = `${MIG}/20260929180000_legislacao_rag_baseline.sql`;
const ACL_LOCK = `${MIG}/20260929180014_sec_rag_acl_lock.sql`;
const CLASSIFICACAO = `${MIG}/20260929183258_sec_rag_chunks_classificacao_insert.sql`;
const ORIGEM = `${MIG}/20260929185134_sec_rag_confianca_origem_controlada.sql`;
const BUSCAR_PY = "./services/coletor-externo/coletor/buscar.py";
const RAG_CONTEXTO_PY = "./services/coletor-externo/coletor/rag_contexto.py";
const ACL_CHECK = "./supabase/tests/sec_rag_prompt_injection_acl_check.sql";
const IA_PY = "./services/coletor-externo/coletor/ia.py";
const FECHA_LEITURA = `${MIG}/20260929190000_sec_legislacao_fecha_leitura.sql`;

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
    "INSERT OR UPDATE OF texto, metadados, secao",
    "classificar_origem_controlada",
    "base64_longo",
    "EMBEDDING IS NOT NULL",
  ]) {
    assertEquals(sql.includes(trecho), true, `ACL check sem: ${trecho}`);
  }
});

Deno.test("confiança vem da seção do portal; tipo_documento da IA só rebaixa", async () => {
  const sql = await Deno.readTextFile(ORIGEM);
  assertEquals(sql.includes("before insert or update of texto, metadados, secao"), true);
  assertEquals(sql.includes("from private.classificar_origem_controlada(new.metadados, new.secao) c"), true);
  const trigger = sql.slice(sql.indexOf("create or replace function private.trg_scan_chunk"));
  assertEquals(trigger.includes("classificar_tipo_documento"), false, "trigger não pode usar o tipo da IA direto");
  // na função de origem, orgao_publicado só nasce da seção 'parecer'
  const origem = sql.slice(sql.indexOf("create or replace function private.classificar_origem_controlada"), sql.indexOf("comment on function"));
  assertEquals((origem.match(/'orgao_publicado'/g) ?? []).length, 1);
  assertEquals(origem.includes("elsif secao = 'parecer' then"), true);
});

Deno.test("consumidor do RAG usa a v2 e o envelope de confiança", async () => {
  const py = await Deno.readTextFile(BUSCAR_PY);
  assertEquals(py.includes('"match_licitacao_chunks_v2"'), true);
  assertEquals(/rpc\("match_licitacao_chunks"/.test(py), false, "buscar.py ainda chama a v1");
  assertEquals(py.includes('"incluir_partes_interessadas"'), true);
  const ctx = await Deno.readTextFile(RAG_CONTEXTO_PY);
  assertEquals(ctx.includes("alegacao_de_parte") && ctx.includes("NIVEIS_EXCLUIDOS"), true);
});

Deno.test("ACL lock para com diagnóstico se consultas_log tiver linhas sem dono", async () => {
  const sql = await Deno.readTextFile(ACL_LOCK);
  const guarda = sql.indexOf("sem dono identificável");
  assertEquals(guarda > 0 && guarda < sql.indexOf("add column if not exists user_id uuid not null"), true);
});

Deno.test("base normativa: leitura e busca vetorial só service_role (20260929190000)", async () => {
  const sql = await Deno.readTextFile(FECHA_LEITURA);
  assertEquals(ACL_LOCK < FECHA_LEITURA && BASELINE < FECHA_LEITURA, true, "precisa vir depois da baseline e do ACL lock");
  for (const p of ["Permitir leitura pública de legislação", "Permitir leitura pública de embeddings"]) {
    assertEquals(sql.includes(`drop policy if exists "${p}"`), true, p);
  }
  assertEquals(
    sql.includes("revoke all on table public.legislacao, public.legislacao_embeddings from public, anon, authenticated;"),
    true,
  );
  assertEquals(
    sql.includes("revoke all on function public.match_legislacao_embeddings(vector, double precision, integer) from public, anon, authenticated;"),
    true,
  );
  assertEquals(/grant [^;]*to [^;]*\b(anon|authenticated|public)\b/i.test(sql), false, "não pode conceder nada a anon/authenticated/public");

  const check = await Deno.readTextFile(ACL_CHECK);
  assertEquals(check.includes("possui SELECT em % (leitura só service_role)"), true, "ACL check espera SELECT fechado");
  assertEquals(check.includes("has_function_privilege('authenticated', v_fn, 'EXECUTE')"), true);
});
