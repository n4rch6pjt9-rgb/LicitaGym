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
  assertEquals(consolidar([]).status_geral, "ok");
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
});
