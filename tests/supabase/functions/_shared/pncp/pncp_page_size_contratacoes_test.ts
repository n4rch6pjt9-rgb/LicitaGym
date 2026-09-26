import { assertEquals } from "jsr:@std/assert@1";
import { clampConsultaPageSize, installFetch, jsonResponse, PncpConsultaClient } from "./_harness.ts";

const base = {
  dataInicial: "20260101",
  dataFinal: "20260102",
  codigoModalidadeContratacao: 6,
  pagina: 1,
};

Deno.test("A1 clampConsultaPageSize contratacoes", () => {
  assertEquals(clampConsultaPageSize("contratacoes"), 50);
  assertEquals(clampConsultaPageSize("contratacoes", 49), 49);
  assertEquals(clampConsultaPageSize("contratacoes", 50), 50);
  assertEquals(clampConsultaPageSize("contratacoes", 51), 50);
  assertEquals(clampConsultaPageSize("contratacoes", 100), 50);
  assertEquals(clampConsultaPageSize("contratacoes", 500), 50);
  assertEquals(clampConsultaPageSize("contratacoes", 0), 10);
  assertEquals(clampConsultaPageSize("contratacoes", -5), 10);
});

Deno.test("A1 client sends clamped tamanhoPagina for contratacoes", async () => {
  const mock = installFetch(() => jsonResponse(200, { data: [], paginasRestantes: 0 }));
  try {
    const client = new PncpConsultaClient("https://pncp.test/api/consulta/v1");
    await client.fetchContratacoesPublicacao({ ...base, tamanhoPagina: 500 });
    const url = new URL(mock.urls[0]);
    assertEquals(url.searchParams.get("tamanhoPagina"), "50");
    assertEquals(url.pathname.endsWith("/contratacoes/publicacao"), true);
  } finally {
    mock.restore();
  }
});
