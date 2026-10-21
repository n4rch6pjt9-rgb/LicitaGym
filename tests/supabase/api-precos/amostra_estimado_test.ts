// Spec 0031, fase A: CA-6, CA-6b e CA-9c da api-precos (action=amostras).
import { assertEquals } from "jsr:@std/assert@1";
import { arred2, linkPncp, linkPortalOficial } from "../../../supabase/functions/api-precos/precos.ts";
import { amostraBelem, chamar } from "./_fake.ts";

Deno.test("CA-6: estimado 80800 e homologado 52000 dão diferença −28800 e −35,64%, com os dois links", async () => {
  const linha = amostraBelem({
    id_compra: "93099205000052026",
    numero_item_compra: 11,
    preco_unitario: 52000,
    valor_unitario_estimado: 80800,
    numero_controle_pncp: "44678797000156-1-000004/2026",
    link_sistema_origem: null,
  });
  const { res, body } = await chamar("action=amostras&pdm=9634", { amostras: [linha] });
  assertEquals(res.status, 200);
  const i = body.itens[0];
  assertEquals(i.valor_estimado, 80800);
  assertEquals(i.valor_homologado, 52000);
  assertEquals(i.diferenca_valor, -28800);
  assertEquals(i.diferenca_percentual, -35.64);
  assertEquals(i.link_pncp, "https://pncp.gov.br/app/editais/44678797000156/2026/4");
  assertEquals(
    i.link_portal_oficial,
    "https://cnetmobile.estaleiro.serpro.gov.br/comprasnet-web/public/compras/acompanhamento-compra?compra=93099205000052026",
  );
  assertEquals(i.motivo_sem_estimado, null);
});

Deno.test("CA-6: caso de Belém −29,39%; sem estimado as três colunas vêm null com motivo", async () => {
  const { body } = await chamar("action=amostras&pdm=9634", {
    amostras: [
      amostraBelem(),
      amostraBelem({ numero_item_compra: 65, valor_unitario_estimado: null }),
      amostraBelem({ id_compra: "15316705900112026", compra_consultada: false, compra_encontrada: null,
        numero_controle_pncp: null, link_sistema_origem: null, valor_unitario_estimado: null }),
      amostraBelem({ id_compra: "15316705900112021", compra_consultada: true, compra_encontrada: false,
        numero_controle_pncp: null, link_sistema_origem: null, valor_unitario_estimado: null }),
    ],
  });
  const [ok, semEst, naoConsultada, naoEncontrada] = body.itens;
  assertEquals(ok.diferenca_percentual, -29.39);
  assertEquals(ok.diferenca_valor, -927.67);
  for (const i of [semEst, naoConsultada, naoEncontrada]) {
    assertEquals([i.valor_estimado, i.diferenca_valor, i.diferenca_percentual], [null, null, null]);
    assertEquals(typeof i.motivo_sem_estimado, "string");
  }
  assertEquals(semEst.link_pncp, "https://pncp.gov.br/app/editais/00394452000103/2026/10524");
  // compra não encontrada: estimado que tenha sobrado no item não vale
  const sobra = await chamar("action=amostras&pdm=9634", {
    amostras: [amostraBelem({ compra_encontrada: false, valor_unitario_estimado: 3156.67 })],
  });
  assertEquals([sobra.body.itens[0].valor_estimado, sobra.body.itens[0].diferenca_percentual], [null, null]);
  // compra não consultada ou fora do PNCP: sem links (não inventa)
  for (const i of [naoConsultada, naoEncontrada]) {
    assertEquals([i.link_pncp, i.link_portal_oficial, i.link_portal_oficial_origem], [null, null, null]);
  }
});

Deno.test("CA-6b: link do portal é o do PNCP quando existe; sem ele, montado do id_compra", async () => {
  const { body } = await chamar("action=amostras&pdm=9634", {
    amostras: [amostraBelem(), amostraBelem({ id_compra: "98756505900352026", link_sistema_origem: null })],
  });
  assertEquals(body.itens[0].link_portal_oficial_origem, "pncp");
  assertEquals(body.itens[0].link_portal_oficial, amostraBelem().link_sistema_origem);
  assertEquals(body.itens[1].link_portal_oficial_origem, "montado");
  assertEquals(
    body.itens[1].link_portal_oficial,
    "https://cnetmobile.estaleiro.serpro.gov.br/comprasnet-web/public/compras/acompanhamento-compra?compra=98756505900352026",
  );
  // link do PNCP só https; id_compra fora do formato não monta link
  assertEquals(linkPortalOficial("http://x", "ZZTESTE"), { link: null, origem: null });
  assertEquals(linkPncp("00394452000103-1-010524"), null);
});

Deno.test("CA-9c: esfera e poder com código e rótulo; campos já gravados chegam à amostra", async () => {
  const { body } = await chamar("action=amostras&pdm=9634", {
    amostras: [amostraBelem({ esfera: "M", poder: "E" }), amostraBelem({ esfera: null, poder: "X" })],
  });
  const [a, b] = body.itens;
  assertEquals([a.esfera, a.esfera_codigo, a.poder, a.poder_codigo], ["Municipal", "M", "Executivo", "E"]);
  assertEquals([b.esfera, b.esfera_codigo, b.poder, b.poder_codigo], [null, null, null, "X"]);
  assertEquals([a.modalidade, a.forma, a.criterio_julgamento, a.percentual_maior_desconto], [5, "SISRP", "V", 0]);
  assertEquals(a.municipio, "BELÉM");
});

Deno.test("arredondamento de 2 casas meio para longe do zero, como o banco", () => {
  assertEquals(arred2(1.005), 1.01);
  assertEquals(arred2(-1.005), -1.01);
  assertEquals(arred2(-35.64356435), -35.64);
  assertEquals(arred2(-0.001), 0);
});
