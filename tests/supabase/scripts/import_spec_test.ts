import { assert, assertEquals, assertThrows } from "jsr:@std/assert@1";
import * as XLSX from "npm:xlsx@0.18.5";
import {
  dataIso,
  digitoVerificador,
  gerarSeedModelosSql,
  gerarSeedSql,
  idModelo,
  lerFeriados,
  lerModelosNx,
  lerPlanilha,
  lerRegimes,
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

Deno.test("import-spec: 23 modelos NX (18 novos + 5 parciais), sem LG-T34 e sem os do de-para", () => {
  const { modelos } = lerModelosNx(wb);
  assertEquals(modelos.length, 23);
  const lgT = new Set(modelos.map((m) => m.lgT));
  for (const x of ["LG-T09", "LG-T11", "LG-T20", "LG-T21", "LG-T32"]) {
    assert(lgT.has(x), `falta ${x}`);
  }
  for (const x of ["LG-T02", "LG-T05", "LG-T16", "LG-T18", "LG-T34"]) {
    assert(!lgT.has(x), `${x} não vira modelo NX`);
  }
  assert(
    modelos.every((m) =>
      /^NX\.GEN\.[APSR]\d{2}\.[A-Z]{3}\.\d{3}-\d$/.test(m.codigo)
    ),
  );
});

Deno.test("import-spec: apelidos (33 LG-T, LG-T18 com dois modelos, NX dos mapeados)", () => {
  const { apelidos } = lerModelosNx(wb);
  assertEquals(apelidos.length, 45);
  assertEquals(
    new Set(apelidos.filter((a) => a.sistema === "lg_t").map((a) => a.apelido))
      .size,
    33,
  );
  assertEquals(
    apelidos.filter((a) => a.apelido === "LG-T18").map((a) => a.tarefa_codigo),
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
  assert(!apelidos.some((a) => a.apelido === "LG-T34"));
});

Deno.test("import-spec: prazo e condição seguem a planilha, sem inventar regra", () => {
  const m = new Map(lerModelosNx(wb).modelos.map((x) => [x.lgT, x]));
  const t01 = m.get("LG-T01")!;
  assertEquals([t01.prazoUnidade, t01.prazoHoras, t01.prazoObservacao], [
    "sem_prazo_legal",
    4,
    null,
  ]);
  assertEquals(t01.condicao, {});
  const t20 = m.get("LG-T20")!;
  assertEquals([t20.prazoUnidade, t20.prazoHoras, t20.prazoObservacao], [
    "definido_no_edital",
    null,
    "5 dias úteis após convocação",
  ]);
  assertEquals(m.get("LG-T33")!.condicao, { condicao_nx: "se vencedor" });
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
  // LG-T01 passa de preambulo_quadro_datas (DAT) para objeto (OBJ); o Glossario guardado ainda diz DAT.
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
  assertEquals(modelos.find((m) => m.lgT === "LG-T01")?.condicao, {
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

Deno.test("import-spec: LG-T repetido ou fora do Glossario 3 dá erro", () => {
  erroModelos("Tarefas_Default", "A3", "LG-T01", "repetido");
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
