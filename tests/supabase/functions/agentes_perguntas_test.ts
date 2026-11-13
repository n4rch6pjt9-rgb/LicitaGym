// Spec 0038 (fase 2): histórico das perguntas (K-5, CA-7), estrela, nota na oportunidade (K-11, CA-11) e
// "Ler os documentos" (K-6).
import { assertEquals } from "jsr:@std/assert@1";
import { createSupabaseRepo } from "../../../supabase/functions/api-agentes/repo.ts";
import { parseActionFromBody } from "../../../supabase/functions/api-agentes/validation.ts";
import { ambiente, chamar, ctx, type PerguntaGravada, USUARIO } from "./agentes_fake.ts";

function pergunta(amb: ReturnType<typeof ambiente>, extra: Partial<PerguntaGravada> = {}): PerguntaGravada {
  const row: PerguntaGravada = {
    id: amb.perguntas.length + 1, tenant_id: 1, agente: "edital", licitacao_id: 101, pergunta: "Há amostra?",
    resposta: "Sim [1].", motivo_sem_resposta: null,
    citacoes: [{ n: 1, chunk_id: 1, documento_id: 9, documento_nome: "Edital.pdf", pagina: 11, item: "8.4.2", trecho_limpo: "8.4.2 Amostra.", apoio: "Amostra" }],
    modelo: "m", versao_prompt: "v", uso: { tokens: 1 }, perguntado_por: "u-1",
    created_at: new Date(Date.UTC(2026, 9, 22, 12, 0, amb.perguntas.length)).toISOString(), favorita: false, enviada_em: null,
    enviada_por: null, ...extra,
  };
  amb.perguntas.push(row);
  return row;
}

const c = (amb: ReturnType<typeof ambiente>) => ({ ...ctx(amb.repo), agora: amb.relogio });

Deno.test("CA-7: cada empresa só lista as suas perguntas, mais recentes primeiro, com a cota e sem o uso", async () => {
  const amb = ambiente();
  const a = pergunta(amb);
  pergunta(amb, { tenant_id: 2, pergunta: "da outra empresa" });
  const b = pergunta(amb, { agente: "juridico", licitacao_id: null, resposta: null, motivo_sem_resposta: "nao_encontrado", citacoes: [] });
  // a cota vem de agente_cota_dia (do dia de hoje, só desta empresa)
  amb.cotas.set("1|2026-10-22", 7);
  amb.cotas.set("2|2026-10-22", 30);
  const r = await chamar(c(amb), { action: "perguntas_listar" });
  assertEquals(r.status, 200);
  assertEquals(r.json.perguntas.map((p: { id: number }) => p.id), [b.id, a.id]);
  assertEquals([r.json.total, r.json.pagina, r.json.por_pagina, r.json.cota], [2, 1, 20, { usadas: 7, limite: 50 }]);
  assertEquals(JSON.stringify(r.json).includes("tokens"), false);
  assertEquals(JSON.stringify(r.json).includes("da outra empresa"), false);
});

Deno.test("K-5: filtro por agente e por licitação; licitação fora do pipeline dá 404", async () => {
  const amb = ambiente();
  const a = pergunta(amb);
  pergunta(amb, { agente: "juridico", licitacao_id: null, resposta: null, motivo_sem_resposta: "nao_encontrado", citacoes: [] });
  const porAgente = await chamar(c(amb), { action: "perguntas_listar", agente: "edital" });
  assertEquals(porAgente.json.perguntas.map((p: { id: number }) => p.id), [a.id]);
  const porLicitacao = await chamar(c(amb), { action: "perguntas_listar", licitacao_id: 101 });
  assertEquals(porLicitacao.json.perguntas.map((p: { id: number }) => p.id), [a.id]);
  assertEquals((await chamar(c(amb), { action: "perguntas_listar", licitacao_id: 202 })).status, 404);
});

Deno.test("K-5: validação do perguntas_listar", () => {
  for (const body of [{ agente: "aderencia" }, { licitacao_id: -1 }, { somente_enviadas: "sim" }, { pagina: 0 }, { por_pagina: 51 }]) {
    assertEquals("error" in parseActionFromBody({ action: "perguntas_listar", ...body }), true, JSON.stringify(body));
  }
  assertEquals(parseActionFromBody({ action: "perguntas_listar" }), {
    action: "perguntas_listar", agente: null, licitacao_id: null, somente_enviadas: false, pagina: 1, por_pagina: 20,
  });
});

Deno.test("K-5: favoritar marca e desmarca; pergunta de outra empresa dá 404", async () => {
  const amb = ambiente();
  const a = pergunta(amb);
  const outra = pergunta(amb, { tenant_id: 2 });
  const r = await chamar(c(amb), { action: "pergunta_favoritar", pergunta_id: a.id, favorita: true });
  assertEquals([r.status, r.json.pergunta.favorita, a.favorita], [200, true, true]);
  await chamar(c(amb), { action: "pergunta_favoritar", pergunta_id: a.id, favorita: false });
  assertEquals(a.favorita, false);
  assertEquals((await chamar(c(amb), { action: "pergunta_favoritar", pergunta_id: outra.id, favorita: true })).status, 404);
  assertEquals(outra.favorita, false);
  assertEquals("error" in parseActionFromBody({ action: "pergunta_favoritar", pergunta_id: 1, favorita: "true" }), true);
});

Deno.test("CA-11: enviar vira nota da oportunidade (somente_enviadas); de novo dá 409; achados não mudam", async () => {
  const amb = ambiente();
  const a = pergunta(amb);
  pergunta(amb); // não enviada: não aparece nas notas
  const r = await chamar(c(amb), { action: "pergunta_enviar", pergunta_id: a.id });
  assertEquals([r.status, r.json.pergunta.enviada_por, typeof r.json.pergunta.enviada_em], [200, "u-1", "string"]);
  const notas = await chamar(c(amb), { action: "perguntas_listar", licitacao_id: 101, somente_enviadas: true });
  assertEquals(notas.json.perguntas.map((p: { id: number; resposta: string }) => [p.id, p.resposta]), [[a.id, "Sim [1]."]]);
  assertEquals(notas.json.perguntas[0].citacoes[0].item, "8.4.2");
  assertEquals((await chamar(c(amb), { action: "pergunta_enviar", pergunta_id: a.id })).status, 409);
  assertEquals(amb.execucoes.length, 0);
});

Deno.test("K-11: pergunta sem licitação dá 400; de outra empresa ou fora do pipeline, 404", async () => {
  const amb = ambiente();
  const avulsa = pergunta(amb, { agente: "juridico", licitacao_id: null });
  const outra = pergunta(amb, { tenant_id: 2 });
  const foraDoPipeline = pergunta(amb, { licitacao_id: 202 });
  assertEquals((await chamar(c(amb), { action: "pergunta_enviar", pergunta_id: avulsa.id })).status, 400);
  assertEquals((await chamar(c(amb), { action: "pergunta_enviar", pergunta_id: outra.id })).status, 404);
  assertEquals((await chamar(c(amb), { action: "pergunta_enviar", pergunta_id: foraDoPipeline.id })).status, 404);
  assertEquals(amb.perguntas.every((p) => p.enviada_em === null), true);
});

Deno.test("K-11: envio concorrente (a linha já foi enviada entre a leitura e o update) dá 409", async () => {
  const amb = ambiente();
  const a = pergunta(amb);
  amb.repo.enviarPergunta = () => Promise.resolve(null);
  assertEquals((await chamar(c(amb), { action: "pergunta_enviar", pergunta_id: a.id })).status, 409);
});

// --- K-6: "Ler os documentos" ----------------------------------------------------------------------------------

function comPapel(papel: "admin" | "operacao" | null) {
  const amb = ambiente();
  amb.repo.tenantDoUsuario = () => Promise.resolve({ tenant: 1, papel });
  return amb;
}

Deno.test("K-6: admin e operação enfileiram a preparação (mesma fila do Analisar) e o estado é em_leitura", async () => {
  for (const papel of ["admin", "operacao"] as const) {
    const amb = comPapel(papel);
    amb.dossie.chunks = [];
    const r = await chamar(c(amb), { action: "documentos_ler", licitacao_id: 101 });
    assertEquals([r.status, r.json.estado, amb.estado.solicitacoes], [200, "em_leitura", 1], papel);
    // já em leitura: 409, sem novo pedido
    const de_novo = await chamar(c(amb), { action: "documentos_ler", licitacao_id: 101 });
    assertEquals([de_novo.status, amb.estado.solicitacoes], [409, 1], papel);
  }
});

Deno.test("K-6: sem papel na empresa dá 403; o admin da plataforma (sem vínculo) pode", async () => {
  const amb = comPapel(null);
  amb.dossie.chunks = [];
  assertEquals((await chamar(c(amb), { action: "documentos_ler", licitacao_id: 101 })).status, 403);
  assertEquals(amb.estado.solicitacoes, 0);
  const dev = { ...USUARIO, app_metadata: { licitagym_role: "admin" } };
  const r = await chamar({ ...ctx(amb.repo, dev as typeof USUARIO) }, { action: "documentos_ler", licitacao_id: 101 });
  assertEquals([r.status, r.json.estado], [200, "em_leitura"]);
});

Deno.test("K-6: lidos, sem_documentos, pedido que falhou é refeito, fora do pipeline 404", async () => {
  const lidos = comPapel("operacao");
  const r1 = await chamar(c(lidos), { action: "documentos_ler", licitacao_id: 101 });
  assertEquals([r1.status, r1.json.estado, lidos.estado.solicitacoes], [200, "lidos", 0]);

  // chunks, mas documento novo ainda pendente: lê de novo
  const pendente = comPapel("operacao");
  pendente.estado.naoLidos = 1;
  assertEquals((await chamar(c(pendente), { action: "documentos_ler", licitacao_id: 101 })).json.estado, "em_leitura");

  const semDoc = comPapel("admin");
  semDoc.dossie.chunks = [];
  semDoc.estado.preparacao = { status: "completed", resultado: "sem_documento", erro: null, atualizado_em: "ontem" };
  const r2 = await chamar(c(semDoc), { action: "documentos_ler", licitacao_id: 101 });
  assertEquals([r2.status, r2.json.estado, semDoc.estado.solicitacoes], [200, "sem_documentos", 0]);

  const falhou = comPapel("admin");
  falhou.dossie.chunks = [];
  falhou.estado.preparacao = { status: "failed", resultado: null, erro: "download: HTTP 504", atualizado_em: "ontem" };
  const r3 = await chamar(c(falhou), { action: "documentos_ler", licitacao_id: 101 });
  assertEquals([r3.json.estado, falhou.estado.solicitacoes], ["em_leitura", 1]);

  const fora = comPapel("admin");
  assertEquals((await chamar(c(fora), { action: "documentos_ler", licitacao_id: 202 })).status, 404);
  assertEquals(fora.estado.solicitacoes, 0);
});

Deno.test("K-6: a fila responde ja_na_fila (corrida com outro pedido): 409", async () => {
  const amb = comPapel("admin");
  amb.dossie.chunks = [];
  amb.repo.solicitarPreparacao = () => Promise.resolve("ja_na_fila");
  assertEquals((await chamar(c(amb), { action: "documentos_ler", licitacao_id: 101 })).status, 409);
});

// --- repo real (cliente Supabase falso que grava a consulta) -----------------------------------------------------

function clienteGravador(resultado: Record<string, unknown>) {
  const chamadas: Array<[string, unknown[]]> = [];
  const consulta: Record<string, unknown> = {};
  const proxy: unknown = new Proxy(consulta, {
    get(_alvo, nome: string) {
      if (nome === "then") return (ok: (v: unknown) => void) => ok(resultado);
      return (...args: unknown[]) => {
        chamadas.push([nome, args]);
        if (nome === "maybeSingle" || nome === "single") return Promise.resolve(resultado);
        return proxy;
      };
    },
  });
  return { cliente: { from: (t: string) => (chamadas.push(["from", [t]]), proxy) } as unknown as Parameters<typeof createSupabaseRepo>[0], chamadas };
}

Deno.test("repo real: chunks citados só da licitação e da seção processo; envio só se ainda não enviada; sem uso", async () => {
  const chunks = clienteGravador({ data: [{ id: 1, documento_id: 9, pagina: null, texto: "t" }], error: null });
  assertEquals(await createSupabaseRepo(chunks.cliente).chunksDaLicitacao(101, [1, 999]), [{ id: 1, documento_id: 9, pagina: null, texto: "t" }]);
  assertEquals(chunks.chamadas.filter(([n]) => n === "eq" || n === "in"), [
    ["eq", ["licitacao_id", 101]], ["eq", ["secao", "processo"]], ["in", ["id", [1, 999]]],
  ]);
  assertEquals(chunks.chamadas.some(([n, a]) => n === "not" && a[0] === "nivel_confianca"), true);

  const envio = clienteGravador({ data: null, error: null });
  assertEquals(await createSupabaseRepo(envio.cliente).enviarPergunta(1, 5, "u-1"), null);
  assertEquals(envio.chamadas.some(([n, a]) => n === "is" && a[0] === "enviada_em" && a[1] === null), true);
  assertEquals(envio.chamadas.some(([n, a]) => n === "eq" && a[0] === "tenant_id" && a[1] === 1), true);
  const select = envio.chamadas.find(([n]) => n === "select")![1][0] as string;
  assertEquals(select.split(",").includes("uso"), false);

  const conta = clienteGravador({ count: 3, error: null });
  assertEquals(await createSupabaseRepo(conta.cliente).contarChunksIndexados(101), 3);
  // mesmos filtros da agente_chunks_licitacao: só chunks bloqueados contam 0 (CA-3: sem_documentos)
  assertEquals(conta.chamadas.filter(([n]) => n === "eq" || n === "not" || n === "or"), [
    ["eq", ["licitacao_id", 101]],
    ["eq", ["secao", "processo"]],
    ["not", ["embedding", "is", null]],
    ["not", ["nivel_confianca", "in", "(suspeito,bloqueado,parte_interessada)"]],
    ["or", ["embedding_model.is.null,embedding_model.eq.text-multilingual-embedding-002"]],
  ]);

  const semContagem = clienteGravador({ count: null, error: null });
  const erro = await createSupabaseRepo(semContagem.cliente).contarChunksIndexados(101).then(() => null, (e) => e);
  // contagem ilegível não vira "sem documentos" (erro ≠ vazio)
  assertEquals(erro instanceof Error, true);
});
