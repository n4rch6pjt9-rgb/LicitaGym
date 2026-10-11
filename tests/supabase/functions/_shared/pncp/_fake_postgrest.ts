// PostgREST em memória para testes de gravação (sem rede). Cobre o subconjunto usado por upsert.ts,
// pca-origem-link.ts e pca-lote.ts: select/eq/in/neq/range/limit/maybeSingle/single, insert(+select),
// update + filtros, upsert com onConflict, order. Conta as chamadas (cada operação aguardada conta 1).
//
// O que ele NÃO reproduz (não tomar os testes como prova contra o PostgREST real): tipos, NOT NULL, FK, triggers,
// concorrência entre execuções, limite de URL. `maxRows` imita o max-rows do PostgREST; `falhaLinha` imita uma
// linha que o Postgres rejeita (a instrução inteira falha, como no insert/upsert/update em lote real).

type Row = Record<string, unknown>;
type Resp = { data: unknown; error: { message: string } | null };

export const CHAVES_UNICAS: Record<string, string[]> = {
  pca_planos: ["id_pca_pncp"],
  pca_itens: ["pca_plano_id", "numero_item"],
  pca_item_pdm: ["pca_item_id", "codigo_pdm"],
  catalogo_ponte: ["catalogo_item_id", "entidade_tipo", "entidade_id"],
};

/** Defaults de coluna do schema real (aplicados no insert, como o Postgres). */
export const DEFAULTS: Record<string, Row> = {
  pca_planos: { ativo: true },
  pca_itens: { ativo: true },
};

export type Falha = { table: string; op: "select" | "insert" | "update" | "upsert" };

export class FakePostgrest {
  tables = new Map<string, Row[]>();
  chamadas = 0;
  porOperacao: Record<string, number> = {};
  falhas: Falha[] = [];
  /** linha que o banco rejeita: qualquer instrução que a escreva falha por inteiro. */
  falhaLinha: ((table: string, row: Row) => boolean) | null = null;
  /** max-rows do PostgREST: limite de linhas por resposta de select. */
  maxRows = 1000;
  private seq = 0;

  constructor(inicial: Record<string, Row[]> = {}) {
    for (const [t, rows] of Object.entries(inicial)) this.tables.set(t, rows.map((r) => ({ ...r })));
  }

  clone(): FakePostgrest {
    const c = new FakePostgrest();
    for (const [t, rows] of this.tables) c.tables.set(t, structuredClone(rows));
    return c;
  }

  rows(table: string): Row[] {
    if (!this.tables.has(table)) this.tables.set(table, []);
    return this.tables.get(table)!;
  }

  private idPara(table: string, row: Row): string {
    const cols = CHAVES_UNICAS[table];
    if (!cols) return `${table}#${++this.seq}`;
    return `${table}#${cols.map((c) => String(row[c])).join("|")}`;
  }

  private chave(table: string, row: Row): string | null {
    const cols = CHAVES_UNICAS[table];
    return cols ? cols.map((c) => String(row[c])).join("|") : null;
  }

  private falha(table: string, op: Falha["op"]): boolean {
    return this.falhas.some((f) => f.table === table && f.op === op);
  }

  private conta(table: string, op: string) {
    this.chamadas++;
    const k = `${table}.${op}`;
    this.porOperacao[k] = (this.porOperacao[k] ?? 0) + 1;
  }

  from(table: string) {
    return new Builder(this, table);
  }

  /** Um só espaço de tabelas: `schema("private").from("x")` lê a mesma tabela "x". */
  schema(_nome: string) {
    return this;
  }

  /** Funções SQL simuladas pelo teste: rpcs[nome](args, db) devolve `data`; lançar vira `error`. */
  rpcs: Record<string, (args: Row, db: FakePostgrest) => unknown> = {};
  rpc(nome: string, args: Row): Promise<Resp> {
    this.conta(nome, "rpc");
    const fn = this.rpcs[nome];
    if (!fn) return Promise.resolve({ data: null, error: { message: `rpc ${nome} não simulada` } });
    try {
      return Promise.resolve({ data: fn(args, this), error: null });
    } catch (e) {
      return Promise.resolve({ data: null, error: { message: e instanceof Error ? e.message : String(e) } });
    }
  }

  /** usado pelo Builder */
  executar(b: Builder): Resp {
    const { table, op } = b;
    this.conta(table, op);
    if (this.falha(table, op)) return { data: null, error: { message: `falha injetada ${table}.${op}` } };
    const all = this.rows(table);
    const casa = (r: Row) => b.filtros.every((f) => f(r));

    if (op === "select") {
      let out = all.filter(casa);
      if (b.ordem) {
        const c = b.ordem;
        out = [...out].sort((x, y) => String(x[c]).localeCompare(String(y[c])));
      }
      if (b.faixa) out = out.slice(b.faixa[0], b.faixa[1] + 1);
      out = out.slice(0, this.maxRows);
      if (b.limite != null) out = out.slice(0, b.limite);
      out = out.map((r) => projetar(r, b.colunas));
      return this.formato(b, out);
    }
    const rejeita = (rows: Row[]) =>
      this.falhaLinha && rows.some((r) => this.falhaLinha!(table, r))
        ? { data: null, error: { message: `linha rejeitada em ${table}.${op}` } }
        : null;
    if (op === "insert") {
      const novos = b.payload as Row[];
      const r = rejeita(novos);
      if (r) return r;
      const chaves = new Set(all.map((r) => this.chave(table, r)));
      for (const r of novos) {
        const k = this.chave(table, r);
        if (k && chaves.has(k)) return { data: null, error: { message: `duplicate key ${table} ${k}` } };
        if (k) chaves.add(k);
      }
      const gravados = novos.map((r) => ({ id: this.idPara(table, r), ...DEFAULTS[table], ...structuredClone(r) }));
      all.push(...gravados);
      return this.formato(b, gravados.map((r) => projetar(r, b.colunas)));
    }
    if (op === "update") {
      const alvo = all.filter(casa);
      const r = rejeita(alvo.map((x) => ({ ...x, ...(b.payload as Row) })));
      if (r) return r;
      for (const r of alvo) Object.assign(r, structuredClone(b.payload as Row));
      return { data: null, error: null };
    }
    // upsert
    const rj = rejeita(b.payload as Row[]);
    if (rj) return rj;
    const cols = (b.onConflict ?? "").split(",").map((c) => c.trim()).filter(Boolean);
    const vistos = new Set<string>();
    for (const r of b.payload as Row[]) {
      const k = cols.map((c) => String(r[c])).join("|");
      if (vistos.has(k)) {
        return { data: null, error: { message: "ON CONFLICT DO UPDATE command cannot affect row a second time" } };
      }
      vistos.add(k);
      const atual = all.find((x) => cols.every((c) => String(x[c]) === String(r[c])));
      if (atual) Object.assign(atual, structuredClone(r));
      else all.push({ id: this.idPara(table, r), ...DEFAULTS[table], ...structuredClone(r) });
    }
    return { data: null, error: null };
  }

  private formato(b: Builder, rows: Row[]): Resp {
    if (b.modo === "maybeSingle") {
      if (rows.length > 1) return { data: null, error: { message: "multiple rows" } };
      return { data: rows[0] ?? null, error: null };
    }
    if (b.modo === "single") {
      if (rows.length !== 1) return { data: null, error: { message: "not single" } };
      return { data: rows[0], error: null };
    }
    return { data: rows, error: null };
  }
}

function projetar(r: Row, colunas: string): Row {
  if (!colunas || colunas.trim() === "*") return structuredClone(r);
  const out: Row = {};
  for (const c of colunas.split(",").map((x) => x.trim())) out[c] = r[c];
  return out;
}

class Builder implements PromiseLike<Resp> {
  op: "select" | "insert" | "update" | "upsert" = "select";
  colunas = "*";
  filtros: ((r: Row) => boolean)[] = [];
  faixa: [number, number] | null = null;
  limite: number | null = null;
  modo: "lista" | "maybeSingle" | "single" = "lista";
  ordem: string | null = null;
  payload: unknown = null;
  onConflict: string | null = null;

  constructor(private db: FakePostgrest, public table: string) {}

  select(colunas = "*") {
    this.colunas = colunas;
    return this;
  }
  insert(rows: Row | Row[]) {
    this.op = "insert";
    this.payload = Array.isArray(rows) ? rows : [rows];
    this.colunas = "";
    return this;
  }
  update(vals: Row) {
    this.op = "update";
    this.payload = vals;
    return this;
  }
  upsert(rows: Row | Row[], opts?: { onConflict?: string }) {
    this.op = "upsert";
    this.payload = Array.isArray(rows) ? rows : [rows];
    this.onConflict = opts?.onConflict ?? null;
    return this;
  }
  eq(c: string, v: unknown) {
    this.filtros.push((r) => String(r[c]) === String(v));
    return this;
  }
  neq(c: string, v: unknown) {
    this.filtros.push((r) => String(r[c]) !== String(v));
    return this;
  }
  gte(c: string, v: number) {
    this.filtros.push((r) => Number(r[c]) >= v);
    return this;
  }
  in(c: string, vs: unknown[]) {
    const s = new Set(vs.map(String));
    this.filtros.push((r) => s.has(String(r[c])));
    return this;
  }
  order(c: string) {
    this.ordem = c;
    return this;
  }
  range(from: number, to: number) {
    this.faixa = [from, to];
    return this;
  }
  limit(n: number) {
    this.limite = n;
    return this;
  }
  maybeSingle() {
    this.modo = "maybeSingle";
    return Promise.resolve(this.db.executar(this));
  }
  single() {
    this.modo = "single";
    return Promise.resolve(this.db.executar(this));
  }
  then<A = Resp, B = never>(
    ok?: ((v: Resp) => A | PromiseLike<A>) | null,
    fail?: ((e: unknown) => B | PromiseLike<B>) | null,
  ): PromiseLike<A | B> {
    return Promise.resolve(this.db.executar(this)).then(ok, fail);
  }
}
