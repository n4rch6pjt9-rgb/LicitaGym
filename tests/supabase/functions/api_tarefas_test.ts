import { assertEquals } from "jsr:@std/assert@1";
import { type ApiTarefasContext, handleRequest } from "../../../supabase/functions/api-tarefas/index.ts";
import type { TarefasRepo } from "../../../supabase/functions/api-tarefas/repo.ts";
import type { Tarefa } from "../../../supabase/functions/api-tarefas/types.ts";
import { parseActionFromBody } from "../../../supabase/functions/api-tarefas/validation.ts";
import type { PapelTenant } from "../../../supabase/functions/_shared/tenant.ts";

// #252, spec 0019. Repositório em memória com as regras de tarefas_equipe_liberar (pipeline, regulamento, idempotência).
const ADMIN = "00000000-0000-0000-0000-00000000000a";
const OP1 = "00000000-0000-0000-0000-0000000000b1";
const OP2 = "00000000-0000-0000-0000-0000000000b2";
const OUTRA = "00000000-0000-0000-0000-0000000000c1"; // membro de outra empresa

function repoMemoria(papel: PapelTenant | null) {
  let seq = 0;
  const tarefas: Tarefa[] = [];
  const pipeline = new Set([10, 11, 12]); // licitações no pipeline da empresa 1
  const regulamento = new Map<number, string | null>([[10, "LEI_14133"], [11, null], [12, "RLC"], [20, "LEI_14133"]]);
  const membros = new Map<string, PapelTenant>([[ADMIN, "admin"], [OP1, "operacao"], [OP2, "operacao"]]);
  const catalogo: Record<string, string[]> = { ATA_HABILITACAO: ["14133-F05-T01", "14133-F05-T03"], F05: ["14133-F05-T01", "14133-F05-T02"] };
  const nova = (codigo: string, lic: number): Tarefa => ({
    id: ++seq, tenant_id: 1, licitacao_id: lic, origem: "catalogo", tarefa_codigo: codigo, titulo: null, descricao: null,
    liberada_por_fase: null, liberada_por_evento: "ATA_HABILITACAO", condicao_verificada: null, contexto: {},
    prazo_situacao: "nao_calculado", prazo_em: null, prazo_informado_por: null, prazo_informado_em: null, status: "aberta",
    responsavel_papel: "admin", responsavel_user_id: null, responsavel_tipo: "papel", responsavel_agente: null, criada_em: "t", atualizada_em: "t", concluida_em: null, catalogo: null,
  });
  // tarefa de outra empresa (tenant 2), atribuída a OP1: nunca pode aparecer nem ser alterada pela empresa 1
  tarefas.push({ ...nova("14133-F05-T03", 99), id: 900, tenant_id: 2, responsavel_user_id: OP1 });

  const repo: TarefasRepo = {
    tenantDoUsuario: () => Promise.resolve({ tenant: 1, papel }),
    estaNoPipeline: (_t, lic) => Promise.resolve(pipeline.has(lic)),
    regulamento: (lic) => Promise.resolve(regulamento.get(lic) ?? null),
    previa: (_lic, fase, evento) =>
      Promise.resolve((catalogo[fase ?? evento ?? ""] ?? []).map((codigo) => ({
        codigo, fase_codigo: "F05", parent_codigo: null, titulo: codigo, natureza: "faculdade", prazo_quantidade: null,
        prazo_unidade: "imediato", prazo_sentido: null, prazo_evento: null, aplicavel: null, base_legal: "art. 165 (caput)",
      }))),
    liberar: (_t, lic, fase, evento) => {
      if (!pipeline.has(lic)) return Promise.resolve({ criadas: 0, existentes: 0, bloqueio: "fora_do_pipeline" });
      const reg = regulamento.get(lic) ?? null;
      if (reg === null) return Promise.resolve({ criadas: 0, existentes: 0, bloqueio: "regulamento_nao_informado" });
      if (!["LEI_14133", "LEI_14981"].includes(reg)) return Promise.resolve({ criadas: 0, existentes: 0, bloqueio: "regulamento_sem_catalogo" });
      let criadas = 0;
      const codigos = catalogo[fase ?? evento ?? ""] ?? [];
      for (const c of codigos) {
        if (tarefas.some((t) => t.tenant_id === 1 && t.licitacao_id === lic && t.tarefa_codigo === c)) continue;
        tarefas.push(nova(c, lic));
        criadas++;
      }
      return Promise.resolve({ criadas, existentes: codigos.length - criadas, bloqueio: null });
    },
    // mesmas regras do repo real: tudo filtra tenant_id
    listar: (tenant, f) =>
      Promise.resolve({
        truncado: false,
        tarefas: tarefas.filter((t) =>
          t.tenant_id === tenant && (f.licitacao_id === null || t.licitacao_id === f.licitacao_id) &&
          (f.status === null || t.status === f.status) && (f.responsavel === null || t.responsavel_user_id === f.responsavel)
        ),
      }),
    obter: (tenant, id) => Promise.resolve(tarefas.find((t) => t.tenant_id === tenant && t.id === id) ?? null),
    atualizar: (tenant, id, campos, _u, soDoResponsavel) => {
      const t = tarefas.find((x) => x.tenant_id === tenant && x.id === id);
      if (!t || (soDoResponsavel && t.responsavel_user_id !== soDoResponsavel)) return Promise.resolve(null);
      Object.assign(t, campos);
      return Promise.resolve(t);
    },
    papelDoMembro: (_t, userId) => Promise.resolve(membros.get(userId) ?? null),
  };
  return { repo, tarefas };
}

type CtxTeste = ApiTarefasContext & { usuario?: { id: string; app_metadata: Record<string, unknown> } };

const pedir = (body: unknown, ctx: CtxTeste, comUsuario = true) =>
  handleRequest(
    new Request("http://local/api-tarefas", { method: "POST", body: JSON.stringify(body) }),
    { ...ctx, getUser: () => Promise.resolve(comUsuario ? ctx.usuario ?? { id: ADMIN, app_metadata: {} } : null) },
  );

function ctxDe(papel: PapelTenant | null, userId = ADMIN, desenvolvedor = false) {
  const m = repoMemoria(papel);
  const ctx: CtxTeste = { getRepo: () => m.repo, usuario: { id: userId, app_metadata: desenvolvedor ? { licitagym_role: "admin" } : {} } };
  return { ...m, ctx };
}

/** Mesmo repositório (mesmas tarefas), visto por um usuário de operação. */
function comoOperacao(repo: TarefasRepo, userId: string): CtxTeste {
  const repoOp: TarefasRepo = { ...repo, tenantDoUsuario: () => Promise.resolve({ tenant: 1, papel: "operacao" }) };
  return { getRepo: () => repoOp, usuario: { id: userId, app_metadata: {} } };
}

const da1 = (ts: Tarefa[]) => ts.filter((t) => t.tenant_id === 1);

Deno.test("CA-11: sem JWT → 401", async () => {
  const { ctx } = ctxDe("admin");
  const r = await pedir({ action: "tarefas_listar" }, ctx, false);
  assertEquals(r.status, 401);
});

Deno.test("CA-11: liberar sem fase nem evento, ou com os dois → 400", () => {
  assertEquals("error" in parseActionFromBody({ action: "tarefas_liberar", licitacao_id: 10 }), true);
  assertEquals("error" in parseActionFromBody({ action: "tarefas_liberar", licitacao_id: 10, fase: "F05", evento: "ATA_HABILITACAO" }), true);
  assertEquals("error" in parseActionFromBody({ action: "tarefas_liberar", licitacao_id: 10, fase: "F5;drop" }), true);
  assertEquals(parseActionFromBody({ action: "tarefas_liberar", licitacao_id: 10, evento: "ATA_HABILITACAO" }), {
    action: "tarefas_liberar", licitacao_id: 10, fase: null, evento: "ATA_HABILITACAO",
  });
});

Deno.test("admin libera; repetir não duplica; a tarefa nasce na fila do admin", async () => {
  const { ctx, tarefas } = ctxDe("admin");
  let r = await pedir({ action: "tarefas_liberar", licitacao_id: 10, evento: "ATA_HABILITACAO" }, ctx);
  assertEquals(r.status, 200);
  assertEquals((await r.json()).criadas, 2);
  r = await pedir({ action: "tarefas_liberar", licitacao_id: 10, evento: "ATA_HABILITACAO" }, ctx);
  assertEquals(await r.json(), { action: "tarefas_liberar", criadas: 0, existentes: 2 });
  assertEquals(da1(tarefas).every((t) => t.responsavel_papel === "admin" && t.responsavel_user_id === null), true);
});

Deno.test("CA-13: operação não libera (403); só admin ou desenvolvedor", async () => {
  const op = ctxDe("operacao", OP1);
  const r = await pedir({ action: "tarefas_liberar", licitacao_id: 10, evento: "ATA_HABILITACAO" }, op.ctx);
  assertEquals(r.status, 403);
  assertEquals(da1(op.tarefas).length, 0);
  const dev = ctxDe(null, ADMIN, true);
  assertEquals((await pedir({ action: "tarefas_liberar", licitacao_id: 10, evento: "ATA_HABILITACAO" }, dev.ctx)).status, 200);
});

Deno.test("CA-13: regulamento nulo ou sem catálogo → 409 com o motivo, nada gravado", async () => {
  const { ctx, tarefas } = ctxDe("admin");
  let r = await pedir({ action: "tarefas_liberar", licitacao_id: 11, evento: "ATA_HABILITACAO" }, ctx);
  assertEquals(r.status, 409);
  assertEquals(((await r.json()).error as string).includes("regulamento"), true);
  r = await pedir({ action: "tarefas_liberar", licitacao_id: 12, evento: "ATA_HABILITACAO" }, ctx);
  assertEquals(r.status, 409);
  assertEquals(da1(tarefas).length, 0);
});

Deno.test("CA-10: licitação fora do pipeline → 404 (liberar e prévia), nada gravado", async () => {
  const { ctx, tarefas } = ctxDe("admin");
  assertEquals((await pedir({ action: "tarefas_liberar", licitacao_id: 20, evento: "ATA_HABILITACAO" }, ctx)).status, 404);
  assertEquals((await pedir({ action: "catalogo_liberadas", licitacao_id: 20, fase: "F05" }, ctx)).status, 404);
  assertEquals(da1(tarefas).length, 0);
});

Deno.test("prévia devolve as tarefas com 'aplicavel' e o bloqueio de regulamento, sem gravar", async () => {
  const { ctx, tarefas } = ctxDe("operacao", OP1);
  const r = await pedir({ action: "catalogo_liberadas", licitacao_id: 11, fase: "F05" }, ctx);
  assertEquals(r.status, 200);
  const j = await r.json();
  assertEquals(j.bloqueio, "regulamento_nao_informado");
  assertEquals(j.tarefas.length, 2);
  assertEquals(j.tarefas[0].aplicavel, null);
  assertEquals(da1(tarefas).length, 0);
});

Deno.test("CA-8: atribuir — operação 403; admin a membro ativo; fora da empresa 400; null volta à fila", async () => {
  const adm = ctxDe("admin");
  await pedir({ action: "tarefas_liberar", licitacao_id: 10, evento: "ATA_HABILITACAO" }, adm.ctx);
  const id = da1(adm.tarefas)[0].id;

  const ctxOp = comoOperacao(adm.repo, OP1);
  assertEquals((await pedir({ action: "tarefa_atribuir", id, user_id: OP1 }, ctxOp)).status, 403);

  assertEquals((await pedir({ action: "tarefa_atribuir", id, user_id: OUTRA }, adm.ctx)).status, 400);
  const r = await pedir({ action: "tarefa_atribuir", id, user_id: OP1 }, adm.ctx);
  assertEquals(r.status, 200);
  assertEquals(da1(adm.tarefas)[0].responsavel_user_id, OP1);
  assertEquals(da1(adm.tarefas)[0].responsavel_papel, "operacao");
  await pedir({ action: "tarefa_atribuir", id, user_id: null }, adm.ctx);
  assertEquals(da1(adm.tarefas)[0].responsavel_user_id, null);
  assertEquals(da1(adm.tarefas)[0].responsavel_papel, "admin");
});

Deno.test("CA-9: operação lista só as atribuídas a ela; admin lista todas da empresa", async () => {
  const adm = ctxDe("admin");
  await pedir({ action: "tarefas_liberar", licitacao_id: 10, evento: "ATA_HABILITACAO" }, adm.ctx);
  await pedir({ action: "tarefa_atribuir", id: da1(adm.tarefas)[0].id, user_id: OP1 }, adm.ctx);
  await pedir({ action: "tarefa_atribuir", id: da1(adm.tarefas)[1].id, user_id: OP2 }, adm.ctx);

  const todas = await (await pedir({ action: "tarefas_listar" }, adm.ctx)).json();
  assertEquals(todas.tarefas.length, 2);

  const ctxOp = comoOperacao(adm.repo, OP1);
  const minhas = await (await pedir({ action: "tarefas_listar" }, ctxOp)).json();
  assertEquals(minhas.tarefas.map((t: Tarefa) => t.responsavel_user_id), [OP1]);
});

Deno.test("atualizar: operação conclui a dela, não mexe na de outro nem no prazo; admin informa prazo manual", async () => {
  const adm = ctxDe("admin");
  await pedir({ action: "tarefas_liberar", licitacao_id: 10, evento: "ATA_HABILITACAO" }, adm.ctx);
  const [a, b] = da1(adm.tarefas);
  await pedir({ action: "tarefa_atribuir", id: a.id, user_id: OP1 }, adm.ctx);

  const ctxOp = comoOperacao(adm.repo, OP1);
  assertEquals((await pedir({ action: "tarefa_atualizar", id: b.id, status: "concluida" }, ctxOp)).status, 403);
  assertEquals((await pedir({ action: "tarefa_atualizar", id: a.id, prazo_em: "2026-10-20T12:00:00Z" }, ctxOp)).status, 403);
  assertEquals((await pedir({ action: "tarefa_atualizar", id: a.id, status: "concluida" }, ctxOp)).status, 200);
  assertEquals(a.status, "concluida");
  assertEquals(typeof a.concluida_em, "string");

  const r = await pedir({ action: "tarefa_atualizar", id: b.id, prazo_em: "2026-10-20T12:00:00Z" }, adm.ctx);
  assertEquals(r.status, 200);
  assertEquals([b.prazo_situacao, b.prazo_em, b.prazo_informado_por], ["manual", "2026-10-20T12:00:00.000Z", ADMIN]);
  assertEquals((await pedir({ action: "tarefa_atualizar", id: 999, status: "aberta" }, adm.ctx)).status, 404);
});

Deno.test("validação: status e prazo inválidos → 400", () => {
  assertEquals("error" in parseActionFromBody({ action: "tarefa_atualizar", id: 1, status: "feito" }), true);
  assertEquals("error" in parseActionFromBody({ action: "tarefa_atualizar", id: 1, prazo_em: "amanhã" }), true);
  assertEquals("error" in parseActionFromBody({ action: "tarefa_atualizar", id: 1 }), true);
  assertEquals("error" in parseActionFromBody({ action: "tarefa_atribuir", id: 1, user_id: "nao-uuid" }), true);
});

Deno.test("CA-11: corpo inválido responde 400 pela handleRequest", async () => {
  const { ctx } = ctxDe("admin");
  assertEquals((await pedir({ action: "tarefas_liberar", licitacao_id: 10 }, ctx)).status, 400);
  assertEquals((await pedir({ action: "tarefas_liberar", licitacao_id: 10, fase: "F05", evento: "ATA_HABILITACAO" }, ctx)).status, 400);
});

Deno.test("CA-9: tarefa de outra empresa não aparece, não é alterada nem atribuída (404)", async () => {
  const adm = ctxDe("admin");
  const lista = await (await pedir({ action: "tarefas_listar" }, adm.ctx)).json();
  assertEquals(lista.tarefas.some((t: Tarefa) => t.tenant_id !== 1), false);
  assertEquals((await pedir({ action: "tarefa_atualizar", id: 900, status: "concluida" }, adm.ctx)).status, 404);
  assertEquals((await pedir({ action: "tarefa_atribuir", id: 900, user_id: OP2 }, adm.ctx)).status, 404);
  // OP1 é o responsável da tarefa da empresa 2, mas está na empresa 1: também não enxerga
  const op = comoOperacao(adm.repo, OP1);
  const minhas = await (await pedir({ action: "tarefas_listar" }, op)).json();
  assertEquals(minhas.tarefas.length, 0);
  assertEquals(adm.tarefas.find((t) => t.id === 900)!.status, "aberta");
});

Deno.test("prazo: data sem hora ou sem fuso → 400 (evita meia-noite UTC, um dia antes em Brasília)", () => {
  assertEquals("error" in parseActionFromBody({ action: "tarefa_atualizar", id: 1, prazo_em: "2026-10-20" }), true);
  assertEquals("error" in parseActionFromBody({ action: "tarefa_atualizar", id: 1, prazo_em: "2026-10-20T12:00" }), true);
  // data impossível não é normalizada para outro dia
  for (const impossivel of ["2026-02-29T12:00:00Z", "2026-04-31T12:00:00-03:00", "2026-10-20T24:00:00Z", "2026-13-01T12:00:00Z"]) {
    assertEquals("error" in parseActionFromBody({ action: "tarefa_atualizar", id: 1, prazo_em: impossivel }), true, impossivel);
  }
  assertEquals("error" in parseActionFromBody({ action: "tarefa_atualizar", id: 1, prazo_em: "2028-02-29T12:00:00Z" }), false);
  assertEquals(parseActionFromBody({ action: "tarefa_atualizar", id: 1, prazo_em: "2026-10-20T18:00:00-03:00" }), {
    action: "tarefa_atualizar", id: 1, prazo_em: "2026-10-20T21:00:00.000Z",
  });
});

Deno.test("atualizar: reatribuída no meio do caminho, a operação recebe 403 e nada muda", async () => {
  const adm = ctxDe("admin");
  await pedir({ action: "tarefas_liberar", licitacao_id: 10, evento: "ATA_HABILITACAO" }, adm.ctx);
  const [a] = da1(adm.tarefas);
  await pedir({ action: "tarefa_atribuir", id: a.id, user_id: OP1 }, adm.ctx);
  // o repo vê a tarefa ainda com OP1 na leitura, mas o admin reatribui antes do UPDATE
  const repoCorrida: TarefasRepo = {
    ...adm.repo,
    tenantDoUsuario: () => Promise.resolve({ tenant: 1, papel: "operacao" }),
    obter: async (t, id) => {
      const lida = { ...(await adm.repo.obter(t, id))! };
      a.responsavel_user_id = OP2;
      return lida;
    },
  };
  const r = await pedir({ action: "tarefa_atualizar", id: a.id, status: "concluida" }, { getRepo: () => repoCorrida, usuario: { id: OP1, app_metadata: {} } });
  assertEquals(r.status, 403);
  assertEquals(a.status, "aberta");
});

Deno.test("concluir de novo não troca a data de conclusão", async () => {
  const adm = ctxDe("admin");
  await pedir({ action: "tarefas_liberar", licitacao_id: 10, evento: "ATA_HABILITACAO" }, adm.ctx);
  const [a] = da1(adm.tarefas);
  await pedir({ action: "tarefa_atualizar", id: a.id, status: "concluida" }, adm.ctx);
  a.concluida_em = "2026-10-01T00:00:00.000Z";
  await pedir({ action: "tarefa_atualizar", id: a.id, status: "concluida" }, adm.ctx);
  assertEquals(a.concluida_em, "2026-10-01T00:00:00.000Z");
});

// --- Spec 0035, R-11: tarefa de agente ------------------------------------------------------------------------------

Deno.test("CA-32: tarefa de agente não muda de status à mão (409); prazo e atribuição seguem e o tipo fica", async () => {
  const { ctx, tarefas } = ctxDe("admin");
  tarefas.push({
    ...tarefas[0], id: 50, tenant_id: 1, licitacao_id: 10, origem: "empresa", tarefa_codigo: null, titulo: "Analisar o edital",
    responsavel_tipo: "agente", responsavel_agente: "edital", responsavel_user_id: null,
  });
  for (const status of ["concluida", "em_andamento", "cancelada"]) {
    const r = await pedir({ action: "tarefa_atualizar", id: 50, status }, ctx);
    assertEquals(r.status, 409, status);
    await r.body?.cancel();
  }
  assertEquals(tarefas.find((t) => t.id === 50)!.status, "aberta");
  const prazo = await pedir({ action: "tarefa_atualizar", id: 50, prazo_em: "2026-10-30T12:00:00Z" }, ctx);
  assertEquals(prazo.status, 200);
  await prazo.body?.cancel();
  const atr = await pedir({ action: "tarefa_atribuir", id: 50, user_id: OP1 }, ctx);
  assertEquals(atr.status, 200);
  const t = (await atr.json()).tarefa;
  assertEquals([t.responsavel_tipo, t.responsavel_agente, t.responsavel_user_id], ["agente", "edital", OP1]);
});
