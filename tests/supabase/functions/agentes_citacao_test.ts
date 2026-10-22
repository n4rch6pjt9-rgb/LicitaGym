// Spec 0038 (K-4, CA-6): item/cláusula e trecho limpo da citação, extraídos do texto do chunk.
import { assertEquals } from "jsr:@std/assert@1";
import { itemDoTrecho, itemNaPosicao, trechoLimpo } from "../../../supabase/functions/_shared/agentes/citacao.ts";
import { detectarExigencias } from "../../../supabase/functions/_shared/agentes/edital.ts";

const OCR =
  "nte o preenchimento do formulário de cadastro. 8.4.2 É obrigatória a realização de visita técnica ao local de " +
  "instalação dos equipamentos. A visita será agendada pelo telefone indicado no preâmbulo e acompanhada por servid";

Deno.test("CA-6: item no início da frase que contém o trecho; trecho limpo começa na frase, sem palavra cortada", () => {
  assertEquals(itemDoTrecho(OCR, "visita técnica"), "8.4.2");
  assertEquals(
    trechoLimpo(OCR, 300, "visita técnica"),
    "8.4.2 É obrigatória a realização de visita técnica ao local de instalação dos equipamentos.",
  );
});

Deno.test("itemDoTrecho: numerações reais de edital", () => {
  assertEquals(itemDoTrecho("6.7.1. A amostra deverá ser entregue em 5 dias."), "6.7.1");
  assertEquals(itemDoTrecho("5.1.2) Atestado de capacidade técnica."), "5.1.2");
  assertEquals(itemDoTrecho("Cláusula anterior.\n12.3 - Garantia de proposta de 1%.", "Garantia"), "12.3");
  // "8.4.2." separado da frase pelo ponto continua sendo o item da frase seguinte
  assertEquals(itemDoTrecho("Texto anterior. 8.4.2. É obrigatória a visita técnica.", "visita"), "8.4.2");
});

Deno.test("itemDoTrecho: não inventa item", () => {
  // frase sem numeração no início
  assertEquals(itemDoTrecho(OCR, "agendada pelo telefone"), null);
  // data, valor e número de lei não são item
  assertEquals(itemDoTrecho("21.10.2026 às 9h, sessão pública."), null);
  assertEquals(itemDoTrecho("1.500,00 é o valor estimado."), null);
  assertEquals(itemDoTrecho("14.133/2021 rege a contratação."), null);
  // número sem subnível ("8.") não é item
  assertEquals(itemDoTrecho("8. Da amostra"), null);
  // trecho que não está no texto
  assertEquals(itemDoTrecho(OCR, "garantia contratual"), null);
  assertEquals(itemDoTrecho("", "x"), null);
  assertEquals(itemNaPosicao("8.1 Texto.", -1), null);
});

Deno.test("itemDoTrecho: abreviação ('art. 5º') não fecha a frase", () =>
  assertEquals(itemDoTrecho("9.2 Conforme o art. 5º da lei, exige-se amostra.", "exige-se amostra"), "9.2"));

Deno.test("trechoLimpo: tira o fragmento inicial e colapsa espaços", () => {
  assertEquals(trechoLimpo("nte   o preenchimento.\n\nA licitante   deverá apresentar\namostra."), "A licitante deverá apresentar amostra.");
});

Deno.test("trechoLimpo: junta frases inteiras até o limite, nunca corta no meio da frase seguinte", () => {
  const texto = "Primeira frase curta. Segunda frase também curta. Terceira frase que já não cabe no limite pedido.";
  assertEquals(trechoLimpo(texto, 50), "Primeira frase curta. Segunda frase também curta.");
});

Deno.test("trechoLimpo: última frase cortada na fonte perde a palavra cortada e ganha reticências", () => {
  assertEquals(trechoLimpo("A visita será acompanhada por servid"), "A visita será acompanhada por…");
});

Deno.test("trechoLimpo: frase maior que o limite é cortada entre palavras, com o foco dentro", () => {
  const longa = `8.1 ${"palavra ".repeat(80)}amostra obrigatória ${"fim ".repeat(20)}.`;
  const t = trechoLimpo(longa, 120, "amostra obrigatória");
  assertEquals(t.length <= 120, true, t);
  assertEquals(t.includes("amostra obrigatória"), true, t);
  assertEquals(/^…palavra/.test(t) && t.endsWith("…"), true, t);
  assertEquals(trechoLimpo("x".repeat(500), 300).length <= 300, true);
});

Deno.test("trechoLimpo: texto vazio", () => assertEquals(trechoLimpo("   "), ""));

Deno.test("K-4: fonte do edital traz o item da frase que casou e o trecho limpo", () => {
  const [achado] = detectarExigencias([{ id: 3, documento_id: 9, pagina: 11, texto: OCR }]);
  assertEquals(achado.codigo, "exigencia.visita_tecnica");
  const fonte = achado.fontes[0];
  if (fonte.tipo !== "chunk") throw new Error("fonte de chunk esperada");
  assertEquals(fonte.item, "8.4.2");
  assertEquals(fonte.trecho_limpo?.startsWith("8.4.2 É obrigatória a realização de visita técnica"), true, fonte.trecho_limpo);
  // o trecho cru continua o mesmo de antes (contrato aditivo)
  assertEquals(OCR.includes(fonte.trecho), true);
});
