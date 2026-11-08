import { assertEquals, assertRejects } from "jsr:@std/assert@1";
import {
  consultarChatSerpro,
  consultarDiligenciasSerpro,
  converterDataHoraFonte,
  definirDormirParaTeste,
  ErroIntegraCompras,
  invalidarTokenCache,
  obterTokenSerpro,
} from "./serpro.ts";

// Exemplo oficial da documentação do Integra Compras (compra de demonstração 99998803000012026).
const EXEMPLO_OFICIAL = await Deno.readTextFile(
  new URL("../../../tests/supabase/fixtures/integra_compras_chat_exemplo.json", import.meta.url),
);
const CHAVE = "99998803000012026";

type Rota = (url: string, init?: RequestInit) => Response;

/** Troca o fetch global; o token responde sempre e conta as chamadas por rota. */
function comFetch(rota: Rota) {
  const original = globalThis.fetch;
  const chamadas = { token: 0, api: [] as string[] };
  invalidarTokenCache();
  Deno.env.set("SERPRO_CONSUMER_KEY", "chave-teste");
  Deno.env.set("SERPRO_CONSUMER_SECRET", "segredo-teste");
  definirDormirParaTeste(() => Promise.resolve());
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/token")) {
      chamadas.token++;
      return Promise.resolve(
        new Response(JSON.stringify({ access_token: `tok-${chamadas.token}`, expires_in: 3600 }), { status: 200 }),
      );
    }
    chamadas.api.push(url);
    return Promise.resolve(rota(url, init));
  }) as typeof fetch;
  return {
    chamadas,
    restaurar: () => {
      globalThis.fetch = original;
      invalidarTokenCache();
    },
  };
}

Deno.test("Serpro: falha se credenciais não forem fornecidas", async () => {
  invalidarTokenCache();
  await assertRejects(() => obterTokenSerpro("", ""), Error, "Credenciais do Integra Compras Serpro não configuradas");
});

Deno.test("Serpro: token fica em cache", async () => {
  const f = comFetch(() => new Response("[]", { status: 200 }));
  try {
    assertEquals(await obterTokenSerpro(), "tok-1");
    assertEquals(await obterTokenSerpro(), "tok-1");
    assertEquals(f.chamadas.token, 1);
  } finally {
    f.restaurar();
  }
});

Deno.test("CA-2 (cliente): exemplo oficial vira 3 mensagens, item nulo na primeira e \"1\" nas outras", async () => {
  const f = comFetch(() => new Response(EXEMPLO_OFICIAL, { status: 200 }));
  try {
    const r = await consultarChatSerpro(CHAVE);
    assertEquals(r.status, 200);
    assertEquals(r.mensagens.length, 3);
    assertEquals(r.mensagens.map((m) => m.identificadorItem), [null, "1", "1"]);
    assertEquals(r.mensagens[0].chaveMensagem, "3e6a53fa-6470-4626-ab8a-dfc29c221328");
    assertEquals(r.mensagens[0].categoria, "11");
    assertEquals(r.mensagens[0].tipoRemetente, "0");
    assertEquals(r.mensagens[0].tipo, "mensagem");
    // 16:15:00.144 em Brasília (UTC-3) = 19:15:00.144Z
    assertEquals(r.mensagens[0].dataHora, "2026-02-05T19:15:00.144Z");
    assertEquals(r.mensagens[0].dataHoraFonte, "2026-02-05 16:15:00.144");
    assertEquals(r.mensagens[0].chaveCompra?.numeroUasg, 999988);
    assertEquals(f.chamadas.api, [`https://gateway.apiserpro.serpro.gov.br/integra-compras/v1/chat/${CHAVE}`]);
  } finally {
    f.restaurar();
  }
});

Deno.test("Serpro: diligências usam /chat/{chave}/diligencias e marcam tipo diligencia", async () => {
  const f = comFetch(() => new Response(EXEMPLO_OFICIAL, { status: 200 }));
  try {
    const r = await consultarDiligenciasSerpro(CHAVE);
    assertEquals(r.mensagens.every((m) => m.tipo === "diligencia"), true);
    assertEquals(f.chamadas.api, [
      `https://gateway.apiserpro.serpro.gov.br/integra-compras/v1/chat/${CHAVE}/diligencias`,
    ]);
  } finally {
    f.restaurar();
  }
});

Deno.test("CA-3 (cliente): 404 = zero mensagens com status 404, sem erro", async () => {
  const f = comFetch(() => new Response("", { status: 404 }));
  try {
    const r = await consultarChatSerpro(CHAVE);
    assertEquals(r, { status: 404, mensagens: [] });
  } finally {
    f.restaurar();
  }
});

Deno.test("CA-4: 401 pede token novo uma única vez e repete a chamada", async () => {
  let n = 0;
  const f = comFetch(() => (++n === 1 ? new Response("", { status: 401 }) : new Response(EXEMPLO_OFICIAL, { status: 200 })));
  try {
    const r = await consultarChatSerpro(CHAVE);
    assertEquals(r.mensagens.length, 3);
    assertEquals(f.chamadas.token, 2);
    assertEquals(f.chamadas.api.length, 2);
  } finally {
    f.restaurar();
  }
});

Deno.test("CA-4: 401 repetido não entra em laço (um só token novo) e vira erro", async () => {
  const f = comFetch(() => new Response("", { status: 401 }));
  try {
    const e = await assertRejects(() => consultarChatSerpro(CHAVE), ErroIntegraCompras);
    assertEquals(e.status, 401);
    assertEquals(f.chamadas.token, 2);
    assertEquals(f.chamadas.api.length, 2);
  } finally {
    f.restaurar();
  }
});

Deno.test("CA-5 (cliente): 502 vira ErroIntegraCompras com status, sem retry", async () => {
  const f = comFetch(() => new Response("manutenção", { status: 502 }));
  try {
    const e = await assertRejects(() => consultarChatSerpro(CHAVE), ErroIntegraCompras);
    assertEquals(e.status, 502);
    assertEquals(f.chamadas.api.length, 1);
  } finally {
    f.restaurar();
  }
});

Deno.test("Serpro: 429 respeita Retry-After e tenta de novo", async () => {
  const esperas: number[] = [];
  let n = 0;
  const f = comFetch(() =>
    ++n === 1
      ? new Response("", { status: 429, headers: { "Retry-After": "7" } })
      : new Response(EXEMPLO_OFICIAL, { status: 200 })
  );
  definirDormirParaTeste((ms) => {
    esperas.push(ms);
    return Promise.resolve();
  });
  try {
    const r = await consultarChatSerpro(CHAVE);
    assertEquals(r.mensagens.length, 3);
    assertEquals(esperas, [7000]);
  } finally {
    f.restaurar();
  }
});

Deno.test("Serpro: resposta fora do formato documentado é erro, não lista vazia", async () => {
  const f = comFetch(() => new Response(JSON.stringify({ mensagens: [] }), { status: 200 }));
  try {
    await assertRejects(() => consultarChatSerpro(CHAVE), ErroIntegraCompras, "esperada uma lista");
  } finally {
    f.restaurar();
  }
});

Deno.test("Serpro: mensagem sem chaveMensagem é erro, não linha inventada", async () => {
  const semChave = JSON.stringify([{ texto: "x", dataHora: "2026-02-05 16:15:00.144" }]);
  const f = comFetch(() => new Response(semChave, { status: 200 }));
  try {
    await assertRejects(() => consultarChatSerpro(CHAVE), ErroIntegraCompras, "fora do formato documentado");
  } finally {
    f.restaurar();
  }
});

Deno.test("Serpro: chave de compra que não tem 17 dígitos não chega à API", async () => {
  const f = comFetch(() => new Response("[]", { status: 200 }));
  try {
    await assertRejects(() => consultarChatSerpro("123/../token"), ErroIntegraCompras, "17 dígitos");
    assertEquals(f.chamadas.api.length, 0);
  } finally {
    f.restaurar();
  }
});

Deno.test("Serpro: converterDataHoraFonte", () => {
  assertEquals(converterDataHoraFonte("2026-02-05 16:15:00"), "2026-02-05T19:15:00.000Z");
  assertEquals(converterDataHoraFonte("2026-02-05 16:15:00.5"), "2026-02-05T19:15:00.500Z");
  assertEquals(converterDataHoraFonte(1792900000000), new Date(1792900000000).toISOString());
  assertEquals(converterDataHoraFonte("2026-02-31 10:00:00"), null);
  assertEquals(converterDataHoraFonte("ontem"), null);
  assertEquals(converterDataHoraFonte(null), null);
});

Deno.test("Serpro: timeout ou falha de rede vira ErroIntegraCompras sem status", async () => {
  const f = comFetch(() => {
    throw new DOMException("tempo esgotado", "TimeoutError");
  });
  try {
    const e = await assertRejects(() => consultarChatSerpro(CHAVE), ErroIntegraCompras, "TimeoutError");
    assertEquals(e.status, null);
  } finally {
    f.restaurar();
  }
});

Deno.test("Serpro: chaveMensagem fora do formato uuid é erro", async () => {
  const ruim = JSON.stringify([{ chaveMensagem: "abc", texto: "x", dataHora: "2026-02-05 16:15:00.144" }]);
  const f = comFetch(() => new Response(ruim, { status: 200 }));
  try {
    await assertRejects(() => consultarChatSerpro(CHAVE), ErroIntegraCompras, "fora do formato documentado");
  } finally {
    f.restaurar();
  }
});

Deno.test("Serpro: categoria e tipoRemetente ausentes ficam nulos, não viram texto vazio", async () => {
  const semCodigos = JSON.stringify([
    { chaveMensagem: "3e6a53fa-6470-4626-ab8a-dfc29c221328", texto: "x", dataHora: "2026-02-05 16:15:00.144" },
  ]);
  const f = comFetch(() => new Response(semCodigos, { status: 200 }));
  try {
    const r = await consultarChatSerpro(CHAVE);
    assertEquals(r.mensagens[0].categoria, null);
    assertEquals(r.mensagens[0].tipoRemetente, null);
  } finally {
    f.restaurar();
  }
});

Deno.test("Serpro: 400 guarda o motivo do corpo, curto e sem token", async () => {
  const corpo = JSON.stringify({
    mensagem: "Parâmetro ordem é obrigatório",
    eco: "Bearer abc.def.ghi",
    hash: "a".repeat(40),
  }) + " ".repeat(10) + "x".repeat(400);
  const f = comFetch(() => new Response(corpo, { status: 400 }));
  try {
    const e = await assertRejects(() => consultarChatSerpro(CHAVE), ErroIntegraCompras);
    assertEquals(e.status, 400);
    assertEquals(e.message.startsWith('Integra Compras respondeu HTTP 400: {"mensagem":"Parâmetro ordem é obrigatório"'), true);
    assertEquals(e.message.includes("abc.def.ghi"), false);
    assertEquals(e.message.includes("a".repeat(40)), false);
    assertEquals(e.message.length <= "Integra Compras respondeu HTTP 400: ".length + 301, true);
  } finally {
    f.restaurar();
  }
});

Deno.test("Serpro: 502 não lê o corpo (página de manutenção)", async () => {
  const f = comFetch(() => new Response("<html>manutenção</html>", { status: 502 }));
  try {
    const e = await assertRejects(() => consultarChatSerpro(CHAVE), ErroIntegraCompras);
    assertEquals(e.message, "Integra Compras respondeu HTTP 502.");
  } finally {
    f.restaurar();
  }
});
