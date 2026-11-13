import { assertEquals } from "jsr:@std/assert@1";
import {
  baselineFrequencia,
  estadoDoPlano,
  fusao,
  notaMaterialidade,
  rotuloHorizonte,
} from "../../../supabase/functions/_shared/motor-oportunidade.ts";

Deno.test("materialidade não usa orçamento total e não transforma ausência em zero", () => {
  assertEquals(notaMaterialidade(100, null).status, "not_observed");
  assertEquals(estadoDoPlano(null), "not_observed");
  assertEquals(estadoDoPlano(false), "not_observed");
  const nota = notaMaterialidade(25, 100);
  assertEquals(nota.status, "nota");
  if (nota.status === "nota") {
    assertEquals(nota.nota, 3);
    assertEquals(nota.denominador, "equipamento_permanente");
  }
});

Deno.test("Y_90 só conta edital da mesma regional e família depois do corte", () => {
  const corte = {
    entidade: "sesc",
    regional: "SP",
    produto: "esteira",
    cutoff: "2024-01-01",
  };
  const eventos = [
    { entidade: "sesc", regional: "SP", produto: "esteira", publicadoEm: "2024-02-01" },
    { entidade: "sesc", regional: "BA", produto: "esteira", publicadoEm: "2024-02-01" },
    { entidade: "sesc", regional: "SP", produto: "esteira", publicadoEm: "2024-06-01" },
  ];
  assertEquals(rotuloHorizonte(corte, eventos, 90), 1);
  assertEquals(rotuloHorizonte(corte, eventos, 20), 0);
});

Deno.test("baseline sem amostra se abstém e a fusão não vira percentual", () => {
  assertEquals(baselineFrequencia({ positivos: 0, total: 0 }).sinal, "abstencao");
  assertEquals(baselineFrequencia({ positivos: 8, total: 10 }).sinal, "forte");
  assertEquals(
    fusao([
      { nome: "recorrencia", sinal: "forte" },
      { nome: "plano", sinal: "abstencao" },
    ]),
    "abstencao",
  );
});
