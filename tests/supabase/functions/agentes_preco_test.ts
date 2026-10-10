import { assertEquals } from "jsr:@std/assert@1";
import {
  agentePreco,
  classificarExequibilidade as cx,
  MOTIVO_SEM_UNIDADE,
  pisoTenantCentavos,
  referenciaPraticada,
} from "../../../supabase/functions/_shared/agentes/preco.ts";
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
    amostras: am([1000, 100, 300, 200, 400]),
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
    amostras: am([100, 200, 300, 400]),
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

Deno.test("faixa: natureza desconhecida não classifica exequibilidade, mas acima do estimado continua", () => {
  assertEquals(cx(1, E, null), "natureza_nao_verificada");
  assertEquals(cx(1_000_000, E, null), "natureza_nao_verificada");
  assertEquals(cx(1_000_001, E, null), "acima_do_estimado");
  assertEquals(cx(1, null, null), "sem_referencia");
});

Deno.test("agentePreco: natureza desconhecida avisa e não inventa faixa; os outros achados seguem", () => {
  const r = agentePreco({
    natureza: null,
    itens: [item(1, { piso_centavos: 600_000 }), item(2), item(3, { estimado_centavos: null })],
    proposta: [
      { numero_item: 1, preco_unitario_centavos: 400_000, custo_zero: true },
      { numero_item: 2, preco_unitario_centavos: 1_100_000 },
      { numero_item: 3, preco_unitario_centavos: 1 },
    ],
  });
  assertEquals(r.achados.map((a) => a.codigo), [
    "preco.custo_zero",
    "preco.abaixo_do_piso",
    "preco.acima_do_estimado",
    "preco.natureza_nao_verificada",
  ]);
  const aviso = r.achados[3];
  assertEquals(aviso.detalhe.startsWith("Natureza da contratação não verificada; exequibilidade não classificada."), true);
  assertEquals(aviso.dados, { itens_nao_classificados: [1] });
  assertEquals(r.situacao, "ok");
  for (const a of r.achados) assertEquals(validarAchado(a), null);
});

Deno.test("referência: item sem unidade não aceita amostra nenhuma", () => {
  const amostras = [...am([100, 200, 300, 400, 500]), ...am([900, 950, 990, 999, 1000], "KIT"), ...am([10, 20, 30, 40, 50], "CAIXA")];
  for (const unidade of [null, "", "   "]) {
    assertEquals(referenciaPraticada(amostras, unidade), {
      situacao: "referencia_ausente",
      motivo: MOTIVO_SEM_UNIDADE,
      n: 0,
      descartadas: 15,
      mediana_centavos: null,
      min_centavos: null,
      max_centavos: null,
      amostras: [],
    });
  }
  const r = agentePreco({
    natureza: "bens_servicos_gerais",
    itens: [item(1, { unidade: null, amostras })],
    proposta: [{ numero_item: 1, preco_unitario_centavos: 900_000 }],
  });
  assertEquals(r.achados.some((a) => a.codigo === "preco.referencia_praticada"), false);
});

Deno.test("agentePreco: a referência guarda todas as amostras do cálculo, sem cortar", () => {
  const amostras = [...am(Array.from({ length: 25 }, (_, i) => 1000 + i)), ...am([5], "KIT")];
  const r = agentePreco({
    natureza: "bens_servicos_gerais",
    itens: [item(1, { amostras })],
    proposta: [{ numero_item: 1, preco_unitario_centavos: 900_000 }],
  });
  const ref = r.achados.find((a) => a.codigo === "preco.referencia_praticada")!;
  assertEquals(ref.dados.n, 25);
  const guardadas = ref.dados.amostras as Array<{ id: string; preco_centavos: number; unidade: string }>;
  assertEquals(guardadas.length, 25);
  assertEquals(guardadas[24], { id: "c24", preco_centavos: 1024, unidade: "UN" });
  assertEquals(ref.fontes.length, 25);
  assertEquals(ref.fontes.map((f) => f.tipo === "registro" ? f.id : ""), guardadas.map((a) => a.id));
  assertEquals(validarAchado(ref), null);
});
