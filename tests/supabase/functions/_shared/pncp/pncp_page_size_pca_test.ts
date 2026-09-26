import { assertEquals } from "jsr:@std/assert@1";
import { clampConsultaPageSize, installFetch, jsonResponse, PncpConsultaClient } from "./_harness.ts";

Deno.test("A4 clampConsultaPageSize pca", () => {
  assertEquals(clampConsultaPageSize("pca"), 500);
  assertEquals(clampConsultaPageSize("pca", undefined), 500);
  assertEquals(clampConsultaPageSize("pca", 500), 500);
  assertEquals(clampConsultaPageSize("pca", 501), 500);
  assertEquals(clampConsultaPageSize("pca", 5), 20);
  assertEquals(clampConsultaPageSize("pca", 0), 20);
});

Deno.test("A4 probePcaClassificacao forces tamanhoPagina 20", async () => {
  const mock = installFetch(() =>
    jsonResponse(200, { data: [], paginasRestantes: 0, totalRegistros: 0 })
  );
  try {
    const client = new PncpConsultaClient("https://pncp.test/api/consulta/v1");
    await client.probePcaClassificacao(2026, "7830");
    const url = new URL(mock.urls[0]);
    assertEquals(url.searchParams.get("tamanhoPagina"), "20");
    assertEquals(url.searchParams.get("pagina"), "1");
    assertEquals(url.searchParams.get("codigoClassificacaoSuperior"), "7830");
  } finally {
    mock.restore();
  }
});
