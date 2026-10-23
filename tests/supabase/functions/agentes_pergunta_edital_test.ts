// Spec 0038 (fase 2): pergunta livre ao edital (K-1; CA-1, CA-2, CA-3, CA-12), com o serviço do modelo falso.
import { assertEquals } from "jsr:@std/assert@1";
import {
  criarServicoPerguntas,
  diaSaoPaulo,
  inicioUtf16,
  marcadores,
  validarRespostaEdital,
} from "../../../supabase/functions/api-agentes/perguntas.ts";
import { ErroAgentes } from "../../../supabase/functions/api-agentes/repo.ts";
import { parseActionFromBody } from "../../../supabase/functions/api-agentes/validation.ts";
import { ambiente, chamar, ctx, servicoFalso } from "./agentes_fake.ts";

const AMOSTRA =
  "nte o preenchimento da proposta. 8.4.2 A licitante classificada em primeiro lugar deverá apresentar amostra do " +
  "equipamento em até 5 dias úteis. A amostra será avaliada pela comissão.";
const PERGUNTA = "Há exigência de amostra?";
const PRAZO = "9.1 O prazo de entrega é de 30 dias.";
/** Citação do serviço: o chunk inteiro em `texto` e o recorte que apoia a afirmação, com a posição. */
// apoio_inicio em pontos de código, como o Python (os textos de teste sem emoji coincidem com o índice UTF-16)
const apoio = (texto: string, trecho: string) => ({ texto, apoio: trecho, apoio_inicio: Array.from(texto.slice(0, texto.indexOf(trecho))).length });

function respostaServico(extra: Record<string, unknown> = {}) {
  return {
    resposta: "Sim. O edital exige amostra do equipamento em até 5 dias úteis [1].",
    motivo_sem_resposta: null,
    citacoes: [{ n: 1, chunk_id: 1, documento_id: 9, pagina: 11, ...apoio(AMOSTRA, "deverá apresentar amostra do equipamento") }],
    modelo: "gemini-2.5-flash",
    versao_prompt: "edital-2026-10-22.1",
    uso: { tokens_entrada: 1800, tokens_saida: 120 },
    ...extra,
  };
}

/** Licitação 101 com um chunk na página 11 e o documento com nome (a citação ganha documento_nome). */
function comEdital() {
  const amb = ambiente();
  amb.dossie.chunks = [{ id: 1, documento_id: 9, pagina: 11, texto: AMOSTRA }];
  amb.documentosBrutos.push({
    id: 9, secao: "processo", nome: "Edital PE 29-2026.pdf", data_documento: null, status_processamento: "indexado", paginas: 20, erro: null,
  });
  return amb;
}

function contexto(amb: ReturnType<typeof ambiente>, corpo: unknown | (() => unknown)) {
  const falso = servicoFalso(corpo);
  return { c: { ...ctx(amb.repo), getServicoPerguntas: () => falso.servico, agora: amb.relogio }, chamadas: falso.chamadas };
}

Deno.test("CA-1: resposta cita [n] só com chunks da licitação, com documento, página, item e trecho limpo", async () => {
  const amb = comEdital();
  // o serviço erra documento e página: valem os do banco
  const { c, chamadas } = contexto(amb, respostaServico({
    citacoes: [{ n: 1, chunk_id: 1, documento_id: 555, pagina: 3, ...apoio(AMOSTRA, "deverá apresentar amostra do equipamento") }],
  }));
  const r = await chamar(c, { action: "pergunta_edital", licitacao_id: 101, pergunta: `  ${PERGUNTA}  ` });
  assertEquals(r.status, 200);
  assertEquals(chamadas, [{ licitacao_id: 101, pergunta: PERGUNTA, k: 8 }]);
  assertEquals(r.json.resposta, "Sim. O edital exige amostra do equipamento em até 5 dias úteis [1].");
  assertEquals(r.json.motivo_sem_resposta, null);
  assertEquals(r.json.citacoes, [{
    n: 1,
    chunk_id: 1,
    documento_id: 9,
    documento_nome: "Edital PE 29-2026.pdf",
    pagina: 11,
    item: "8.4.2",
    trecho_limpo:
      "8.4.2 A licitante classificada em primeiro lugar deverá apresentar amostra do equipamento em até 5 dias úteis. " +
      "A amostra será avaliada pela comissão.",
    apoio: "deverá apresentar amostra do equipamento",
  }]);
  assertEquals(r.json.cota, { usadas: 1, limite: 50 });
  const [gravada] = amb.perguntas;
  assertEquals(r.json.pergunta_id, gravada.id);
  assertEquals([gravada.tenant_id, gravada.agente, gravada.licitacao_id, gravada.pergunta, gravada.perguntado_por], [
    1, "edital", 101, PERGUNTA, "u-1",
  ]);
  assertEquals([gravada.modelo, gravada.versao_prompt, gravada.uso], [
    "gemini-2.5-flash", "edital-2026-10-22.1", { tokens_entrada: 1800, tokens_saida: 120 },
  ]);
  // o uso (tokens) fica só no banco
  assertEquals("uso" in r.json, false);
});

Deno.test("CA-2: [7] que não foi entregue ao modelo vira nao_encontrado, sem resposta exibida", async () => {
  const amb = comEdital();
  const { c } = contexto(amb, respostaServico({ resposta: "Sim [1]; prazo de 5 dias [7]." }));
  const r = await chamar(c, { action: "pergunta_edital", licitacao_id: 101, pergunta: PERGUNTA });
  assertEquals(r.status, 200);
  assertEquals([r.json.resposta, r.json.motivo_sem_resposta, r.json.citacoes], [null, "nao_encontrado", []]);
  // gravada como não encontrada, com o modelo (custo rastreável)
  assertEquals([amb.perguntas[0].resposta, amb.perguntas[0].motivo_sem_resposta, amb.perguntas[0].modelo], [
    null, "nao_encontrado", "gemini-2.5-flash",
  ]);
});

Deno.test("K-1: citação de chunk de outra licitação, resposta sem [n] ou nao_encontrado do serviço: nao_encontrado", async () => {
  const casos: Array<Record<string, unknown>> = [
    { citacoes: [{ n: 1, chunk_id: 999, documento_id: 9, pagina: 11, texto: "x", apoio: "x", apoio_inicio: 0 }] },
    // citação não marcada, mas de outra licitação: a resposta inteira cai
    { citacoes: [respostaServico().citacoes[0], { n: 2, chunk_id: 999, documento_id: 9, pagina: 1, texto: "x", apoio: "x", apoio_inicio: 0 }] },
    { resposta: "Sim, o edital exige amostra." },
    { resposta: null, motivo_sem_resposta: "nao_encontrado", citacoes: [] },
  ];
  for (const extra of casos) {
    const amb = comEdital();
    const { c } = contexto(amb, respostaServico(extra));
    const r = await chamar(c, { action: "pergunta_edital", licitacao_id: 101, pergunta: PERGUNTA });
    assertEquals([r.status, r.json.resposta, r.json.motivo_sem_resposta, r.json.citacoes], [200, null, "nao_encontrado", []], JSON.stringify(extra));
    assertEquals(amb.perguntas.length, 1);
  }
});

Deno.test("K-1: só as citações marcadas no texto saem, em ordem de n", async () => {
  const amb = comEdital();
  amb.dossie.chunks.push({ id: 2, documento_id: 9, pagina: 15, texto: PRAZO });
  const { c } = contexto(amb, respostaServico({
    resposta: "Prazo de 30 dias [2] e amostra [1].",
    citacoes: [
      { n: 2, chunk_id: 2, documento_id: 9, pagina: 15, ...apoio(PRAZO, "prazo de entrega") },
      { n: 1, chunk_id: 1, documento_id: 9, pagina: 11, ...apoio(AMOSTRA, "amostra do") },
      { n: 3, chunk_id: 2, documento_id: 9, pagina: 15, ...apoio(PRAZO, "30 dias") },
    ],
  }));
  const r = await chamar(c, { action: "pergunta_edital", licitacao_id: 101, pergunta: PERGUNTA });
  assertEquals(r.json.citacoes.map((x: { n: number; item: string | null }) => [x.n, x.item]), [[1, "8.4.2"], [2, "9.1"]]);
});

Deno.test("CA-3: licitação sem chunks devolve sem_documentos sem chamar o modelo", async () => {
  const amb = ambiente();
  amb.dossie.chunks = [];
  const { c, chamadas } = contexto(amb, () => {
    throw new Error("não devia chamar o serviço");
  });
  const r = await chamar(c, { action: "pergunta_edital", licitacao_id: 101, pergunta: PERGUNTA });
  assertEquals(r.status, 200);
  assertEquals([r.json.resposta, r.json.motivo_sem_resposta, r.json.citacoes, r.json.cota], [
    null, "sem_documentos", [], { usadas: 0, limite: 50 },
  ]);
  assertEquals(chamadas.length, 0);
  assertEquals([amb.perguntas[0].motivo_sem_resposta, amb.perguntas[0].modelo], ["sem_documentos", null]);
});

Deno.test("K-1: sem chunks e documentos em leitura, 409 sem gravar", async () => {
  const amb = ambiente();
  amb.dossie.chunks = [];
  amb.estado.preparacao = { status: "processing", resultado: null, erro: null, atualizado_em: "agora" };
  const { c, chamadas } = contexto(amb, respostaServico());
  const r = await chamar(c, { action: "pergunta_edital", licitacao_id: 101, pergunta: PERGUNTA });
  assertEquals(r.status, 409);
  assertEquals([amb.perguntas.length, chamadas.length], [0, 0]);
});

Deno.test("CA-12: na 51ª pergunta do dia, 429; o dia anterior e outra empresa não contam; no dia seguinte volta", async () => {
  const amb = comEdital();
  // relógio do fake: 22/10 12h em Brasília
  amb.cotas.set("1|2026-10-21", 50);
  amb.cotas.set("2|2026-10-22", 50);
  amb.cotas.set("1|2026-10-22", 49);
  const { c, chamadas } = contexto(amb, respostaServico());

  const a50 = await chamar(c, { action: "pergunta_edital", licitacao_id: 101, pergunta: PERGUNTA });
  assertEquals([a50.status, a50.json.cota], [200, { usadas: 50, limite: 50 }]);
  const a51 = await chamar(c, { action: "pergunta_edital", licitacao_id: 101, pergunta: PERGUNTA });
  assertEquals(a51.status, 429);
  assertEquals(a51.json, { error: "Limite de 50 perguntas por dia atingido", cota: { usadas: 50, limite: 50 } });
  assertEquals([chamadas.length, amb.perguntas.length], [1, 1]);

  // 0h01 de 23/10 em Brasília
  const amanha = { ...c, agora: () => new Date("2026-10-23T03:01:00.000Z") };
  const dia2 = await chamar(amanha, { action: "pergunta_edital", licitacao_id: 101, pergunta: PERGUNTA });
  assertEquals([dia2.status, dia2.json.cota], [200, { usadas: 1, limite: 50 }]);
});

Deno.test("CA-12: duas perguntas simultâneas na 50ª: a vaga é reservada antes do modelo, só uma passa", async () => {
  const amb = comEdital();
  amb.cotas.set("1|2026-10-22", 49);
  const { c, chamadas } = contexto(amb, respostaServico());
  const [x, y] = await Promise.all([
    chamar(c, { action: "pergunta_edital", licitacao_id: 101, pergunta: PERGUNTA }),
    chamar(c, { action: "pergunta_edital", licitacao_id: 101, pergunta: PERGUNTA }),
  ]);
  assertEquals([x.status, y.status].sort(), [200, 429]);
  assertEquals([chamadas.length, amb.cotas.get("1|2026-10-22")], [1, 50]);
});

Deno.test("diaSaoPaulo: o dia vira à meia-noite de Brasília", () => {
  assertEquals(diaSaoPaulo(new Date("2026-10-22T02:59:00Z")), "2026-10-21");
  assertEquals(diaSaoPaulo(new Date("2026-10-22T03:00:00Z")), "2026-10-22");
});

Deno.test("K-1: fora do pipeline, 404 sem chamar o modelo nem gravar", async () => {
  const amb = comEdital();
  amb.pipeline.clear();
  const { c, chamadas } = contexto(amb, respostaServico());
  const r = await chamar(c, { action: "pergunta_edital", licitacao_id: 101, pergunta: PERGUNTA });
  assertEquals([r.status, amb.perguntas.length, chamadas.length], [404, 0, 0]);
});

Deno.test("K-1: serviço sem configuração, 503; serviço falhando ou fora do contrato, 502; nada gravado", async () => {
  const amb = comEdital();
  Deno.env.delete("AGENTE_PERGUNTAS_URL");
  Deno.env.delete("AGENTE_PERGUNTAS_SEGREDO");
  const semServico = await chamar({ ...ctx(amb.repo), agora: amb.relogio }, { action: "pergunta_edital", licitacao_id: 101, pergunta: PERGUNTA });
  assertEquals([semServico.status, semServico.json.error], [503, "serviço de perguntas não configurado"]);

  const ruins: unknown[] = [
    () => {
      throw new ErroAgentes("falha ao consultar o agente", 502);
    },
    respostaServico({ resposta: null }), // nem resposta nem motivo
    respostaServico({ motivo_sem_resposta: "nao_encontrado" }), // os dois
    respostaServico({ modelo: undefined }),
    respostaServico({ uso: null }),
    respostaServico({ citacoes: [respostaServico().citacoes[0], respostaServico().citacoes[0]] }), // n repetido
    respostaServico({ citacoes: [{ n: 1, chunk_id: "1", documento_id: 9, pagina: 11, texto: "x", apoio: "x", apoio_inicio: 0 }] }),
    // apoio obrigatório: ausente, vazio, posição negativa ou não inteira
    respostaServico({ citacoes: [{ n: 1, chunk_id: 1, documento_id: 9, pagina: 11, texto: AMOSTRA }] }),
    respostaServico({ citacoes: [{ n: 1, chunk_id: 1, documento_id: 9, pagina: 11, texto: AMOSTRA, apoio: " ", apoio_inicio: 0 }] }),
    respostaServico({ citacoes: [{ n: 1, chunk_id: 1, documento_id: 9, pagina: 11, texto: AMOSTRA, apoio: "nte", apoio_inicio: -1 }] }),
    respostaServico({ citacoes: [{ n: 1, chunk_id: 1, documento_id: 9, pagina: 11, texto: AMOSTRA, apoio: "nte", apoio_inicio: 1.5 }] }),
    "texto solto",
  ];
  for (const corpo of ruins) {
    const { c } = contexto(amb, corpo);
    const r = await chamar(c, { action: "pergunta_edital", licitacao_id: 101, pergunta: PERGUNTA });
    assertEquals([r.status, r.json.error], [502, "falha ao consultar o agente"], JSON.stringify(corpo));
  }
  assertEquals(amb.perguntas.length, 0);
});

Deno.test("K-1: cliente real chama POST /edital/perguntar com o segredo no cabeçalho", async () => {
  const pedidos: Request[] = [];
  const env = (nome: string) =>
    ({ AGENTE_PERGUNTAS_URL: "https://agente-perguntas.run.app/", AGENTE_PERGUNTAS_SEGREDO: "s3gr3d0" } as Record<string, string>)[nome];
  const fetchOk = ((input: URL, init?: RequestInit) => {
    pedidos.push(new Request(input, init));
    return Promise.resolve(new Response(JSON.stringify(respostaServico()), { status: 200 }));
  }) as typeof fetch;
  const corpo = await criarServicoPerguntas(env, fetchOk).perguntarEdital({ licitacao_id: 101, pergunta: PERGUNTA, k: 8 });
  assertEquals(validarRespostaEdital(corpo)?.modelo, "gemini-2.5-flash");
  assertEquals([pedidos[0].method, pedidos[0].url, pedidos[0].headers.get("X-Agente-Segredo")], [
    "POST", "https://agente-perguntas.run.app/edital/perguntar", "s3gr3d0",
  ]);
  assertEquals(await pedidos[0].json(), { licitacao_id: 101, pergunta: PERGUNTA, k: 8 });

  const falha = (res: () => Promise<Response>) => criarServicoPerguntas(env, res as unknown as typeof fetch)
    .perguntarEdital({ licitacao_id: 101, pergunta: PERGUNTA, k: 8 }).then(() => null, (e) => e);
  for (const res of [
    () => Promise.resolve(new Response("erro interno", { status: 500 })),
    () => Promise.resolve(new Response("{", { status: 200 })),
    () => Promise.reject(new TypeError("conexão recusada")),
  ]) {
    const e = await falha(res);
    assertEquals([e instanceof ErroAgentes, e?.status, e?.message], [true, 502, "falha ao consultar o agente"]);
  }

  // sem segredo, sem URL ou URL sem https: não configurado (e o segredo nunca aparece no erro)
  for (const vars of [{ AGENTE_PERGUNTAS_URL: "https://x" }, { AGENTE_PERGUNTAS_SEGREDO: "s3gr3d0" }, {
    AGENTE_PERGUNTAS_URL: "http://x", AGENTE_PERGUNTAS_SEGREDO: "s3gr3d0",
  }]) {
    let erro: unknown = null;
    try {
      criarServicoPerguntas((n) => (vars as Record<string, string>)[n], fetchOk);
    } catch (e) {
      erro = e;
    }
    assertEquals([(erro as ErroAgentes)?.status, String((erro as Error)?.message).includes("s3gr3d0")], [503, false], JSON.stringify(vars));
  }
});

Deno.test("validação: pergunta vazia, longa demais ou não texto dá 400", () => {
  for (const pergunta of ["", "   ", "x".repeat(501), 12, null]) {
    assertEquals("error" in parseActionFromBody({ action: "pergunta_edital", licitacao_id: 101, pergunta }), true, String(pergunta));
  }
  assertEquals("error" in parseActionFromBody({ action: "pergunta_edital", licitacao_id: 0, pergunta: "ok" }), true);
  assertEquals(parseActionFromBody({ action: "pergunta_edital", licitacao_id: 101, pergunta: "x".repeat(500) }), {
    action: "pergunta_edital", licitacao_id: 101, pergunta: "x".repeat(500),
  });
});

Deno.test("CA-12: sem_documentos não conta na cota (49 normais + 3 sem_documentos: a próxima passa; 50 normais: 429)", async () => {
  const semDoc = ambiente();
  semDoc.dossie.chunks = [];
  semDoc.cotas.set("1|2026-10-22", 49);
  const s = contexto(semDoc, respostaServico());
  for (let i = 0; i < 3; i++) {
    const r = await chamar(s.c, { action: "pergunta_edital", licitacao_id: 101, pergunta: PERGUNTA });
    assertEquals([r.status, r.json.motivo_sem_resposta, r.json.cota], [200, "sem_documentos", { usadas: 49, limite: 50 }]);
  }
  // os documentos foram lidos: a 50ª ainda passa, a 51ª não
  semDoc.dossie.chunks = [{ id: 1, documento_id: 9, pagina: 11, texto: AMOSTRA }];
  const a50 = await chamar(s.c, { action: "pergunta_edital", licitacao_id: 101, pergunta: PERGUNTA });
  assertEquals([a50.status, a50.json.cota], [200, { usadas: 50, limite: 50 }]);
  const a51 = await chamar(s.c, { action: "pergunta_edital", licitacao_id: 101, pergunta: PERGUNTA });
  assertEquals([a51.status, a51.json.cota], [429, { usadas: 50, limite: 50 }]);
  assertEquals(s.chamadas.length, 1);
});

Deno.test("CA-12: 503 (serviço não configurado) devolve a vaga; 502 não devolve (o modelo pode ter cobrado)", async () => {
  const amb = comEdital();
  Deno.env.delete("AGENTE_PERGUNTAS_URL");
  Deno.env.delete("AGENTE_PERGUNTAS_SEGREDO");
  const r503 = await chamar({ ...ctx(amb.repo), agora: amb.relogio }, { action: "pergunta_edital", licitacao_id: 101, pergunta: PERGUNTA });
  assertEquals([r503.status, amb.cotas.get("1|2026-10-22")], [503, 0]);
  const { c } = contexto(amb, () => {
    throw new ErroAgentes("falha ao consultar o agente", 502);
  });
  const r502 = await chamar(c, { action: "pergunta_edital", licitacao_id: 101, pergunta: PERGUNTA });
  assertEquals([r502.status, amb.cotas.get("1|2026-10-22"), amb.perguntas.length], [502, 1, 0]);
});

Deno.test("K-1: marcadores como no serviço Python: '[2, 5]' vale; marcador malformado recusa", () => {
  assertEquals([...marcadores("Prazo [2, 5] e amostra [1].")!].sort(), [1, 2, 5]);
  assertEquals([...marcadores("[1] e [7]")!].sort(), [1, 7]);
  for (const t of ["Sim [1-3].", "Sim [12a].", "Sim [1", "Sim [ 4 ]"]) assertEquals(marcadores(t), null, t);
  assertEquals(marcadores("Sem citação [nota]."), new Set());
});

Deno.test("K-1: '[2, 5]' com as duas citações entregues responde; '[1] e [7]' sem a 7 vira nao_encontrado", async () => {
  const amb = comEdital();
  amb.dossie.chunks.push({ id: 2, documento_id: 9, pagina: 15, texto: PRAZO });
  const cit = (n: number, chunk_id: number) => ({
    n, chunk_id, documento_id: 9, pagina: 1, ...(chunk_id === 2 ? apoio(PRAZO, "prazo") : apoio(AMOSTRA, "amostra do")),
  });
  const ok = contexto(amb, respostaServico({ resposta: "Prazo e amostra [2, 5].", citacoes: [cit(2, 2), cit(5, 1)] }));
  const r1 = await chamar(ok.c, { action: "pergunta_edital", licitacao_id: 101, pergunta: PERGUNTA });
  assertEquals(r1.json.citacoes.map((x: { n: number; chunk_id: number }) => [x.n, x.chunk_id]), [[2, 2], [5, 1]]);
  const ruim = contexto(amb, respostaServico({ resposta: "Amostra [1] e prazo [7].", citacoes: [cit(1, 1)] }));
  const r2 = await chamar(ruim.c, { action: "pergunta_edital", licitacao_id: 101, pergunta: PERGUNTA });
  assertEquals([r2.json.resposta, r2.json.motivo_sem_resposta], [null, "nao_encontrado"]);
  const malformado = contexto(amb, respostaServico({ resposta: "Amostra [1] e prazo [1-2].", citacoes: [cit(1, 1)] }));
  const r3 = await chamar(malformado.c, { action: "pergunta_edital", licitacao_id: 101, pergunta: PERGUNTA });
  assertEquals(r3.json.motivo_sem_resposta, "nao_encontrado");
});

Deno.test("K-4: apoio na cláusula 8.2 de um chunk que começa na 8.1 → item 8.2 e trecho da 8.2", async () => {
  const amb = comEdital();
  const texto = "8.1 A proposta será enviada pelo sistema eletrônico. A proposta terá validade de 60 dias.\n" +
    "8.2 A licitante deverá apresentar amostra do equipamento no prazo de 5 dias úteis. A comissão avaliará a amostra.";
  amb.dossie.chunks = [{ id: 1, documento_id: 9, pagina: 11, texto }];
  const { c } = contexto(amb, respostaServico({
    citacoes: [{ n: 1, chunk_id: 1, documento_id: 9, pagina: 11, ...apoio(texto, "apresentar amostra do equipamento") }],
  }));
  const r = await chamar(c, { action: "pergunta_edital", licitacao_id: 101, pergunta: PERGUNTA });
  assertEquals(r.status, 200);
  const [cit] = r.json.citacoes;
  assertEquals([cit.item, cit.apoio], ["8.2", "apresentar amostra do equipamento"]);
  assertEquals(cit.trecho_limpo, "8.2 A licitante deverá apresentar amostra do equipamento no prazo de 5 dias úteis. A comissão avaliará a amostra.");
});

Deno.test("K-1: apoio que não bate com o texto do banco na posição informada vira nao_encontrado", async () => {
  for (const errado of [
    { texto: AMOSTRA, apoio: "deverá apresentar amostra", apoio_inicio: 0 }, // posição errada
    { texto: AMOSTRA, apoio: "exige garantia contratual", apoio_inicio: 40 }, // texto que não está no chunk
    { texto: AMOSTRA, apoio: "comissão.", apoio_inicio: AMOSTRA.length - 2 }, // passa do fim
  ]) {
    const amb = comEdital();
    const { c } = contexto(amb, respostaServico({ citacoes: [{ n: 1, chunk_id: 1, documento_id: 9, pagina: 11, ...errado }] }));
    const r = await chamar(c, { action: "pergunta_edital", licitacao_id: 101, pergunta: PERGUNTA });
    assertEquals([r.status, r.json.resposta, r.json.motivo_sem_resposta, r.json.citacoes], [200, null, "nao_encontrado", []], JSON.stringify(errado));
  }
});

Deno.test("K-1: apoio_inicio em pontos de código (Python): emoji antes do apoio é aceito, item 8.2", async () => {
  const amb = comEdital();
  const texto = "📌 8.2 A amostra deverá ser entregue em cinco dias úteis.";
  amb.dossie.chunks = [{ id: 1, documento_id: 9, pagina: 11, texto }];
  const cit = { n: 1, chunk_id: 1, documento_id: 9, pagina: 11, texto, apoio: "A amostra deverá ser entregue", apoio_inicio: 6 };
  const ok = contexto(amb, respostaServico({ citacoes: [cit] }));
  const r = await chamar(ok.c, { action: "pergunta_edital", licitacao_id: 101, pergunta: PERGUNTA });
  assertEquals([r.status, r.json.motivo_sem_resposta, r.json.citacoes[0]?.item, r.json.citacoes[0]?.apoio], [
    200, null, "8.2", "A amostra deverá ser entregue",
  ]);
  // índice UTF-16 (7) não é o contrato; posição além do texto também não passa
  for (const apoio_inicio of [7, Array.from(texto).length + 1]) {
    const ruim = contexto(amb, respostaServico({ citacoes: [{ ...cit, apoio_inicio }] }));
    const x = await chamar(ruim.c, { action: "pergunta_edital", licitacao_id: 101, pergunta: PERGUNTA });
    assertEquals([x.status, x.json.motivo_sem_resposta], [200, "nao_encontrado"], String(apoio_inicio));
  }
});

Deno.test("inicioUtf16: converte pontos de código para o índice do JavaScript", () => {
  assertEquals(inicioUtf16("📌 8.2 A", 6), 7);
  assertEquals(inicioUtf16("abc", 3), 3);
  assertEquals(inicioUtf16("abc", 4), null);
});
