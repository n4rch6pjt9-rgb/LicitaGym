import { assertEquals, assertNotEquals } from "jsr:@std/assert@1";
import { hashContexto, normalizarTexto, validarAchado } from "../../../supabase/functions/_shared/agentes/achados.ts";
import type { Achado } from "../../../supabase/functions/_shared/agentes/tipos.ts";

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
