import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { type ApiTenantContext, handleRequest } from "../../../supabase/functions/api-tenant/index.ts";
import {
  type ConsultaCnpj,
  cnpjValido,
  consultarCnpjBrasilApi,
  ErroCnpj,
  lerRespostaBrasilApi,
} from "../../../supabase/functions/api-tenant/cnpj.ts";
import { createSupabaseRepo, type TenantRepo } from "../../../supabase/functions/api-tenant/repo.ts";
import type { DadosRestritos, Empresa, Usuario, Vinculo } from "../../../supabase/functions/api-tenant/types.ts";
import { parseActionFromBody, slugDe } from "../../../supabase/functions/api-tenant/validation.ts";
import type { AuthenticatedUser } from "../../../supabase/functions/_shared/http.ts";

// Spec 0017. CNPJs públicos de teste: 00000000000191 (Banco do Brasil, DV válido), 11222333000181 (DV válido).
const CNPJ_BB = "00000000000191";
const CNPJ_NOVO = "11222333000181";
const U = {
  dev: "00000000-0000-4000-8000-000000000001",
  adminK: "00000000-0000-4000-8000-000000000002",
  opK: "00000000-0000-4000-8000-000000000003",
  semVinculo: "00000000-0000-4000-8000-000000000004",
  adminX: "00000000-0000-4000-8000-000000000005",
};

function repoMemoria(opts: { falharVinculo?: boolean; falharApagar?: boolean } = {}) {
  let seq = 1;
  const empresas: Empresa[] = [{ id: 1, slug: "konnen", nome: "Konnen", cnpj: null, tipo: "cliente", ativo: true }];
  const vinculos: Vinculo[] = [];
  const dados = new Map<number, DadosRestritos>();
  const usuarios: Usuario[] = Object.entries(U).map(([k, id]) => ({ id, email: `${k.toLowerCase()}@exemplo.com`, desenvolvedor: id === U.dev }));
  const repo: TenantRepo = {
    vinculosDoUsuario: (u) => Promise.resolve(vinculos.filter((v) => v.user_id === u)),
    empresas: (ids) => Promise.resolve(empresas.filter((e) => ids === null || ids.includes(e.id))),
    empresaPorId: (id) => Promise.resolve(empresas.find((e) => e.id === id) ?? null),
    empresaPorCnpj: (c) => Promise.resolve(empresas.find((e) => e.cnpj === c) ?? null),
    criarEmpresa: (e) => {
      const nova = { id: ++seq, ...e };
      empresas.push(nova);
      return Promise.resolve(nova);
    },
    apagarEmpresa: (id) => {
      if (opts.falharApagar) return Promise.reject(new Error("falha simulada ao apagar"));
      empresas.splice(empresas.findIndex((e) => e.id === id), 1);
      return Promise.resolve();
    },
    atualizarEmpresa: (id, campos) => {
      const e = empresas.find((x) => x.id === id);
      if (e) Object.assign(e, campos);
      return Promise.resolve(e ?? null);
    },
    ativasSemMembro: (exceto) =>
      Promise.resolve(empresas.filter((e) => e.ativo && e.id !== exceto && !vinculos.some((v) => v.tenant_id === e.id && v.ativo))),
    vinculos: (t) => Promise.resolve(vinculos.filter((v) => v.tenant_id === t)),
    salvarVinculo: (v) => {
      if (opts.falharVinculo) return Promise.reject(new Error("falha simulada no vínculo"));
      const i = vinculos.findIndex((x) => x.tenant_id === v.tenant_id && x.user_id === v.user_id);
      if (i >= 0) vinculos[i] = { ...v };
      else vinculos.push({ ...v });
      return Promise.resolve();
    },
    usuarioPorEmail: (e) => Promise.resolve(usuarios.find((u) => u.email === e) ?? null),
    usuarios: (ids) => Promise.resolve(ids.map((id) => usuarios.find((u) => u.id === id) ?? { id, email: null, desenvolvedor: false })),
    dadosRestritos: (t) => Promise.resolve(dados.get(t) ?? null),
    salvarDadosRestritos: (t, d) => {
      const out = { banco: null, agencia: null, conta: null, ...dados.get(t), ...d, updated_at: "2026-10-10T00:00:00.000Z" };
      dados.set(t, out);
      return Promise.resolve(out);
    },
  };
  return { repo, empresas, vinculos, dados };
}

function consulta(cnpj: string, ativa = true): ConsultaCnpj {
  return lerRespostaBrasilApi(
    { cnpj, razao_social: "EMPRESA EXEMPLO LTDA", nome_fantasia: "Exemplo Fitness", situacao_cadastral: ativa ? 2 : 8,
      descricao_situacao_cadastral: ativa ? "ATIVA" : "BAIXADA", cnae_fiscal: 4789099, cnae_fiscal_descricao: "Comércio" },
    cnpj, `https://brasilapi.com.br/api/cnpj/v1/${cnpj}`, new Date("2026-10-10T12:00:00Z"),
  );
}

function ctxCom(userId: string | null, base = repoMemoria(), extra: Partial<ApiTenantContext> & { dev?: boolean; ativa?: boolean } = {}) {
  let chamadasCnpj = 0;
  const user: AuthenticatedUser | null = userId
    ? { id: userId, email: null, app_metadata: (extra.dev ?? userId === U.dev) ? { licitagym_role: "admin" } : {} }
    : null;
  const ctx: ApiTenantContext = {
    getRepo: () => base.repo,
    getUser: () => Promise.resolve(user),
    consultarCnpj: (c) => {
      chamadasCnpj++;
      return Promise.resolve(consulta(c, extra.ativa ?? true));
    },
    ...extra,
  };
  return { ctx, base, chamadas: () => chamadasCnpj };
}

async function chamar(ctx: ApiTenantContext, body: unknown) {
  const res = await handleRequest(new Request("http://x/api-tenant", { method: "POST", body: JSON.stringify(body) }), ctx);
  return { status: res.status, json: await res.json() };
}

function konnenComMembros() {
  const base = repoMemoria();
  base.vinculos.push(
    { tenant_id: 1, user_id: U.adminK, papel: "admin", ativo: true },
    { tenant_id: 1, user_id: U.opK, papel: "operacao", ativo: true },
  );
  return base;
}

Deno.test("sem JWT: 401", async () => {
  const { ctx } = ctxCom(null);
  assertEquals((await chamar(ctx, { action: "minha_empresa" })).status, 401);
});

Deno.test("CA-1: usuário sem vínculo recebe empresas vazia", async () => {
  const { ctx } = ctxCom(U.semVinculo);
  const r = await chamar(ctx, { action: "minha_empresa" });
  assertEquals(r.status, 200);
  assertEquals(r.json.empresas, []);
  assertEquals(r.json.desenvolvedor, false);
});

Deno.test("CA-2: operação ligada à Konnen recebe a Konnen com o papel", async () => {
  const { ctx } = ctxCom(U.opK, konnenComMembros());
  const r = await chamar(ctx, { action: "minha_empresa" });
  assertEquals(r.json.empresas.map((e: { slug: string; papel: string }) => [e.slug, e.papel]), [["konnen", "operacao"]]);
});

Deno.test("CA-3: CNPJ com DV inválido devolve 400 sem chamar a fonte", async () => {
  const { ctx, chamadas } = ctxCom(U.dev);
  const r = await chamar(ctx, { action: "cnpj_consultar", cnpj: "00000000000192" });
  assertEquals(r.status, 400);
  assertEquals(chamadas(), 0);
  const c = await chamar(ctx, { action: "empresa_criar", cnpj: "11.222.333/0001-80", admin_email: "adminx@exemplo.com" });
  assertEquals(c.status, 400);
  assertEquals(chamadas(), 0);
});

Deno.test("CA-4: situação BAIXADA na fonte recusa a criação e não grava empresa", async () => {
  const { ctx, base } = ctxCom(U.dev, repoMemoria(), { ativa: false });
  const r = await chamar(ctx, { action: "empresa_criar", cnpj: CNPJ_NOVO, admin_email: "adminx@exemplo.com" });
  assertEquals(r.status, 400);
  assert(r.json.error.includes("BAIXADA"));
  assertEquals(base.empresas.length, 1);
});

Deno.test("CA-5: quem não é desenvolvedor não cria empresa (admin da empresa também não)", async () => {
  for (const u of [U.semVinculo, U.adminK]) {
    const { ctx, base } = ctxCom(u, konnenComMembros());
    const r = await chamar(ctx, { action: "empresa_criar", cnpj: CNPJ_NOVO, admin_email: "adminx@exemplo.com" });
    assertEquals(r.status, 403);
    assertEquals(base.empresas.length, 1);
  }
});

Deno.test("CA-5: papel vem só de app_metadata (user_metadata não entra no AuthenticatedUser)", async () => {
  const base = repoMemoria();
  const ctx: ApiTenantContext = {
    getRepo: () => base.repo,
    getUser: () => Promise.resolve({ id: U.semVinculo, app_metadata: {}, user_metadata: { licitagym_role: "admin" } } as AuthenticatedUser),
    consultarCnpj: (c) => Promise.resolve(consulta(c)),
  };
  assertEquals((await chamar(ctx, { action: "empresa_criar", cnpj: CNPJ_NOVO, admin_email: "adminx@exemplo.com" })).status, 403);
});

Deno.test("CA-6: CNPJ já cadastrado devolve 409", async () => {
  const base = repoMemoria();
  base.empresas[0].cnpj = CNPJ_BB;
  const { ctx, chamadas } = ctxCom(U.dev, base);
  const r = await chamar(ctx, { action: "empresa_criar", cnpj: CNPJ_BB, admin_email: "adminx@exemplo.com" });
  assertEquals(r.status, 409);
  assertEquals(chamadas(), 0);
});

Deno.test("CA-7: criar grava empresa inativa e o primeiro admin", async () => {
  const { ctx, base } = ctxCom(U.dev);
  const r = await chamar(ctx, { action: "empresa_criar", cnpj: "11.222.333/0001-81", admin_email: "AdminX@Exemplo.com" });
  assertEquals(r.status, 201);
  assertEquals(r.json.empresa.cnpj, CNPJ_NOVO);
  assertEquals(r.json.empresa.ativo, false);
  assertEquals(r.json.empresa.nome, "Exemplo Fitness");
  assertEquals(r.json.empresa.slug, "exemplo-fitness");
  assertEquals(base.vinculos, [{ tenant_id: r.json.empresa.id, user_id: U.adminX, papel: "admin", ativo: true }]);
});

Deno.test("CA-7: falha no vínculo do admin desfaz a empresa", async () => {
  const { ctx, base } = ctxCom(U.dev, repoMemoria({ falharVinculo: true }));
  const r = await chamar(ctx, { action: "empresa_criar", cnpj: CNPJ_NOVO, admin_email: "adminx@exemplo.com" });
  assertEquals(r.status, 500);
  assertEquals(base.empresas.map((e) => e.id), [1]);
});

Deno.test("CA-8: admin da empresa X não mexe na empresa Y", async () => {
  const base = konnenComMembros();
  base.empresas.push({ id: 2, slug: "x", nome: "X", cnpj: CNPJ_NOVO, tipo: "cliente", ativo: false });
  base.vinculos.push({ tenant_id: 2, user_id: U.adminX, papel: "admin", ativo: true });
  const { ctx } = ctxCom(U.adminX, base);
  const r = await chamar(ctx, { action: "membro_adicionar", tenant_id: 1, email: "semvinculo@exemplo.com", papel: "admin" });
  assertEquals(r.status, 403);
  assertEquals((await chamar(ctx, { action: "membros_listar", tenant_id: 1 })).status, 403);
});

Deno.test("CA-9: não tira o último admin ativo", async () => {
  const { ctx, base } = ctxCom(U.adminK, konnenComMembros());
  assertEquals((await chamar(ctx, { action: "membro_atualizar", tenant_id: 1, user_id: U.adminK, papel: "operacao" })).status, 400);
  assertEquals((await chamar(ctx, { action: "membro_atualizar", tenant_id: 1, user_id: U.adminK, ativo: false })).status, 400);
  assertEquals((await chamar(ctx, { action: "membro_atualizar", tenant_id: 1, user_id: U.opK, papel: "admin" })).status, 200);
  assertEquals((await chamar(ctx, { action: "membro_atualizar", tenant_id: 1, user_id: U.adminK, papel: "operacao" })).status, 200);
  assertEquals(base.vinculos.find((v) => v.user_id === U.adminK)?.papel, "operacao");
});

Deno.test("CA-10: operação não lê dados bancários; admin lê e grava", async () => {
  const base = konnenComMembros();
  const op = ctxCom(U.opK, base).ctx;
  assertEquals((await chamar(op, { action: "dados_restritos_obter", tenant_id: 1 })).status, 403);
  assertEquals((await chamar(op, { action: "dados_restritos_salvar", tenant_id: 1, banco: "001" })).status, 403);
  const adm = ctxCom(U.adminK, base).ctx;
  assertEquals((await chamar(adm, { action: "dados_restritos_salvar", tenant_id: 1, banco: "001", agencia: "1234", conta: "99999-9" })).status, 200);
  const r = await chamar(adm, { action: "dados_restritos_obter", tenant_id: 1 });
  assertEquals([r.json.dados.banco, r.json.dados.agencia, r.json.dados.conta], ["001", "1234", "99999-9"]);
});

Deno.test("CA-11: e-mail sem conta devolve 404 e não cria vínculo", async () => {
  const { ctx, base } = ctxCom(U.adminK, konnenComMembros());
  const r = await chamar(ctx, { action: "membro_adicionar", tenant_id: 1, email: "ninguem@exemplo.com", papel: "operacao" });
  assertEquals(r.status, 404);
  assertEquals(base.vinculos.length, 2);
  const d = ctxCom(U.dev, repoMemoria()).ctx;
  assertEquals((await chamar(d, { action: "empresa_criar", cnpj: CNPJ_NOVO, admin_email: "ninguem@exemplo.com" })).status, 404);
});

Deno.test("CA-14: log não leva dado bancário nem o token", async () => {
  const linhas: string[] = [];
  const orig = { info: console.info, error: console.error };
  console.info = (...a: unknown[]) => void linhas.push(JSON.stringify(a));
  console.error = (...a: unknown[]) => void linhas.push(JSON.stringify(a));
  try {
    const { ctx } = ctxCom(U.adminK, konnenComMembros());
    const req = new Request("http://x/api-tenant", {
      method: "POST", headers: { authorization: "Bearer token-secreto-xyz" },
      body: JSON.stringify({ action: "dados_restritos_salvar", tenant_id: 1, banco: "BANCO-777", agencia: "AG-555", conta: "CONTA-333" }),
    });
    assertEquals((await handleRequest(req, ctx)).status, 200);
  } finally {
    console.info = orig.info;
    console.error = orig.error;
  }
  assert(linhas.length > 0);
  for (const s of ["BANCO-777", "AG-555", "CONTA-333", "token-secreto-xyz"]) assert(!linhas.join("\n").includes(s), s);
});

Deno.test("CA-15: desenvolvedor sem vínculo age como admin em qualquer empresa", async () => {
  const { ctx, base } = ctxCom(U.dev);
  const r = await chamar(ctx, { action: "membro_adicionar", tenant_id: 1, email: "adminK@exemplo.com", papel: "admin" });
  assertEquals(r.status, 201);
  assertEquals(base.vinculos[0], { tenant_id: 1, user_id: U.adminK, papel: "admin", ativo: true });
  assertEquals((await chamar(ctx, { action: "dados_restritos_obter", tenant_id: 1 })).status, 200);
  const m = await chamar(ctx, { action: "minha_empresa" });
  assertEquals(m.json.desenvolvedor, true);
  assertEquals(m.json.empresas.length, 1);
});

Deno.test("CA-17: empresa nova nasce inativa e só ativa depois de a Konnen ter membro", async () => {
  const { ctx, base } = ctxCom(U.dev);
  const criada = await chamar(ctx, { action: "empresa_criar", cnpj: CNPJ_NOVO, admin_email: "adminx@exemplo.com" });
  const id = criada.json.empresa.id;
  assertEquals(criada.json.empresa.ativo, false);
  const negada = await chamar(ctx, { action: "empresa_atualizar", tenant_id: id, ativo: true });
  assertEquals(negada.status, 409);
  assert(negada.json.error.includes("Konnen"));
  base.vinculos.push({ tenant_id: 1, user_id: U.adminK, papel: "admin", ativo: true });
  const ok = await chamar(ctx, { action: "empresa_atualizar", tenant_id: id, ativo: true });
  assertEquals(ok.status, 200);
  assertEquals(ok.json.empresa.ativo, true);
});

Deno.test("empresa_atualizar: admin muda nome, não ativa; CNPJ novo passa pela fonte", async () => {
  const { ctx, base, chamadas } = ctxCom(U.adminK, konnenComMembros());
  assertEquals((await chamar(ctx, { action: "empresa_atualizar", tenant_id: 1, ativo: false })).status, 403);
  const r = await chamar(ctx, { action: "empresa_atualizar", tenant_id: 1, nome: "Konnen Equipamentos", cnpj: CNPJ_BB });
  assertEquals(r.status, 200);
  assertEquals([base.empresas[0].nome, base.empresas[0].cnpj], ["Konnen Equipamentos", CNPJ_BB]);
  assertEquals(chamadas(), 1);
});

Deno.test("membros_listar: membro lê a lista com e-mail; não membro, 403", async () => {
  const base = konnenComMembros();
  const r = await chamar(ctxCom(U.opK, base).ctx, { action: "membros_listar", tenant_id: 1 });
  assertEquals(r.status, 200);
  assertEquals(r.json.membros.map((m: { email: string; papel: string }) => [m.email, m.papel]), [["admink@exemplo.com", "admin"], ["opk@exemplo.com", "operacao"]]);
  assertEquals((await chamar(ctxCom(U.semVinculo, base).ctx, { action: "membros_listar", tenant_id: 1 })).status, 403);
});

Deno.test("cnpj_consultar: operação não consulta; admin consulta", async () => {
  const base = konnenComMembros();
  assertEquals((await chamar(ctxCom(U.opK, base).ctx, { action: "cnpj_consultar", cnpj: CNPJ_BB })).status, 403);
  const r = await chamar(ctxCom(U.adminK, base).ctx, { action: "cnpj_consultar", cnpj: CNPJ_BB });
  assertEquals(r.status, 200);
  assertEquals([r.json.consulta.fonte, r.json.consulta.ativa], ["BrasilAPI", true]);
});

// --- validação e CNPJ ---

Deno.test("cnpjValido: mod-11, máscara e sequência repetida", () => {
  assertEquals(cnpjValido("00.000.000/0001-91"), CNPJ_BB);
  assertEquals(cnpjValido(CNPJ_NOVO), CNPJ_NOVO);
  assertEquals(cnpjValido("11222333000182"), null);
  assertEquals(cnpjValido("11111111111111"), null);
  assertEquals(cnpjValido("123"), null);
  assertEquals(cnpjValido(191), null);
});

Deno.test("validação: ação desconhecida, e-mail e papel", () => {
  assert("error" in parseActionFromBody({ action: "apagar_tudo" }));
  assert("error" in parseActionFromBody({ action: "membro_adicionar", tenant_id: 1, email: "x", papel: "admin" }));
  assert("error" in parseActionFromBody({ action: "membro_adicionar", tenant_id: 1, email: "a@b.com", papel: "dono" }));
  assert("error" in parseActionFromBody({ action: "empresa_atualizar", tenant_id: 1 }));
  assertEquals(slugDe("Konnen Equipamentos Fitness Ltda."), "konnen-equipamentos-fitness-ltda");
});

Deno.test("lerRespostaBrasilApi: 200 sem os campos esperados é erro, não vazio", () => {
  for (const json of [null, [], {}, { cnpj: CNPJ_BB }, { cnpj: "99", razao_social: "X", descricao_situacao_cadastral: "ATIVA" }]) {
    try {
      lerRespostaBrasilApi(json, CNPJ_BB, "u", new Date());
      throw new Error("deveria falhar");
    } catch (e) {
      assert(e instanceof ErroCnpj && e.status === 502);
    }
  }
});

// CA-16: cliente real com fetch falso (sem rede, sem sleep real)
async function comFetch(respostas: Array<() => Response | Promise<Response>>, fn: () => Promise<void>) {
  const original = globalThis.fetch;
  let i = 0;
  globalThis.fetch = (() => Promise.resolve(respostas[Math.min(i++, respostas.length - 1)]())) as typeof fetch;
  try {
    await fn();
  } finally {
    globalThis.fetch = original;
  }
  return i;
}
const corpoBB = () =>
  new Response(JSON.stringify({ cnpj: CNPJ_BB, razao_social: "BANCO DO BRASIL SA", nome_fantasia: "DIRECAO GERAL",
    situacao_cadastral: 2, descricao_situacao_cadastral: "ATIVA", cnae_fiscal: 6422100,
    cnaes_secundarios: [{ codigo: 6499999, descricao: "Outras" }, { codigo: 0, descricao: "" }], uf: "DF" }), { status: 200 });

Deno.test("CA-16: 429 e depois 200 devolve a consulta, respeitando Retry-After", async () => {
  const esperas: number[] = [];
  const n = await comFetch([() => new Response("", { status: 429, headers: { "retry-after": "1" } }), corpoBB], async () => {
    const c = await consultarCnpjBrasilApi(CNPJ_BB, { sleep: (ms) => (esperas.push(ms), Promise.resolve()) });
    assertEquals([c.razao_social, c.ativa, c.cnaes_secundarios.length], ["BANCO DO BRASIL SA", true, 1]);
  });
  assertEquals(n, 2);
  assertEquals(esperas, [1000]);
});

Deno.test("CA-16: 404 da fonte devolve 404 sem nova tentativa", async () => {
  const n = await comFetch([() => new Response("", { status: 404 })], async () => {
    const e = await assertRejects(() => consultarCnpjBrasilApi(CNPJ_BB, { sleep: () => Promise.resolve() }), ErroCnpj);
    assertEquals(e.status, 404);
  });
  assertEquals(n, 1);
});

Deno.test("CA-16: 503 esgota as 3 tentativas e devolve 503", async () => {
  const n = await comFetch([() => new Response("", { status: 503 })], async () => {
    const e = await assertRejects(() => consultarCnpjBrasilApi(CNPJ_BB, { sleep: () => Promise.resolve() }), ErroCnpj);
    assertEquals(e.status, 503);
  });
  assertEquals(n, 3);
});

Deno.test("CA-16: erro de conexão é transitório; 400 da fonte é permanente", async () => {
  const n = await comFetch([() => Promise.reject(new TypeError("conexão recusada")), corpoBB], async () => {
    assertEquals((await consultarCnpjBrasilApi(CNPJ_BB, { sleep: () => Promise.resolve() })).cnpj, CNPJ_BB);
  });
  assertEquals(n, 2);
  const m = await comFetch([() => new Response("", { status: 400 })], async () => {
    const e = await assertRejects(() => consultarCnpjBrasilApi(CNPJ_BB, { sleep: () => Promise.resolve() }), ErroCnpj);
    assertEquals(e.status, 502);
  });
  assertEquals(m, 1);
});


// --- regressões da revisão de 10/10 ---

Deno.test("membro_adicionar não regrava vínculo existente (burlaria a regra do último admin)", async () => {
  const { ctx, base } = ctxCom(U.adminK, konnenComMembros());
  const r = await chamar(ctx, { action: "membro_adicionar", tenant_id: 1, email: "admink@exemplo.com", papel: "operacao" });
  assertEquals(r.status, 409);
  assertEquals(base.vinculos.find((v) => v.user_id === U.adminK)?.papel, "admin");
});

Deno.test("admin de cliente não liga conta de outra empresa nem a do desenvolvedor, e não distingue o motivo", async () => {
  const base = konnenComMembros();
  base.empresas.push({ id: 2, slug: "x", nome: "X", cnpj: CNPJ_NOVO, tipo: "cliente", ativo: false });
  base.vinculos.push({ tenant_id: 2, user_id: U.adminX, papel: "admin", ativo: true });
  const { ctx } = ctxCom(U.adminX, base);
  const outra = await chamar(ctx, { action: "membro_adicionar", tenant_id: 2, email: "opk@exemplo.com", papel: "operacao" });
  const dev = await chamar(ctx, { action: "membro_adicionar", tenant_id: 2, email: "dev@exemplo.com", papel: "operacao" });
  const semConta = await chamar(ctx, { action: "membro_adicionar", tenant_id: 2, email: "ninguem@exemplo.com", papel: "operacao" });
  assertEquals([outra.status, dev.status, semConta.status], [404, 404, 404]);
  assertEquals(new Set([outra.json.error, dev.json.error, semConta.json.error]).size, 1);
  assertEquals(base.vinculos.filter((v) => v.tenant_id === 2).length, 1);
  const d = await chamar(ctxCom(U.dev, base).ctx, { action: "membro_adicionar", tenant_id: 2, email: "opk@exemplo.com", papel: "operacao" });
  assertEquals(d.status, 409);
});

Deno.test("CNPJ de outra empresa: admin recebe mensagem sem o nome; desenvolvedor recebe o nome", async () => {
  const base = konnenComMembros();
  base.empresas.push({ id: 2, slug: "x", nome: "Empresa Secreta", cnpj: CNPJ_NOVO, tipo: "cliente", ativo: false });
  const adm = await chamar(ctxCom(U.adminK, base).ctx, { action: "empresa_atualizar", tenant_id: 1, cnpj: CNPJ_NOVO });
  assertEquals(adm.status, 409);
  assert(!adm.json.error.includes("Secreta"));
  const dev = await chamar(ctxCom(U.dev, base).ctx, { action: "empresa_atualizar", tenant_id: 1, cnpj: CNPJ_NOVO });
  assert(dev.json.error.includes("Secreta"));
});

Deno.test("empresa_criar: e-mail sem conta não gasta consulta à BrasilAPI", async () => {
  const { ctx, chamadas } = ctxCom(U.dev);
  assertEquals((await chamar(ctx, { action: "empresa_criar", cnpj: CNPJ_NOVO, admin_email: "ninguem@exemplo.com" })).status, 404);
  assertEquals(chamadas(), 0);
});

Deno.test("CA-7: se desfazer a empresa também falha, registra a órfã e devolve o erro original", async () => {
  const linhas: string[] = [];
  const orig = console.error;
  console.error = (...a: unknown[]) => void linhas.push(JSON.stringify(a));
  try {
    const { ctx } = ctxCom(U.dev, repoMemoria({ falharVinculo: true, falharApagar: true }));
    const r = await chamar(ctx, { action: "empresa_criar", cnpj: CNPJ_NOVO, admin_email: "adminx@exemplo.com" });
    assertEquals(r.status, 500);
  } finally {
    console.error = orig;
  }
  assert(linhas.some((l) => l.includes("não foi desfeita") && l.includes('"tenant":2')));
  assert(linhas.some((l) => l.includes("falha simulada no vínculo")));
});

Deno.test("dados_restritos_salvar grava só os campos enviados", async () => {
  const { ctx, base } = ctxCom(U.adminK, konnenComMembros());
  await chamar(ctx, { action: "dados_restritos_salvar", tenant_id: 1, banco: "001", agencia: "1234", conta: "999" });
  await chamar(ctx, { action: "dados_restritos_salvar", tenant_id: 1, conta: "111" });
  const d = base.dados.get(1)!;
  assertEquals([d.banco, d.agencia, d.conta], ["001", "1234", "111"]);
  assertEquals((await chamar(ctx, { action: "dados_restritos_salvar", tenant_id: 1 })).status, 400);
});

Deno.test("CA-17: não desativa o último membro de empresa ativa enquanto houver outra ativa", async () => {
  const base = repoMemoria();
  base.vinculos.push({ tenant_id: 1, user_id: U.opK, papel: "operacao", ativo: true });
  base.empresas.push({ id: 2, slug: "x", nome: "X", cnpj: CNPJ_NOVO, tipo: "cliente", ativo: true });
  base.vinculos.push({ tenant_id: 2, user_id: U.adminX, papel: "admin", ativo: true });
  const { ctx } = ctxCom(U.dev, base);
  assertEquals((await chamar(ctx, { action: "membro_atualizar", tenant_id: 1, user_id: U.opK, ativo: false })).status, 409);
  base.empresas[1].ativo = false;
  assertEquals((await chamar(ctx, { action: "membro_atualizar", tenant_id: 1, user_id: U.opK, ativo: false })).status, 200);
});

Deno.test("repo.usuarios: conta apagada vem sem e-mail; erro do Auth é falha", async () => {
  const cliente = (status: number) => ({
    auth: { admin: { getUserById: () => Promise.resolve({ data: { user: null }, error: { status, message: `HTTP ${status}` } }) } },
  });
  // deno-lint-ignore no-explicit-any
  const apagado = await createSupabaseRepo(cliente(404) as any).usuarios([U.opK]);
  assertEquals(apagado, [{ id: U.opK, email: null, desenvolvedor: false }]);
  // deno-lint-ignore no-explicit-any
  await assertRejects(() => createSupabaseRepo(cliente(500) as any).usuarios([U.opK]), Error, "getUserById");
});
