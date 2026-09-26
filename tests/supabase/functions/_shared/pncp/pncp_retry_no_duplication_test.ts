import { assertEquals } from "jsr:@std/assert@1";
import { hashPayload, installFetch, PncpConsultaClient } from "./_harness.ts";

Deno.test("B4 same payload hashes equal across two calls", async () => {
  const payload = { data: [{ id: "p5" }], paginasRestantes: 1 };
  assertEquals(await hashPayload(payload), await hashPayload(payload));
});

Deno.test("B4 a retried page returns one body to the caller", async () => {
  let n = 0;
  const body = { data: [{ id: "once" }], paginasRestantes: 0 };
  const mock = installFetch(() => {
    n++;
    if (n === 1) return new Response("rate", { status: 429 });
    return new Response(JSON.stringify(body), {
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
    assertEquals(result.body, body);
    assertEquals(await hashPayload(result.body), await hashPayload(body));
    assertEquals(mock.urls.length, 2);
  } finally {
    mock.restore();
  }
});
