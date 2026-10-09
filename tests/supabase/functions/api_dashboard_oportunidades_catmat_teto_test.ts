// Spec specs/0004-catmat-sem-teto-1000.md: recorte CATMAT acima de 1.000 oportunidades sem o 422.
// Usa um PostgREST falso em memória (filtros, ordenação, range e contagem) para comparar a lista em duas fases
// com a ordenação direta, e para contar quantos ids vão em cada `in("id", ...)`.
import { assert, assertEquals } from "jsr:@std/assert@1";
import { handleRequest, MAX_IDS_CATMAT, OPORTUNIDADES_VIEW, ordenarChaves } from "../../../supabase/functions/api-dashboard-oportunidades/index.ts";

type Linha = Record<string, unknown> & { id: number };

interface FakeOpts {
  linhas: Linha[];
  /** ids que a RPC licitacoes_ids_por_catmat_unica devolve */
  idsRpc: number[];
  /** falha a N-ésima leitura da view (1-based), para o CA-7 */
  falharLeituraView?: number;
  /** erro devolvido na N-ésima leitura da view (padrão: XX000) */
  erroLeitura?: { code: string; message: string };
  /** linhas de matches da RPC; padrão: um match texto_item por id */
  matchesRpc?: Array<Record<string, unknown>>;
}

function cmp(a: unknown, b: unknown): number {
  if (typeof a === "number" && typeof b === "number") return a - b;
  const da = Date.parse(String(a));
  const db = Date.parse(String(b));
  if (!Number.isNaN(da) && !Number.isNaN(db)) return da - db;
  return String(a).localeCompare(String(b));
}

/** Ordenação de referência do PostgREST: coluna no sentido pedido, nulos por último, id crescente. */
function ordenarReferencia(linhas: Linha[], col: string, asc: boolean): Linha[] {
  return [...linhas].sort((x, y) => {
    const a = x[col];
    const b = y[col];
    const an = a === null || a === undefined;
    const bn = b === null || b === undefined;
    if (an !== bn) return an ? 1 : -1;
    if (!an && !bn) {
      const c = cmp(a, b);
      if (c !== 0) return asc ? c : -c;
    }
    return x.id - y.id;
  });
}

function criarFake(opts: FakeOpts) {
  const idsPorIn: number[] = [];
  const chamadas: Array<{ tabela: string; metodo: string; args: unknown[] }> = [];
  let rpcs = 0;
  let leiturasView = 0;

  function query(tabela: string) {
    const filtros: Array<(l: Linha) => boolean> = [];
    const ordens: Array<{ col: string; asc: boolean }> = [];
    let faixa: [number, number] | null = null;
    let contar = false;
    let head = false;
    let colunas = "*";
    const gravar = (metodo: string, args: unknown[]) => chamadas.push({ tabela, metodo, args });
    const q = {
      select(cols?: string, o?: { count?: string; head?: boolean }) {
        gravar("select", [cols, o]);
        colunas = cols ?? "*";
        contar = o?.count === "exact";
        head = !!o?.head;
        return q;
      },
      eq(c: string, v: unknown) { gravar("eq", [c, v]); filtros.push((l) => l[c] === v); return q; },
      in(c: string, vs: unknown[]) {
        if (c === "id") idsPorIn.push(vs.length);
        const s = new Set(vs.map(Number));
        filtros.push((l) => s.has(Number(l[c])));
        return q;
      },
      gte(c: string, v: unknown) { filtros.push((l) => l[c] !== null && l[c] !== undefined && cmp(l[c], v) >= 0); return q; },
      lte(c: string, v: unknown) { filtros.push((l) => l[c] !== null && l[c] !== undefined && cmp(l[c], v) <= 0); return q; },
      lt(c: string, v: unknown) { filtros.push((l) => l[c] !== null && l[c] !== undefined && cmp(l[c], v) < 0); return q; },
      ilike(c: string, p: string) {
        const t = p.replaceAll("*", "").replaceAll("%", "").toLowerCase();
        filtros.push((l) => String(l[c] ?? "").toLowerCase().includes(t));
        return q;
      },
      or(f: string) {
        gravar("or", [f]);
        const m = f.match(/^prioridade\.in\.\(([^)]*)\)$/);
        if (m) {
          const ps = new Set(m[1].split(","));
          filtros.push((l) => ps.has(String(l.prioridade)));
        } else {
          const partes = f.split(",").map((p) => p.match(/^(\w+)\.ilike\.\*(.*)\*$/)).filter(Boolean) as RegExpMatchArray[];
          filtros.push((l) => partes.some((p) => String(l[p[1]] ?? "").toLowerCase().includes(p[2].toLowerCase())));
        }
        return q;
      },
      order(c: string, o: { ascending?: boolean }) { ordens.push({ col: c, asc: o?.ascending !== false }); return q; },
      range(a: number, b: number) { faixa = [a, b]; return q; },
      then(ok?: (v: unknown) => unknown, ko?: (e: unknown) => unknown) {
        const base = tabela === "catmat_pdms" ? [] : opts.linhas;
        if (tabela === OPORTUNIDADES_VIEW) {
          leiturasView += 1;
          if (opts.falharLeituraView === leiturasView) {
            return Promise.resolve({ data: null, count: null, error: opts.erroLeitura ?? { code: "XX000", message: "falha simulada" } }).then(ok, ko);
          }
        }
        let rs = base.filter((l) => filtros.every((f) => f(l)));
        const total = rs.length;
        if (ordens.length > 0) {
          const o = ordens[0];
          rs = ordenarReferencia(rs, o.col, o.asc);
        }
        if (faixa) {
          if (faixa[0] >= rs.length && rs.length > 0) {
            return Promise.resolve({ data: null, count: null, error: { code: "PGRST103", message: "range" } }).then(ok, ko);
          }
          rs = rs.slice(faixa[0], faixa[1] + 1);
        }
        const cols = colunas === "*" ? null : colunas.split(",").map((c) => c.trim());
        const data = head ? null : rs.map((l) => (cols ? Object.fromEntries(cols.map((c) => [c, l[c] ?? null])) : { ...l }));
        return Promise.resolve({ data, count: contar ? total : null, error: null }).then(ok, ko);
      },
    };
    return q;
  }

  const client = {
    from: (t: string) => query(t),
    rpc: (_fn: string, _args: unknown) => {
      rpcs += 1;
      return {
        single: () => Promise.resolve({
          data: {
            ids: opts.idsRpc,
            matches: opts.matchesRpc ??
              opts.idsRpc.map((id) => ({ licitacao_id: id, codigo_pdm: 7115, codigo_item: null, motivo: "texto_item" })),
          },
          error: null,
        }),
      };
    },
  };
  return { client, idsPorIn, chamadas, rpcs: () => rpcs, leiturasView: () => leiturasView };
}

/** 1.100 compras: 1.012 em Oportunidades (leads/monitorar, canônicas), 88 historico. Datas com nulos e empates. */
function fixture(): Linha[] {
  const linhas: Linha[] = [];
  for (let id = 1; id <= 1100; id++) {
    const historico = id % 12 === 0 && linhas.filter((l) => l.prioridade === "historico").length < 88;
    linhas.push({
      id,
      prioridade: historico ? "historico" : (id % 3 === 0 ? "monitorar" : "leads"),
      eh_canonica: true,
      uf: id % 4 === 0 ? "SP" : "RJ",
      objeto: id % 5 === 0 ? "esteira ergometrica" : "piso de borracha",
      // nulos (id%17) e empates (dia repetido a cada 7 ids)
      data_fim: id % 17 === 0 ? null : `2026-11-${String((id % 7) + 1).padStart(2, "0")}T12:00:00+00:00`,
      data_publicacao: id % 13 === 0 ? null : `2026-09-${String((id % 9) + 1).padStart(2, "0")}T09:00:00+00:00`,
      valor_total: id % 11 === 0 ? null : (id % 50) * 1000.5,
    });
  }
  return linhas;
}

/** select da fase 1: só id e a coluna de ordenação. */
const FASE1 = /^id,(data_fim|data_publicacao|valor_total)$/;

function emOportunidades(l: Linha): boolean {
  return l.eh_canonica === true && (l.prioridade === "leads" || l.prioridade === "monitorar");
}

async function listar(fake: ReturnType<typeof criarFake>, qs: string) {
  const req = new Request(`http://localhost/api-dashboard-oportunidades?action=list&catalogo=true&${qs}`, { method: "GET" });
  // deno-lint-ignore no-explicit-any
  const res = await handleRequest(req, { getClient: () => fake.client as any, requireAuth: () => null });
  return { status: res.status, body: await res.json() };
}

const LINHAS = fixture();
const IDS = LINHAS.map((l) => l.id);
const NO_ESCOPO = LINHAS.filter(emOportunidades);

Deno.test("fixture: 1012 oportunidades no escopo, 1100 ids no recorte", () => {
  assertEquals(NO_ESCOPO.length, 1012);
  assertEquals(IDS.length, 1100);
});

Deno.test("CA-1: recorte com 1012 oportunidades responde 200, total 1012 e a página 1 na ordem certa", async () => {
  const fake = criarFake({ linhas: LINHAS, idsRpc: IDS });
  const { status, body } = await listar(fake, "limit=20&order_by=data_fim&order_direction=desc");
  assertEquals(status, 200, JSON.stringify(body));
  assertEquals(body.total, 1012);
  const esperado = ordenarReferencia(NO_ESCOPO, "data_fim", false).slice(0, 20).map((l) => l.id);
  assertEquals(body.items.map((i: { id: number }) => i.id), esperado);
  assert(body.items.every((i: { catmat_match: unknown[] }) => Array.isArray(i.catmat_match) && i.catmat_match.length === 1));
});

Deno.test("CA-2: última página traz o restante; página além do fim volta vazia com o total", async () => {
  const fake = criarFake({ linhas: LINHAS, idsRpc: IDS });
  const ultima = await listar(fake, "limit=20&page=51&order_by=data_fim&order_direction=desc");
  assertEquals(ultima.status, 200);
  assertEquals(ultima.body.total, 1012);
  const esperado = ordenarReferencia(NO_ESCOPO, "data_fim", false).slice(1000, 1012).map((l) => l.id);
  assertEquals(ultima.body.items.map((i: { id: number }) => i.id), esperado);
  const alem = await listar(fake, "limit=20&page=60");
  assertEquals(alem.status, 200);
  assertEquals(alem.body.total, 1012);
  assertEquals(alem.body.items, []);
});

Deno.test("CA-3: ordem em duas fases = ordem direta (3 colunas x 2 sentidos, nulos por último, id desempata)", async () => {
  for (const col of ["data_fim", "data_publicacao", "valor_total"]) {
    for (const dir of ["asc", "desc"]) {
      const fake = criarFake({ linhas: LINHAS, idsRpc: IDS });
      const ref = ordenarReferencia(NO_ESCOPO, col, dir === "asc");
      for (const page of [1, 3, 51]) {
        const { status, body } = await listar(fake, `limit=20&page=${page}&order_by=${col}&order_direction=${dir}`);
        assertEquals(status, 200);
        assertEquals(
          body.items.map((i: { id: number }) => i.id),
          ref.slice((page - 1) * 20, page * 20).map((l) => l.id),
          `${col} ${dir} página ${page}`,
        );
      }
    }
  }
});

Deno.test("CA-4: filtros (UF e busca) valem antes de contar: 1100 ids que caem abaixo de 1000 respondem 200", async () => {
  const fake = criarFake({ linhas: LINHAS, idsRpc: IDS });
  const { status, body } = await listar(fake, "limit=20&uf=SP");
  assertEquals(status, 200);
  assertEquals(body.total, NO_ESCOPO.filter((l) => l.uf === "SP").length);
  const busca = await listar(fake, "limit=20&busca=esteira");
  assertEquals(busca.status, 200);
  assertEquals(busca.body.total, NO_ESCOPO.filter((l) => String(l.objeto).includes("esteira")).length);
});

Deno.test("CA-5: nenhuma chamada ao PostgREST leva mais de 500 ids", async () => {
  const fake = criarFake({ linhas: LINHAS, idsRpc: IDS });
  const { status } = await listar(fake, "limit=100&page=2&order_by=valor_total&order_direction=desc");
  assertEquals(status, 200);
  assert(fake.idsPorIn.length > 0);
  assert(Math.max(...fake.idsPorIn) <= 500, `maior lote: ${Math.max(...fake.idsPorIn)}`);
});

Deno.test("CA-6: acima do teto de proteção continua 422 com a contagem", async () => {
  const muitos = Array.from({ length: MAX_IDS_CATMAT + 1 }, (_, i) => i + 1);
  const fake = criarFake({ linhas: [], idsRpc: muitos });
  const { status, body } = await listar(fake, "limit=20");
  assertEquals(status, 422);
  assert(String(body.error).includes(String(MAX_IDS_CATMAT + 1)), body.error);
  assertEquals(fake.leiturasView(), 0);
});

Deno.test("CA-6: teto de proteção entre 2.000 (folga sobre o maior recorte real) e 5.000 (até 10 lotes)", () => {
  assert(MAX_IDS_CATMAT >= 2000 && MAX_IDS_CATMAT <= 5000, `MAX_IDS_CATMAT=${MAX_IDS_CATMAT}`);
});

Deno.test("CA-7: erro em qualquer lote vira 500, nunca lista parcial", async () => {
  for (const n of [1, 2, 3]) {
    const fake = criarFake({ linhas: LINHAS, idsRpc: IDS, falharLeituraView: n });
    const { status, body } = await listar(fake, "limit=20");
    assertEquals(status, 500, `falha na leitura ${n}: ${JSON.stringify(body)}`);
    assertEquals(body.items, undefined);
  }
});

// Casos que antes viviam em api_dashboard_oportunidades_test.ts com o teto de 1000 (reescritos para as duas fases)

/** n compras; `atual(id)` decide se está em Oportunidades (leads) ou é historico. */
function compras(n: number, atual: (id: number) => boolean): Linha[] {
  return Array.from({ length: n }, (_, i) => ({
    id: i + 1,
    prioridade: atual(i + 1) ? "leads" : "historico",
    eh_canonica: true,
    data_fim: `2026-11-01T12:00:00+00:00`,
  }));
}

Deno.test("catalogo=true com 3098 casamentos (volume de prod): RPC única, lotes 500+500+103 e casamentos preservados", async () => {
  // 1103 licitações distintas, ~2,8 casamentos cada (dados fictícios); ids e codigo_item chegam como string (bigint)
  const matches = Array.from({ length: 3098 }, (_, i) => ({
    licitacao_id: String(1 + (i % 1103)),
    codigo_pdm: 7115 + (i % 3),
    codigo_item: i % 7 === 0 ? String(600000 + i) : null,
    motivo: i % 7 === 0 ? "codigo" : "texto_item",
  }));
  const ids = Array.from({ length: 1103 }, (_, i) => i + 1);
  const fake = criarFake({ linhas: compras(1103, (id) => id <= 40), idsRpc: ids, matchesRpc: matches });
  const { status, body } = await listar(fake, "limit=1&order_by=data_fim&order_direction=asc");
  assertEquals(status, 200);
  assertEquals(fake.rpcs(), 1);
  assertEquals(fake.idsPorIn.slice(0, 3), [500, 500, 103]);
  assertEquals(body.total, 40);
  assertEquals(body.items[0].id, 1);
  const casamentos1 = matches.filter((m) => m.licitacao_id === "1").length;
  assertEquals(body.items[0].catmat_match.length, casamentos1);
  assertEquals(typeof body.items[0].catmat_match[0].codigo_item, "number");
});

Deno.test("1200 historico + 300 atuais: total 300; cada lote e a página aplicam a canônica e o or do escopo", async () => {
  const fake = criarFake({ linhas: compras(1500, (id) => id > 1200), idsRpc: Array.from({ length: 1500 }, (_, i) => i + 1) });
  const { status, body } = await listar(fake, "limit=2");
  assertEquals(status, 200);
  assertEquals(body.total, 300);
  assertEquals(body.items.map((i: { id: number }) => i.id), [1201, 1202]);
  const fase1 = fake.chamadas.filter((c) => c.tabela === OPORTUNIDADES_VIEW && c.metodo === "select" && FASE1.test(String(c.args[0])));
  assertEquals(fase1.length, 3);
  const ors = fake.chamadas.filter((c) => c.tabela === OPORTUNIDADES_VIEW && c.metodo === "or").map((c) => c.args[0]);
  // 3 lotes da fase 1 + a leitura da página
  assertEquals(ors, Array(4).fill("prioridade.in.(leads,monitorar)"));
  const eqs = fake.chamadas.filter((c) => c.tabela === OPORTUNIDADES_VIEW && c.metodo === "eq").map((c) => c.args);
  assertEquals(eqs, Array(4).fill(["eh_canonica", true]));
});

Deno.test("só historico acima do limite da URL: 200 vazio, sem ler as colunas completas", async () => {
  const fake = criarFake({ linhas: compras(1500, () => false), idsRpc: Array.from({ length: 1500 }, (_, i) => i + 1) });
  const { status, body } = await listar(fake, "limit=20");
  assertEquals(status, 200);
  assertEquals(body.total, 0);
  assertEquals(body.items, []);
  assertEquals(fake.chamadas.some((c) => c.tabela === OPORTUNIDADES_VIEW && c.metodo === "select" && !FASE1.test(String(c.args[0]))), false);
});

Deno.test("prioridade=leads acima do limite da URL: cada lote e a página filtram eq(prioridade, leads) e a canônica, sem o or", async () => {
  const fake = criarFake({ linhas: compras(1001, (id) => id % 2 === 0), idsRpc: Array.from({ length: 1001 }, (_, i) => i + 1) });
  const { status, body } = await listar(fake, "limit=20&prioridade=leads");
  assertEquals(status, 200);
  assertEquals(body.total, 500);
  const eqs = fake.chamadas.filter((c) => c.tabela === OPORTUNIDADES_VIEW && c.metodo === "eq").map((c) => c.args);
  // 3 lotes da fase 1 + a leitura da página
  assertEquals(eqs, Array(4).fill([["prioridade", "leads"], ["eh_canonica", true]]).flat());
  assertEquals(fake.chamadas.some((c) => c.tabela === OPORTUNIDADES_VIEW && c.metodo === "or"), false);
});

Deno.test("compra que sai do escopo entre as fases não volta na página", async () => {
  const linhas = compras(1100, () => true);
  const fake = criarFake({ linhas, idsRpc: linhas.map((l) => l.id) });
  // depois da fase 1 (3 lotes), o id 1 vira historico: a leitura da página (4ª leitura) não pode trazê-lo
  const original = fake.client.from;
  let leituras = 0;
  fake.client.from = (t: string) => {
    if (t === OPORTUNIDADES_VIEW && ++leituras === 4) linhas[0].prioridade = "historico";
    return original(t);
  };
  const { status, body } = await listar(fake, "limit=5&order_by=data_fim&order_direction=asc");
  assertEquals(status, 200);
  assertEquals(body.items.some((i: { id: number }) => i.id === 1), false);
});

Deno.test("ordenarChaves com ordem escrita à mão: offsets diferentes, frações, nulos, zero e negativos", () => {
  // mesmo instante em -03:00 e +00:00 (ids 2 e 3) empata e desempata por id
  const datas = [
    { id: 5, chave: null },
    { id: 3, chave: "2026-11-01T15:00:00+00:00" },
    { id: 2, chave: "2026-11-01T12:00:00-03:00" },
    { id: 4, chave: "2026-11-01T15:00:00.123456+00:00" },
    { id: 1, chave: "2026-10-31T23:59:59+00:00" },
  ];
  assertEquals(ordenarChaves(datas, "data_fim", true).map((c) => c.id), [1, 2, 3, 4, 5]);
  assertEquals(ordenarChaves(datas, "data_fim", false).map((c) => c.id), [4, 2, 3, 1, 5]);
  const valores = [
    { id: 1, chave: 0 },
    { id: 2, chave: -10.5 },
    { id: 3, chave: null },
    { id: 4, chave: 1000.25 },
    { id: 5, chave: 0 },
  ];
  assertEquals(ordenarChaves(valores, "valor_total", true).map((c) => c.id), [2, 1, 5, 4, 3]);
  assertEquals(ordenarChaves(valores, "valor_total", false).map((c) => c.id), [4, 1, 5, 2, 3]);
});

Deno.test("statement_timeout num lote da fase 1 vira 503 'filtro de catálogo indisponível'", async () => {
  const fake = criarFake({
    linhas: LINHAS,
    idsRpc: IDS,
    falharLeituraView: 2,
    erroLeitura: { code: "57014", message: "canceling statement due to statement timeout" },
  });
  const { status, body } = await listar(fake, "limit=20");
  assertEquals(status, 503);
  assertEquals(body, { error: "filtro de catálogo indisponível" });
});
