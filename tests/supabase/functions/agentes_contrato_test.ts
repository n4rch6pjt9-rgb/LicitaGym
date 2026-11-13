import { assertEquals, assertNotEquals } from "jsr:@std/assert@1";
import { hashContexto, normalizarTexto, validarAchado } from "../../../supabase/functions/_shared/agentes/achados.ts";
import type { Achado } from "../../../supabase/functions/_shared/agentes/tipos.ts";
import { parseActionFromBody } from "../../../supabase/functions/api-agentes/validation.ts";
import { ambiente, chamar, ctx } from "./agentes_fake.ts";

const base: Achado = {
  codigo: "exigencia.amostra",
  natureza: "fato",
  metodo: "regra",
  severidade: "atencao",
  titulo: "t",
  detalhe: "d",
  dados: {},
  fontes: [{ tipo: "chunk", chunk_id: 1, documento_id: 2, pagina: 3, trecho: "apresentar amostra" }],
};

Deno.test("validarAchado: aceita achado com fonte", () => assertEquals(validarAchado(base), null));
Deno.test("validarAchado: rejeita sem fonte", () =>
  assertEquals(validarAchado({ ...base, fontes: [] }), "achado sem fonte"));
Deno.test("validarAchado: rejeita trecho vazio", () =>
  assertEquals(
    validarAchado({ ...base, fontes: [{ tipo: "chunk", chunk_id: 1, documento_id: 2, pagina: null, trecho: "  " }] }),
    "fonte chunk sem trecho",
  ));
Deno.test("validarAchado: rejeita código fora do padrão", () =>
  assertEquals(validarAchado({ ...base, codigo: "Amostra" }), "código inválido: Amostra"));
Deno.test("validarAchado: fato precisa de fonte primária; análise aceita cálculo", () => {
  const soCalculo = [{ tipo: "calculo" as const, regra: "r", versao: "1" }];
  assertEquals(validarAchado({ ...base, fontes: soCalculo }), "fato sem fonte primária");
  assertEquals(validarAchado({ ...base, natureza: "analise", fontes: soCalculo }), null);
});
Deno.test("validarAchado: rejeita dado sigiloso", () =>
  assertEquals(validarAchado({ ...base, dados: { preco_tabela: 1 } }), "dado sigiloso em achado: preco_tabela"));

Deno.test("hashContexto: ordem das chaves não muda; ordem da lista muda", async () => {
  assertEquals(await hashContexto({ a: 1, b: { c: 2, d: 3 } }), await hashContexto({ b: { d: 3, c: 2 }, a: 1 }));
  assertNotEquals(await hashContexto([1, 2]), await hashContexto([2, 1]));
  assertEquals((await hashContexto({})).length, 64);
});

Deno.test("normalizarTexto", () => assertEquals(normalizarTexto("  Visita   TÉCNICA\nobrigatória "), "visita tecnica obrigatoria"));

// --- Spec 0035: agentes pedidos em analise_executar (K-2, R-4, R-5) ------------------------------------------------

Deno.test("CA-3: agentes:[edital] grava só o edital", async () => {
  const { repo, execucoes } = ambiente();
  const r = await chamar(ctx(repo), { action: "analise_executar", licitacao_id: 101, agentes: ["edital"] });
  assertEquals(r.status, 200);
  assertEquals(execucoes.map((e) => e.agente), ["edital"]);
});

Deno.test("CA-4: agentes:[juridico] sem execução anterior grava edital, preço e jurídico, com os sinais do edital", async () => {
  const { repo, execucoes } = ambiente();
  const r = await chamar(ctx(repo), { action: "analise_executar", licitacao_id: 101, agentes: ["juridico"] });
  assertEquals(r.status, 200);
  assertEquals(execucoes.map((e) => e.agente), ["edital", "preco", "juridico"]);
  const juridico = execucoes.find((e) => e.agente === "juridico")!;
  assertEquals(juridico.achados.some((a) => a.dados.sinal_origem === "exigencia.amostra"), true);
  // com o edital já gravado, o jurídico de novo reaproveita tudo
  await chamar(ctx(repo), { action: "analise_executar", licitacao_id: 101, agentes: ["juridico"] });
  assertEquals(execucoes.length, 3);
});

Deno.test("CA-5: agente desconhecido, lista vazia ou preço sozinho dão 400", () => {
  for (const agentes of [["xyz"], [], ["preco"], "edital"]) {
    assertEquals("error" in parseActionFromBody({ action: "analise_executar", licitacao_id: 1, agentes }), true, JSON.stringify(agentes));
  }
  assertEquals(parseActionFromBody({ action: "analise_executar", licitacao_id: 1, agentes: ["juridico", "edital"] }), {
    action: "analise_executar", licitacao_id: 1, proposta: null, agentes: ["edital", "preco", "juridico"],
  });
});
