import { assertEquals } from "jsr:@std/assert@1";
import { clampConsultaPageSize, installFetch, jsonResponse, PncpConsultaClient } from "./_harness.ts";

Deno.test("A3 clampConsultaPageSize atasContratos", () => {
  assertEquals(clampConsultaPageSize("atasContratos"), 500);
  assertEquals(clampConsultaPageSize("atasContratos", 250), 250);
  assertEquals(clampConsultaPageSize("atasContratos", 500), 500);
  assertEquals(clampConsultaPageSize("atasContratos", 501), 500);
  assertEquals(clampConsultaPageSize("atasContratos", 1000), 500);
  assertEquals(clampConsultaPageSize("atasContratos", 0), 10);
});

Deno.test("A3 client sends clamped tamanhoPagina for atas and contratos", async () => {
  const mock = installFetch(() => jsonResponse(200, { data: [], paginasRestantes: 0 }));
  try {
    const client = new PncpConsultaClient("https://pncp.test/api/consulta/v1");
    await client.fetchAtas({
      dataInicial: "20260101",
      dataFinal: "20260102",
      pagina: 1,
      tamanhoPagina: 1000,
    });
    await client.fetchContratos({
      dataInicial: "20260101",
      dataFinal: "20260102",
      pagina: 1,
      tamanhoPagina: 1000,
    });
    assertEquals(new URL(mock.urls[0]).searchParams.get("tamanhoPagina"), "500");
    assertEquals(new URL(mock.urls[1]).searchParams.get("tamanhoPagina"), "500");
  } finally {
    mock.restore();
  }
});
