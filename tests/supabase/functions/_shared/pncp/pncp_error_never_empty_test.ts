import { assertEquals, assertRejects } from "jsr:@std/assert@1";
import { installFetch, jsonResponse, PermanentHttpError, PncpConsultaClient } from "./_harness.ts";

const params = {
  dataInicial: "20260101",
  dataFinal: "20260102",
  codigoModalidadeContratacao: 6,
  pagina: 1,
};

Deno.test("C1 HTTP 500 throws and does not become an empty list", async () => {
  const mock = installFetch(() => new Response("nope", { status: 500 }));
  try {
    const client = new PncpConsultaClient("https://pncp.test/api/consulta/v1");
    await assertRejects(() => client.fetchContratacoesPublicacao(params), Error, "PNCP consulta HTTP 500");
  } finally {
    mock.restore();
  }
});

Deno.test("C1 HTTP 429 throws after retries and does not become []", async () => {
  const mock = installFetch(() => new Response("rate", { status: 429 }));
  try {
    const client = new PncpConsultaClient("https://pncp.test/api/consulta/v1");
    await assertRejects(() => client.fetchContratacoesPublicacao(params), Error, "PNCP consulta HTTP 429");
    assertEquals(mock.urls.length, 3);
  } finally {
    mock.restore();
  }
});

Deno.test("C1 HTTP 200 empty list is distinct from HTTP 500", async () => {
  const mock = installFetch(() => jsonResponse(200, { resultado: [] }));
  try {
    const client = new PncpConsultaClient("https://pncp.test/api/consulta/v1");
    const result = await client.fetchContratacoesPublicacao(params);
    assertEquals(result.status, 200);
    assertEquals(client.extractList(result.body), []);
  } finally {
    mock.restore();
  }
});

Deno.test("C1 HTTP 400 throws once and is not retried", async () => {
  const mock = installFetch(() => jsonResponse(400, { message: "bad" }));
  try {
    const client = new PncpConsultaClient("https://pncp.test/api/consulta/v1");
    await assertRejects(
      () => client.fetchContratacoesPublicacao(params),
      PermanentHttpError,
      "PNCP consulta HTTP 400",
    );
    assertEquals(mock.urls.length, 1);
  } finally {
    mock.restore();
  }
});

Deno.test("C1 connection error is retried and does not become []", async () => {
  const mock = installFetch(() => {
    throw new TypeError("connection reset");
  });
  try {
    const client = new PncpConsultaClient("https://pncp.test/api/consulta/v1");
    await assertRejects(
      () => client.fetchContratacoesPublicacao(params),
      TypeError,
      "connection reset",
    );
    assertEquals(mock.urls.length, 3);
  } finally {
    mock.restore();
  }
});
