// Spec 0031, fase A: CA-7, CA-7b e CA-7c da api-precos (filtros novos vão para as funções do banco).
import { assert, assertEquals } from "jsr:@std/assert@1";
import { chamar } from "./_fake.ts";

const ARGS_VAZIOS = { p_municipio: null, p_uasg: null, p_objeto: null, p_q: null };

Deno.test("CA-7: uasg (código ou texto) vai para a amostra e para o resumo", async () => {
  for (const action of ["amostras", "resumo"]) {
    for (const uasg of ["160218", "belem"]) {
      const { res, rpcs } = await chamar(`action=${action}&pdm=9634&meses=24&uasg=${uasg}`, {
        resumo: [{ n: 0, unidades: [] }],
      });
      assertEquals(res.status, 200, `${action} ${uasg}`);
      const r = rpcs.find((c) => c.funcao.startsWith("precos_praticados_"));
      assertEquals(r?.args.p_uasg, uasg);
      assertEquals(r?.args.p_inicio, "2024-10-22");
    }
  }
});

Deno.test("CA-7b: uf e municipio vão juntos; municipio sem uf é 400 sem ler o banco", async () => {
  const ok = await chamar("action=amostras&pdm=9634&uf=pa&municipio=BEL%C3%89M");
  assertEquals(ok.res.status, 200);
  const r = ok.rpcs.find((c) => c.funcao === "precos_praticados_amostras");
  assertEquals([r?.args.p_uf, r?.args.p_municipio], ["PA", "BELÉM"]);
  assertEquals(ok.body.filtro.municipio, "BELÉM");

  const sem = await chamar("action=amostras&pdm=9634&municipio=BELEM");
  assertEquals(sem.res.status, 400);
  assertEquals(sem.clientes, 0);
});

Deno.test("CA-7c: busca livre e objeto vão com espaços normalizados; texto longo é 400", async () => {
  const { rpcs, body } = await chamar("action=amostras&pdm=9634&q=%20klopf%20%20mesa%20&objeto=esportivo");
  const r = rpcs.find((c) => c.funcao === "precos_praticados_amostras");
  assertEquals([r?.args.p_q, r?.args.p_objeto], ["klopf mesa", "esportivo"]);
  assertEquals([body.filtro.q, body.filtro.objeto], ["klopf mesa", "esportivo"]);

  for (const qs of [`q=${"a".repeat(121)}`, "uasg=%01x"]) {
    const { res, clientes } = await chamar(`action=amostras&pdm=9634&${qs}`);
    assertEquals(res.status, 400, qs);
    assertEquals(clientes, 0, qs);
  }
});

Deno.test("CA-7: sem filtro novo, os parâmetros vão null (contrato aditivo)", async () => {
  const { rpcs } = await chamar("action=amostras&pdm=9634");
  const r = rpcs.find((c) => c.funcao === "precos_praticados_amostras");
  for (const [k, v] of Object.entries(ARGS_VAZIOS)) assertEquals(r?.args[k], v, k);
  assert(r?.args.p_offset === 0 && r?.args.p_limit === 20);
});
