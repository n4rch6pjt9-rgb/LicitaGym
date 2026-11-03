// Spec 0031, fase A: CA-8 da api-precos (action=itens, dropdown da /precos).
import { assertEquals } from "jsr:@std/assert@1";
import { chamar } from "./_fake.ts";

Deno.test("CA-8: itens do PDM 9634 só com n > 0, por n desc, sem o filtro de item", async () => {
  const { res, body, rpcs } = await chamar("action=itens&pdm=9634&meses=24&item=602701&uf=PA", {
    itens: [
      { codigo_item_catalogo: 471988, descricao: "MESA TÊNIS DE MESA / FUTMESA, MATERIAL TAMPO: MDF", n: 146 },
      { codigo_item_catalogo: 67288, descricao: "MESA TÊNIS DE MESA", n: 0 },
      { codigo_item_catalogo: 602701, descricao: "MESA TÊNIS DE MESA / FUTMESA, ESPESSURA TAMPO: 18 MM", n: 234 },
    ],
  });
  assertEquals(res.status, 200);
  assertEquals(body.itens.map((i: { codigo_item_catalogo: number; n: number }) => [i.codigo_item_catalogo, i.n]), [
    [602701, 234],
    [471988, 146],
  ]);
  assertEquals(body.total, 2);
  const r = rpcs.find((c) => c.funcao === "precos_praticados_itens_pdm");
  assertEquals(r?.args.p_item, undefined); // a lista é para escolher o item
  assertEquals(r?.args.p_uf, "PA");
});

Deno.test("CA-8: item sem código ou contagem é 500 (não verificado), nunca lista vazia", async () => {
  const { res, body } = await chamar("action=itens&pdm=9634", { itens: [{ codigo_item_catalogo: null, n: 3 }] });
  assertEquals(res.status, 500);
  assertEquals(body.itens, undefined);
});
