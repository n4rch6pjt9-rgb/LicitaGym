import { assertEquals } from "jsr:@std/assert@1";
import { installFetch, jsonResponse, PncpConsultaClient, PncpSearchClient } from "./_harness.ts";

Deno.test("A5 consulta uses tamanhoPagina and search uses tam_pagina", async () => {
  const mock = installFetch((url) => {
    if (url.includes("/api/search")) {
      return jsonResponse(200, { items: [], total: 0 });
    }
    return jsonResponse(200, { data: [], paginasRestantes: 0 });
  });
  try {
    const consulta = new PncpConsultaClient("https://pncp.test/api/consulta/v1");
    await consulta.fetchContratacoesPublicacao({
      dataInicial: "20260101",
      dataFinal: "20260102",
      codigoModalidadeContratacao: 6,
      pagina: 1,
      tamanhoPagina: 50,
    });
    const search = new PncpSearchClient("https://pncp.test/api/search");
    await search.fetchPcaOrgaoPage({ pagina: 1, tamPagina: 20, ano: 2026 });

    const consultaUrl = new URL(mock.urls[0]);
    const searchUrl = new URL(mock.urls[1]);
    assertEquals(consultaUrl.searchParams.has("tamanhoPagina"), true);
    assertEquals(consultaUrl.searchParams.has("tam_pagina"), false);
    assertEquals(searchUrl.searchParams.get("tam_pagina"), "20");
    assertEquals(searchUrl.searchParams.has("tamanhoPagina"), false);
  } finally {
    mock.restore();
  }
});
