import { assertEquals, assertRejects } from "jsr:@std/assert@1";
import { installFetch, jsonResponse, PermanentHttpError, PncpConsultaClient } from "./_harness.ts";

Deno.test("B2 HTTP 200 resultado [] is not an exception", async () => {
  const mock = installFetch(() => jsonResponse(200, { resultado: [], paginasRestantes: 0 }));
  try {
    const client = new PncpConsultaClient("https://pncp.test/api/consulta/v1");
    const result = await client.fetchContratacoesPublicacao({
      dataInicial: "20260101",
      dataFinal: "20260102",
      codigoModalidadeContratacao: 6,
      pagina: 1,
    });
    assertEquals(result.status, 200);
    assertEquals(client.extractList(result.body), []);
    assertEquals(client.extractPagination(result.body, 1).paginasRestantes, 0);
  } finally {
    mock.restore();
  }
});

Deno.test("B2 HTTP 200 data [] is an empty list", async () => {
  const mock = installFetch(() => jsonResponse(200, { data: [] }));
  try {
    const client = new PncpConsultaClient("https://pncp.test/api/consulta/v1");
    const result = await client.fetchAtas({
      dataInicial: "20260101",
      dataFinal: "20260102",
      pagina: 1,
    });
    assertEquals(client.extractList(result.body), []);
    assertEquals(client.extractPagination(result.body, 1).paginasRestantes, 0);
  } finally {
    mock.restore();
  }
});

Deno.test("B2 empty body on 200 is an anomaly, not an empty list", async () => {
  const mock = installFetch(() => new Response("", { status: 200 }));
  try {
    const client = new PncpConsultaClient("https://pncp.test/api/consulta/v1");
    await assertRejects(
      () =>
        client.fetchContratos({
          dataInicial: "20260101",
          dataFinal: "20260102",
          pagina: 1,
        }),
      PermanentHttpError,
      "empty body anomaly",
    );
    assertEquals(mock.urls.length, 2);
  } finally {
    mock.restore();
  }
});
