import { assertEquals, assertRejects } from "jsr:@std/assert@1";
import { installFetch, PncpConsultaClient } from "./_harness.ts";

function timeoutError(): DOMException {
  return new DOMException("The operation was aborted due to timeout", "TimeoutError");
}

Deno.test("B3c timeout is retried and surfaces PNCP consulta timeout (45000ms)", async () => {
  const mock = installFetch(() => {
    throw timeoutError();
  });
  try {
    const client = new PncpConsultaClient("https://pncp.test/api/consulta/v1");
    await assertRejects(
      () =>
        client.fetchContratacoesPublicacao({
          dataInicial: "20260101",
          dataFinal: "20260102",
          codigoModalidadeContratacao: 6,
          pagina: 5,
        }),
      Error,
      "PNCP consulta timeout (45000ms)",
    );
    // maxTimeoutRetries = 1: one retry only, keeps the call inside the Edge budget.
    assertEquals(mock.urls.length, 2);
  } finally {
    mock.restore();
  }
});

Deno.test("B3c timeout then success returns the successful body", async () => {
  let n = 0;
  const mock = installFetch(() => {
    n++;
    if (n === 1) throw timeoutError();
    return new Response(JSON.stringify({ data: [{ id: "after-timeout" }], paginasRestantes: 0 }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
  try {
    const client = new PncpConsultaClient("https://pncp.test/api/consulta/v1");
    const result = await client.fetchContratacoesPublicacao({
      dataInicial: "20260101",
      dataFinal: "20260102",
      codigoModalidadeContratacao: 6,
      pagina: 5,
    });
    assertEquals(result.status, 200);
    assertEquals(client.extractList(result.body), [{ id: "after-timeout" }]);
    assertEquals(new URL(mock.urls[0]).searchParams.get("pagina"), "5");
    assertEquals(new URL(mock.urls[1]).searchParams.get("pagina"), "5");
  } finally {
    mock.restore();
  }
});
