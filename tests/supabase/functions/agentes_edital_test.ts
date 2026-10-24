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
 chore/higiene-contexto-e-pipeline
  assertEquals(prazo.fontes, [{ tipo: "calculo", regra: "lei_14133_art_164_3_dias_uteis", versao: "2026-10-20.1" }]);

  assertEquals(prazo.fontes, [{ tipo: "calculo", regra: "lei_14133_art_164_3_dias_uteis", versao: "2026-10-21.1" }]);
 main
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

// --- Negação e dispensa (20/10/2026, licitação 11374 de Itajaí e frases reais da base) ------------------------------
// "4.2. Amostras ( X) Não" e "Garantia contratual: Não se aplica" viravam exigência e o jurídico sugeria
// pedido de esclarecimento sobre amostra que o edital não pede.

const codigos = (textos: string[]) => detectarExigencias(textos.map((t, i) => c(i + 1, t))).map((a) => a.codigo).sort();

Deno.test("edital: caixa marcada em Não é dispensa, não exigência (11374, p. 9)", () => {
  assertEquals(
    codigos([
      "4.1 Regime de execução: ( X ) Por lote \n4.2. Amostras \n( X) Não \n\nA Administração realizará a análise da conformidade",
      "4.3. Garantia de proposta \n(X ) Não \n\n5. DOS CRITÉRIOS DE HABILITAÇÃO",
    ]),
    ["dispensa.amostra", "dispensa.garantia_proposta"],
  );
});

Deno.test("edital: formulário com Não marcado antes do Sim é dispensa; Sim marcado é exigência", () => {
  assertEquals(codigos(["4.2. Será exigido amostra do(s) produto(s)/demonstração do(s) serviço(s): ( X ) Não ( ) Sim 4.3. Será exigida"]), [
    "dispensa.amostra",
  ]);
  assertEquals(codigos(["4.2. Será exigido amostra do(s) produto(s): ( ) Não ( X ) Sim"]), ["exigencia.amostra"]);
  assertEquals(
    codigos(["3.3. Haverá necessidade de vistoria prévia (visita técnica)? ( ) Vistoria obrigatória ( ) Vistoria facultativa ( X ) Não será exigida vistoria."]),
    ["dispensa.visita_tecnica"],
  );
});

Deno.test("edital: 'Não se aplica' / 'Não haverá' / 'Não será exigida' depois do título é dispensa", () => {
  assertEquals(codigos(["CLÁUSULA NONA – DA GARANTIA CONTRATUAL\n\n9.1. Não se aplica.\n\nCLÁUSULA DÉCIMA – DA FISCALIZAÇÃO"]), [
    "dispensa.garantia_contratual",
  ]);
  assertEquals(codigos(["7. DAS AMOSTRAS 7.1. Para a presente contratação não será obrigatória a apresentação de amostras por parte"]), [
    "dispensa.amostra",
  ]);
  assertEquals(codigos(["7 . 3 . Da Amostra: 7 . 3 . 1 . Não será exigida a apresentação de amostras nesta contratação."]), ["dispensa.amostra"]);
  assertEquals(codigos(["4.1.3. Da exigência de amostra: 4.1.3.1. Não se aplica a exigência de amostra para a presente aquisição"]), [
    "dispensa.amostra",
  ]);
});

Deno.test("edital: negação antes do termo na mesma frase é dispensa", () => {
  assertEquals(codigos(["10.1. Não haverá exigência de garantia contratual da execução."]), ["dispensa.garantia_contratual"]);
  assertEquals(codigos(["10.1. Não será exigida garantia contratual para a presente contratação"]), ["dispensa.garantia_contratual"]);
  assertEquals(codigos(["15.1. Não haverá exigência de garantia de proposta para a presente contratação."]), ["dispensa.garantia_proposta"]);
  assertEquals(codigos(["Não haverá a exigência de amostras. Para a análise e aceitação dos produtos"]), ["dispensa.amostra"]);
});

Deno.test("edital: afirmação continua exigência", () => {
  assertEquals(codigos(["2.5.1. Conforme o art. 58 da Lei nº 14.133/2021, será exigida garantia de proposta no valor de 1%"]), [
    "exigencia.garantia_proposta",
  ]);
  assertEquals(codigos(["8.1 A licitante deverá apresentar amostra em 5 dias úteis. Não serão aceitas amostras fora do prazo."]), [
    "exigencia.amostra",
  ]);
});

Deno.test("edital: a dispensa de um tema não apaga a exigência do tema seguinte", () => {
  assertEquals(codigos(["4.2. Amostras ( X ) Não 4.3. Garantia de proposta: será exigida garantia de proposta de 1%"]), [
    "dispensa.amostra",
    "exigencia.garantia_proposta",
  ]);
  assertEquals(codigos(["4.2. Amostras: obrigatória para o item 1. 4.3. Garantia de proposta: Não se aplica."]), [
    "dispensa.garantia_proposta",
    "exigencia.amostra",
  ]);
});

Deno.test("edital: menção condicional ('quando houver') não é exigência nem dispensa", () => {
  assertEquals(codigos(["7.8. As multas poderão ser descontadas da garantia contratual, quando houver, ou cobradas judicialmente."]), []);
});

Deno.test("edital: exigência e dispensa no mesmo edital viram exigência com aviso de conflito", () => {
  const achados = detectarExigencias([c(1, "4.2. Amostras ( X ) Não"), c(2, "8.1 O vencedor deverá apresentar amostra da esteira.")]);
  assertEquals(achados.map((a) => a.codigo), ["exigencia.amostra"]);
  assertEquals(achados[0].dados.conflito_dispensa, true);
  assertEquals(achados[0].fontes.map((f) => (f as { chunk_id: number }).chunk_id), [2, 1]);
});

Deno.test("edital: dispensa é fato informativo com o trecho, e passa na validação", () => {
  const [a] = detectarExigencias([c(1, "CLÁUSULA NONA – DA GARANTIA CONTRATUAL 9.1. Não se aplica.")]);
  assertEquals([a.codigo, a.natureza, a.severidade], ["dispensa.garantia_contratual", "fato", "info"]);
  assertEquals(a.detalhe, "O edital diz que não exige.");
  assertEquals(validarAchado(a), null);
});

Deno.test("edital: trechos repetidos por chunks sobrepostos aparecem uma vez", () => {
  const t = "CLÁUSULA NONA – DA GARANTIA CONTRATUAL 9.1. Não se aplica. CLÁUSULA DÉCIMA";
  const [a] = detectarExigencias([
    { id: 1, documento_id: 9, pagina: 22, texto: "requisitos previstos na Lei. " + t },
    { id: 2, documento_id: 9, pagina: 22, texto: t + " – DA FISCALIZAÇÃO 10.1." },
  ]);
  assertEquals(a.fontes.length, 1);
});

Deno.test("edital: texto padrão que só cita o tema não é exigência (sanção, condição, garantia do produto)", () => {
  assertEquals(
    codigos([
      "o sujeitará às penalidades e à imediata perda da garantia de proposta em favor do órgão.",
      "7.10. Caso o Termo de Referência exija a apresentação de amostra, o licitante classificado em primeiro lugar deverá apresentá-la.",
      "20.1.7.3. Apresentar amostra falsificada ou deteriorada.",
      "5.11. O prazo de garantia contratual dos bens, complementar à garantia legal, será de 36 meses.",
      "Por meio de mensagem no sistema, será divulgado o local para a avaliação das amostras.",
      "10.1.2.4. deixar de apresentar amostra; 10.1.2.5. apresentar proposta ou amostra em desacordo com o edital;",
      "7.14. Se a(s) amostra(s) apresentada(s) pelo primeiro classificado não for(em) aceita(s), o Pregoeiro analisará",
      "16.15. O contratado deverá manter atualizada a vigência da garantia contratual.",
    ]),
    [],
  );
  assertEquals(codigos(["Exige-se apresentação de amostras ou documentação técnica para diversos itens."]), ["exigencia.amostra"]);
  assertEquals(codigos(["§ 6º perda da garantia de proposta. A regra do § 5º não se aplicará aos licitantes remanescentes."]), []);
});

Deno.test("detectarExigencias: negação em frase seguinte não anula exigência anterior", () => {
  // Cenário exato do bug reportado: a negação do prazo não deve anular a exigência de amostra
  // Usando a função auxiliar 'c' já definida no topo do arquivo para garantir consistência de tipos
  const chunks = [
    c(1, "A licitante deverá apresentar amostras. Não haverá prorrogação do prazo de entrega.")
  ];

  const achados = detectarExigencias(chunks);

  // Deve encontrar a exigência de amostra
  const temExigenciaAmostra = achados.some((a) => a.codigo === "exigencia.amostra" || a.codigo.includes("amostra"));
  assertEquals(temExigenciaAmostra, true, "Deve identificar a exigência de amostra na primeira frase");

  // NÃO deve marcar como dispensado por causa da segunda frase
  const temDispensaAmostra = achados.some((a) => a.codigo === "dispensa.amostra");
  assertEquals(temDispensaAmostra, false, "A negação do prazo na segunda frase não deve anular a amostra da primeira");
});
