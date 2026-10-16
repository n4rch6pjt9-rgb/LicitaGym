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
  // coletor Python agora dispara pelo GitHub Actions (workflow coletor-pncp.yml)
  assertEquals(coletor.disparavel, true);
  assertEquals(coletor.github_workflow, "coletor-pncp.yml");
  assertEquals(coletor.cron?.includes("GitHub Actions"), true);
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

Deno.test("api-syncs: sync desconhecido e sync sem função nem workflow não disparam", async () => {
  let chamou = false;
  const c = ctx({ fetchFn: () => { chamou = true; return Promise.resolve(new Response("{}")); } });
  assertEquals((await handleRequest(post({ action: "rodar", sync: "nao-existe" }), c)).status, 400);
  assertEquals(chamou, false);
  // o catálogo não pode ter item disparável sem destino (função ou workflow)
  assertEquals(SYNCS.every((s) => !s.disparavel || Boolean(s.funcao) || Boolean(s.github_workflow)), true);
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

Deno.test("api-syncs: rodar coletor-pncp dispara o workflow no GitHub com rapido=true e não devolve o token", async () => {
  let url = "";
  let authorization = "";
  let enviado = "";
  const c = ctx({
    githubToken: () => "github-token-de-teste",
    githubRepo: () => "dono/repo",
    fetchFn: (input, init) => {
      url = String(input);
      authorization = new Headers(init?.headers).get("authorization") ?? "";
      enviado = String(init?.body);
      return Promise.resolve(new Response(null, { status: 204 }));
    },
  });
  const res = await handleRequest(post({ action: "rodar", sync: "coletor-pncp" }), c);
  const body = await res.json();
  assertEquals(res.status, 200);
  assertEquals(url, "https://api.github.com/repos/dono/repo/actions/workflows/coletor-pncp.yml/dispatches");
  assertEquals(authorization, "Bearer github-token-de-teste");
  assertEquals(JSON.parse(enviado), { ref: "main", inputs: { modo: "leads", dry_run: "false", rapido: "true" } });
  assertEquals(body.http, 204);
  assertEquals(body.resposta.status, "disparado");
  assertEquals(JSON.stringify(body).includes("github-token-de-teste"), false);
});

Deno.test("api-syncs: coletor-pncp sem GITHUB_ACTIONS_TOKEN responde 500 sem chamar o GitHub", async () => {
  let chamou = false;
  const c = ctx({ githubToken: () => null, fetchFn: () => { chamou = true; return Promise.resolve(new Response(null, { status: 204 })); } });
  const res = await handleRequest(post({ action: "rodar", sync: "coletor-pncp" }), c);
  assertEquals(res.status, 500);
  assertEquals(chamou, false);
});

Deno.test("api-syncs: GitHub recusa (422) volta como http da resposta, sem segredo", async () => {
  const c = ctx({
    githubToken: () => "github-token-de-teste",
    fetchFn: () => Promise.resolve(new Response(JSON.stringify({ message: "Unexpected inputs provided" }), { status: 422 })),
  });
  const res = await handleRequest(post({ action: "rodar", sync: "coletor-pncp" }), c);
  const body = await res.json();
  assertEquals(res.status, 200);
  assertEquals(body.http, 422);
  assertEquals(body.resposta.message, "Unexpected inputs provided");
  assertEquals(JSON.stringify(body).includes("github-token-de-teste"), false);
});

Deno.test("api-syncs: GITHUB_ACTIONS_REPO inválido responde 500 sem cair no repositório padrão", async () => {
  let chamou = false;
  const c = ctx({
    githubToken: () => "github-token-de-teste",
    githubRepo: () => null,
    fetchFn: () => { chamou = true; return Promise.resolve(new Response(null, { status: 204 })); },
  });
  const res = await handleRequest(post({ action: "rodar", sync: "coletor-pncp" }), c);
  assertEquals(res.status, 500);
  assertEquals(chamou, false);
});

// ---- spec 0025: refazer as etapas que falharam no cron do Coletor PNCP ----

type RunGh = {
  id: number;
  event: string;
  status: string;
  conclusion: string | null;
  run_attempt: number;
  created_at: string;
  html_url: string;
};

function runGh(over: Partial<RunGh> = {}): RunGh {
  return {
    id: 38746383473,
    event: "schedule",
    status: "completed",
    conclusion: "cancelled",
    run_attempt: 1,
    created_at: "2026-10-15T13:52:12Z",
    html_url: "https://github.com/dono/repo/actions/runs/38746383473",
    ...over,
  };
}

const JOBS_GH = {
  total_count: 2,
  jobs: [
    { name: "plano", status: "completed", conclusion: "success", started_at: "2026-10-15T13:52:15Z", completed_at: "2026-10-15T13:52:20Z" },
    { name: "coletar (monitorar)", status: "completed", conclusion: "cancelled", started_at: "2026-10-15T13:52:21Z", completed_at: "2026-10-15T18:52:40Z" },
  ],
};

/** GitHub falso: responde por URL e anota cada chamada. */
function github(opts: { agendado?: RunGh | null; recentes?: RunGh[]; falha?: number; rerun?: number } = {}) {
  const chamadas: { url: string; method: string; authorization: string }[] = [];
  const agendado = opts.agendado === undefined ? runGh() : opts.agendado;
  const fetchFn: typeof fetch = (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    chamadas.push({ url, method, authorization: new Headers(init?.headers).get("authorization") ?? "" });
    const json = (b: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(b), { status }));
    if (opts.falha) return json({ message: "Server Error" }, opts.falha);
    if (url.includes("/rerun-failed-jobs")) {
      const st = opts.rerun ?? 201;
      return st === 201 ? Promise.resolve(new Response(null, { status: 201 })) : json({ message: "Cannot rerun" }, st);
    }
    if (url.includes("/actions/runs/") && url.includes("/jobs")) return json(JOBS_GH);
    if (url.includes("/workflows/coletor-pncp.yml/runs") && url.includes("event=schedule")) {
      return json({ total_count: agendado ? 1 : 0, workflow_runs: agendado ? [agendado] : [] });
    }
    if (url.includes("/workflows/coletor-pncp.yml/runs")) {
      const recentes = opts.recentes ?? (agendado ? [agendado] : []);
      return json({ total_count: recentes.length, workflow_runs: recentes });
    }
    return json({ message: "Not Found" }, 404);
  };
  return { chamadas, fetchFn };
}

function ctxGh(gh: ReturnType<typeof github>, over: Partial<ApiSyncsContext> = {}): ApiSyncsContext {
  return ctx({ githubToken: () => "github-token-de-teste", githubRepo: () => "dono/repo", fetchFn: gh.fetchFn, ...over });
}

async function coletorListado(c: ApiSyncsContext) {
  const body = await (await handleRequest(post({ action: "listar" }), c)).json();
  return { body, coletor: body.syncs.find((s: { slug: string }) => s.slug === "coletor-pncp") };
}

for (const conclusion of ["failure", "cancelled", "timed_out"]) {
  Deno.test(`CA-1: último cron agendado em ${conclusion} libera refazer e traz as etapas como o GitHub devolveu`, async () => {
    const gh = github({ agendado: runGh({ conclusion }) });
    const { coletor } = await coletorListado(ctxGh(gh));
    assertEquals(coletor.pode_refazer, true);
    assertEquals(coletor.ultimo_cron?.run_id, 38746383473);
    assertEquals(coletor.ultimo_cron?.conclusion, conclusion);
    assertEquals(coletor.ultimo_cron?.run_attempt, 1);
    assertEquals(coletor.ultimo_cron?.created_at, "2026-10-15T13:52:12Z");
    assertEquals(coletor.ultimo_cron?.etapas, [
      { nome: "plano", status: "completed", conclusion: "success", started_at: "2026-10-15T13:52:15Z", completed_at: "2026-10-15T13:52:20Z" },
      { nome: "coletar (monitorar)", status: "completed", conclusion: "cancelled", started_at: "2026-10-15T13:52:21Z", completed_at: "2026-10-15T18:52:40Z" },
    ]);
    assertEquals(coletor.erro_ultimo_cron, null);
    assertEquals(gh.chamadas.some((c) => c.url.includes("event=schedule")), true);
  });
}

Deno.test("CA-2: cron em success não libera refazer, e refazer responde 409 sem rerun", async () => {
  const gh = github({ agendado: runGh({ conclusion: "success" }) });
  const { coletor } = await coletorListado(ctxGh(gh));
  assertEquals(coletor.pode_refazer, false);
  const res = await handleRequest(post({ action: "refazer", sync: "coletor-pncp" }), ctxGh(gh));
  assertEquals(res.status, 409);
  assertEquals(gh.chamadas.some((c) => c.url.includes("rerun")), false);
});

Deno.test("CA-2: run do workflow na fila ou rodando bloqueia refazer (409), mesmo com o cron em falha", async () => {
  for (const status of ["queued", "in_progress"]) {
    const falhou = runGh({ conclusion: "failure" });
    const manual = runGh({ id: 99, event: "workflow_dispatch", status, conclusion: null });
    const gh = github({ agendado: falhou, recentes: [manual, falhou] });
    const { coletor } = await coletorListado(ctxGh(gh));
    assertEquals(coletor.pode_refazer, false);
    assertEquals(typeof coletor.motivo_refazer, "string");
    const res = await handleRequest(post({ action: "refazer", sync: "coletor-pncp" }), ctxGh(gh));
    assertEquals(res.status, 409);
    assertEquals(gh.chamadas.some((c) => c.url.includes("rerun")), false);
  }
});

Deno.test("CA-2: o próprio cron ainda rodando não libera refazer", async () => {
  const gh = github({ agendado: runGh({ status: "in_progress", conclusion: null }) });
  const { coletor } = await coletorListado(ctxGh(gh));
  assertEquals(coletor.pode_refazer, false);
  assertEquals((await handleRequest(post({ action: "refazer", sync: "coletor-pncp" }), ctxGh(gh))).status, 409);
});

Deno.test("CA-3: refazer faz um único POST rerun-failed-jobs no run que o servidor achou, ignorando run_id do corpo", async () => {
  const gh = github({ agendado: runGh({ conclusion: "failure" }) });
  const res = await handleRequest(post({ action: "refazer", sync: "coletor-pncp", run_id: 1 }), ctxGh(gh));
  const body = await res.json();
  assertEquals(res.status, 200);
  const posts = gh.chamadas.filter((c) => c.method === "POST");
  assertEquals(posts.length, 1);
  assertEquals(posts[0]?.url, "https://api.github.com/repos/dono/repo/actions/runs/38746383473/rerun-failed-jobs");
  assertEquals(gh.chamadas.some((c) => c.url.includes("/dispatches")), false);
  assertEquals(body.resposta?.status, "refeito");
  assertEquals(body.resposta?.run_id, 38746383473);
  assertEquals(body.resposta?.acompanhe, "https://github.com/dono/repo/actions/runs/38746383473");
});

Deno.test("CA-3: GitHub recusa o rerun → erro, nunca 'refeito'", async () => {
  const gh = github({ agendado: runGh({ conclusion: "cancelled" }), rerun: 403 });
  const res = await handleRequest(post({ action: "refazer", sync: "coletor-pncp" }), ctxGh(gh));
  const body = await res.json();
  assertEquals(res.status, 502);
  assertEquals(body.http, 403);
  assertEquals(JSON.stringify(body).includes("refeito"), false);
  assertEquals(JSON.stringify(body).includes("github-token-de-teste"), false);
});

Deno.test("CA-4: leitura do GitHub falha → ultimo_cron null, pode_refazer false, erro aparece e os outros syncs seguem", async () => {
  for (const falha of [500, 401]) {
    const gh = github({ falha });
    const { body, coletor } = await coletorListado(ctxGh(gh));
    assertEquals(coletor.ultimo_cron, null);
    assertEquals(coletor.pode_refazer, false);
    assertEquals(typeof coletor.erro_ultimo_cron, "string");
    assertEquals(String(coletor.erro_ultimo_cron).length > 0, true);
    assertEquals(body.syncs.length, SYNCS.length);
    assertEquals(JSON.stringify(body).includes("github-token-de-teste"), false);
  }
});

Deno.test("CA-4: timeout na leitura do GitHub também vira erro, não cron ok", async () => {
  const c = ctxGh(github(), { fetchFn: () => Promise.reject(new DOMException("timeout", "TimeoutError")) });
  const { body, coletor } = await coletorListado(c);
  assertEquals(coletor.ultimo_cron, null);
  assertEquals(coletor.pode_refazer, false);
  assertEquals(typeof coletor.erro_ultimo_cron, "string");
  assertEquals(body.syncs.length, SYNCS.length);
});

Deno.test("CA-5: refazer por usuário sem papel admin 403, pelo cron 403 e sem token 401, sem chamar o GitHub", async () => {
  const gh = github({ agendado: runGh({ conclusion: "failure" }) });
  const r = () => post({ action: "refazer", sync: "coletor-pncp" });
  assertEquals((await handleRequest(r(), ctxGh(gh, { getUser: () => Promise.resolve(COMUM) }))).status, 403);
  assertEquals((await handleRequest(r(), ctxGh(gh, { isCron: () => true }))).status, 403);
  assertEquals((await handleRequest(r(), ctxGh(gh, { getUser: () => Promise.resolve(null) }))).status, 401);
  assertEquals(gh.chamadas.length, 0);
});

Deno.test("CA-6: refazer sem GITHUB_ACTIONS_TOKEN responde 500 com a mensagem e não chama o GitHub", async () => {
  const gh = github({ agendado: runGh({ conclusion: "failure" }) });
  const res = await handleRequest(post({ action: "refazer", sync: "coletor-pncp" }), ctxGh(gh, { githubToken: () => null }));
  const body = await res.json();
  assertEquals(res.status, 500);
  assertEquals(body.error, "Disparo do coletor não configurado (GITHUB_ACTIONS_TOKEN).");
  assertEquals(gh.chamadas.length, 0);
});

Deno.test("CA-6: o token nunca aparece no listar nem no refazer, mesmo com erro do GitHub", async () => {
  const cenarios = [
    github({ agendado: runGh({ conclusion: "failure" }) }),
    github({ falha: 500 }),
    github({ agendado: runGh({ conclusion: "failure" }), rerun: 422 }),
  ];
  for (const gh of cenarios) {
    const l = await (await handleRequest(post({ action: "listar" }), ctxGh(gh))).text();
    const r = await (await handleRequest(post({ action: "refazer", sync: "coletor-pncp" }), ctxGh(gh))).text();
    assertEquals(l.includes("github-token-de-teste"), false);
    assertEquals(r.includes("github-token-de-teste"), false);
    assertEquals(gh.chamadas.length > 0, true);
    assertEquals(gh.chamadas.every((c) => c.authorization === "Bearer github-token-de-teste"), true);
  }
});

Deno.test("CA-7: rodar coletor-pncp continua um workflow_dispatch rápido, sem rerun", async () => {
  let enviado = "";
  let url = "";
  const c = ctxGh(github({ agendado: runGh({ conclusion: "failure" }) }), {
    fetchFn: (input, init) => {
      url = String(input);
      enviado = String(init?.body);
      return Promise.resolve(new Response(null, { status: 204 }));
    },
  });
  const res = await handleRequest(post({ action: "rodar", sync: "coletor-pncp" }), c);
  assertEquals(res.status, 200);
  assertEquals(url, "https://api.github.com/repos/dono/repo/actions/workflows/coletor-pncp.yml/dispatches");
  assertEquals(JSON.parse(enviado), { ref: "main", inputs: { modo: "leads", dry_run: "false", rapido: "true" } });
});
