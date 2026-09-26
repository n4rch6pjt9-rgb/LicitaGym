import { assertEquals } from "jsr:@std/assert@1";
import { clampConsultaPageSize, installFetch, jsonResponse, PncpConsultaClient } from "./_harness.ts";

Deno.test("A2 clampConsultaPageSize instrumentosCobranca", () => {
  assertEquals(clampConsultaPageSize("instrumentosCobranca"), 100);
  assertEquals(clampConsultaPageSize("instrumentosCobranca", 100), 100);
  assertEquals(clampConsultaPageSize("instrumentosCobranca", 101), 100);
  assertEquals(clampConsultaPageSize("instrumentosCobranca", 200), 100);
  assertEquals(clampConsultaPageSize("instrumentosCobranca", 500), 100);
  assertEquals(clampConsultaPageSize("instrumentosCobranca", 0), 10);
});

Deno.test("A2 client sends clamped tamanhoPagina for instrumentos", async () => {
  const mock = installFetch(() => jsonResponse(200, { data: [], paginasRestantes: 0 }));
  try {
    const client = new PncpConsultaClient("https://pncp.test/api/consulta/v1");
    await client.fetchInstrumentosCobrancaInclusao({
      dataInicial: "20260101",
      dataFinal: "20260102",
      pagina: 1,
      tamanhoPagina: 500,
    });
    const url = new URL(mock.urls[0]);
    assertEquals(url.searchParams.get("tamanhoPagina"), "100");
  } finally {
    mock.restore();
  }
});
