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
// Fase 0, PR 1: feriados nacionais (Documentacao_Edital, M34:O52) e regimes (Padrao_Lei, seção 3).
// Fase 0, PR 2: etapas NX (Glossario 2a + Pipeline_Etapas), modelos NX (Tarefas_Default + Glossario 2b/3) e apelidos
// NX-T/NX (de-para aprovado em specs/nexor-de-para-tarefas.md). Decisões em specs/nexor-fase0-mapa.md.
//
// Uso do bloco do PR 2: deno run --allow-read scripts/import-spec.ts [planilha] --bloco=modelos

import * as XLSX from "npm:xlsx@0.18.5";

export type Feriado = { data: string; nome: string; fundamento: string };
export type Regime = { id: string; norma: string; situacao_pesquisa: string };

export const MARCA_INICIO =
  "-- >>> gerado por scripts/import-spec.ts: não editar à mão";
export const MARCA_FIM = "-- <<< fim do bloco gerado";

type Linha = unknown[];

function linhas(wb: XLSX.WorkBook, aba: string): Linha[] {
  const ws = wb.Sheets[aba];
  if (!ws) throw new Error(`aba "${aba}" não encontrada na planilha`);
  return XLSX.utils.sheet_to_json<Linha>(ws, {
    header: 1,
    raw: true,
    defval: null,
    blankrows: true,
  });
}

function texto(v: unknown): string {
  return typeof v === "string"
    ? v.trim()
    : v === null || v === undefined
    ? ""
    : String(v).trim();
}

function semVazioNemRepetido<T>(
  lista: T[],
  chave: (x: T) => string,
  nome: string,
): T[] {
  if (lista.length === 0) {
    throw new Error(`nenhum registro de ${nome} na planilha`);
  }
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
  return new Date(Date.UTC(1899, 11, 30) + v * 86_400_000).toISOString().slice(
    0,
    10,
  );
}

/** Tabela "Feriados nacionais (lei federal)" da aba Documentacao_Edital, colunas M:O. */
export function lerFeriados(wb: XLSX.WorkBook): Feriado[] {
  if (wb.Workbook?.WBProps?.date1904) {
    throw new Error("planilha no sistema de datas 1904: converta para 1900");
  }
  const ls = linhas(wb, "Documentacao_Edital");
  const col = 12; // M
  const titulo = ls.findIndex((l) =>
    texto(l[col]).startsWith("Feriados nacionais")
  );
  if (titulo < 0) {
    throw new Error(
      'tabela "Feriados nacionais" não encontrada em Documentacao_Edital, coluna M',
    );
  }
  const cab = ls[titulo + 1] ?? [];
  if (
    texto(cab[col]) !== "data" || texto(cab[col + 1]) !== "feriado" ||
    texto(cab[col + 2]) !== "base legal"
  ) {
    throw new Error(
      "cabeçalho da tabela de feriados mudou (esperado: data | feriado | base legal)",
    );
  }
  const out: Feriado[] = [];
  for (let i = titulo + 2; i < ls.length; i++) {
    const l = ls[i];
    if (l[col] === null || l[col] === undefined || texto(l[col]) === "") break;
    const nome = texto(l[col + 1]);
    const fundamento = texto(l[col + 2]);
    if (!nome || !fundamento) {
      throw new Error(`feriado sem nome ou base legal na linha ${i + 1}`);
    }
    out.push({ data: dataIso(l[col]), nome, fundamento });
  }
  return semVazioNemRepetido(out, (x) => x.data, "feriados");
}

/** Seção "3. REGIMES" da aba Padrao_Lei. */
export function lerRegimes(wb: XLSX.WorkBook): Regime[] {
  const ls = linhas(wb, "Padrao_Lei");
  const titulo = ls.findIndex((l) => texto(l[0]).startsWith("3. REGIMES"));
  if (titulo < 0) {
    throw new Error('seção "3. REGIMES" não encontrada em Padrao_Lei');
  }
  const cab = ls[titulo + 1] ?? [];
  if (
    texto(cab[0]) !== "id" || texto(cab[1]) !== "norma" ||
    texto(cab[2]) !== "situação da pesquisa"
  ) {
    throw new Error(
      "cabeçalho de regimes mudou (esperado: id | norma | situação da pesquisa)",
    );
  }
  const out: Regime[] = [];
  for (let i = titulo + 2; i < ls.length; i++) {
    const id = texto(ls[i][0]);
    if (!id) break;
    if (!/^[a-z0-9_]+$/.test(id)) {
      throw new Error(`id de regime inválido: "${id}"`);
    }
    const norma = texto(ls[i][1]);
    const situacao_pesquisa = texto(ls[i][2]);
    if (!norma || !situacao_pesquisa) {
      throw new Error(`regime "${id}" sem norma ou situação na linha ${i + 1}`);
    }
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
  const f = feriados.map((x) =>
    `  (date ${lit(x.data)}, ${lit(x.nome)}, ${lit(x.fundamento)})`
  ).join(",\n");
  const r = regimes.map((x) =>
    `  (${lit(x.id)}, ${lit(x.norma)}, ${lit(x.situacao_pesquisa)})`
  ).join(",\n");
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

// ---------------------------------------------------------------------------------------------------------------
// PR 2: etapas e modelos NX
// ---------------------------------------------------------------------------------------------------------------

export const MARCA_MODELOS_INICIO =
  "-- >>> gerado por scripts/import-spec.ts (modelos NX): não editar à mão";
export const MARCA_MODELOS_FIM = "-- <<< fim do bloco gerado (modelos NX)";

export const NATUREZAS = [
  "obrigacao",
  "faculdade",
  "direito",
  "acompanhamento",
  "preparacao",
] as const;
export const ATORES = [
  "licitante",
  "contratado",
  "licitante_ou_contratado",
] as const;

/**
 * Etapas da macrofase de contrato (código → nome esperado); as demais são do certame (decisão em
 * specs/nexor-fase0-mapa.md). O nome é conferido: se a planilha renumerar as etapas, o script falha.
 */
const ETAPAS_CONTRATO: ReadonlyMap<string, string> = new Map([[
  "R12",
  "Ata e execução",
]]);

/** Códigos NX-T reservados (descontinuados): não viram modelo nem apelido. NX-T34 foi fundido no NX-T09 em 07/11. */
export const RESERVADOS: ReadonlySet<string> = new Set(["NX-T34"]);

/** Responsável sugerido pela planilha: papel ou agente, podendo combinar com " + " (ex.: "agente:edital + agente:precos"). */
const RESPONSAVEL_RE =
  /^(papel:(admin|operacao)|agente:[a-z_]+)( \+ (papel:(admin|operacao)|agente:[a-z_]+))*$/;

/**
 * De-para aprovado em 07/11/2026 (specs/nexor-de-para-tarefas.md): NX-T que **não** vira modelo NX novo, porque o
 * modelo da 14.133 já cobre (7 iguais + 3 parciais com apelido). NX-T18 aponta para dois modelos.
 */
export const DE_PARA_14133: Readonly<Record<string, readonly string[]>> = {
  "NX-T02": ["14133-F01-T01"],
  "NX-T05": ["14133-F01-T04"],
  "NX-T13": ["14133-F01-T10"],
  "NX-T14": ["14133-F01-T09"],
  "NX-T16": ["14133-F04-T01"],
  "NX-T17": ["14133-F02-T04"],
  "NX-T18": ["14133-F05-T01", "14133-F05-T02"],
  "NX-T19": ["14133-F06-T04"],
  "NX-T22": ["14133-F08-T01"],
  "NX-T24": ["14133-F12-T02"],
};

export type EtapaNx = {
  codigo: string;
  ordem: number;
  nome: string;
  macro: "certame" | "contrato";
  descricao: string;
};

export type ModeloNx = {
  codigo: string;
  /** Código curto da planilha (NX-Txx, antigo LG-Txx). */
  curto: string;
  fase: string;
  ordem: number;
  titulo: string;
  criterio: string;
  responsavel: string;
  natureza: string;
  ator: string;
  prazoUnidade: "sem_prazo_legal" | "definido_no_edital";
  prazoHoras: number | null;
  prazoObservacao: string | null;
  condicao: Record<string, string>;
};

export type Apelido = {
  sistema: "nx" | "nx_t";
  apelido: string;
  tarefa_codigo: string;
};

export type ModelosNx = {
  etapas: EtapaNx[];
  modelos: ModeloNx[];
  apelidos: Apelido[];
};

/** Dígito verificador do identificador: MOD(Σ código do caractere × posição (1..n); 10). Glossario, linha 10. */
export function digitoVerificador(semDv: string): number {
  let soma = 0;
  for (let i = 0; i < semDv.length; i++) soma += semDv.charCodeAt(i) * (i + 1);
  return soma % 10;
}

/** Origem.Regime.Etapa.Bloco.Seq-DV (Glossario, seção 1). */
export function idModelo(
  origem: string,
  regime: string,
  etapa: string,
  bloco: string,
  seq: number,
): string {
  const semDv = `${origem}.${regime}.${etapa}.${bloco}.${
    String(seq).padStart(3, "0")
  }`;
  return `${semDv}-${digitoVerificador(semDv)}`;
}

function achar(ls: Linha[], col: number, prefixo: string, aba: string): number {
  const i = ls.findIndex((l) => texto(l[col]).startsWith(prefixo));
  if (i < 0) throw new Error(`"${prefixo}" não encontrado em ${aba}`);
  return i;
}

function exigirCabecalho(
  l: Linha,
  col: number,
  esperado: string[],
  onde: string,
): void {
  const achado = esperado.map((_, k) => texto(l[col + k]));
  if (achado.join("|") !== esperado.join("|")) {
    throw new Error(
      `cabeçalho de ${onde} mudou (esperado: ${esperado.join(" | ")}; achei: ${
        achado.join(" | ")
      })`,
    );
  }
}

/** Glossario 2a (etapas) + Pipeline_Etapas (entrada automática, gatilho e guardrail, copiados como estão). */
export function lerEtapasNx(wb: XLSX.WorkBook): EtapaNx[] {
  const g = linhas(wb, "Glossario");
  const t = achar(g, 0, "2a. Códigos de etapa", "Glossario");
  exigirCabecalho(
    g[t + 1] ?? [],
    0,
    ["codigo", "grupo", "etapa"],
    "Glossario 2a",
  );

  const p = linhas(wb, "Pipeline_Etapas");
  exigirCabecalho(
    p[0] ?? [],
    0,
    [
      "ordem",
      "grupo",
      "coluna_nova",
      "coluna_atual",
      "tarefas_padrao",
      "entrada_automatica",
      "fonte_do_gatilho",
      "guardrail",
    ],
    "Pipeline_Etapas",
  );
  const porNome = new Map<string, Linha>();
  for (const l of p.slice(1)) {
    if (typeof l[0] !== "number") break;
    porNome.set(texto(l[2]), l);
  }

  const out: EtapaNx[] = [];
  for (let i = t + 2; i < g.length; i++) {
    const codigo = texto(g[i][0]);
    if (!codigo) break;
    if (!/^[APSR]\d{2}$/.test(codigo)) {
      throw new Error(`código de etapa inválido no Glossario: "${codigo}"`);
    }
    const grupo = texto(g[i][1]);
    const nome = texto(g[i][2]);
    const pe = porNome.get(nome);
    if (!pe) {
      throw new Error(
        `etapa "${nome}" (${codigo}) do Glossario não está em Pipeline_Etapas`,
      );
    }
    if (texto(pe[1]) !== grupo) {
      throw new Error(
        `etapa ${codigo}: grupo "${grupo}" no Glossario, "${
          texto(pe[1])
        }" na Pipeline_Etapas`,
      );
    }
    const ordem = Number(pe[0]);
    if (Number(codigo.slice(1)) !== ordem) {
      throw new Error(`etapa ${codigo}: ordem ${ordem} na Pipeline_Etapas`);
    }
    const partes = [
      `Grupo: ${grupo}.`,
      `Coluna atual no pipeline: ${texto(pe[3])}.`,
    ];
    for (
      const [rotulo, v] of [["Entrada automática", pe[5]], ["Gatilho", pe[6]], [
        "Guardrail",
        pe[7],
      ]] as const
    ) {
      const s = texto(v);
      if (s && s !== "—") {
        partes.push(`${rotulo}: ${s}${/[.!?]$/.test(s) ? "" : "."}`);
      }
    }
    const nomeContrato = ETAPAS_CONTRATO.get(codigo);
    if (nomeContrato !== undefined && nomeContrato !== nome) {
      throw new Error(
        `etapa ${codigo} deveria ser "${nomeContrato}" (macro contrato), achei "${nome}"`,
      );
    }
    out.push({
      codigo,
      ordem,
      nome,
      macro: nomeContrato !== undefined ? "contrato" : "certame",
      descricao: partes.join(" "),
    });
  }
  for (const [codigo, nome] of ETAPAS_CONTRATO) {
    if (!out.some((e) => e.codigo === codigo)) {
      throw new Error(
        `etapa de contrato ${codigo} (${nome}) ausente no Glossario 2a`,
      );
    }
  }
  if (out.length !== porNome.size) {
    throw new Error(
      `Glossario 2a tem ${out.length} etapas e Pipeline_Etapas tem ${porNome.size}`,
    );
  }
  return semVazioNemRepetido(out, (x) => x.codigo, "etapas NX");
}

/** Glossario 2b: bloco_padrao → código de 3 letras. "—" (sem bloco) está na própria tabela, como GER. */
function lerBlocos(wb: XLSX.WorkBook): Map<string, string> {
  const g = linhas(wb, "Glossario");
  const t = achar(g, 4, "2b. Códigos de bloco", "Glossario");
  exigirCabecalho(
    g[t + 1] ?? [],
    4,
    ["codigo", "bloco_padrao", "descrição"],
    "Glossario 2b",
  );
  const m = new Map<string, string>();
  for (let i = t + 2; i < g.length; i++) {
    const cod = texto(g[i][4]);
    if (!cod) break;
    if (!/^[A-Z]{3}$/.test(cod)) {
      throw new Error(`código de bloco inválido no Glossario: "${cod}"`);
    }
    const bloco = texto(g[i][5]);
    if (m.has(bloco)) {
      throw new Error(`bloco "${bloco}" repetido no Glossario 2b`);
    }
    m.set(bloco, cod);
  }
  if (m.size === 0) throw new Error("nenhum bloco no Glossario 2b");
  return m;
}

type LinhaGlossario = { idModelo: string; codigoBanco: string };

/**
 * Glossario 3: id_modelo com origem NX (calculado pela planilha) e codigo_catalogo_banco. Usado só para conferir o
 * cálculo deste script e o de-para; é uma contagem independente (INDEX sobre a tabela TarefasDefault inteira).
 */
function lerIdsGlossario(wb: XLSX.WorkBook): Map<string, LinhaGlossario> {
  const g = linhas(wb, "Glossario");
  const t = achar(g, 0, "3. Glossário das tarefas", "Glossario");
  const cab = g[t + 1] ?? [];
  if (
    texto(cab[0]) !== "codigo_legado" || texto(cab[7]) !== "id_modelo" ||
    texto(cab[8]) !== "codigo_catalogo_banco"
  ) {
    throw new Error(
      "cabeçalho do Glossario 3 mudou (esperado: codigo_legado em A, id_modelo em H, codigo_catalogo_banco em I)",
    );
  }
  const m = new Map<string, LinhaGlossario>();
  for (let i = t + 2; i < g.length; i++) {
    const cod = texto(g[i][0]);
    if (!/^NX-T\d{2}$/.test(cod)) break;
    if (m.has(cod)) throw new Error(`${cod} repetido no Glossario 3`);
    m.set(cod, { idModelo: texto(g[i][7]), codigoBanco: texto(g[i][8]) });
  }
  if (m.size === 0) throw new Error("nenhuma tarefa no Glossario 3");
  return m;
}

const CAB_TAREFAS = [
  "codigo",
  "etapa_gatilho",
  "titulo",
  "responsavel",
  "prazo_horas_apos_etapa",
  "prazo_evento",
  "condicao",
  "criterio_conclusao",
];

/** Tarefas_Default + Glossario → etapas, modelos NX novos e apelidos. Erro em qualquer divergência, nunca valor inventado. */
export function lerModelosNx(wb: XLSX.WorkBook): ModelosNx {
  const etapas = lerEtapasNx(wb);
  const etapaPorNome = new Map(etapas.map((e) => [e.nome, e.codigo]));
  const blocos = lerBlocos(wb);
  const idsGlossario = lerIdsGlossario(wb);

  const ls = linhas(wb, "Tarefas_Default");
  const cab = ls[0] ?? [];
  exigirCabecalho(cab, 0, CAB_TAREFAS, "Tarefas_Default");
  const col = (nome: string) => {
    const i = cab.findIndex((v) => texto(v) === nome);
    if (i < 0) {
      throw new Error(`coluna "${nome}" não encontrada em Tarefas_Default`);
    }
    return i;
  };
  const [cBloco, cNat, cAtor] = [
    col("bloco_padrao"),
    col("natureza"),
    col("ator"),
  ];

  const modelos: ModeloNx[] = [];
  const apelidos: Apelido[] = [];
  const vistos = new Set<string>();
  let fim = ls.length;
  for (let i = 1; i < ls.length; i++) {
    if (!texto(ls[i][0])) {
      fim = i;
      break;
    }
  }
  // Linha vazia no meio da tabela cortaria a importação em silêncio: nada pode vir depois dela.
  for (let i = fim + 1; i < ls.length; i++) {
    if (texto(ls[i][0])) {
      throw new Error(
        `Tarefas_Default: linha ${fim + 1} vazia antes de "${
          texto(ls[i][0])
        }" (linha ${i + 1})`,
      );
    }
  }
  for (let i = 1; i < fim; i++) {
    const l = ls[i];
    const curto = texto(l[0]);
    const linha = i + 1;
    if (!/^NX-T(\d{2})$/.test(curto)) {
      throw new Error(
        `código inválido na linha ${linha} de Tarefas_Default: "${curto}"`,
      );
    }
    if (vistos.has(curto)) {
      throw new Error(`${curto} repetido em Tarefas_Default`);
    }
    vistos.add(curto);
    const seq = Number(curto.slice(4));
    const condicaoTxt = texto(l[6]);
    const natureza = texto(l[cNat]);
    const ator = texto(l[cAtor]);

    // Código reservado (RESERVADOS): não vira modelo nem apelido. A planilha também precisa marcá-lo como reservado.
    const marcadoReservado = condicaoTxt.startsWith("nunca (código reservado");
    if (RESERVADOS.has(curto) !== marcadoReservado) {
      throw new Error(
        `${curto}: reserva divergente (lista do script: ${
          RESERVADOS.has(curto)
        }; condição na planilha: "${condicaoTxt}")`,
      );
    }
    if (RESERVADOS.has(curto)) {
      if (DE_PARA_14133[curto]) {
        throw new Error(`${curto} está reservado e também no de-para`);
      }
      if (natureza || ator) {
        throw new Error(
          `${curto} está reservado e tem natureza/ator preenchidos`,
        );
      }
      continue;
    }

    const etapa = etapaPorNome.get(texto(l[1]));
    if (!etapa) {
      throw new Error(
        `${curto}: etapa "${texto(l[1])}" não está no Glossario 2a`,
      );
    }
    // Vazio não é "sem bloco": só o "—" do Glossario 2b vira GER.
    const blocoPadrao = texto(l[cBloco]);
    const bloco = blocos.get(blocoPadrao);
    if (!bloco) {
      throw new Error(
        `${curto}: bloco_padrao "${blocoPadrao}" vazio ou fora do Glossario 2b`,
      );
    }

    // O Glossario 3 calcula o mesmo id por fórmula do Excel: conferência independente deste cálculo.
    const gl = idsGlossario.get(curto);
    const nx = idModelo("NX", "GEN", etapa, bloco, seq);
    if (gl?.idModelo !== nx) {
      throw new Error(
        `${curto}: id calculado ${nx} difere do Glossario 3 (${
          gl?.idModelo ?? "ausente"
        })`,
      );
    }

    const destinos = DE_PARA_14133[curto];
    // Glossario 3, coluna I: quando aponta para um modelo da 14.133, o de-para deste script tem de concordar.
    if (
      /^14133-F\d{2}-T\d{2}$/.test(gl.codigoBanco) &&
      !destinos?.includes(gl.codigoBanco)
    ) {
      throw new Error(
        `${curto}: Glossario 3 aponta ${gl.codigoBanco}, de-para do script diz ${
          destinos?.join(", ") ?? "modelo NX novo"
        }`,
      );
    }
    if (destinos) {
      for (const d of destinos) {
        apelidos.push({ sistema: "nx_t", apelido: curto, tarefa_codigo: d });
        apelidos.push({ sistema: "nx", apelido: nx, tarefa_codigo: d });
      }
      continue;
    }

    if (!(NATUREZAS as readonly string[]).includes(natureza)) {
      throw new Error(
        `${curto}: natureza "${natureza}" inválida ou vazia (aceitos: ${
          NATUREZAS.join(", ")
        })`,
      );
    }
    if (!(ATORES as readonly string[]).includes(ator)) {
      throw new Error(
        `${curto}: ator "${ator}" inválido ou vazio (aceitos: ${
          ATORES.join(", ")
        })`,
      );
    }
    const titulo = texto(l[2]);
    const responsavel = texto(l[3]);
    const criterio = texto(l[7]);
    if (!titulo || !responsavel || !criterio) {
      throw new Error(`${curto}: título, responsável ou critério vazio`);
    }
    if (!RESPONSAVEL_RE.test(responsavel)) {
      throw new Error(
        `${curto}: responsável "${responsavel}" fora do formato papel:<admin|operacao> ou agente:<nome>`,
      );
    }

    // Prazo: horas após entrar na etapa (SLA interno, sem prazo legal) OU evento em texto (prazo vem do edital).
    const horas = l[4];
    const evento = texto(l[5]);
    const temHoras = horas !== null && horas !== undefined &&
      texto(horas) !== "";
    if (temHoras === (evento !== "")) {
      throw new Error(
        `${curto}: informe só prazo_horas_apos_etapa ou só prazo_evento`,
      );
    }
    if (
      temHoras &&
      (typeof horas !== "number" || !Number.isInteger(horas) || horas <= 0)
    ) {
      throw new Error(
        `${curto}: prazo_horas_apos_etapa inválido: ${JSON.stringify(horas)}`,
      );
    }

    if (!condicaoTxt) throw new Error(`${curto}: condição vazia`);
    modelos.push({
      codigo: nx,
      curto,
      fase: etapa,
      ordem: seq,
      titulo,
      criterio,
      responsavel,
      natureza,
      ator,
      prazoUnidade: temHoras ? "sem_prazo_legal" : "definido_no_edital",
      prazoHoras: temHoras ? horas as number : null,
      prazoObservacao: temHoras ? null : evento,
      // Condição em texto não tem chave no contexto da oportunidade: catalogo_condicao_avaliar devolve null
      // ("não verificada"). Nunca vira {} (que seria "sempre").
      condicao: condicaoTxt === "sempre" ? {} : { condicao_nx: condicaoTxt },
    });
    apelidos.push({ sistema: "nx_t", apelido: curto, tarefa_codigo: nx });
  }

  for (const curto of [...Object.keys(DE_PARA_14133), ...RESERVADOS]) {
    if (!vistos.has(curto)) {
      throw new Error(
        `de-para ou reserva cita ${curto}, que não está em Tarefas_Default`,
      );
    }
  }
  // Contagem independente: o Glossario 3 lista a tabela TarefasDefault inteira.
  const soGlossario = [...idsGlossario.keys()].filter((x) => !vistos.has(x));
  const soTarefas = [...vistos].filter((x) => !idsGlossario.has(x));
  if (soGlossario.length || soTarefas.length) {
    throw new Error(
      `Tarefas_Default e Glossario 3 divergem (só no Glossario: ${
        soGlossario.join(", ") || "—"
      }; ` +
        `só em Tarefas_Default: ${soTarefas.join(", ") || "—"})`,
    );
  }
  semVazioNemRepetido(modelos, (x) => x.codigo, "modelos NX");
  semVazioNemRepetido(
    apelidos,
    (x) => `${x.sistema}|${x.apelido}|${x.tarefa_codigo}`,
    "apelidos",
  );
  return { etapas, modelos, apelidos };
}

function litOuNull(s: string | null): string {
  return s === null ? "null" : lit(s);
}

// on conflict ... do update só em linha NX: nunca reescreve modelo da 14.133. O que sair da planilha não é apagado
// aqui; desativar exige migration própria.
export function gerarSeedModelosSql(
  { etapas, modelos, apelidos }: ModelosNx,
): string {
  const e = etapas.map((x) =>
    `  (${lit(x.codigo)}, 'NX', ${x.ordem}, ${lit(x.nome)}, ${lit(x.macro)}, ${
      lit(x.descricao)
    }, '{}'::integer[])`
  ).join(",\n");
  const m = modelos.map((x) =>
    `  (${lit(x.codigo)}, 'NX', ${lit(x.fase)}, ${x.ordem}, ${lit(x.titulo)}, ${
      lit(x.criterio)
    }, ` +
    `${lit(x.natureza)}::public.tarefa_natureza, ${lit(x.ator)}, ${
      lit(x.prazoUnidade)
    }::public.prazo_unidade, ` +
    `${x.prazoHoras ?? "null"}, ${litOuNull(x.prazoObservacao)}, ${
      lit(JSON.stringify(x.condicao))
    }::jsonb, ` +
    `${lit(x.criterio)}, ${lit(x.responsavel)})`
  ).join(",\n");
  const a = apelidos.map((x) =>
    `  (${lit(x.sistema)}, ${lit(x.apelido)}, ${lit(x.tarefa_codigo)})`
  ).join(",\n");
  return [
    MARCA_MODELOS_INICIO,
    "insert into public.processo_fases (codigo, norma, ordem, nome, macro, descricao, artigos) values",
    e,
    "on conflict (codigo) do update set ordem = excluded.ordem, nome = excluded.nome, macro = excluded.macro,",
    "  descricao = excluded.descricao",
    "  where public.processo_fases.norma = 'NX';",
    "",
    "insert into public.tarefas_catalogo (codigo, norma, fase_codigo, ordem, titulo, descricao, natureza, ator,",
    "  prazo_unidade, prazo_horas_apos_etapa, prazo_observacao, condicao, saida_esperada, responsavel_padrao) values",
    m,
    "on conflict (codigo) do update set fase_codigo = excluded.fase_codigo, ordem = excluded.ordem,",
    "  titulo = excluded.titulo, descricao = excluded.descricao, natureza = excluded.natureza, ator = excluded.ator,",
    "  prazo_unidade = excluded.prazo_unidade, prazo_horas_apos_etapa = excluded.prazo_horas_apos_etapa,",
    "  prazo_observacao = excluded.prazo_observacao, condicao = excluded.condicao,",
    "  saida_esperada = excluded.saida_esperada, responsavel_padrao = excluded.responsavel_padrao, atualizado_em = now()",
    "  where public.tarefas_catalogo.norma = 'NX';",
    "",
    "insert into public.tarefas_catalogo_apelidos (sistema, apelido, tarefa_codigo) values",
    a,
    "on conflict (sistema, apelido, tarefa_codigo) do nothing;",
    MARCA_MODELOS_FIM,
  ].join("\n");
}

if (import.meta.main) {
  const flags = Deno.args.filter((a) => a.startsWith("--"));
  const desconhecidas = flags.filter((f) =>
    f !== "--bloco=modelos" && f !== "--bloco=feriados"
  );
  if (desconhecidas.length) {
    console.error(
      `opção desconhecida: ${
        desconhecidas.join(" ")
      } (use --bloco=feriados ou --bloco=modelos)`,
    );
    Deno.exit(2);
  }
  const args = Deno.args.filter((a) => !a.startsWith("--"));
  const caminho = args[0] ?? "specs/nexor_spec.xlsx";
  const wb = lerPlanilha(caminho);
  if (flags.includes("--bloco=modelos")) {
    console.log(gerarSeedModelosSql(lerModelosNx(wb)));
  } else console.log(gerarSeedSql(lerFeriados(wb), lerRegimes(wb)));
}
