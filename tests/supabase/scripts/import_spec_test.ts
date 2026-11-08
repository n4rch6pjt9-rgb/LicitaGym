import { assert, assertEquals, assertThrows } from "jsr:@std/assert@1";
import * as XLSX from "npm:xlsx@0.18.5";
import {
  dataIso,
  digitoVerificador,
  gerarSeedBlocosSql,
  gerarSeedModelosSql,
  gerarSeedSql,
  idModelo,
  lerBlocosLegais,
  lerFeriados,
  lerModelosNx,
  lerPlanilha,
  lerRegimes,
  MARCA_BLOCOS_FIM,
  MARCA_BLOCOS_INICIO,
  MARCA_FIM,
  MARCA_INICIO,
  MARCA_MODELOS_FIM,
  MARCA_MODELOS_INICIO,
} from "../../../scripts/import-spec.ts";

const PLANILHA = new URL("../../../specs/nexor_spec.xlsx", import.meta.url);
const MIGRATION = new URL(
  "../../../supabase/migrations/20261107180000_nexor_feriados_regimes.sql",
  import.meta.url,
);

const wb = lerPlanilha(PLANILHA);

Deno.test("import-spec: 18 feriados nacionais (2026 e 2027), todos com lei", () => {
  const f = lerFeriados(wb);
  assertEquals(f.length, 18);
  assertEquals(new Set(f.map((x) => x.data)).size, 18);
  assertEquals(f.filter((x) => x.data.startsWith("2026-")).length, 9);
  assertEquals(f.filter((x) => x.data.startsWith("2027-")).length, 9);
  assert(
    f.every((x) => /^Lei \d/.test(x.fundamento)),
    "feriado sem lei no fundamento",
  );
});

Deno.test("import-spec: feriados usados nos testes de prazo da 0041", () => {
  const datas = new Set(lerFeriados(wb).map((x) => x.data));
  for (const d of ["2026-10-12", "2026-12-25", "2027-01-01"]) {
    assert(datas.has(d), `falta ${d}`);
  }
});

Deno.test("import-spec: 5 regimes da Padrao_Lei", () => {
  assertEquals(lerRegimes(wb).map((r) => r.id), [
    "lei_14133",
    "lei_13303",
    "sistema_s_sesc_senac",
    "sistema_s_sesi_senai",
    "lei_14981",
  ]);
});

Deno.test("import-spec: bloco da migration é o que o script gera da planilha (sem drift)", () => {
  const sql = Deno.readTextFileSync(MIGRATION);
  const i = sql.indexOf(MARCA_INICIO);
  const j = sql.indexOf(MARCA_FIM);
  assert(
    i >= 0 && j > i,
    "marcas do bloco gerado não encontradas na migration",
  );
  const naMigration = sql.slice(i, j + MARCA_FIM.length).replaceAll(
    "\r\n",
    "\n",
  );
  assertEquals(naMigration, gerarSeedSql(lerFeriados(wb), lerRegimes(wb)));
});

Deno.test("import-spec: seed é idempotente (on conflict nas chaves primárias)", () => {
  const sql = gerarSeedSql(lerFeriados(wb), lerRegimes(wb));
  assert(sql.includes("on conflict (data) do update"));
  assert(sql.includes("on conflict (id) do update"));
});

Deno.test("import-spec: aspas simples são escapadas", () => {
  const sql = gerarSeedSql([{
    data: "2026-01-01",
    nome: "D'Ávila",
    fundamento: "Lei 1/2000",
  }], []);
  assert(sql.includes("'D''Ávila'"));
});

Deno.test("import-spec: aba ausente dá erro, nunca lista vazia", () => {
  const vazio = { SheetNames: [], Sheets: {} } as unknown as Parameters<
    typeof lerFeriados
  >[0];
  assertThrows(() => lerFeriados(vazio), Error, "Documentacao_Edital");
  assertThrows(() => lerRegimes(vazio), Error, "Padrao_Lei");
});

function planilhaFeriados(linhas: unknown[][]): XLSX.WorkBook {
  const wb = XLSX.utils.book_new();
  const aoa: unknown[][] = [
    [],
    ...linhas.map((l) => [...Array(12).fill(null), ...l]),
  ];
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.aoa_to_sheet(aoa),
    "Documentacao_Edital",
  );
  return wb;
}
const CAB = ["Feriados nacionais (lei federal)", null, null];
const COLS = ["data", "feriado", "base legal"];

Deno.test("import-spec: data como texto ou serial fracionado dá erro", () => {
  assertThrows(() => dataIso("01/01/2026"), Error, "data inválida");
  assertThrows(() => dataIso(46023.5), Error, "data inválida");
  assertEquals(dataIso(46023), "2026-01-01");
});

Deno.test("import-spec: cabeçalho de feriados mudado dá erro", () => {
  const wb = planilhaFeriados([CAB, ["dia", "feriado", "base legal"], [
    46023,
    "Ano Novo",
    "Lei 662/1949",
  ]]);
  assertThrows(() => lerFeriados(wb), Error, "cabeçalho");
});

Deno.test("import-spec: feriado sem base legal dá erro", () => {
  const wb = planilhaFeriados([CAB, COLS, [46023, "Ano Novo", null]]);
  assertThrows(() => lerFeriados(wb), Error, "sem nome ou base legal");
});

Deno.test("import-spec: tabela de feriados vazia dá erro, nunca seed vazio", () => {
  assertThrows(
    () => lerFeriados(planilhaFeriados([CAB, COLS])),
    Error,
    "nenhum registro",
  );
});

Deno.test("import-spec: data repetida dá erro antes do banco", () => {
  const wb = planilhaFeriados([CAB, COLS, [46023, "A", "Lei 1/2000"], [
    46023,
    "B",
    "Lei 2/2000",
  ]]);
  assertThrows(() => lerFeriados(wb), Error, "repetida");
});

Deno.test("import-spec: planilha no sistema 1904 dá erro", () => {
  const wb = planilhaFeriados([CAB, COLS, [46023, "A", "Lei 1/2000"]]);
  wb.Workbook = { WBProps: { date1904: true } };
  assertThrows(() => lerFeriados(wb), Error, "1904");
});

// ------------------------------------------------------------------------------------------------------------------
// PR 2: etapas, modelos NX e apelidos
// ------------------------------------------------------------------------------------------------------------------

const MIGRATION_MODELOS = new URL(
  "../../../supabase/migrations/20261107220000_nexor_modelos_nx.sql",
  import.meta.url,
);

Deno.test("import-spec: DV confere com o Glossario (LG = 8) e o prefixo NX dá 4", () => {
  assertEquals(digitoVerificador("LG.GEN.A02.IMP.005"), 8);
  assertEquals(idModelo("NX", "GEN", "A02", "IMP", 5), "NX.GEN.A02.IMP.005-4");
});

Deno.test("import-spec: 14 etapas NX, R12 é contrato e as demais certame", () => {
  const { etapas } = lerModelosNx(wb);
  assertEquals(etapas.map((e) => e.codigo), [
    "A01",
    "A02",
    "A03",
    "A04",
    "P05",
    "P06",
    "P07",
    "S08",
    "S09",
    "S10",
    "S11",
    "R12",
    "R13",
    "R14",
  ]);
  assertEquals(
    etapas.filter((e) => e.macro === "contrato").map((e) => e.codigo),
    ["R12"],
  );
  assert(etapas.every((e) => e.descricao.startsWith("Grupo: ")));
});

Deno.test("import-spec: 23 modelos NX (18 novos + 5 parciais), sem NX-T34 e sem os do de-para", () => {
  const { modelos } = lerModelosNx(wb);
  assertEquals(modelos.length, 23);
  const curto = new Set(modelos.map((m) => m.curto));
  for (const x of ["NX-T09", "NX-T11", "NX-T20", "NX-T21", "NX-T32"]) {
    assert(curto.has(x), `falta ${x}`);
  }
  for (const x of ["NX-T02", "NX-T05", "NX-T16", "NX-T18", "NX-T34"]) {
    assert(!curto.has(x), `${x} não vira modelo NX`);
  }
  assert(
    modelos.every((m) =>
      /^NX\.GEN\.[APSR]\d{2}\.[A-Z]{3}\.\d{3}-\d$/.test(m.codigo)
    ),
  );
});

Deno.test("import-spec: apelidos (33 NX-T, NX-T18 com dois modelos, NX dos mapeados)", () => {
  const { apelidos } = lerModelosNx(wb);
  assertEquals(apelidos.length, 45);
  assertEquals(
    new Set(apelidos.filter((a) => a.sistema === "nx_t").map((a) => a.apelido))
      .size,
    33,
  );
  assertEquals(
    apelidos.filter((a) => a.apelido === "NX-T18").map((a) => a.tarefa_codigo),
    [
      "14133-F05-T01",
      "14133-F05-T02",
    ],
  );
  assert(
    apelidos.some((a) =>
      a.apelido === "NX.GEN.A02.IMP.005-4" &&
      a.tarefa_codigo === "14133-F01-T04"
    ),
  );
  assert(!apelidos.some((a) => a.apelido === "NX-T34"));
});

Deno.test("import-spec: prazo e condição seguem a planilha, sem inventar regra", () => {
  const m = new Map(lerModelosNx(wb).modelos.map((x) => [x.curto, x]));
  const t01 = m.get("NX-T01")!;
  assertEquals([t01.prazoUnidade, t01.prazoHoras, t01.prazoObservacao], [
    "sem_prazo_legal",
    4,
    null,
  ]);
  assertEquals(t01.condicao, {});
  const t20 = m.get("NX-T20")!;
  assertEquals([t20.prazoUnidade, t20.prazoHoras, t20.prazoObservacao], [
    "definido_no_edital",
    null,
    "5 dias úteis após convocação",
  ]);
  assertEquals(m.get("NX-T33")!.condicao, { condicao_nx: "se vencedor" });
});

Deno.test("import-spec: bloco de modelos da migration é o que o script gera (sem drift)", () => {
  const sql = Deno.readTextFileSync(MIGRATION_MODELOS).replaceAll("\r\n", "\n");
  const i = sql.indexOf(MARCA_MODELOS_INICIO);
  const j = sql.indexOf(MARCA_MODELOS_FIM);
  assert(
    i >= 0 && j > i,
    "marcas do bloco de modelos não encontradas na migration",
  );
  assertEquals(
    sql.slice(i, j + MARCA_MODELOS_FIM.length),
    gerarSeedModelosSql(lerModelosNx(wb)),
  );
});

Deno.test("import-spec: seed de modelos só atualiza linha NX e não apaga nada", () => {
  const sql = gerarSeedModelosSql(lerModelosNx(wb));
  assert(sql.includes("where public.tarefas_catalogo.norma = 'NX'"));
  assert(sql.includes("where public.processo_fases.norma = 'NX'"));
  assert(!/\bdelete\b|\btruncate\b|\bdrop\b/i.test(sql));
});

/** Cópia da planilha real com uma célula trocada (null apaga). */
function planilhaCom(
  aba: string,
  celula: string,
  valor: string | number | null,
): XLSX.WorkBook {
  const c = lerPlanilha(PLANILHA);
  const ws = c.Sheets[aba];
  if (valor === null) delete ws[celula];
  else {ws[celula] = typeof valor === "number"
      ? { t: "n", v: valor }
      : { t: "s", v: valor };}
  return c;
}

Deno.test("import-spec: natureza vazia ou fora do enum dá erro", () => {
  assertThrows(
    () => lerModelosNx(planilhaCom("Tarefas_Default", "T2", null)),
    Error,
    "natureza",
  );
  assertThrows(
    () => lerModelosNx(planilhaCom("Tarefas_Default", "T2", "Preparação")),
    Error,
    "natureza",
  );
});

Deno.test("import-spec: ator fora da lista dá erro", () => {
  assertThrows(
    () => lerModelosNx(planilhaCom("Tarefas_Default", "U2", "empresa")),
    Error,
    "ator",
  );
});

Deno.test("import-spec: id calculado diferente do Glossario dá erro", () => {
  // NX-T01 passa de preambulo_quadro_datas (DAT) para objeto (OBJ); o Glossario guardado ainda diz DAT.
  assertThrows(
    () => lerModelosNx(planilhaCom("Tarefas_Default", "P2", "objeto")),
    Error,
    "Glossario 3",
  );
});

Deno.test("import-spec: prazo em horas e em evento ao mesmo tempo (ou nenhum) dá erro", () => {
  assertThrows(
    () => lerModelosNx(planilhaCom("Tarefas_Default", "E2", null)),
    Error,
    "prazo",
  );
  assertThrows(
    () => lerModelosNx(planilhaCom("Tarefas_Default", "F2", "na abertura")),
    Error,
    "prazo",
  );
});

Deno.test("import-spec: código reservado com natureza preenchida dá erro", () => {
  assertThrows(
    () => lerModelosNx(planilhaCom("Tarefas_Default", "T35", "preparacao")),
    Error,
    "reservado",
  );
});

Deno.test("import-spec: etapa do Glossario ausente na Pipeline_Etapas dá erro", () => {
  assertThrows(
    () => lerModelosNx(planilhaCom("Pipeline_Etapas", "C3", "Triagem inicial")),
    Error,
    "Pipeline_Etapas",
  );
});

/** Cópia da planilha real com várias células trocadas (null apaga). */
function planilhaComVarias(
  mudancas: Array<[string, string, string | number | null]>,
): XLSX.WorkBook {
  const c = lerPlanilha(PLANILHA);
  for (const [aba, celula, valor] of mudancas) {
    const ws = c.Sheets[aba];
    if (valor === null) delete ws[celula];
    else {ws[celula] = typeof valor === "number"
        ? { t: "n", v: valor }
        : { t: "s", v: valor };}
  }
  return c;
}

const erroModelos = (
  aba: string,
  celula: string,
  valor: string | number | null,
  msg: string,
) =>
  assertThrows(() => lerModelosNx(planilhaCom(aba, celula, valor)), Error, msg);

// Regressão (revisor-codigo, PR 2): estes três casos geravam SQL incompleto sem erro.
Deno.test("import-spec: linha vazia no meio da Tarefas_Default dá erro (não corta a importação)", () => {
  erroModelos("Tarefas_Default", "A27", null, "vazia");
});

Deno.test("import-spec: condição começando com 'nunca' não torna a tarefa reservada", () => {
  const { modelos } = lerModelosNx(
    planilhaCom("Tarefas_Default", "G2", "nunca se consórcio"),
  );
  assertEquals(modelos.length, 23);
  assertEquals(modelos.find((m) => m.curto === "NX-T01")?.condicao, {
    condicao_nx: "nunca se consórcio",
  });
});

Deno.test("import-spec: bloco_padrao vazio dá erro (só '—' vira GER)", () => {
  erroModelos("Tarefas_Default", "P26", null, "bloco_padrao");
});

Deno.test("import-spec: reservado sem a marca na planilha dá erro", () => {
  erroModelos("Tarefas_Default", "G35", "sempre", "reserva divergente");
});

Deno.test("import-spec: bloco ou etapa fora do Glossario dá erro", () => {
  erroModelos("Tarefas_Default", "P2", "bloco_inexistente", "Glossario 2b");
  erroModelos("Tarefas_Default", "B2", "Etapa inexistente", "Glossario 2a");
});

Deno.test("import-spec: NX-T repetido ou fora do Glossario 3 dá erro", () => {
  erroModelos("Tarefas_Default", "A3", "NX-T01", "repetido");
  erroModelos("Glossario", "A77", null, "Glossario 3");
});

Deno.test("import-spec: condição, título ou critério vazio dá erro", () => {
  erroModelos("Tarefas_Default", "G2", null, "condição vazia");
  erroModelos("Tarefas_Default", "C2", null, "vazio");
  erroModelos("Tarefas_Default", "H2", null, "vazio");
});

Deno.test("import-spec: responsável fora do formato dá erro", () => {
  erroModelos("Tarefas_Default", "D2", "time jurídico", "responsável");
});

Deno.test("import-spec: prazo em horas zero, fracionado ou em texto dá erro", () => {
  for (const v of [0, 4.5, "48"]) {
    erroModelos("Tarefas_Default", "E2", v, "prazo_horas_apos_etapa");
  }
});

Deno.test("import-spec: Glossario 3 apontando outro modelo da 14.133 que o de-para dá erro", () => {
  erroModelos("Glossario", "I48", "14133-F01-T05", "Glossario 3 aponta");
});

Deno.test("import-spec: grupo divergente entre Glossario 2a e Pipeline_Etapas dá erro", () => {
  erroModelos("Pipeline_Etapas", "B3", "Preparação", "grupo");
});

Deno.test("import-spec: R12 renomeada dá erro (macro contrato amarrada ao nome)", () => {
  assertThrows(
    () =>
      lerModelosNx(planilhaComVarias([
        ["Glossario", "C28", "Execução"],
        ["Pipeline_Etapas", "C13", "Execução"],
      ])),
    Error,
    "macro contrato",
  );
});

Deno.test("import-spec: aspas simples escapadas no seed de modelos", () => {
  const base = lerModelosNx(wb);
  const m = {
    ...base.modelos[0],
    titulo: "D'Ávila",
    condicao: { condicao_nx: "se o órgão 'exigir'" },
  };
  const sql = gerarSeedModelosSql({ ...base, modelos: [m] });
  assert(sql.includes("'D''Ávila'"));
  assert(sql.includes(`'{"condicao_nx":"se o órgão ''exigir''"}'::jsonb`));
});

// ---------------------------------------------------------------------------------------------------------------
// PR 3b: blocos legais (Padrao_Lei, seções 1 e 2)
// ---------------------------------------------------------------------------------------------------------------
const MIGRATION_BLOCOS = new URL(
  "../../../supabase/migrations/20261108230000_nexor_blocos_legais.sql",
  import.meta.url,
);

Deno.test("import-spec (blocos): 22 blocos × 5 procedimentos, todos da Lei 14.133", () => {
  const b = lerBlocosLegais(wb);
  assertEquals(b.length, 110);
  assertEquals(new Set(b.map((x) => x.bloco)).size, 22);
  assertEquals(
    [...new Set(b.map((x) => x.procedimento))],
    ["pregao", "concorrencia", "dispensa", "inexigibilidade", "credenciamento"],
  );
  assert(b.every((x) => x.regime_id === "lei_14133"));
  assertEquals(b.filter((x) => x.procedimento === "pregao").map((x) => x.ordem), Array.from({ length: 22 }, (_, i) => i + 1));
});

Deno.test("import-spec (blocos): célula da matriz vira status, prazo e confiança", () => {
  const b = lerBlocosLegais(wb);
  const um = (proc: string, bloco: string) => b.find((x) => x.procedimento === proc && x.bloco === bloco)!;
  const imp = um("pregao", "impugnacao_esclarecimento");
  assertEquals(
    [imp.status, imp.prazo_quantidade, imp.prazo_unidade, imp.prazo_sentido, imp.prazo_ancora, imp.confianca],
    ["obrigatorio", 3, "du", "antes", "abertura_sessao", "alta"],
  );
  assert(imp.base_legal?.includes("art. 164"));
  assertEquals(imp.parte_obrigada, "licitante");
  assert(imp.temas_rag?.includes("prazo_impugnacao"));
  const inex = um("inexigibilidade", "valor_estimado_sigilo");
  assertEquals([inex.prazo_quantidade, inex.prazo_unidade, inex.prazo_sentido, inex.prazo_ancora], [1, "anos", "antes", "contratacao"]);
  const cred = um("credenciamento", "impugnacao_esclarecimento");
  assertEquals([cred.prazo_sentido, cred.prazo_ancora], ["depois", "recebimento_pedido"]);
  const na = um("inexigibilidade", "proposta");
  assertEquals([na.status, na.prazo_quantidade, na.confianca], ["nao_aplica", null, "media"]);
  const anexos = um("pregao", "anexos_obrigatorios");
  assertEquals([anexos.prazo_quantidade, anexos.prazo_unidade], [0, "dc"]);
  // Proposta no pregão: sem quantidade, mas "até a abertura" (sentido e âncora da seção 2).
  const prop = um("pregao", "proposta");
  assertEquals([prop.prazo_quantidade, prop.prazo_unidade, prop.prazo_sentido, prop.prazo_ancora], [null, null, "antes", "abertura_sessao"]);
});

Deno.test("import-spec (blocos): detalhe (condição, base legal) só no pregão; os outros ficam null", () => {
  const b = lerBlocosLegais(wb);
  assert(b.filter((x) => x.procedimento === "pregao").every((x) => x.base_legal && x.condicao && x.parte_obrigada));
  assert(
    b.filter((x) => x.procedimento !== "pregao").every((x) =>
      x.base_legal === null && x.condicao === null && x.parte_obrigada === null && x.temas_rag === null &&
      x.variacoes === null
    ),
  );
});

Deno.test("import-spec (blocos): célula fora do padrão dá erro com a célula", () => {
  assertThrows(() => lerBlocosLegais(planilhaCom("Padrao_Lei", "B9", "Obrigatório")), Error, "B9");
  assertThrows(() => lerBlocosLegais(planilhaCom("Padrao_Lei", "C9", "Obrig. · 3 semanas antes abertura_sessao [alta]")), Error, "C9");
  assertThrows(() => lerBlocosLegais(planilhaCom("Padrao_Lei", "D9", null)), Error, "D9");
});

Deno.test("import-spec (blocos): pregão da matriz divergente do detalhe dá erro", () => {
  assertThrows(() => lerBlocosLegais(planilhaCom("Padrao_Lei", "E34", 4)), Error, "diverge");
  assertThrows(() => lerBlocosLegais(planilhaCom("Padrao_Lei", "L34", "media")), Error, "diverge");
  assertThrows(() => lerBlocosLegais(planilhaCom("Padrao_Lei", "B34", "condicional")), Error, "diverge");
  assertThrows(() => lerBlocosLegais(planilhaCom("Padrao_Lei", "A34", "bloco_inexistente")), Error, "bloco_inexistente");
});

Deno.test("import-spec (blocos): seção 2 sem Lei 14.133 no título dá erro (regime não é adivinhado)", () => {
  assertThrows(() => lerBlocosLegais(planilhaCom("Padrao_Lei", "A27", "2. PREGÃO – DETALHE POR BLOCO")), Error, "14.133");
});

Deno.test("import-spec (blocos): bloco da migration é o que o script gera da planilha", () => {
  const sql = Deno.readTextFileSync(MIGRATION_BLOCOS);
  const i = sql.indexOf(MARCA_BLOCOS_INICIO);
  const j = sql.indexOf(MARCA_BLOCOS_FIM);
  assert(i >= 0 && j > i, "marcas do bloco gerado não encontradas na migration");
  assertEquals(sql.slice(i, j + MARCA_BLOCOS_FIM.length), gerarSeedBlocosSql(lerBlocosLegais(wb)));
});

Deno.test("import-spec (blocos): coluna a mais (procedimento ou campo novo) dá erro, não some", () => {
  assertThrows(() => lerBlocosLegais(planilhaCom("Padrao_Lei", "G3", "leilao")), Error, "G3");
  assertThrows(() => lerBlocosLegais(planilhaCom("Padrao_Lei", "G4", "Obrig. [alta]")), Error, "G4");
  // Fora do intervalo da aba (A1:L59): o Excel amplia o !ref ao gravar; aqui amplia-se à mão.
  const comM = (celulaM: string, v: string) => {
    const c = planilhaCom("Padrao_Lei", celulaM, v);
    c.Sheets["Padrao_Lei"]["!ref"] = "A1:M59";
    return c;
  };
  assertThrows(() => lerBlocosLegais(comM("M28", "prazo_obs")), Error, "M28");
  assertThrows(() => lerBlocosLegais(comM("M34", "x")), Error, "M34");
});

Deno.test("import-spec (blocos): linha em branco no meio das duas seções dá erro, não corta blocos", () => {
  const apagar = (linha: number, ate: string) =>
    [..."ABCDEFGHIJKL".slice(0, "ABCDEFGHIJKL".indexOf(ate) + 1)].map((c) =>
      ["Padrao_Lei", `${c}${linha}`, null] as [string, string, null]
    );
  assertThrows(
    () => lerBlocosLegais(planilhaComVarias([...apagar(15, "F"), ...apagar(40, "L")])),
    Error,
    "linha em branco",
  );
});

Deno.test("import-spec (blocos): unidade com nome de propriedade herdada dá erro com a célula", () => {
  assertThrows(
    () => lerBlocosLegais(planilhaCom("Padrao_Lei", "C9", "Obrig. · 3 constructor antes abertura_sessao [alta]")),
    Error,
    "C9",
  );
});
