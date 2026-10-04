import { assertEquals } from "jsr:@std/assert@1";
import { handleRequest } from "../../../supabase/functions/api-dashboard-oportunidades/index.ts";
import { applyLicitacaoFilters, type FilterableQuery } from "../../../supabase/functions/api-dashboard-oportunidades/query.ts";
import { parseActionFromBody } from "../../../supabase/functions/api-dashboard-oportunidades/validation.ts";

// Objeto canônico (migration 20261004140000) e aderência no detalhe. Dados fictícios.

type Chamada = { tabela: string; metodo: string; args: unknown[] };

/** Cliente falso que responde por tabela e grava as chamadas. */
function clientePorTabela(respostas: Record<string, { data: unknown; error?: unknown; count?: number }>) {
  const chamadas: Chamada[] = [];
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
  return { cliente: { from }, chamadas };
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
    { codigo_pdm: 7115, nome_pdm: "ESTEIRA ERGOMÉTRICA", codigo_item: null, motivo: "texto_item" },
    { codigo_pdm: 7115, nome_pdm: "ESTEIRA ERGOMÉTRICA", codigo_item: null, motivo: "texto_objeto" },
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
