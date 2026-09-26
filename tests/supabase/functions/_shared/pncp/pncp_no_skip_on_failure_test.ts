import { assertEquals, assertRejects } from "jsr:@std/assert@1";
import { installFetch, PncpConsultaClient, readSync } from "./_harness.ts";

Deno.test("C2 failed getJson does not issue a later pagina", async () => {
  const mock = installFetch(() => new Response("rate", { status: 429 }));
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
      "PNCP consulta HTTP 429",
    );
    assertEquals(mock.urls.length, 3);
    for (const url of mock.urls) {
      assertEquals(new URL(url).searchParams.get("pagina"), "5");
    }
  } finally {
    mock.restore();
  }
});

Deno.test("C2 editais keeps the failed slice via PageFetchError instead of skipping it", async () => {
  const src = await readSync("sync-pncp-contratacoes-editais/index.ts");
  assertEquals(src.includes("runCappedDateSync"), true);
  assertEquals(src.includes("error instanceof PageFetchError"), true);
  const catchAt = src.indexOf("} catch (error) {");
  assertEquals(catchAt > 0, true);
  assertEquals(src.slice(catchAt).includes('"incompleta"'), true);
  assertEquals(src.slice(catchAt).includes('"falhou"'), true);
});
