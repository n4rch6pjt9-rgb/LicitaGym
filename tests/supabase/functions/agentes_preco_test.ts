import { assertEquals } from "jsr:@std/assert@1";
import { agentePreco, classificarExequibilidade as cx, pisoTenantCentavos, referenciaPraticada } from "../../../supabase/functions/_shared/agentes/preco.ts";
import { validarAchado } from "../../../supabase/functions/_shared/agentes/achados.ts";

const E = 1_000_000;

Deno.test("faixa: bens não usa o limite de 75% das obras", () => {
  assertEquals(cx(749_999, E, "bens_servicos_gerais"), "normal");
  assertEquals(cx(499_999, E, "bens_servicos_gerais"), "indicio_inexequibilidade");
  assertEquals(cx(500_000, E, "bens_servicos_gerais"), "normal");
});
Deno.test("faixa: obras e engenharia, limites de 75% e 85%", () => {
  assertEquals(cx(749_999, E, "obras_servicos_engenharia"), "inexequivel_presumida");
  assertEquals(cx(750_000, E, "obras_servicos_engenharia"), "garantia_adicional");
  assertEquals(cx(849_999, E, "obras_servicos_engenharia"), "garantia_adicional");
  assertEquals(cx(850_000, E, "obras_servicos_engenharia"), "normal");
});
Deno.test("faixa: acima do estimado e sem referência", () => {
  assertEquals(cx(1_000_001, E, "bens_servicos_gerais"), "acima_do_estimado");
  assertEquals(cx(1_000_000, E, "bens_servicos_gerais"), "normal");
  assertEquals(cx(500, null, "bens_servicos_gerais"), "sem_referencia");
  assertEquals(cx(500, 0, "bens_servicos_gerais"), "sem_referencia");
});

const am = (precos: number[], unidade = "UN") => precos.map((p, i) => ({ id_compra_item: `c${i}`, preco_centavos: p, unidade }));

Deno.test("referência: mediana ímpar, par e meio centavo para cima", () => {
  assertEquals(referenciaPraticada(am([1000, 100, 300, 200, 400]), "UN"), {
    situacao: "ok",
    n: 5,
    descartadas: 0,
    mediana_centavos: 300,
    min_centavos: 100,
    max_centavos: 1000,
  });
  assertEquals(referenciaPraticada(am([100, 200, 300, 400, 500, 600]), "UN").mediana_centavos, 350);
  assertEquals(referenciaPraticada(am([100, 200, 300, 301, 400, 500]), "UN").mediana_centavos, 301);
});
Deno.test("referência: menos de 5 amostras não devolve número", () =>
  assertEquals(referenciaPraticada(am([100, 200, 300, 400]), "UN"), {
    situacao: "amostra_insuficiente",
    n: 4,
    descartadas: 0,
    mediana_centavos: null,
    min_centavos: null,
    max_centavos: null,
  }));
Deno.test("referência: descarta unidade diferente e preço ≤ 0", () => {
  const r = referenciaPraticada([...am([100, 200, 300, 400, 500]), ...am([9000], "KIT"), ...am([0]), ...am([50], " un ")], "un");
  assertEquals([r.n, r.descartadas, r.mediana_centavos], [6, 2, 250]);
});

Deno.test("piso: tabela menos desconto máximo, meio centavo para cima", () => {
  assertEquals(pisoTenantCentavos(1_000_000, 12.5), 875_000);
  assertEquals(pisoTenantCentavos(999_999, 12.5), 874_999);
  assertEquals(pisoTenantCentavos(1_001, 50), 501);
});

const item = (n: number, extra = {}) => ({
  numero_item: n,
  unidade: "UN",
  estimado_centavos: E,
  amostras: [],
  piso_centavos: null as number | null,
  ...extra,
});

Deno.test("agentePreco: sem proposta", () =>
  assertEquals(agentePreco({ natureza: "bens_servicos_gerais", itens: [item(1)], proposta: null }).situacao, "sem_proposta"));

Deno.test("agentePreco: orçamento sigiloso não gera inexequibilidade", () => {
  const r = agentePreco({
    natureza: "bens_servicos_gerais",
    itens: [item(1, { estimado_centavos: null })],
    proposta: [{ numero_item: 1, preco_unitario_centavos: 1 }],
  });
  assertEquals(r.situacao, "sem_referencia");
  assertEquals(r.achados, []);
});

Deno.test("agentePreco: indício, custo zero e piso sem vazar valor", () => {
  const r = agentePreco({
    natureza: "bens_servicos_gerais",
    itens: [item(1, { piso_centavos: 600_000 })],
    proposta: [{ numero_item: 1, preco_unitario_centavos: 400_000, custo_zero: true }],
  });
  assertEquals(r.achados.map((a) => a.codigo), ["preco.indicio_inexequibilidade", "preco.custo_zero", "preco.abaixo_do_piso"]);
  assertEquals(r.achados.map((a) => a.natureza), ["analise", "fato", "analise"]);
  assertEquals(r.achados[1].fontes, [{ tipo: "cliente", campo: "proposta.custo_zero" }]);
  assertEquals(r.achados[2].dados, { numero_item: 1 });
  assertEquals(JSON.stringify(r).includes("600000"), false);
  assertEquals(r.achados[0].dados, { numero_item: 1, preco_centavos: 400_000, estimado_centavos: E, percentual_do_estimado: 40 });
  for (const a of r.achados) assertEquals(validarAchado(a), null);
});

Deno.test("agentePreco: item da proposta que não existe no edital é ignorado", () => {
  const r = agentePreco({
    natureza: "bens_servicos_gerais",
    itens: [item(1)],
    proposta: [{ numero_item: 7, preco_unitario_centavos: 1 }],
  });
  assertEquals(r.achados, []);
});
