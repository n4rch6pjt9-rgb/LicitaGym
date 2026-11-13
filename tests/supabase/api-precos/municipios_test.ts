// Spec 0031, fase A (Proposta 7): action=municipios da api-precos (lista do filtro Cidade, vinda do recorte).
import { assertEquals } from "jsr:@std/assert@1";
import { chamar } from "./_fake.ts";

Deno.test("municipios: lista do recorte com UF e n, sem o filtro de cidade e com os outros filtros", async () => {
  const { res, body, rpcs } = await chamar("action=municipios&pdm=9634&meses=24&uf=pa&q=mesa", {
    municipios: [{ uf: "PA", municipio: "BELÉM", n: 2 }, { uf: "PA", municipio: "SANTARÉM", n: 1 }],
  });
  assertEquals(res.status, 200);
  assertEquals(body.municipios, [{ uf: "PA", municipio: "BELÉM", n: 2 }, { uf: "PA", municipio: "SANTARÉM", n: 1 }]);
  assertEquals(body.total, 2);
  const r = rpcs.find((c) => c.funcao === "precos_praticados_municipios");
  assertEquals([r?.args.p_uf, r?.args.p_q, r?.args.p_inicio], ["PA", "mesa", "2024-10-22"]);
  assertEquals("p_municipio" in (r?.args ?? {}), false);
});

Deno.test("municipios: cidade sem UF ou sem contagem é 500 (não verificado), nunca lista vazia", async () => {
  const { res, body } = await chamar("action=municipios&pdm=9634", { municipios: [{ uf: null, municipio: "X", n: 1 }] });
  assertEquals(res.status, 500);
  assertEquals(body.municipios, undefined);
});
