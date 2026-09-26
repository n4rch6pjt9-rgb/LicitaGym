import { assertEquals } from "jsr:@std/assert@1";
import { installFetch, jsonResponse, PncpConsultaClient } from "./_harness.ts";

Deno.test("B1 client walks pages until paginasRestantes is 0", async () => {
  const bodies = [
    { data: [{ id: 1 }], paginasRestantes: 2, totalRegistros: 3 },
    { data: [{ id: 2 }], paginasRestantes: 1, totalRegistros: 3 },
    { data: [], paginasRestantes: 0, totalRegistros: 3 },
  ];
  let i = 0;
  const mock = installFetch(() => jsonResponse(200, bodies[i++] ?? { data: [], paginasRestantes: 0 }));
  try {
    const client = new PncpConsultaClient("https://pncp.test/api/consulta/v1");
    const fetched: number[] = [];
    let pagina = 1;
    let paginasRestantes = 1;
    while (paginasRestantes > 0 && pagina <= 200) {
      fetched.push(pagina);
      const result = await client.fetchContratacoesPublicacao({
        dataInicial: "20260101",
        dataFinal: "20260102",
        codigoModalidadeContratacao: 6,
        pagina,
        tamanhoPagina: 50,
      });
      const pagination = client.extractPagination(result.body, pagina);
      paginasRestantes = pagination.paginasRestantes;
      if (paginasRestantes <= 0) break;
      pagina++;
    }
    assertEquals(fetched, [1, 2, 3]);
    assertEquals(mock.urls.length, 3);
    assertEquals(new URL(mock.urls[2]).searchParams.get("pagina"), "3");
  } finally {
    mock.restore();
  }
});

Deno.test("B1 missing paginasRestantes is treated as 0 by extractPagination", () => {
  const client = new PncpConsultaClient("https://pncp.test/api/consulta/v1");
  assertEquals(client.extractPagination({ data: [{ id: 1 }] }, 4).paginasRestantes, 0);
  assertEquals(client.extractPagination({ resultado: [], paginasRestantes: 1 }, 2).paginasRestantes, 1);
});
