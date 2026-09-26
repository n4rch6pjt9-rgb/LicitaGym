import { assertEquals, assertRejects } from "jsr:@std/assert@1";
import { installFetch, PncpConsultaClient } from "./_harness.ts";

Deno.test("B3b HTTP 500 is retried 3 times on the same pagina then throws", async () => {
  const mock = installFetch(() => new Response("boom", { status: 500 }));
  const retryDelays: number[] = [];
  try {
    const client = new PncpConsultaClient(
      "https://pncp.test/api/consulta/v1",
      {
        sleep: async (ms: number) => {
          retryDelays.push(ms);
        },
        random: () => 0,
      },
    );
    await assertRejects(
      () =>
        client.fetchAtas({
          dataInicial: "20260101",
          dataFinal: "20260102",
          pagina: 5,
        }),
      Error,
      "PNCP consulta HTTP 500",
    );
    assertEquals(mock.urls.length, 3);
    for (const url of mock.urls) {
      assertEquals(new URL(url).searchParams.get("pagina"), "5");
    }
    assertEquals(retryDelays.length, 2);
    assertEquals(retryDelays[0], 1000);
    assertEquals(retryDelays[1], 2000);
  } finally {
    mock.restore();
  }
});

Deno.test("B3b HTTP 503 success on second attempt returns that body", async () => {
  let n = 0;
  const mock = installFetch(() => {
    n++;
    if (n === 1) return new Response("unavailable", { status: 503 });
    return new Response(JSON.stringify({ data: [{ id: 1 }], paginasRestantes: 0 }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
  const retryDelays: number[] = [];
  try {
    const client = new PncpConsultaClient(
      "https://pncp.test/api/consulta/v1",
      {
        sleep: async (ms: number) => {
          retryDelays.push(ms);
        },
        random: () => 0,
      },
    );
    const result = await client.fetchContratos({
      dataInicial: "20260101",
      dataFinal: "20260102",
      pagina: 5,
    });
    assertEquals(result.status, 200);
    assertEquals(mock.urls.length, 2);
    assertEquals(client.extractList(result.body), [{ id: 1 }]);
    assertEquals(retryDelays.length, 1);
    assertEquals(retryDelays[0], 1000);
  } finally {
    mock.restore();
  }
});
