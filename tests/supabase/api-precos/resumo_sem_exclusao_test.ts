// Spec 0031, fase A: CA-9 e KPIs da api-precos (action=resumo).
import { assertEquals } from "jsr:@std/assert@1";
import { chamar } from "./_fake.ts";

function resumo(p: Record<string, unknown> = {}) {
  return {
    n: 5, media: 9342.88, preco_min: 2000, p25: 2100, mediana: 2229, p75: 3500, preco_max: 37293.4, motivo: null,
    unidade_sigla: "UN", unidade_nome: "UNIDADE", unidade_n: 5, unidades: [{ sigla: "UN", nome: "UNIDADE", n: 5 }],
    ultima_data_resultado: "2026-08-06", atualizado_em: "2026-10-03T02:09:15+00:00",
    item_mais_codigo: 602701, item_mais_descricao: "MESA TÊNIS DE MESA", item_mais_n: 234,
    n_com_estimado: 4, diferenca_mediana_percentual: -16.25,
    ...p,
  };
}

Deno.test("CA-9: o resumo não tem parâmetro de exclusão automática e devolve o máximo como veio", async () => {
  const { body, rpcs } = await chamar("action=resumo&pdm=9634&item=602701", { resumo: [resumo()] });
  const r = rpcs.find((c) => c.funcao === "precos_praticados_resumo");
  assertEquals(Object.keys(r?.args ?? {}).sort(), [
    "p_fim", "p_inicio", "p_item", "p_municipio", "p_objeto", "p_pdm", "p_q", "p_uasg", "p_uf", "p_unidade",
  ]);
  assertEquals(body.max, 37293.4);
  assertEquals(body.n, 5);
});

Deno.test("KPIs: item com mais amostras e desconto mediano com o n de linhas com estimado", async () => {
  const { body } = await chamar("action=resumo&pdm=9634", { resumo: [resumo()] });
  assertEquals(body.item_mais_amostras, { codigo_item_catalogo: 602701, descricao: "MESA TÊNIS DE MESA", n: 234 });
  assertEquals(body.n_com_estimado, 4);
  assertEquals(body.diferenca_mediana_percentual, -16.25);

  const pouco = await chamar("action=resumo&pdm=9634", {
    resumo: [resumo({ n_com_estimado: 2, diferenca_mediana_percentual: -10, item_mais_n: 0 })],
  });
  assertEquals(pouco.body.diferenca_mediana_percentual, null);
  assertEquals(pouco.body.item_mais_amostras, null);
});
