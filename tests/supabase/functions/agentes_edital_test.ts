import { assertEquals } from "jsr:@std/assert@1";
import { agenteEdital, detectarExigencias, limiteImpugnacao } from "../../../supabase/functions/_shared/agentes/edital.ts";
import { validarAchado } from "../../../supabase/functions/_shared/agentes/achados.ts";
import { calendarioNacional } from "../../../supabase/functions/_shared/prazos/dias-uteis.ts";

// Feriados nacionais de 2026 como estão em public.feriados_nacionais (migration 20261107180000).
const FERIADOS_2026 = calendarioNacional([
  "2026-01-01", "2026-04-21", "2026-05-01", "2026-09-07", "2026-10-12", "2026-11-02", "2026-11-15", "2026-11-20",
  "2026-12-25",
]);

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
    // spec 0038 (K-4)
    item: "8.1",
    trecho_limpo: "8.1 A licitante deverá apresentar AMOSTRA da esteira em 5 dias úteis.",
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

Deno.test("edital: limite de impugnação conta dias úteis com feriados nacionais", () => {
  assertEquals(limiteImpugnacao("2026-10-21T09:00:00-03:00", FERIADOS_2026), { data_limite: "2026-10-16", feriados_pulados: [] });
  // Spec 0041 CA-2: abertura 14/10/2026 08:30 → 08/10/2026 (12/10 é feriado).
  assertEquals(limiteImpugnacao("2026-10-14T08:30:00-03:00", FERIADOS_2026), {
    data_limite: "2026-10-08",
    feriados_pulados: ["2026-10-12"],
  });
});

// Spec 0041 CA-3 (regressão): o teste antigo fixava 12/10/2026, que é feriado nacional.
Deno.test("edital (0041 CA-3): abertura 15/10/2026 dá limite 09/10, não 12/10", () => {
  const r = agenteEdital({ chunks: [c(1, "amostra")], data_abertura: "2026-10-15T09:00:00-03:00", feriados: FERIADOS_2026 });
  const prazo = r.achados.find((a) => a.codigo === "prazo.impugnacao")!;
  assertEquals(prazo.severidade, "atencao");
  assertEquals(prazo.natureza, "analise");
  assertEquals(prazo.dados, {
    situacao: "calculado",
    data_limite: "2026-10-09",
    data_abertura: "2026-10-15",
    feriados_considerados: true,
    abrangencia: "nacional",
    feriados_pulados: ["2026-10-12"],
  });
  assertEquals(prazo.detalhe.includes("estaduais e municipais"), true);
  assertEquals(prazo.fontes, [{ tipo: "calculo", regra: "lei_14133_art_164_3_dias_uteis", versao: "2026-11-08.1" }]);
  assertEquals(validarAchado(prazo), null);
});

Deno.test("edital (0041 K-3): sem calendário do ano, prazo nao_calculado com motivo, nunca data sem feriado", () => {
  const semAno = agenteEdital({
    chunks: [c(1, "amostra")],
    data_abertura: "2028-03-10T09:00:00-03:00",
    feriados: FERIADOS_2026,
  }).achados.find((a) => a.codigo === "prazo.impugnacao")!;
  assertEquals(semAno.dados?.situacao, "nao_calculado");
  assertEquals(semAno.dados?.data_limite, null);
  assertEquals(semAno.dados?.feriados_considerados, false);
  assertEquals(String(semAno.dados?.motivo).includes("2028"), true);
  assertEquals(validarAchado(semAno), null);

  const semCalendario = agenteEdital({ chunks: [c(1, "amostra")], data_abertura: "2026-10-15T09:00:00-03:00" })
    .achados.find((a) => a.codigo === "prazo.impugnacao")!;
  assertEquals(semCalendario.dados?.situacao, "nao_calculado");
  assertEquals(semCalendario.dados?.data_limite, null);
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
