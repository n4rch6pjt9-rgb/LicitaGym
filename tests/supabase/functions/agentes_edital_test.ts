import { assertEquals } from "jsr:@std/assert@1";
import { agenteEdital, detectarExigencias, limiteImpugnacao } from "../../../supabase/functions/_shared/agentes/edital.ts";
import { validarAchado } from "../../../supabase/functions/_shared/agentes/achados.ts";

const c = (id: number, texto: string) => ({ id, documento_id: 9, pagina: id, texto });

Deno.test("edital: detecta exigências com trecho literal", () => {
  const achados = detectarExigencias([
    c(1, "8.1 A licitante deverá apresentar AMOSTRA da esteira em 5 dias úteis."),
    c(2, "9.2 Atestado de capacidade técnica compatível com o objeto."),
    c(3, "Prazo máximo de entrega: 30 dias. Garantia de proposta de 1%."),
  ]);
  assertEquals(achados.map((a) => a.codigo).sort(), [
    "exigencia.amostra",
    "exigencia.atestado_capacidade",
    "exigencia.garantia_proposta",
    "exigencia.prazo_entrega",
  ]);
  const amostra = achados.find((a) => a.codigo === "exigencia.amostra")!;
  assertEquals(amostra.fontes, [{
    tipo: "chunk",
    chunk_id: 1,
    documento_id: 9,
    pagina: 1,
    trecho: "8.1 A licitante deverá apresentar AMOSTRA da esteira em 5 dias úteis.",
  }]);
  assertEquals([amostra.natureza, amostra.metodo], ["fato", "regra"]);
  for (const a of achados) assertEquals(validarAchado(a), null);
});

Deno.test("edital: um achado por código, no máximo 3 fontes", () => {
  const achados = detectarExigencias([1, 2, 3, 4].map((i) => c(i, `item ${i}: amostra obrigatória`)));
  assertEquals(achados.length, 1);
  assertEquals(achados[0].fontes.map((f) => (f as { chunk_id: number }).chunk_id), [1, 2, 3]);
});

Deno.test("edital: texto sem exigência não gera achado", () =>
  assertEquals(detectarExigencias([c(1, "Aquisição de halteres para o ginásio municipal.")]), []));

Deno.test("edital: limite de impugnação conta só dias úteis", () => {
  assertEquals(limiteImpugnacao("2026-10-21T09:00:00-03:00"), "2026-10-16");
  assertEquals(limiteImpugnacao("2026-10-15T09:00:00-03:00"), "2026-10-12");
});

Deno.test("edital: prazo avisa que não considerou feriados", () => {
  const r = agenteEdital({ chunks: [c(1, "amostra")], data_abertura: "2026-10-15T09:00:00-03:00" });
  const prazo = r.achados.find((a) => a.codigo === "prazo.impugnacao")!;
  assertEquals(prazo.severidade, "atencao");
  assertEquals(prazo.natureza, "analise");
  assertEquals(prazo.dados, { data_limite: "2026-10-12", data_abertura: "2026-10-15", feriados_considerados: false });
  assertEquals(prazo.fontes, [{ tipo: "calculo", regra: "lei_14133_art_164_3_dias_uteis", versao: "2026-10-06.1" }]);
});

Deno.test("edital: sem chunks é sem_documento, não 'nenhuma exigência'", () => {
  const r = agenteEdital({ chunks: [], data_abertura: "2026-10-21T09:00:00-03:00" });
  assertEquals(r.situacao, "sem_documento");
  assertEquals(r.achados.filter((a) => a.codigo.startsWith("exigencia.")), []);
  assertEquals(r.achados.map((a) => a.codigo), ["prazo.impugnacao"]);
});

Deno.test("edital: sem data de abertura não inventa prazo", () => {
  const r = agenteEdital({ chunks: [c(1, "amostra")], data_abertura: null });
  assertEquals(r.achados.some((a) => a.codigo === "prazo.impugnacao"), false);
});
