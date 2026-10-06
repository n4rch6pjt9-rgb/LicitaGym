import { assertEquals } from "jsr:@std/assert@1";
import { handleRequest, ITENS_ADERENCIA_LOTE, MAX_ITENS_ADERENCIA } from "../../../supabase/functions/api-dashboard-oportunidades/index.ts";
import { applyLicitacaoFilters, type FilterableQuery } from "../../../supabase/functions/api-dashboard-oportunidades/query.ts";
import { parseActionFromBody } from "../../../supabase/functions/api-dashboard-oportunidades/validation.ts";

// Objeto canônico (migration 20261004140000) e aderência no detalhe. Dados fictícios.

type Chamada = { tabela: string; metodo: string; args: unknown[] };

/**
 * Cliente falso que responde por tabela e grava as chamadas. RPC responde por `rpc:<nome>`; sem resposta definida,
 * catalogo_catmat_pdms_efetivos devolve todos os PDMs de licitacao_match (catálogo que contém tudo o que casou).
 */
function clientePorTabela(respostas: Record<string, { data: unknown; error?: unknown; count?: number }>) {
  const chamadas: Chamada[] = [];
  const rpc = (nome: string) => {
    chamadas.push({ tabela: `rpc:${nome}`, metodo: "rpc", args: [nome] });
    const definida = respostas[`rpc:${nome}`];
    if (definida) return Promise.resolve({ data: definida.data, error: definida.error ?? null });
    if (nome === "catalogo_catmat_pdms_efetivos") {
      const match = respostas.licitacao_match?.data;
      const pdms = Array.isArray(match) ? [...new Set(match.map((m: { codigo_pdm: number }) => m.codigo_pdm))] : [];
      return Promise.resolve({ data: pdms.map((codigo_pdm) => ({ codigo_pdm })), error: null });
    }
    return Promise.resolve({ data: null, error: { message: `rpc ${nome} sem resposta no teste` } });
  };
  const from = (tabela: string) => {
    const q: Record<string, unknown> = {};
    const res = respostas[tabela] ?? { data: [], error: null };
    for (const m of ["select", "eq", "in", "order", "limit", "range", "or", "gte", "lte", "lt", "ilike"]) {
      q[m] = (...args: unknown[]) => {
        chamadas.push({ tabela, metodo: m, args });
        return q;
      };
    }
    q.maybeSingle = () => Promise.resolve({ data: res.data, error: res.error ?? null });
    q.then = (ok: (v: unknown) => unknown, err?: (e: unknown) => unknown) =>
      Promise.resolve({ data: res.data, error: res.error ?? null, count: res.count ?? null }).then(ok, err);
    chamadas.push({ tabela, metodo: "from", args: [tabela] });
    return q;
  };
  return { cliente: { from, rpc }, chamadas };
}

const autorizado = { requireAuth: () => null };
const post = (body: unknown) => new Request("http://x/api-dashboard-oportunidades", { method: "POST", body: JSON.stringify(body) });

Deno.test("objeto_categorias: lista o catálogo na ordem e acrescenta OUTROS", async () => {
  const { cliente } = clientePorTabela({
    objeto_categorias: { data: [{ slug: "equipamento_musculacao", nome: "AQUISIÇÃO DE EQUIPAMENTO DE MUSCULAÇÃO", ordem: 40 }] },
  });
  // deno-lint-ignore no-explicit-any
  const res = await handleRequest(post({ action: "objeto_categorias" }), { ...autorizado, getClient: () => cliente as any });
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.categorias.map((c: { slug: string }) => c.slug), ["equipamento_musculacao", "outros"]);
});

Deno.test("objeto_categorias exige sessão", async () => {
  const res = await handleRequest(post({ action: "objeto_categorias" }), {
    requireAuth: () => new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 }),
  });
  assertEquals(res.status, 401);
  await res.body?.cancel();
});

Deno.test("filtros: objeto_categoria (um ou vários, só slugs válidos) e registro_preco", () => {
  const parsed = parseActionFromBody({ action: "list", objeto_categoria: ["material_esportivo", "DROP TABLE", "piso_esportivo"], registro_preco: "true" });
  if ("error" in parsed || parsed.action !== "list") throw new Error("parse falhou");
  assertEquals(parsed.filtros.objeto_categoria, ["material_esportivo", "piso_esportivo"]);
  assertEquals(parsed.filtros.registro_preco, true);

  const chamadas: Array<[string, unknown[]]> = [];
  const q = new Proxy({}, {
    get: (_t, m: string) => (...args: unknown[]) => {
      chamadas.push([m, args]);
      return q;
    },
  }) as unknown as FilterableQuery;
  applyLicitacaoFilters(q, { objeto_categoria: ["material_esportivo", "piso_esportivo"], registro_preco: false });
  assertEquals(chamadas, [
    ["in", ["objeto_categoria", ["material_esportivo", "piso_esportivo"]]],
    ["eq", ["objeto_registro_preco", false]],
  ]);
  chamadas.length = 0;
  applyLicitacaoFilters(q, { objeto_categoria: ["credenciamento"] });
  assertEquals(chamadas, [["eq", ["objeto_categoria", "credenciamento"]]]);
});

Deno.test("get por id traz a aderência CATMAT (licitacao_match) com o nome do PDM", async () => {
  const { cliente, chamadas } = clientePorTabela({
    licitacoes_externas_prioridade_efetiva: { data: { id: 77, fonte: "pncp", objeto: "Esteira (fictício)" } },
    licitacao_match: {
      data: [
        { licitacao_id: 77, codigo_pdm: 7115, origem: "texto_item" },
        { licitacao_id: 77, codigo_pdm: 7115, origem: "texto_item" },
        { licitacao_id: 77, codigo_pdm: 7115, origem: "texto_objeto" },
      ],
    },
    catmat_pdms: { data: [{ codigo_pdm: 7115, nome_pdm: "ESTEIRA ERGOMÉTRICA" }] },
  });
  // deno-lint-ignore no-explicit-any
  const res = await handleRequest(post({ action: "get", id: 77 }), { ...autorizado, getClient: () => cliente as any });
  assertEquals(res.status, 200);
  const { item } = await res.json();
  assertEquals(item.catmat_match, [
    // linhas sem item_id neste cenário: itens vazio (os números dos itens estão nos testes de `itens` abaixo)
    { codigo_pdm: 7115, nome_pdm: "ESTEIRA ERGOMÉTRICA", codigo_item: null, motivo: "texto_item", itens: [] },
    { codigo_pdm: 7115, nome_pdm: "ESTEIRA ERGOMÉTRICA", codigo_item: null, motivo: "texto_objeto", itens: [] },
  ]);
  assertEquals(chamadas.some((c) => c.tabela === "licitacao_match" && c.metodo === "in"), true);
});

Deno.test("get sem casamento não ganha catmat_match; falha na aderência não derruba o detalhe", async () => {
  const sem = clientePorTabela({ licitacoes_externas_prioridade_efetiva: { data: { id: 5, fonte: "pncp" } } });
  // deno-lint-ignore no-explicit-any
  const r1 = await handleRequest(post({ action: "get", id: 5 }), { ...autorizado, getClient: () => sem.cliente as any });
  assertEquals("catmat_match" in (await r1.json()).item, false);

  const falha = clientePorTabela({
    licitacoes_externas_prioridade_efetiva: { data: { id: 5, fonte: "pncp" } },
    licitacao_match: { data: null, error: { message: "timeout" } },
  });
  // deno-lint-ignore no-explicit-any
  const r2 = await handleRequest(post({ action: "get", id: 5 }), { ...autorizado, getClient: () => falha.cliente as any });
  assertEquals(r2.status, 200);
  assertEquals("catmat_match" in (await r2.json()).item, false);
});

Deno.test("get: aderência só mostra PDMs efetivos do catálogo (sem excluídos nem fora do catálogo)", async () => {
  const { cliente, chamadas } = clientePorTabela({
    licitacoes_externas_prioridade_efetiva: { data: { id: 77, fonte: "pncp" } },
    licitacao_match: {
      data: [
        { licitacao_id: 77, codigo_pdm: 1400, origem: "texto_item" }, // no catálogo
        { licitacao_id: 77, codigo_pdm: 3233, origem: "texto_item" }, // excluído (fora de pdms_efetivos)
        { licitacao_id: 77, codigo_pdm: 758, origem: "texto_objeto" }, // fora do catálogo
      ],
    },
    "rpc:catalogo_catmat_pdms_efetivos": { data: [{ codigo_pdm: 1400 }, { codigo_pdm: 8166 }] },
    catmat_pdms: { data: [{ codigo_pdm: 1400, nome_pdm: "CORDA DE PULAR" }] },
  });
  // deno-lint-ignore no-explicit-any
  const res = await handleRequest(post({ action: "get", id: 77 }), { ...autorizado, getClient: () => cliente as any });
  assertEquals(res.status, 200);
  assertEquals((await res.json()).item.catmat_match, [
    { codigo_pdm: 1400, nome_pdm: "CORDA DE PULAR", codigo_item: null, motivo: "texto_item", itens: [] },
  ]);
  // nomes lidos só dos PDMs que ficaram
  assertEquals(chamadas.filter((c) => c.tabela === "catmat_pdms" && c.metodo === "in").map((c) => c.args), [["codigo_pdm", [1400]]]);
});

Deno.test("get: catálogo vazio ou ilegível deixa o detalhe sem aderência (nunca mostra PDM sem filtro)", async () => {
  const warn = console.warn;
  const avisos: unknown[][] = [];
  console.warn = (...a: unknown[]) => avisos.push(a);
  try {
    for (const catalogo of [{ data: [] }, { data: null, error: { message: "timeout" } }, { data: null }]) {
      const { cliente } = clientePorTabela({
        licitacoes_externas_prioridade_efetiva: { data: { id: 77, fonte: "pncp" } },
        licitacao_match: { data: [{ licitacao_id: 77, codigo_pdm: 1400, origem: "texto_item" }] },
        "rpc:catalogo_catmat_pdms_efetivos": catalogo,
      });
      // deno-lint-ignore no-explicit-any
      const res = await handleRequest(post({ action: "get", id: 77 }), { ...autorizado, getClient: () => cliente as any });
      assertEquals(res.status, 200);
      assertEquals("catmat_match" in (await res.json()).item, false);
    }
  } finally {
    console.warn = warn;
  }
  assertEquals(avisos.filter((a) => String(a[0]).includes("catálogo CATMAT indisponível")).length, 2);
});

Deno.test("get: catmat_match.itens agrupa os numero_item por PDM + motivo, sem repetição e em ordem numérica", async () => {
  const { cliente, chamadas } = clientePorTabela({
    licitacoes_externas_prioridade_efetiva: { data: { id: 77, fonte: "pncp", objeto: "Academia (fictício)" } },
    licitacao_match: {
      data: [
        { licitacao_id: 77, codigo_pdm: 7115, origem: "texto_item", item_id: 9010 },
        { licitacao_id: 77, codigo_pdm: 7115, origem: "texto_item", item_id: 9002 },
        { licitacao_id: 77, codigo_pdm: 7115, origem: "texto_item", item_id: 9010 }, // repetido
        { licitacao_id: 77, codigo_pdm: 7115, origem: "texto_item", item_id: 9009 },
        { licitacao_id: 77, codigo_pdm: 7115, origem: "texto_objeto", item_id: null },
        { licitacao_id: 77, codigo_pdm: 2638, origem: "texto_item", item_id: 9002 }, // mesmo item, outro PDM
        { licitacao_id: 77, codigo_pdm: 2638, origem: "texto_item", item_id: 9999 }, // item sem linha em licitacao_itens
      ],
    },
    licitacao_itens: {
      data: [
        { id: 9010, numero_item: 10 },
        { id: 9002, numero_item: 2 },
        { id: 9009, numero_item: 9 },
      ],
    },
    catmat_pdms: { data: [{ codigo_pdm: 7115, nome_pdm: "ESTEIRA ERGOMÉTRICA" }, { codigo_pdm: 2638, nome_pdm: "APARELHO" }] },
  });
  // deno-lint-ignore no-explicit-any
  const res = await handleRequest(post({ action: "get", id: 77 }), { ...autorizado, getClient: () => cliente as any });
  assertEquals(res.status, 200);
  const { item } = await res.json();
  assertEquals(item.catmat_match, [
    { codigo_pdm: 7115, nome_pdm: "ESTEIRA ERGOMÉTRICA", codigo_item: null, motivo: "texto_item", itens: [2, 9, 10] },
    { codigo_pdm: 7115, nome_pdm: "ESTEIRA ERGOMÉTRICA", codigo_item: null, motivo: "texto_objeto", itens: [] },
    { codigo_pdm: 2638, nome_pdm: "APARELHO", codigo_item: null, motivo: "texto_item", itens: [2] },
  ]);
  // licitacao_itens lida só pelos item_ids necessários, sem repetição, numa chamada
  const leituras = chamadas.filter((c) => c.tabela === "licitacao_itens" && c.metodo === "in");
  assertEquals(leituras, [{ tabela: "licitacao_itens", metodo: "in", args: ["id", [9010, 9002, 9009, 9999]] }]);
  assertEquals(chamadas.some((c) => c.tabela === "licitacao_itens" && c.metodo === "select" && c.args[0] === "id,numero_item"), true);
});

Deno.test("get: catmat_match.itens limita a MAX_ITENS_ADERENCIA (os menores números) e lê licitacao_itens em lotes", async () => {
  const total = ITENS_ADERENCIA_LOTE + 20;
  // ids em ordem decrescente de numero_item, para provar que a ordem vem do número e não da leitura
  const match = Array.from({ length: total }, (_, i) => ({ licitacao_id: 5, codigo_pdm: 7115, origem: "texto_item", item_id: 1000 + i }));
  const itens = Array.from({ length: total }, (_, i) => ({ id: 1000 + i, numero_item: total - i }));
  const { cliente, chamadas } = clientePorTabela({
    licitacoes_externas_prioridade_efetiva: { data: { id: 5, fonte: "pncp" } },
    licitacao_match: { data: match },
    licitacao_itens: { data: itens },
  });
  // deno-lint-ignore no-explicit-any
  const res = await handleRequest(post({ action: "get", id: 5 }), { ...autorizado, getClient: () => cliente as any });
  const { item } = await res.json();
  assertEquals(item.catmat_match.length, 1);
  assertEquals(item.catmat_match[0].itens, Array.from({ length: MAX_ITENS_ADERENCIA }, (_, i) => i + 1));
  const lotes = chamadas.filter((c) => c.tabela === "licitacao_itens" && c.metodo === "in").map((c) => (c.args[1] as number[]).length);
  assertEquals(lotes, [ITENS_ADERENCIA_LOTE, 20]);
});

Deno.test("get: falha na leitura de licitacao_itens não derruba o detalhe e deixa itens vazio", async () => {
  const warn = console.warn;
  const avisos: unknown[][] = [];
  console.warn = (...a: unknown[]) => avisos.push(a);
  try {
    for (const licitacaoItens of [{ data: null, error: { message: "timeout" } }, { data: null }]) {
      const { cliente } = clientePorTabela({
        licitacoes_externas_prioridade_efetiva: { data: { id: 5, fonte: "pncp" } },
        licitacao_match: { data: [{ licitacao_id: 5, codigo_pdm: 7115, origem: "texto_item", item_id: 1 }] },
        licitacao_itens: licitacaoItens,
        catmat_pdms: { data: [{ codigo_pdm: 7115, nome_pdm: "ESTEIRA ERGOMÉTRICA" }] },
      });
      // deno-lint-ignore no-explicit-any
      const res = await handleRequest(post({ action: "get", id: 5 }), { ...autorizado, getClient: () => cliente as any });
      assertEquals(res.status, 200);
      assertEquals((await res.json()).item.catmat_match, [
        { codigo_pdm: 7115, nome_pdm: "ESTEIRA ERGOMÉTRICA", codigo_item: null, motivo: "texto_item", itens: [] },
      ]);
    }
    // exceção lançada pelo cliente (rede) também não derruba
    const base = clientePorTabela({
      licitacoes_externas_prioridade_efetiva: { data: { id: 5, fonte: "pncp" } },
      licitacao_match: { data: [{ licitacao_id: 5, codigo_pdm: 7115, origem: "texto_item", item_id: 1 }] },
    });
    const cliente = {
      rpc: base.cliente.rpc,
      from: (t: string) => {
        if (t === "licitacao_itens") throw new Error("rede caiu");
        return base.cliente.from(t);
      },
    };
    // deno-lint-ignore no-explicit-any
    const res = await handleRequest(post({ action: "get", id: 5 }), { ...autorizado, getClient: () => cliente as any });
    assertEquals(res.status, 200);
    assertEquals((await res.json()).item.catmat_match[0].itens, []);
  } finally {
    console.warn = warn;
  }
  assertEquals(avisos.filter((a) => String(a[0]).includes("licitacao_itens") || String(a[0]).includes("números dos itens")).length, 3);
});

Deno.test("get: falha no 2º lote de licitacao_itens deixa itens vazio (sem lista parcial do 1º lote)", async () => {
  const total = ITENS_ADERENCIA_LOTE + 20;
  const match = Array.from({ length: total }, (_, i) => ({ licitacao_id: 5, codigo_pdm: 7115, origem: "texto_item", item_id: 1000 + i }));
  const base = clientePorTabela({
    licitacoes_externas_prioridade_efetiva: { data: { id: 5, fonte: "pncp" } },
    licitacao_match: { data: match },
  });
  let leituras = 0;
  const cliente = {
    rpc: base.cliente.rpc,
    from: (t: string) => {
      if (t !== "licitacao_itens") return base.cliente.from(t);
      leituras++;
      const resposta = leituras === 1
        ? { data: Array.from({ length: ITENS_ADERENCIA_LOTE }, (_, i) => ({ id: 1000 + i, numero_item: i + 1 })) }
        : { data: null, error: { message: "timeout" } };
      return clientePorTabela({ licitacao_itens: resposta }).cliente.from(t);
    },
  };
  const warn = console.warn;
  console.warn = () => {};
  try {
    // deno-lint-ignore no-explicit-any
    const res = await handleRequest(post({ action: "get", id: 5 }), { ...autorizado, getClient: () => cliente as any });
    assertEquals(res.status, 200);
    assertEquals((await res.json()).item.catmat_match[0].itens, []);
  } finally {
    console.warn = warn;
  }
  assertEquals(leituras, 2);
});

Deno.test("get por processo: itens separados por licitação, com uma leitura de licitacao_itens para todas", async () => {
  const { cliente, chamadas } = clientePorTabela({
    licitacoes_externas_prioridade_efetiva: { data: [{ id: 1, fonte: "pncp" }, { id: 2, fonte: "pncp" }], count: 2 },
    licitacao_match: {
      data: [
        { licitacao_id: 1, codigo_pdm: 7115, origem: "texto_item", item_id: 11 },
        { licitacao_id: 2, codigo_pdm: 7115, origem: "texto_item", item_id: 21 },
      ],
    },
    licitacao_itens: { data: [{ id: 11, numero_item: 3 }, { id: 21, numero_item: 1 }] },
  });
  // deno-lint-ignore no-explicit-any
  const res = await handleRequest(post({ action: "get", orgao_cnpj: "07486108000185", processo_norm: "2026001" }), { ...autorizado, getClient: () => cliente as any });
  assertEquals(res.status, 200);
  const { items } = await res.json();
  assertEquals(items.map((i: { catmat_match: Array<{ itens: number[] }> }) => i.catmat_match[0].itens), [[3], [1]]);
  assertEquals(chamadas.filter((c) => c.tabela === "licitacao_itens" && c.metodo === "in").length, 1);
});

Deno.test("get só com texto_objeto não lê licitacao_itens", async () => {
  const { cliente, chamadas } = clientePorTabela({
    licitacoes_externas_prioridade_efetiva: { data: { id: 5, fonte: "pncp" } },
    licitacao_match: { data: [{ licitacao_id: 5, codigo_pdm: 7115, origem: "texto_objeto", item_id: null }] },
  });
  // deno-lint-ignore no-explicit-any
  const res = await handleRequest(post({ action: "get", id: 5 }), { ...autorizado, getClient: () => cliente as any });
  assertEquals((await res.json()).item.catmat_match[0].itens, []);
  assertEquals(chamadas.some((c) => c.tabela === "licitacao_itens"), false);
});

Deno.test("get: view sem as colunas do objeto (função publicada antes da migration) responde sem elas", async () => {
  const selects: string[] = [];
  let tentativa = 0;
  const cliente = {
    from: (tabela: string) => {
      const q: Record<string, unknown> = {};
      for (const m of ["eq", "in", "order", "limit"]) q[m] = () => q;
      q.select = (cols: string) => {
        if (tabela !== "licitacao_match") selects.push(cols);
        return q;
      };
      q.maybeSingle = () => {
        tentativa++;
        return Promise.resolve(
          tentativa === 1
            ? { data: null, error: { code: "42703", message: "column licitacoes_externas_prioridade_efetiva.objeto_categoria does not exist" } }
            : { data: { id: 9, fonte: "pncp" }, error: null },
        );
      };
      q.then = (ok: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(ok);
      return q;
    },
  };
  // deno-lint-ignore no-explicit-any
  const res = await handleRequest(post({ action: "get", id: 9 }), { ...autorizado, getClient: () => cliente as any });
  assertEquals(res.status, 200);
  assertEquals(selects.length, 2);
  assertEquals(selects[0].includes("objeto_categoria"), true);
  assertEquals(selects[1].includes("objeto_categoria"), false);
});

Deno.test("filtro objeto_categoria: só slugs inválidos é 400 (não vira lista sem filtro); mais de 20 é 400", async () => {
  const invalido = parseActionFromBody({ action: "list", objeto_categoria: ["FOO", "a b"] });
  assertEquals("error" in invalido, true);
  const muitos = parseActionFromBody({ action: "list", objeto_categoria: Array.from({ length: 21 }, (_, i) => `cat_${i}`) });
  assertEquals("error" in muitos, true);
  const misto = parseActionFromBody({ action: "list", objeto_categoria: ["FOO", "playground"] });
  if ("error" in misto || misto.action !== "list") throw new Error("parse falhou");
  assertEquals(misto.filtros.objeto_categoria, ["playground"]);
});
