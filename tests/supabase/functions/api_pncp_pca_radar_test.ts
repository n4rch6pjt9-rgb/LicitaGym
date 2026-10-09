// Spec specs/0006-pca-radar-itens-escopo.md: GET api-pncp-pca?visao=radar (CA-1 a CA-7, backend).
// Usa um PostgREST falso em memória (eq, ilike, gte, order com nulos, range e contagem) e registra cada chamada,
// para provar que os filtros vão para o banco e que nada é lido com service_role antes da autenticação.
import { assert, assertEquals } from "jsr:@std/assert@1";
import { RADAR_VIEW, type RadarClient, responderRadar } from "../../../supabase/functions/api-pncp-pca/radar.ts";

type Linha = Record<string, unknown>;

interface Chamada {
  tabela: string;
  metodo: string;
  args: unknown[];
}

function linha(p: Partial<Linha>): Linha {
  return {
    fonte: "pncp",
    orgao_cnpj: "12345678000190",
    codigo_uasg: "925000",
    orgao_nome: "Prefeitura de Exemplo",
    ano_pca: 2026,
    codigo_pdm: 1234,
    codigo_item: 400000,
    descricao_item: "Esteira ergométrica",
    quantidade: 1,
    valor_unitario: 1000,
    valor_total: 1000,
    data_prevista: "2026-03-10",
    mes_previsto: "2026-03",
    prioridade: "Alta",
    status: "Planejada",
    numero_item_pncp: 1,
    casamento_confirmado: true,
    metodo_identificacao: "pncp_pdm_confirmado",
    ...p,
  };
}

function cmp(a: unknown, b: unknown): number {
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a).localeCompare(String(b));
}

function criarFake(linhas: Linha[], erro?: { message: string; code?: string }) {
  const chamadas: Chamada[] = [];
  function from(tabela: string) {
    const filtros: Array<(l: Linha) => boolean> = [];
    const ordens: Array<{ col: string; asc: boolean; nullsFirst: boolean }> = [];
    let faixa: [number, number] | null = null;
    let contar = false;
    const gravar = (metodo: string, args: unknown[]) => chamadas.push({ tabela, metodo, args });
    const q = {
      select(cols?: string, o?: { count?: string }) {
        gravar("select", [cols, o]);
        contar = o?.count === "exact";
        return q;
      },
      eq(col: string, v: unknown) {
        gravar("eq", [col, v]);
        filtros.push((l) => l[col] === v);
        return q;
      },
      gte(col: string, v: number) {
        gravar("gte", [col, v]);
        filtros.push((l) => typeof l[col] === "number" && (l[col] as number) >= v);
        return q;
      },
      ilike(col: string, padrao: string) {
        gravar("ilike", [col, padrao]);
        const termo = padrao.replace(/^%|%$/g, "").toLowerCase();
        filtros.push((l) => typeof l[col] === "string" && (l[col] as string).toLowerCase().includes(termo));
        return q;
      },
      order(col: string, o?: { ascending?: boolean; nullsFirst?: boolean }) {
        gravar("order", [col, o]);
        ordens.push({ col, asc: o?.ascending !== false, nullsFirst: o?.nullsFirst === true });
        return q;
      },
      range(a: number, b: number) {
        gravar("range", [a, b]);
        faixa = [a, b];
        return q;
      },
      then(resolve: (r: unknown) => unknown, reject?: (e: unknown) => unknown) {
        try {
          if (erro) return Promise.resolve({ data: null, error: erro, count: null }).then(resolve, reject);
          let r = linhas.filter((l) => filtros.every((f) => f(l)));
          r = [...r].sort((x, y) => {
            for (const o of ordens) {
              const a = x[o.col];
              const b = y[o.col];
              const an = a === null || a === undefined;
              const bn = b === null || b === undefined;
              if (an !== bn) return (an ? 1 : -1) * (o.nullsFirst ? -1 : 1);
              if (!an && !bn) {
                const c = cmp(a, b);
                if (c !== 0) return o.asc ? c : -c;
              }
            }
            return 0;
          });
          const total = r.length;
          if (faixa) r = r.slice(faixa[0], faixa[1] + 1);
          return Promise.resolve({ data: r, error: null, count: contar ? total : null }).then(resolve, reject);
        } catch (e) {
          return Promise.reject(e).then(resolve, reject);
        }
      },
    };
    return q;
  }
  return { client: { from } as unknown as RadarClient, chamadas };
}

function req(qs: string): [Request, URL] {
  const url = new URL(`https://x.supabase.co/functions/v1/api-pncp-pca?visao=radar${qs}`);
  return [new Request(url, { headers: { Authorization: "Bearer jwt-do-usuario" } }), url];
}

const autenticado = () => Promise.resolve(null);

async function chamar(qs: string, linhas: Linha[], erro?: { message: string }) {
  const fake = criarFake(linhas, erro);
  let clientes = 0;
  const [r, u] = req(qs);
  const res = await responderRadar(r, u, {
    requireAuth: autenticado,
    criarCliente: () => {
      clientes++;
      return fake.client;
    },
  });
  const body = await res.json();
  return { res, body, chamadas: fake.chamadas, clientes };
}

const BASE = [
  linha({ numero_item_pncp: 1, ano_pca: 2026, data_prevista: "2026-05-01", mes_previsto: "2026-05", valor_total: 300 }),
  linha({ numero_item_pncp: 2, ano_pca: 2026, data_prevista: "2026-02-01", mes_previsto: "2026-02", valor_total: 900 }),
  linha({ numero_item_pncp: 3, ano_pca: 2026, data_prevista: null, mes_previsto: null, valor_total: 50 }),
  linha({ numero_item_pncp: 4, ano_pca: 2025, data_prevista: "2025-01-01", mes_previsto: "2025-01", valor_total: 10 }),
];

Deno.test("CA-1: sem JWT válido responde 401 e não cria cliente service_role", async () => {
  const [r, u] = req("&ano=2026");
  let clientes = 0;
  const res = await responderRadar(r, u, {
    requireAuth: () => Promise.resolve(new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 })),
    criarCliente: () => {
      clientes++;
      return criarFake(BASE).client;
    },
  });
  assertEquals(res.status, 401);
  assertEquals(clientes, 0);
});

Deno.test("CA-2: autenticado lê v_bi_pca_radar filtrado por ano_pca e devolve o envelope", async () => {
  const { res, body, chamadas } = await chamar("&ano=2026", BASE);
  assertEquals(res.status, 200);
  assertEquals(RADAR_VIEW, "v_bi_pca_radar");
  assert(chamadas.every((c) => c.tabela === "v_bi_pca_radar"));
  assert(chamadas.some((c) => c.metodo === "eq" && c.args[0] === "ano_pca" && c.args[1] === 2026));
  assertEquals(Object.keys(body).sort(), ["itens", "itens_sem_valor", "limit", "ordem", "page", "total", "valor_total_escopo"]);
  assertEquals(body.total, 3);
  assertEquals(body.page, 1);
  assertEquals(body.limit, 20);
  assert(body.itens.every((i: Linha) => i.ano_pca === 2026));
});

Deno.test("CA-3: cada filtro vai para o banco", async () => {
  const casos: Array<[string, string, string, unknown]> = [
    ["&mes=2026-02", "eq", "mes_previsto", "2026-02"],
    ["&pdm=1234", "eq", "codigo_pdm", 1234],
    ["&orgao=12.345.678/0001-90", "eq", "orgao_cnpj", "12345678000190"],
    ["&orgao=prefeitura", "ilike", "orgao_nome", "%prefeitura%"],
    ["&fonte=pgc", "eq", "fonte", "pgc"],
    ["&valor_min=500", "gte", "valor_total", 500],
    ["&so_confirmados=true", "eq", "casamento_confirmado", true],
  ];
  for (const [qs, metodo, col, valor] of casos) {
    const { res, chamadas } = await chamar(`&ano=2026${qs}`, BASE);
    assertEquals(res.status, 200, qs);
    assert(
      chamadas.some((c) => c.metodo === metodo && c.args[0] === col && c.args[1] === valor),
      `${qs}: esperado ${metodo}(${col}, ${valor})`,
    );
  }
  const { body } = await chamar("&ano=2026&mes=2026-02", BASE);
  assertEquals(body.total, 1);
});

Deno.test("CA-3: curinga do PostgREST no nome do órgão não vira padrão", async () => {
  const { chamadas } = await chamar("&ano=2026&orgao=pre%25f_*x", BASE);
  const ilike = chamadas.find((c) => c.metodo === "ilike");
  assertEquals(ilike?.args[1], "%prefx%");
});

Deno.test("CA-3: parâmetro inválido devolve 400 com mensagem, não lista vazia", async () => {
  for (
    const qs of [
      "&ano=abc", "&mes=2026-13", "&mes=03/2026", "&pdm=abc", "&fonte=sesc", "&valor_min=-1", "&valor_min=x",
      "&so_confirmados=talvez", "&page=0", "&limit=0", "&limit=101", "&ordem=nome", "&orgao=%25%25",
    ]
  ) {
    const { res, body, clientes } = await chamar(qs, BASE);
    assertEquals(res.status, 400, qs);
    assert(typeof body.error === "string" && body.error.length > 0, qs);
    assertEquals(body.itens, undefined, qs);
    assertEquals(clientes, 0, qs);
  }
});

Deno.test("CA-4: ordem padrão por data_prevista asc com nulos por último; ordem=valor desc", async () => {
  const data = await chamar("&ano=2026", BASE);
  assertEquals(data.body.ordem, "data");
  assertEquals(data.body.itens.map((i: Linha) => i.numero_item_pncp), [2, 1, 3]);
  const ord = data.chamadas.find((c) => c.metodo === "order");
  assertEquals(ord?.args, ["data_prevista", { ascending: true, nullsFirst: false }]);

  const valor = await chamar("&ano=2026&ordem=valor", [...BASE, linha({ numero_item_pncp: 5, valor_total: null })]);
  assertEquals(valor.body.itens.map((i: Linha) => i.numero_item_pncp), [2, 1, 3, 5]);
  const ordV = valor.chamadas.find((c) => c.metodo === "order");
  assertEquals(ordV?.args, ["valor_total", { ascending: false, nullsFirst: false }]);
});

Deno.test("CA-4: paginação com limit até 100", async () => {
  const { body, chamadas } = await chamar("&ano=2026&limit=2&page=2", BASE);
  assertEquals(body.total, 3);
  assertEquals(body.itens.map((i: Linha) => i.numero_item_pncp), [3]);
  assert(chamadas.some((c) => c.metodo === "range" && c.args[0] === 2 && c.args[1] === 3));
});

Deno.test("CA-5: ausentes chegam como null; soma só os valores conhecidos de todo o filtro", async () => {
  const linhas = [
    linha({ numero_item_pncp: 1, valor_total: 100.005, data_prevista: "2026-01-01" }),
    linha({ numero_item_pncp: 2, valor_total: null, valor_unitario: null, data_prevista: "2026-01-02" }),
    linha({ numero_item_pncp: 3, valor_total: "200.10", data_prevista: null, mes_previsto: null }),
    linha({ numero_item_pncp: 4, orgao_nome: "12345678000190", data_prevista: "2026-01-03" }),
  ];
  const { body } = await chamar("&ano=2026&limit=1", linhas);
  assertEquals(body.itens.length, 1);
  assertEquals(body.total, 4);
  assertEquals(body.itens_sem_valor, 1);
  // centavos: 100.01 + 200.10 + 1000.00
  assertEquals(body.valor_total_escopo, 1300.11);

  const todos = (await chamar("&ano=2026", linhas)).body.itens as Linha[];
  const semValor = todos.find((i) => i.numero_item_pncp === 2)!;
  assertEquals(semValor.valor_total, null);
  assertEquals(semValor.valor_unitario, null);
  const semData = todos.find((i) => i.numero_item_pncp === 3)!;
  assertEquals(semData.data_prevista, null);
  assertEquals(semData.valor_total, 200.1);
  const semNome = todos.find((i) => i.numero_item_pncp === 4)!;
  assertEquals(semNome.orgao_nome, null);
  assertEquals(semNome.orgao_cnpj, "12345678000190");
});

Deno.test("CA-5: nenhum valor conhecido dá valor_total_escopo null, não 0", async () => {
  const { body } = await chamar("&ano=2026", [linha({ valor_total: null })]);
  assertEquals(body.valor_total_escopo, null);
  assertEquals(body.itens_sem_valor, 1);
});

Deno.test("CA-6: erro do banco devolve 500 com mensagem, nunca itens vazios", async () => {
  const { res, body } = await chamar("&ano=2026", BASE, { message: "canceling statement due to statement timeout" });
  assertEquals(res.status, 500);
  assert(String(body.error).includes("statement timeout"));
  assertEquals(body.itens, undefined);
});

Deno.test("CA-7: index.ts mantém GET padrão e as visões existentes, e despacha radar", async () => {
  const src = await Deno.readTextFile(new URL("../../../supabase/functions/api-pncp-pca/index.ts", import.meta.url));
  for (const v of ["leading", "conversao", "priorizacao", "motor", "radar"]) {
    assert(src.includes(`visao === "${v}"`), v);
  }
  assert(src.includes('.from("pca_planos")'));
  assert(src.includes("responderRadar(req, url)"));
});
