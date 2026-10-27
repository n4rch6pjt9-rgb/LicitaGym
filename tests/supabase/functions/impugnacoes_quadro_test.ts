import { assertEquals } from "jsr:@std/assert@1";
import { mesclarHistoricoPortal } from "../../../supabase/functions/api-dashboard-oportunidades/pncpAtraso.ts";
import { interpretarCorpoImpugnacoes } from "../../../supabase/functions/api-dashboard-oportunidades/impugnacoes.ts";

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
