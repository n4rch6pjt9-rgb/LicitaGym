import { assertEquals } from "jsr:@std/assert@1";
import { SYNCS } from "../../../supabase/functions/api-syncs/catalogo.ts";
import { type ApiSyncsContext, handleRequest } from "../../../supabase/functions/api-syncs/index.ts";

const ADMIN = { id: "u1", app_metadata: { licitagym_role: "admin" } };
const COMUM = { id: "u2", app_metadata: {} };

function post(body: unknown) {
  return new Request("http://x/api-syncs", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { Authorization: "Bearer t" },
  });
}

function ctx(over: Partial<ApiSyncsContext> = {}): ApiSyncsContext {
  return {
    isCron: () => false,
    getUser: () => Promise.resolve(ADMIN),
    segredo: () => "segredo-de-teste",
    baseUrl: () => "https://exemplo.supabase.co/functions/v1",
    fetchFn: () => Promise.resolve(new Response(JSON.stringify({ status: "ok", sync_id: "1" }), { status: 200 })),
    ...over,
  };
}

Deno.test("api-syncs: sem credencial 401 e usuário comum 403", async () => {
  assertEquals((await handleRequest(post({ action: "listar" }), ctx({ getUser: () => Promise.resolve(null) }))).status, 401);
  assertEquals((await handleRequest(post({ action: "listar" }), ctx({ getUser: () => Promise.resolve(COMUM) }))).status, 403);
});

Deno.test("api-syncs: listar separa cron de quem nunca entrou", async () => {
  const body = await (await handleRequest(post({ action: "listar" }), ctx())).json();
  const portal = body.syncs.find((s: { slug: string }) => s.slug === "sync-portal-compras");
  const editais = body.syncs.find((s: { slug: string }) => s.slug === "sync-pncp-contratacoes-editais");
  const coletor = body.syncs.find((s: { slug: string }) => s.slug === "coletor-pncp");
  assertEquals(portal.cron, "Todo dia às 08:00.");
  assertEquals(portal.disparavel, true);
  assertEquals(editais.cron, null);
  assertEquals(coletor.disparavel, false);
  assertEquals(body.syncs.length, SYNCS.length);
  assertEquals(JSON.stringify(body).includes("segredo-de-teste"), false);
});

Deno.test("api-syncs: rodar encaminha o corpo do catálogo e não devolve o segredo", async () => {
  let url = "";
  let authorization = "";
  let enviado = "";
  const c = ctx({
    fetchFn: (input, init) => {
      url = String(input);
      authorization = new Headers(init?.headers).get("authorization") ?? "";
      enviado = String(init?.body);
      return Promise.resolve(new Response(JSON.stringify({ status: "ok" }), { status: 200 }));
    },
  });
  const res = await handleRequest(post({ action: "rodar", sync: "sync-portal-compras" }), c);
  const body = await res.json();
  assertEquals(res.status, 200);
  assertEquals(url, "https://exemplo.supabase.co/functions/v1/sync-portal-compras");
  assertEquals(authorization, "Bearer segredo-de-teste");
  assertEquals(JSON.parse(enviado), { limite: 40, origem: "manual" });
  assertEquals(JSON.stringify(body).includes("segredo-de-teste"), false);
});

Deno.test("api-syncs: sync que responde erro ainda devolve o corpo e o status", async () => {
  const c = ctx({
    fetchFn: () => Promise.resolve(new Response(JSON.stringify({ error: "limite excedido" }), { status: 429 })),
  });
  const res = await handleRequest(post({ action: "rodar", sync: "sync-portal-compras" }), c);
  const body = await res.json();
  assertEquals(res.status, 200);
  assertEquals(body.http, 429);
  assertEquals(body.resposta.error, "limite excedido");
  assertEquals(JSON.stringify(body).includes("segredo-de-teste"), false);
});

Deno.test("api-syncs: coletor e sync desconhecido não disparam", async () => {
  let chamou = false;
  const c = ctx({ fetchFn: () => { chamou = true; return Promise.resolve(new Response("{}")); } });
  assertEquals((await handleRequest(post({ action: "rodar", sync: "coletor-pncp" }), c)).status, 400);
  assertEquals((await handleRequest(post({ action: "rodar", sync: "nao-existe" }), c)).status, 400);
  assertEquals(chamou, false);
});

Deno.test("CA-6 (spec 0023): rodar manda origem manual no corpo da função disparada", async () => {
  let enviado = "";
  const c = ctx({
    fetchFn: (_input, init) => {
      enviado = String(init?.body);
      return Promise.resolve(new Response(JSON.stringify({ status: "ok" }), { status: 200 }));
    },
  });
  const res = await handleRequest(post({ action: "rodar", sync: "sync-portal-compras" }), c);
  assertEquals(res.status, 200);
  const corpo = JSON.parse(enviado);
  assertEquals(corpo.origem, "manual");
  assertEquals(corpo.limite, 40);
});
