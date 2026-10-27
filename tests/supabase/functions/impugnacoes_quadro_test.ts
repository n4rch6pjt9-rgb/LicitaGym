import { assertEquals } from "jsr:@std/assert@1";
import { mesclarHistoricoPortal } from "../../../supabase/functions/api-dashboard-oportunidades/pncpAtraso.ts";
import { interpretarCorpoImpugnacoes, lerImpugnacoesComprasnet } from "../../../supabase/functions/api-dashboard-oportunidades/impugnacoes.ts";

Deno.test("204 com message-severity error nao e quadro vazio", () => {
  const leitura = interpretarCorpoImpugnacoes(
    204,
    new Headers({
      "message-severity": "error",
      "message-detail": "Nao foi possivel realizar a validacao do Captcha.",
    }),
    "",
  );
  if (leitura.ok) throw new Error("captcha nao pode virar lista vazia");
  assertEquals(leitura.motivo, "captcha_bloqueado");
});

Deno.test("impugnacao do quadro vira aviso e preserva quebras de linha", () => {
  const mesclado = mesclarHistoricoPortal(
    [{
      data: "2026-10-23T10:31:23",
      categoria: "Item de Contratacao",
      tipo: "Inclusao",
      item: 1,
      documentoTitulo: null,
      justificativa: null,
      origem: "pncp",
    }],
    [{
      categoria: "impugnacao",
      remetente: "Compras.gov.br",
      mensagem: "Linha 1\nLinha 2",
      data_hora_oficial: "2026-10-26T11:21:11.62979",
      resposta: "Resposta 1\nResposta 2",
    }],
    "Compras.gov.br",
  );
  const aviso = mesclado.find((evento) => evento.origem === "portal_oficial");
  assertEquals(aviso?.categoria, "Impugnação");
  assertEquals(aviso?.tipo, "Aviso");
  assertEquals(aviso?.justificativa, "Linha 1\nLinha 2\n\nResposta:\nResposta 1\nResposta 2");
});

Deno.test("503 vazio nao vira quadro sem impugnacao", () => {
  const leitura = interpretarCorpoImpugnacoes(503, new Headers(), "");
  if (leitura.ok) throw new Error("503 nao pode virar lista vazia");
  assertEquals(leitura.motivo, "indisponivel");
});

Deno.test("429 com JSON de erro nao vira quadro sem impugnacao", () => {
  const leitura = interpretarCorpoImpugnacoes(
    429,
    new Headers({ "content-type": "application/json" }),
    '{"message":"Too many requests"}',
  );
  if (leitura.ok) throw new Error("429 nao pode virar lista vazia");
  assertEquals(leitura.motivo, "indisponivel");
});

Deno.test("200 sem lista de informativos nao vira quadro vazio", () => {
  const leitura = interpretarCorpoImpugnacoes(200, new Headers(), '{"message":"erro"}');
  if (leitura.ok) throw new Error("envelope invalido nao pode virar lista vazia");
  assertEquals(leitura.motivo, "indisponivel");
});

Deno.test("200 com informativos vazios continua sendo quadro vazio", () => {
  const leitura = interpretarCorpoImpugnacoes(200, new Headers(), '{"informativos":[]}');
  if (!leitura.ok) throw new Error("lista vazia legitima");
  assertEquals(leitura.informativos, []);
});

Deno.test("consulta travada do quadro vira indisponivel", async () => {
  const leitura = await lerImpugnacoesComprasnet("18017405000472026", {
    prazoMs: 40,
    fetchImpl: (_url, init) => new Promise((_resolve, reject) => {
      const sinal = init?.signal;
      if (!sinal) {
        reject(new Error("signal ausente"));
        return;
      }
      sinal.addEventListener("abort", () => {
        reject(sinal.reason ?? new DOMException("The operation was aborted", "AbortError"));
      }, { once: true });
    }),
  });
  if (leitura.ok) throw new Error("prazo esgotado nao pode virar lista");
  assertEquals(leitura.motivo, "indisponivel");
});

Deno.test("corpo travado do quadro tambem vira indisponivel", async () => {
  const leitura = await lerImpugnacoesComprasnet("18017405000472026", {
    prazoMs: 40,
    fetchImpl: () => Promise.resolve(new Response(new ReadableStream({
      start() {},
    }), { status: 200, headers: { "content-type": "application/json" } })),
  });
  if (leitura.ok) throw new Error("corpo travado nao pode virar lista");
  assertEquals(leitura.motivo, "indisponivel");
});
