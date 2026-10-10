import { assertEquals } from "jsr:@std/assert@1";
import type { Achado } from "../../../supabase/functions/_shared/agentes/tipos.ts";
import { type ApiAgentesContext, handleRequest } from "../../../supabase/functions/api-agentes/index.ts";
import { ErroAgentes, type AgentesRepo, type Dossie, type Execucao } from "../../../supabase/functions/api-agentes/repo.ts";
import type { PropostaItem } from "../../../supabase/functions/_shared/agentes/preco.ts";
import { parseActionFromBody } from "../../../supabase/functions/api-agentes/validation.ts";

function ambiente() {
  let seq = 0;
  const execucoes: Execucao[] = [];
  const dossie: Dossie = {
    licitacao: { id: 101, payload_hash: "h1", data_abertura: "2026-10-21T09:00:00-03:00" },
    documentos_sha256: ["d1"],
    chunks: [{ id: 1, documento_id: 9, pagina: 1, texto: "Apresentar amostra do equipamento." }],
    itens: [{ numero_item: 1, unidade: "UN", estimado_centavos: 1_000_000, amostras: [], piso_centavos: 600_000 }],
    dispositivos: [
      { norma: "LEI_14133_2021", artigo: 59, texto: "texto 59", conferido_oficial: false },
      { norma: "LEI_14133_2021", artigo: 164, texto: "texto 164", conferido_oficial: false },
    ],
  };

  const repo: AgentesRepo = {
    tenantDoUsuario: () => Promise.resolve(1),
    carregarDossie: (_t, id) => Promise.resolve(id === dossie.licitacao.id ? dossie : null),
    buscarExecucao: (_t, licitacaoId, agente, contextoHash) =>
      Promise.resolve(execucoes.find((e) => e.licitacao_id === licitacaoId && e.agente === agente && e.contexto_hash === contextoHash) ?? null),
    gravarExecucao: (_t, userId, licitacaoId, contextoHash, proposta, r) => {
      const row: Execucao = {
        id: ++seq,
        licitacao_id: licitacaoId,
        agente: r.agente,
        situacao: r.situacao,
        contexto_hash: contextoHash,
        regra_versao: r.regra_versao,
        entrada: { proposta },
        achados: r.achados,
        revisao: "aguardando",
        revisao_nota: null,
        revisado_por: null,
        revisado_em: null,
        solicitado_por: userId,
        created_at: new Date(seq * 1000).toISOString(),
      };
      execucoes.push(row);
      return Promise.resolve(row);
    },
    ultimasExecucoes: (_t, licitacaoId) => {
      const ordem = ["edital", "preco", "juridico"] as const;
      return Promise.resolve(ordem.flatMap((agente) => {
        const lista = execucoes.filter((e) => e.licitacao_id === licitacaoId && e.agente === agente);
        const ultima = lista[lista.length - 1];
        return ultima ? [ultima] : [];
      }));
    },
    obterExecucao: (_t, id) => Promise.resolve(execucoes.find((e) => e.id === id) ?? null),
    ultimaAprovada: (_t, licitacaoId, agente) => {
      const lista = execucoes.filter((e) => e.licitacao_id === licitacaoId && e.agente === agente && e.revisao === "aprovada");
      return Promise.resolve(lista[lista.length - 1] ?? null);
    },
    revisar: (_t, id, decisao, nota, userId) => {
      const row = execucoes.find((e) => e.id === id);
      if (!row) return Promise.reject(new ErroAgentes("Execução não encontrada.", 404));
      if (row.revisao !== "aguardando") return Promise.resolve(null);
      row.revisao = decisao;
      row.revisao_nota = nota;
      row.revisado_por = userId;
      row.revisado_em = "t";
      return Promise.resolve(row);
    },
  };
  return { repo, dossie, execucoes };
}

const USUARIO = { id: "u-1", app_metadata: {} };

function ctx(repo: AgentesRepo, user: typeof USUARIO | null = USUARIO): ApiAgentesContext {
  return { getRepo: () => repo, getUser: () => Promise.resolve(user) };
}

async function chamar(c: ApiAgentesContext, body: unknown) {
  const res = await handleRequest(new Request("http://x/api-agentes", { method: "POST", body: JSON.stringify(body) }), c);
  return { status: res.status, json: await res.json() };
}

const P: PropostaItem[] = [{ numero_item: 1, preco_unitario_centavos: 400_000 }];

Deno.test("api-agentes: sem sessão 401; GET 405; ação inválida 400; licitação inexistente 404", async () => {
  const { repo } = ambiente();
  assertEquals((await chamar(ctx(repo, null), { action: "analise_obter", licitacao_id: 101 })).status, 401);
  const get = await handleRequest(new Request("http://x", { method: "GET" }), ctx(repo));
  assertEquals(get.status, 405);
  await get.body?.cancel();
  assertEquals((await chamar(ctx(repo), { action: "qualquer" })).status, 400);
  assertEquals((await chamar(ctx(repo), { action: "analise_obter", licitacao_id: 999 })).status, 404);
});

Deno.test("api-agentes: executar roda os três em ordem e o jurídico recebe os sinais", async () => {
  const { repo } = ambiente();
  const r = await chamar(ctx(repo), { action: "analise_executar", licitacao_id: 101, proposta: P });
  assertEquals(r.status, 200);
  assertEquals(r.json.execucoes.map((e: Execucao) => e.agente), ["edital", "preco", "juridico"]);
  assertEquals(r.json.execucoes[2].achados.map((a: Achado) => a.codigo).sort(), [
    "juridico.exigencia_amostra",
    "juridico.prazo_impugnacao",
    "juridico.preco_indicio_inexequibilidade",
  ]);
  assertEquals(r.json.execucoes.every((e: Execucao) => e.revisao === "aguardando"), true);
  assertEquals(JSON.stringify(r.json).includes("600000"), false);
});

Deno.test("api-agentes: mesma entrada reaproveita as execuções", async () => {
  const { repo, execucoes } = ambiente();
  const c = ctx(repo);
  const a = await chamar(c, { action: "analise_executar", licitacao_id: 101, proposta: P });
  const b = await chamar(c, { action: "analise_executar", licitacao_id: 101, proposta: P });
  assertEquals(b.json.execucoes.map((e: Execucao) => e.id), a.json.execucoes.map((e: Execucao) => e.id));
  assertEquals(execucoes.length, 3);
});

Deno.test("api-agentes: proposta nova refaz preço e jurídico, não o edital", async () => {
  const { repo, execucoes } = ambiente();
  const c = ctx(repo);
  const a = await chamar(c, { action: "analise_executar", licitacao_id: 101, proposta: P });
  const b = await chamar(c, { action: "analise_executar", licitacao_id: 101, proposta: [{ numero_item: 1, preco_unitario_centavos: 900_000 }] });
  assertEquals(b.json.execucoes[0].id, a.json.execucoes[0].id);
  assertEquals(execucoes.length, 5);
});

Deno.test("api-agentes: preço de amostra alterado refaz preço e jurídico", async () => {
  const { repo, dossie, execucoes } = ambiente();
  const c = ctx(repo);
  dossie.itens[0].amostras = [{ id_compra_item: "amostra-1", preco_centavos: 500_000, unidade: "UN" }];
  const a = await chamar(c, { action: "analise_executar", licitacao_id: 101, proposta: P });
  dossie.itens[0].amostras[0].preco_centavos = 550_000;
  const b = await chamar(c, { action: "analise_executar", licitacao_id: 101, proposta: P });
  assertEquals(b.json.execucoes[0].id, a.json.execucoes[0].id);
  assertEquals(b.json.execucoes[1].id === a.json.execucoes[1].id, false);
  assertEquals(b.json.execucoes[2].id === a.json.execucoes[2].id, false);
  assertEquals(execucoes.length, 5);
});

Deno.test("api-agentes: edital retificado marca desatualizada e bloqueia a revisão", async () => {
  const { repo, dossie } = ambiente();
  const c = ctx(repo);
  const a = await chamar(c, { action: "analise_executar", licitacao_id: 101, proposta: P });
  dossie.documentos_sha256 = ["d1", "d2"];
  const o = await chamar(c, { action: "analise_obter", licitacao_id: 101 });
  assertEquals(o.json.execucoes.map((e: { desatualizada: boolean }) => e.desatualizada), [true, false, true]);
  const rev = await chamar(c, { action: "analise_revisar", execucao_id: a.json.execucoes[0].id, decisao: "aprovada" });
  assertEquals(rev.status, 409);
});

Deno.test("api-agentes: sem edital indexado, edital é sem_documento e os outros seguem", async () => {
  const { repo, dossie } = ambiente();
  dossie.chunks = [];
  const r = await chamar(ctx(repo), { action: "analise_executar", licitacao_id: 101, proposta: P });
  assertEquals(r.json.execucoes.map((e: Execucao) => e.situacao), ["sem_documento", "ok", "ok"]);
});

Deno.test("api-agentes: revisão registra quem aprovou; rejeitar exige nota; não revisa duas vezes", async () => {
  const { repo } = ambiente();
  const c = ctx(repo);
  const a = await chamar(c, { action: "analise_executar", licitacao_id: 101, proposta: P });
  const id = a.json.execucoes[1].id;
  assertEquals((await chamar(c, { action: "analise_revisar", execucao_id: id, decisao: "rejeitada" })).status, 400);
  const ok = await chamar(c, { action: "analise_revisar", execucao_id: id, decisao: "rejeitada", nota: "Preço errado" });
  assertEquals([ok.json.execucao.revisao, ok.json.execucao.revisado_por, ok.json.execucao.revisao_nota], ["rejeitada", "u-1", "Preço errado"]);
  assertEquals((await chamar(c, { action: "analise_revisar", execucao_id: id, decisao: "aprovada" })).status, 409);
  assertEquals((await chamar(c, { action: "analise_revisar", execucao_id: 999, decisao: "aprovada" })).status, 404);
});

Deno.test("api-agentes: revisão concorrente que perde a atualização condicional é 409", async () => {
  const { repo } = ambiente();
  const concorrente: AgentesRepo = { ...repo, revisar: () => Promise.resolve(null) };
  const c = ctx(concorrente);
  const a = await chamar(c, { action: "analise_executar", licitacao_id: 101, proposta: P });
  const r = await chamar(c, { action: "analise_revisar", execucao_id: a.json.execucoes[0].id, decisao: "aprovada" });
  assertEquals(r.status, 409);
});

Deno.test("api-agentes: execução nova não apaga a aprovada e aponta para ela", async () => {
  const { repo, execucoes } = ambiente();
  const c = ctx(repo);
  const a = await chamar(c, { action: "analise_executar", licitacao_id: 101, proposta: P });
  const aprovada = a.json.execucoes[1].id;
  await chamar(c, { action: "analise_revisar", execucao_id: aprovada, decisao: "aprovada" });
  await chamar(c, { action: "analise_executar", licitacao_id: 101, proposta: [{ numero_item: 1, preco_unitario_centavos: 900_000 }] });
  const o = await chamar(c, { action: "analise_obter", licitacao_id: 101 });
  assertEquals(o.json.execucoes.map((e: { substitui_aprovada_id: number | null }) => e.substitui_aprovada_id), [null, aprovada, null]);
  assertEquals(execucoes.find((e) => e.id === aprovada)!.revisao, "aprovada");
});

Deno.test("api-agentes: mais de um cliente ativo é 409", async () => {
  const { repo } = ambiente();
  const quebrado: AgentesRepo = {
    ...repo,
    tenantDoUsuario: () => Promise.reject(new ErroAgentes("Há mais de uma empresa cadastrada e o usuário ainda não está ligado a uma.", 409)),
  };
  assertEquals((await chamar(ctx(quebrado), { action: "analise_obter", licitacao_id: 101 })).status, 409);
});

Deno.test("validação: proposta", () => {
  assertEquals("error" in parseActionFromBody({ action: "analise_executar", licitacao_id: 0 }), true);
  assertEquals("error" in parseActionFromBody({ action: "analise_executar", licitacao_id: 1, proposta: [{ numero_item: 1, preco_unitario_centavos: 10.5 }] }), true);
  assertEquals("error" in parseActionFromBody({ action: "analise_executar", licitacao_id: 1, proposta: [{ numero_item: 1, preco_unitario_centavos: 0 }] }), true);
  assertEquals("error" in parseActionFromBody({
    action: "analise_executar",
    licitacao_id: 1,
    proposta: [{ numero_item: 1, preco_unitario_centavos: 5 }, { numero_item: 1, preco_unitario_centavos: 6 }],
  }), true);
  assertEquals(parseActionFromBody({ action: "analise_executar", licitacao_id: 1 }), { action: "analise_executar", licitacao_id: 1, proposta: null });
  assertEquals("error" in parseActionFromBody({ action: "analise_revisar", execucao_id: 1, decisao: "talvez" }), true);
});
