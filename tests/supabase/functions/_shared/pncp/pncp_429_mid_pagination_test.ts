import { assertEquals, assertRejects, assertStringIncludes } from "jsr:@std/assert@1";
import { installFetch, PncpConsultaClient } from "./_harness.ts";

const params = {
  dataInicial: "20260101",
  dataFinal: "20260102",
  codigoModalidadeContratacao: 6,
  pagina: 5,
  tamanhoPagina: 50,
};

Deno.test("B3a 429 is retried on the same pagina and then throws", async () => {
  const mock = installFetch(() => new Response("rate", { status: 429, headers: { "Retry-After": "0" } }));
  try {
    const client = new PncpConsultaClient("https://pncp.test/api/consulta/v1");
    const error = await assertRejects(
      () => client.fetchContratacoesPublicacao(params),
      Error,
      "PNCP consulta HTTP 429",
    );
    assertStringIncludes(error.message, "429");
    assertEquals(mock.urls.length, 3);
    for (const url of mock.urls) {
      assertEquals(new URL(url).searchParams.get("pagina"), "5");
    }
  } finally {
    mock.restore();
  }
});

Deno.test("B3a retry success stays on the requested pagina", async () => {
  let n = 0;
  const mock = installFetch(() => {
    n++;
    if (n === 1) return new Response("rate", { status: 429 });
    return new Response(JSON.stringify({ data: [{ id: "p5" }], paginasRestantes: 1 }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
  try {
    const client = new PncpConsultaClient("https://pncp.test/api/consulta/v1");
    const result = await client.fetchContratacoesPublicacao(params);
    assertEquals(result.status, 200);
    assertEquals(mock.urls.length, 2);
    assertEquals(new URL(mock.urls[0]).searchParams.get("pagina"), "5");
    assertEquals(new URL(mock.urls[1]).searchParams.get("pagina"), "5");
    assertEquals(client.extractList(result.body), [{ id: "p5" }]);
  } finally {
    mock.restore();
  }
});
