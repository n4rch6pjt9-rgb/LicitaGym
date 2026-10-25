import { assertEquals, assertRejects } from "jsr:@std/assert";
import {
  consultarChatSerpro,
  consultarDiligenciasSerpro,
  invalidarTokenCache,
  obterTokenSerpro,
} from "./serpro.ts";

Deno.test("Serpro Client - falha se credenciais não forem fornecidas", async () => {
  invalidarTokenCache();
  await assertRejects(
    async () => {
      await obterTokenSerpro("", "");
    },
    Error,
    "Credenciais do Integra Compras Serpro não configuradas"
  );
});

Deno.test("Serpro Client - obtém e armazena token em cache com sucesso", async () => {
  invalidarTokenCache();
  const fetchOriginal = globalThis.fetch;

  let chamadasToken = 0;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const urlStr = String(input);
    if (urlStr.endsWith("/token")) {
      chamadasToken++;
      return Promise.resolve(
        new Response(
          JSON.stringify({
            access_token: "mock-token-jwt-12345",
            token_type: "Bearer",
            expires_in: 3600,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
      );
    }
    return fetchOriginal(input, init);
  }) as typeof fetch;

  try {
    const token1 = await obterTokenSerpro("mock_key", "mock_secret");
    assertEquals(token1, "mock-token-jwt-12345");
    assertEquals(chamadasToken, 1);

    // Segunda chamada deve usar o cache sem fazer novo fetch
    const token2 = await obterTokenSerpro("mock_key", "mock_secret");
    assertEquals(token2, "mock-token-jwt-12345");
    assertEquals(chamadasToken, 1);
  } finally {
    globalThis.fetch = fetchOriginal;
    invalidarTokenCache();
  }
});

Deno.test("Serpro Client - consulta chat e faz parsing correto das mensagens", async () => {
  invalidarTokenCache();
  const fetchOriginal = globalThis.fetch;

  globalThis.fetch = ((input: RequestInfo | URL) => {
    const urlStr = String(input);
    if (urlStr.endsWith("/token")) {
      return Promise.resolve(
        new Response(
          JSON.stringify({ access_token: "mock-token", expires_in: 3600 }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
      );
    }
    if (urlStr.includes("/integra-compras/v1/chat/")) {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            chaveCompra: "15300005000012026",
            mensagens: [
              {
                id: 1,
                item: 1,
                categoria: "AVISO",
                remetente: "Pregoeiro",
                texto: "Item 1 aberto para lances.",
                dataHora: 1792900000000,
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
      );
    }
    return Promise.resolve(new Response("Not Found", { status: 404 }));
  }) as typeof fetch;

  try {
    const msgs = await consultarChatSerpro("15300005000012026", "mock-token");
    assertEquals(msgs.length, 1);
    assertEquals(msgs[0].remetente, "Pregoeiro");
    assertEquals(msgs[0].texto, "Item 1 aberto para lances.");
    assertEquals(msgs[0].categoria, "AVISO");
  } finally {
    globalThis.fetch = fetchOriginal;
    invalidarTokenCache();
  }
});

Deno.test("Serpro Client - consulta diligências e formata como MensagemSerpro", async () => {
  invalidarTokenCache();
  const fetchOriginal = globalThis.fetch;

  globalThis.fetch = ((input: RequestInfo | URL) => {
    const urlStr = String(input);
    if (urlStr.includes("/integra-compras/v1/diligencias/")) {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            chaveCompra: "15300005000012026",
            diligencias: [
              {
                id: 10,
                item: 2,
                remetente: "Pregoeiro",
                texto: "Solicitamos comprovação de atestado técnico.",
                dataHora: 1792900050000,
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
      );
    }
    return Promise.resolve(new Response("Not Found", { status: 404 }));
  }) as typeof fetch;

  try {
    const dils = await consultarDiligenciasSerpro("15300005000012026", "mock-token");
    assertEquals(dils.length, 1);
    assertEquals(dils[0].categoria, "DILIGENCIA");
    assertEquals(dils[0].texto, "Solicitamos comprovação de atestado técnico.");
    assertEquals(dils[0].item, 2);
  } finally {
    globalThis.fetch = fetchOriginal;
    invalidarTokenCache();
  }
});

