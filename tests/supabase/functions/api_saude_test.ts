// deno-lint-ignore-file no-import-prefix -- o repo não tem deno.json/import map; todos os testes importam por jsr:.
import { assertEquals } from "jsr:@std/assert@1";
import { type ApiSaudeContext, consolidar, handleRequest, type Verificacao } from "../../../supabase/functions/api-saude/index.ts";

const v = (verificacao: string, status: string): Verificacao =>
  ({ verificacao, status, valor: 1, unidade: "x", atencao: 1, critico: 3, mensagem: verificacao, detalhe: [] }) as Verificacao;

const post = (body: unknown = { action: "resumo" }) =>
  new Request("http://x/api-saude", { method: "POST", body: JSON.stringify(body), headers: { Authorization: "Bearer t" } });

const ADMIN = { id: "u1", app_metadata: { licitagym_role: "admin" } };
const COMUM = { id: "u2", app_metadata: {} };

function ctx(over: Partial<ApiSaudeContext> = {}): ApiSaudeContext {
  return {
    isCron: () => false,
    getUser: () => Promise.resolve(ADMIN),
    getResumo: () => Promise.resolve([v("a", "ok"), v("b", "atencao"), v("c", "critico")]),
    agora: () => new Date("2026-10-01T06:00:00Z"),
    ...over,
  };
}

Deno.test("api-saude: sem credencial 401, usuário comum 403, admin e cron 200", async () => {
  assertEquals((await handleRequest(post(), ctx({ getUser: () => Promise.resolve(null) }))).status, 401);
  assertEquals((await handleRequest(post(), ctx({ getUser: () => Promise.resolve(COMUM) }))).status, 403);
  assertEquals((await handleRequest(post(), ctx())).status, 200);
  let consultouUsuario = false;
  const r = await handleRequest(post(), ctx({ isCron: () => true, getUser: () => { consultouUsuario = true; return Promise.resolve(null); } }));
  assertEquals(r.status, 200);
  assertEquals(consultouUsuario, false, "cron secret não passa pela validação de usuário");
});

Deno.test("api-saude: status geral é o pior; status desconhecido conta como atenção", async () => {
  const body = await (await handleRequest(post(), ctx())).json();
  assertEquals(body.status_geral, "critico");
  assertEquals(body.contagem, { ok: 1, atencao: 1, critico: 1 });
  assertEquals(body.gerado_em, "2026-10-01T06:00:00.000Z");
  assertEquals(consolidar([v("a", "ok"), v("b", "estranho")]).status_geral, "atencao");
  assertEquals(consolidar([]).status_geral, "atencao");
  assertEquals(consolidar([v("a", "constructor")]).status_geral, "atencao");
});

Deno.test("api-saude: ausência de verificações não retorna sucesso", async () => {
  const r = await handleRequest(post(), ctx({ getResumo: () => Promise.resolve([]) }));
  assertEquals(r.status, 500);
  assertEquals(await r.json(), { error: "Falha ao calcular a saúde operacional." });
});

Deno.test("api-saude: método, corpo e ação inválidos; falha do banco vira 500 sem detalhe interno", async () => {
  assertEquals((await handleRequest(new Request("http://x", { method: "GET" }), ctx())).status, 405);
  assertEquals((await handleRequest(post({ action: "outra" }), ctx())).status, 400);
  const bad = new Request("http://x", { method: "POST", body: "{", headers: { Authorization: "Bearer t" } });
  assertEquals((await handleRequest(bad, ctx())).status, 400);
  const r = await handleRequest(post(), ctx({ getResumo: () => Promise.reject(new Error("senha=xyz")) }));
  assertEquals(r.status, 500);
  assertEquals(JSON.stringify(await r.json()).includes("xyz"), false);
});

Deno.test("api-saude: o resumo não passa pelo schema private do PostgREST", async () => {
  const src = await Deno.readTextFile("./supabase/functions/api-saude/index.ts");
  assertEquals(src.includes('.schema("private")'), false);
  assertEquals(src.includes('rpc("saude_operacional_resumo")'), true);
});

Deno.test("migration de saúde: tudo só service_role e função security definer com search_path fixo", async () => {
  const sql = await Deno.readTextFile("./supabase/migrations/20261001100000_saude_operacional.sql");
  assertEquals(sql.includes("revoke all on table private.saude_limiares from public, anon, authenticated;"), true);
  assertEquals(sql.includes("revoke all on function private.saude_operacional_resumo() from public, anon, authenticated;"), true);
  assertEquals(/grant [^;]*to [^;]*\b(anon|authenticated)\b/i.test(sql), false);
  assertEquals(sql.includes("security definer") && sql.includes("set search_path = pg_catalog, pg_temp"), true);
  assertEquals(sql.includes("on conflict (verificacao) do nothing"), true, "não sobrescreve limiar editado");

  const inv = await Deno.readTextFile("./supabase/migrations/20261007133000_saude_rpc_public.sql");
  assertEquals(inv.includes("create or replace function public.saude_operacional_resumo()"), true);
  assertEquals(inv.includes("from private.saude_operacional_resumo()"), true);
  assertEquals(inv.includes("security definer") && inv.includes("set search_path = pg_catalog, private, pg_temp"), true);
  assertEquals(inv.includes("revoke all on function public.saude_operacional_resumo() from public, anon, authenticated;"), true);
  assertEquals(inv.includes("grant execute on function public.saude_operacional_resumo() to service_role;"), true);
  assertEquals(/grant [^;]*to [^;]*\b(anon|authenticated)\b/i.test(inv), false);
});

// Spec 0063, CA-6 (K-3, K-4): a verificação de execução presa da coleta externa sai na api-saude e o workflow de
// saúde a exige (SAUDE_VERIFICACOES_ESPERADAS), senão o resumo sem ela não acusaria contrato incompleto.
Deno.test("CA-6: coleta_externa_executando_horas sai na api-saude e está em SAUDE_VERIFICACOES_ESPERADAS", async () => {
  const migrations = [...Deno.readDirSync("./supabase/migrations")]
    .map((e) => e.name)
    .filter((n) => /^\d{14}_.*\.sql$/.test(n))
    .sort();
  let ultimaSaude = "";
  for (const nome of migrations) {
    const sql = Deno.readTextFileSync(`./supabase/migrations/${nome}`);
    if (sql.includes("create or replace function private.saude_operacional_resumo()")) ultimaSaude = sql;
  }
  assertEquals(ultimaSaude.includes("'verificacao', 'coleta_externa_executando_horas'"), true,
    "a definição mais recente da função de saúde mede coleta_externa_executando_horas");
  assertEquals(/\('coleta_externa_executando_horas',[^)]*'horas',\s*2,\s*7,/.test(ultimaSaude), true,
    "limiares atenção 2 h e crítico 7 h");

  const body = await (await handleRequest(post(), ctx({
    getResumo: () => Promise.resolve([v("coleta_externa_executando_horas", "critico")]),
  }))).json();
  assertEquals(body.verificacoes.map((x: Verificacao) => x.verificacao), ["coleta_externa_executando_horas"]);

  const yml = await Deno.readTextFile("./.github/workflows/saude.yml");
  const esperadas = yml.match(/SAUDE_VERIFICACOES_ESPERADAS:\s*(\S+)/)?.[1].split(",") ?? [];
  assertEquals(esperadas.includes("coleta_externa_executando_horas"), true);
  assertEquals(esperadas.includes("coleta_externa_dias_sem_sucesso"), true);
});

// Spec 0064, CA-9 (K-9): idade do pendente mais antigo da fila do Sistema S sai na api-saude e o workflow de saúde a
// exige; limiares atenção 26 h e crítico 48 h na definição mais recente da função.
Deno.test("CA-9: coleta_externa_fila_pendente_horas sai na api-saude e está em SAUDE_VERIFICACOES_ESPERADAS", async () => {
  const migrations = [...Deno.readDirSync("./supabase/migrations")]
    .map((e) => e.name)
    .filter((n) => /^\d{14}_.*\.sql$/.test(n))
    .sort();
  let ultimaSaude = "";
  for (const nome of migrations) {
    const sql = Deno.readTextFileSync(`./supabase/migrations/${nome}`);
    if (sql.includes("create or replace function private.saude_operacional_resumo()")) ultimaSaude = sql;
  }
  assertEquals(ultimaSaude.includes("'verificacao', 'coleta_externa_fila_pendente_horas'"), true,
    "a definição mais recente da função de saúde mede coleta_externa_fila_pendente_horas");
  assertEquals(/\('coleta_externa_fila_pendente_horas',[^)]*'horas',\s*26,\s*48,/.test(ultimaSaude), true,
    "limiares atenção 26 h e crítico 48 h");

  const body = await (await handleRequest(post(), ctx({
    getResumo: () => Promise.resolve([v("coleta_externa_fila_pendente_horas", "atencao")]),
  }))).json();
  assertEquals(body.verificacoes.map((x: Verificacao) => x.verificacao), ["coleta_externa_fila_pendente_horas"]);

  const yml = await Deno.readTextFile("./.github/workflows/saude.yml");
  const esperadas = yml.match(/SAUDE_VERIFICACOES_ESPERADAS:\s*(\S+)/)?.[1].split(",") ?? [];
  assertEquals(esperadas.includes("coleta_externa_fila_pendente_horas"), true);
});
