// Gera o bloco de seed da migration a partir da planilha da spec Nexor (specs/nexor_spec.xlsx).
//
// Não grava no banco: dado só entra por migration versionada (CLAUDE.md). O script lê a planilha e devolve SQL
// idempotente; o teste tests/supabase/scripts/import_spec_test.ts confere que o bloco gerado é o mesmo que está na
// migration, para a planilha e o banco não divergirem em silêncio.
//
// Uso:
//   deno run --allow-read scripts/import-spec.ts [specs/nexor_spec.xlsx]
//   (com um package.json acima do repositório, prefixe DENO_NO_PACKAGE_JSON=1)
//
// Dependência: npm:xlsx@0.18.5 é a última versão do SheetJS no npm e tem CVE-2023-30533 e CVE-2024-22363. Risco aceito
// enquanto a entrada for só a planilha versionada no repositório (revisada em PR); nunca importar este arquivo em
// supabase/functions/**.
//
// Fase 0 (PR 1): feriados nacionais (Documentacao_Edital, M34:O52) e regimes (Padrao_Lei, seção 3).
// Etapas, modelos de tarefa e blocos legais entram no PR seguinte, depois das decisões listadas em
// specs/nexor-fase0-mapa.md.

import * as XLSX from "npm:xlsx@0.18.5";

export type Feriado = { data: string; nome: string; fundamento: string };
export type Regime = { id: string; norma: string; situacao_pesquisa: string };

export const MARCA_INICIO = "-- >>> gerado por scripts/import-spec.ts: não editar à mão";
export const MARCA_FIM = "-- <<< fim do bloco gerado";

type Linha = unknown[];

function linhas(wb: XLSX.WorkBook, aba: string): Linha[] {
  const ws = wb.Sheets[aba];
  if (!ws) throw new Error(`aba "${aba}" não encontrada na planilha`);
  return XLSX.utils.sheet_to_json<Linha>(ws, { header: 1, raw: true, defval: null, blankrows: true });
}

function texto(v: unknown): string {
  return typeof v === "string" ? v.trim() : v === null || v === undefined ? "" : String(v).trim();
}

function semVazioNemRepetido<T>(lista: T[], chave: (x: T) => string, nome: string): T[] {
  if (lista.length === 0) throw new Error(`nenhum registro de ${nome} na planilha`);
  const vistas = new Set<string>();
  for (const x of lista) {
    const k = chave(x);
    if (vistas.has(k)) throw new Error(`${nome}: chave repetida "${k}"`);
    vistas.add(k);
  }
  return lista;
}

export function dataIso(v: unknown): string {
  // Serial do Excel (sistema 1900, válido a partir de 01/03/1900): dias desde 30/12/1899. Data sem hora.
  if (typeof v !== "number" || !Number.isInteger(v) || v < 61) {
    throw new Error(`data inválida na planilha: ${JSON.stringify(v)}`);
  }
  return new Date(Date.UTC(1899, 11, 30) + v * 86_400_000).toISOString().slice(0, 10);
}

/** Tabela "Feriados nacionais (lei federal)" da aba Documentacao_Edital, colunas M:O. */
export function lerFeriados(wb: XLSX.WorkBook): Feriado[] {
  if (wb.Workbook?.WBProps?.date1904) throw new Error("planilha no sistema de datas 1904: converta para 1900");
  const ls = linhas(wb, "Documentacao_Edital");
  const col = 12; // M
  const titulo = ls.findIndex((l) => texto(l[col]).startsWith("Feriados nacionais"));
  if (titulo < 0) throw new Error('tabela "Feriados nacionais" não encontrada em Documentacao_Edital, coluna M');
  const cab = ls[titulo + 1] ?? [];
  if (texto(cab[col]) !== "data" || texto(cab[col + 1]) !== "feriado" || texto(cab[col + 2]) !== "base legal") {
    throw new Error("cabeçalho da tabela de feriados mudou (esperado: data | feriado | base legal)");
  }
  const out: Feriado[] = [];
  for (let i = titulo + 2; i < ls.length; i++) {
    const l = ls[i];
    if (l[col] === null || l[col] === undefined || texto(l[col]) === "") break;
    const nome = texto(l[col + 1]);
    const fundamento = texto(l[col + 2]);
    if (!nome || !fundamento) throw new Error(`feriado sem nome ou base legal na linha ${i + 1}`);
    out.push({ data: dataIso(l[col]), nome, fundamento });
  }
  return semVazioNemRepetido(out, (x) => x.data, "feriados");
}

/** Seção "3. REGIMES" da aba Padrao_Lei. */
export function lerRegimes(wb: XLSX.WorkBook): Regime[] {
  const ls = linhas(wb, "Padrao_Lei");
  const titulo = ls.findIndex((l) => texto(l[0]).startsWith("3. REGIMES"));
  if (titulo < 0) throw new Error('seção "3. REGIMES" não encontrada em Padrao_Lei');
  const cab = ls[titulo + 1] ?? [];
  if (texto(cab[0]) !== "id" || texto(cab[1]) !== "norma" || texto(cab[2]) !== "situação da pesquisa") {
    throw new Error("cabeçalho de regimes mudou (esperado: id | norma | situação da pesquisa)");
  }
  const out: Regime[] = [];
  for (let i = titulo + 2; i < ls.length; i++) {
    const id = texto(ls[i][0]);
    if (!id) break;
    if (!/^[a-z0-9_]+$/.test(id)) throw new Error(`id de regime inválido: "${id}"`);
    const norma = texto(ls[i][1]);
    const situacao_pesquisa = texto(ls[i][2]);
    if (!norma || !situacao_pesquisa) throw new Error(`regime "${id}" sem norma ou situação na linha ${i + 1}`);
    out.push({ id, norma, situacao_pesquisa });
  }
  return semVazioNemRepetido(out, (x) => x.id, "regimes");
}

function lit(s: string): string {
  return `'${s.replaceAll("'", "''")}'`;
}

// on conflict ... do update: a planilha versionada é a fonte. Feriado que sair da planilha não é apagado aqui;
// remoção exige migration própria, com justificativa.
export function gerarSeedSql(feriados: Feriado[], regimes: Regime[]): string {
  const f = feriados.map((x) => `  (date ${lit(x.data)}, ${lit(x.nome)}, ${lit(x.fundamento)})`).join(",\n");
  const r = regimes.map((x) => `  (${lit(x.id)}, ${lit(x.norma)}, ${lit(x.situacao_pesquisa)})`).join(",\n");
  return [
    MARCA_INICIO,
    "insert into public.feriados_nacionais (data, nome, fundamento) values",
    f,
    "on conflict (data) do update set nome = excluded.nome, fundamento = excluded.fundamento;",
    "",
    "insert into public.regimes (id, norma, situacao_pesquisa) values",
    r,
    "on conflict (id) do update set norma = excluded.norma, situacao_pesquisa = excluded.situacao_pesquisa;",
    MARCA_FIM,
  ].join("\n");
}

export function lerPlanilha(caminho: string | URL): XLSX.WorkBook {
  return XLSX.read(Deno.readFileSync(caminho), { type: "array" });
}

if (import.meta.main) {
  const caminho = Deno.args[0] ?? "specs/nexor_spec.xlsx";
  const wb = lerPlanilha(caminho);
  console.log(gerarSeedSql(lerFeriados(wb), lerRegimes(wb)));
}
