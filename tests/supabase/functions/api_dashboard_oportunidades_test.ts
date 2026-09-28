import { assertEquals } from "jsr:@std/assert@1";
import {
  getNextDayIso,
  isDateOnly,
  parseActionFromBody,
  parseActionFromUrl,
  parseGetParams,
  parseListParams,
  sanitizeBoolean,
  sanitizeDate,
  sanitizeNumber,
  sanitizeString,
  sanitizeStringList,
} from "../../../supabase/functions/api-dashboard-oportunidades/validation.ts";
import {
  applyLicitacaoFilters,
  calculateRange,
  sanitizeSearchTerm,
  type FilterableQuery,
} from "../../../supabase/functions/api-dashboard-oportunidades/query.ts";
import {
  handleRequest,
  PUBLIC_LICITACAO_COLUMNS,
} from "../../../supabase/functions/api-dashboard-oportunidades/index.ts";

// Helper mock para testar montagem de query
class MockQueryBuilder implements FilterableQuery {
  calls: Array<{ method: string; args: unknown[] }> = [];

  eq(column: string, value: unknown): this {
    this.calls.push({ method: "eq", args: [column, value] });
    return this;
  }
  in(column: string, values: unknown[]): this {
    this.calls.push({ method: "in", args: [column, values] });
    return this;
  }
  gte(column: string, value: unknown): this {
    this.calls.push({ method: "gte", args: [column, value] });
    return this;
  }
  lte(column: string, value: unknown): this {
    this.calls.push({ method: "lte", args: [column, value] });
    return this;
  }
  lt(column: string, value: unknown): this {
    this.calls.push({ method: "lt", args: [column, value] });
    return this;
  }
  ilike(column: string, pattern: string): this {
    this.calls.push({ method: "ilike", args: [column, pattern] });
    return this;
  }
  or(filters: string): this {
    this.calls.push({ method: "or", args: [filters] });
    return this;
  }
}

// --------------------------------------------------------------------------
// Sanitizers e Utilitários de Data
// --------------------------------------------------------------------------

Deno.test("sanitizeString lida com tipos variados e vazios", () => {
  assertEquals(sanitizeString("  teste  "), "teste");
  assertEquals(sanitizeString(""), undefined);
  assertEquals(sanitizeString("   "), undefined);
  assertEquals(sanitizeString(123), undefined);
  assertEquals(sanitizeString(null), undefined);
  assertEquals(sanitizeString(undefined), undefined);
});

Deno.test("sanitizeDate valida formato de data ISO", () => {
  assertEquals(sanitizeDate("2026-09-28"), "2026-09-28");
  assertEquals(sanitizeDate("2026-09-28T12:00:00Z"), "2026-09-28T12:00:00Z");
  assertEquals(sanitizeDate("data-invalida"), undefined);
  assertEquals(sanitizeDate(""), undefined);
  assertEquals(sanitizeDate(null), undefined);
});

Deno.test("isDateOnly e getNextDayIso para limites superiores de data cheia", () => {
  assertEquals(isDateOnly("2026-09-28"), true);
  assertEquals(isDateOnly("2026-09-28T10:00:00Z"), false);
  assertEquals(isDateOnly("2026-02-28"), true);
  assertEquals(getNextDayIso("2026-09-28"), "2026-09-29");
  assertEquals(getNextDayIso("2026-12-31"), "2027-01-01");
});

Deno.test("sanitizeNumber valida e converte números e strings numéricas", () => {
  assertEquals(sanitizeNumber(42), 42);
  assertEquals(sanitizeNumber(0), 0);
  assertEquals(sanitizeNumber("123.45"), 123.45);
  assertEquals(sanitizeNumber("abc"), undefined);
  assertEquals(sanitizeNumber(NaN), undefined);
  assertEquals(sanitizeNumber(Infinity), undefined);
});

Deno.test("sanitizeBoolean converte valores booleanos e strings conhecidas", () => {
  assertEquals(sanitizeBoolean(true), true);
  assertEquals(sanitizeBoolean(false), false);
  assertEquals(sanitizeBoolean("true"), true);
  assertEquals(sanitizeBoolean("1"), true);
  assertEquals(sanitizeBoolean("sim"), true);
  assertEquals(sanitizeBoolean("false"), false);
  assertEquals(sanitizeBoolean("0"), false);
  assertEquals(sanitizeBoolean("nao"), false);
  assertEquals(sanitizeBoolean("outro"), undefined);
});

Deno.test("sanitizeStringList aceita arrays ou strings separadas por vírgula", () => {
  assertEquals(sanitizeStringList(["pregao", "concorrencia"]), ["pregao", "concorrencia"]);
  assertEquals(sanitizeStringList("pregao, concorrencia"), ["pregao", "concorrencia"]);
  assertEquals(sanitizeStringList(""), undefined);
  assertEquals(sanitizeStringList([]), undefined);
});

// --------------------------------------------------------------------------
// Parsing de Parâmetros (URL e Body)
// --------------------------------------------------------------------------

Deno.test("parseListParams aplica paginação padrão e sanitização de campos", () => {
  const result = parseListParams({
    page: "2",
    limit: "50",
    order_by: "data_publicacao",
    order_direction: "asc",
    uf: "rj",
    prioridade: "leads",
    valor_min: "1000",
    valor_max: "50000",
    busca: "halteres musculacao",
  });

  assertEquals(result.action, "list");
  assertEquals(result.page, 2);
  assertEquals(result.limit, 50);
  assertEquals(result.order_by, "data_publicacao");
  assertEquals(result.order_direction, "asc");
  assertEquals(result.filtros.uf, "RJ");
  assertEquals(result.filtros.prioridade, "leads");
  assertEquals(result.filtros.valor_min, 1000);
  assertEquals(result.filtros.valor_max, 50000);
  assertEquals(result.filtros.busca, "halteres musculacao");
});

Deno.test("parseListParams respeita MAX_LIMIT de 100", () => {
  const result = parseListParams({ limit: "500" });
  assertEquals(result.limit, 100);
});

Deno.test("parseGetParams valida ID, codigo_externo ou par orgao_cnpj + processo_norm", () => {
  const byId = parseGetParams({ id: 123 });
  assertEquals(byId.ok, true);
  if (byId.ok) {
    assertEquals(byId.params.id, "123");
  }

  const byCodigo = parseGetParams({
    codigo_externo: "07486108000185-1-000001/2026",
    fonte: "pncp",
  });
  assertEquals(byCodigo.ok, true);
  if (byCodigo.ok) {
    assertEquals(byCodigo.params.codigo_externo, "07486108000185-1-000001/2026");
    assertEquals(byCodigo.params.fonte, "pncp");
  }

  const byCertame = parseGetParams({
    orgao_cnpj: "07.486.108/0001-85",
    processo_norm: "00007.20260204/0002-28",
  });
  assertEquals(byCertame.ok, true);
  if (byCertame.ok) {
    assertEquals(byCertame.params.orgao_cnpj, "07486108000185");
    assertEquals(byCertame.params.processo_norm, "0000720260204000228");
  }

  const invalid = parseGetParams({});
  assertEquals(invalid.ok, false);
});

Deno.test("parseActionFromUrl roteia list, get e readiness", () => {
  const listUrl = new URL("http://localhost/api?action=list&uf=SP&limit=10");
  const listRes = parseActionFromUrl(listUrl);
  assertEquals("error" in listRes, false);
  if (!("error" in listRes)) {
    assertEquals(listRes.action, "list");
    if (listRes.action === "list") {
      assertEquals(listRes.filtros.uf, "SP");
      assertEquals(listRes.limit, 10);
    }
  }

  const getUrl = new URL("http://localhost/api?action=get&id=42");
  const getRes = parseActionFromUrl(getUrl);
  assertEquals("error" in getRes, false);
  if (!("error" in getRes)) {
    assertEquals(getRes.action, "get");
    if (getRes.action === "get") {
      assertEquals(getRes.id, "42");
    }
  }

  const getCodigoUrl = new URL(
    "http://localhost/api?action=get&codigo_externo=07486108000185-1-000001/2026",
  );
  const getCodigoRes = parseActionFromUrl(getCodigoUrl);
  assertEquals("error" in getCodigoRes, false);
  if (!("error" in getCodigoRes)) {
    assertEquals(getCodigoRes.action, "get");
    if (getCodigoRes.action === "get") {
      assertEquals(getCodigoRes.codigo_externo, "07486108000185-1-000001/2026");
    }
  }

  const readinessUrl = new URL("http://localhost/api?action=readiness");
  const readRes = parseActionFromUrl(readinessUrl);
  assertEquals("error" in readRes, false);
  if (!("error" in readRes)) {
    assertEquals(readRes.action, "readiness");
  }

  const invalidUrl = new URL("http://localhost/api?action=desconhecida");
  const invRes = parseActionFromUrl(invalidUrl);
  assertEquals("error" in invRes, true);
});

Deno.test("parseActionFromBody aceita JSON {action, ...}", () => {
  const listBody = parseActionFromBody({
    action: "list",
    uf: "MG",
    modalidade: ["Pregao", "Dispensa"],
  });
  assertEquals("error" in listBody, false);
  if (!("error" in listBody)) {
    assertEquals(listBody.action, "list");
    if (listBody.action === "list") {
      assertEquals(listBody.filtros.uf, "MG");
      assertEquals(listBody.filtros.modalidade, ["Pregao", "Dispensa"]);
    }
  }

  const getBody = parseActionFromBody({
    action: "get",
    codigo_externo: "12345678000199-1-000001/2026",
  });
  assertEquals("error" in getBody, false);
  if (!("error" in getBody)) {
    assertEquals(getBody.action, "get");
    if (getBody.action === "get") {
      assertEquals(getBody.codigo_externo, "12345678000199-1-000001/2026");
    }
  }

  const readBody = parseActionFromBody({ action: "readiness" });
  assertEquals("error" in readBody, false);
  if (!("error" in readBody)) {
    assertEquals(readBody.action, "readiness");
  }
});

// --------------------------------------------------------------------------
// Montagem de Query e Limites de Data
// --------------------------------------------------------------------------

Deno.test("calculateRange calcula limites PostgREST corretos", () => {
  assertEquals(calculateRange(1, 20), { from: 0, to: 19 });
  assertEquals(calculateRange(2, 20), { from: 20, to: 39 });
  assertEquals(calculateRange(3, 10), { from: 20, to: 29 });
});

Deno.test("applyLicitacaoFilters usa lt(dia_seguinte) para datas só-dia", () => {
  const mock = new MockQueryBuilder();

  applyLicitacaoFilters(mock, {
    data_publicacao_fim: "2026-03-31",
    data_fim_max: "2026-04-15",
  });

  const ltCalls = mock.calls.filter((c) => c.method === "lt");
  assertEquals(ltCalls.length, 2);
  assertEquals(ltCalls[0], {
    method: "lt",
    args: ["data_publicacao", "2026-04-01"],
  });
  assertEquals(ltCalls[1], {
    method: "lt",
    args: ["data_fim", "2026-04-16"],
  });
});

Deno.test("applyLicitacaoFilters usa lte para datas com timestamp completo", () => {
  const mock = new MockQueryBuilder();

  applyLicitacaoFilters(mock, {
    data_publicacao_fim: "2026-03-31T23:59:59Z",
  });

  const lteCalls = mock.calls.filter((c) => c.method === "lte");
  assertEquals(lteCalls.length, 1);
  assertEquals(lteCalls[0], {
    method: "lte",
    args: ["data_publicacao", "2026-03-31T23:59:59Z"],
  });
});

Deno.test("applyLicitacaoFilters constrói chamadas no builder", () => {
  const mock = new MockQueryBuilder();

  applyLicitacaoFilters(mock, {
    prioridade: "leads",
    uf: "RJ",
    municipio: "Niteroi",
    orgao_cnpj: "12345678000199",
    orgao_nome: "Prefeitura",
    modalidade: ["Pregão", "Dispensa"],
    situacao: "Aberta",
    fase: "Julgamento",
    categoria_escopo: "catmat",
    interesse_borracha: true,
    fonte: "pncp",
    data_publicacao_inicio: "2026-01-01",
    data_publicacao_fim: "2026-03-31",
    data_inicio_min: "2026-02-01",
    data_inicio_max: "2026-02-28",
    data_fim_min: "2026-03-01",
    data_fim_max: "2026-03-15",
    data_homologacao_min: "2026-04-01",
    data_homologacao_max: "2026-04-30",
    valor_min: 1000,
    valor_max: 50000,
    busca: "anilhas crossfit",
  });

  const methodNames = mock.calls.map((c) => c.method);
  assertEquals(methodNames.includes("eq"), true);
  assertEquals(methodNames.includes("in"), true);
  assertEquals(methodNames.includes("ilike"), true);
  assertEquals(methodNames.includes("gte"), true);
  assertEquals(methodNames.includes("lt"), true);
  assertEquals(methodNames.includes("lte"), true); // valor_max
  assertEquals(methodNames.includes("or"), true);

  // Verificar filtro or de busca textual
  const orCall = mock.calls.find((c) => c.method === "or");
  assertEquals(
    orCall?.args[0],
    "objeto.ilike.*anilhas crossfit*,numero_processo.ilike.*anilhas crossfit*,numero_edital.ilike.*anilhas crossfit*",
  );
});

Deno.test("sanitizeSearchTerm remove caracteres que quebram sintaxe PostgREST", () => {
  assertEquals(sanitizeSearchTerm("teste, (123) \"algo\""), "teste 123 algo");
});

// --------------------------------------------------------------------------
// Contrato HTTP (OPTIONS, CORS, Método não permitido, Erros de Validação e JSON)
// --------------------------------------------------------------------------

Deno.test("handleRequest responde 200 para OPTIONS com CORS headers", async () => {
  const req = new Request("http://localhost/api-dashboard-oportunidades", {
    method: "OPTIONS",
  });
  const res = await handleRequest(req);
  assertEquals(res.status, 200);
  assertEquals(res.headers.get("Access-Control-Allow-Origin"), "*");
});

Deno.test("handleRequest rejeita métodos não permitidos com 405", async () => {
  const req = new Request("http://localhost/api-dashboard-oportunidades", {
    method: "DELETE",
  });
  const res = await handleRequest(req);
  assertEquals(res.status, 405);
  const body = await res.json();
  assertEquals(body.error, "Método não permitido. Utilize GET ou POST.");
});

Deno.test("handleRequest rejeita ação inválida com 400", async () => {
  const req = new Request("http://localhost/api-dashboard-oportunidades?action=invalid", {
    method: "GET",
  });
  const res = await handleRequest(req);
  assertEquals(res.status, 400);
  const body = await res.json();
  assertEquals(body.error.includes("Ação inválida"), true);
});

Deno.test("handleRequest POST com JSON malformado retorna 400 e não cai em list", async () => {
  const req = new Request("http://localhost/api-dashboard-oportunidades", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{ malformed json",
  });
  const res = await handleRequest(req);
  assertEquals(res.status, 400);
  const body = await res.json();
  assertEquals(body.error.includes("Corpo JSON inválido"), true);
});

Deno.test("handleRequest POST com JSON array retorna 400", async () => {
  const req = new Request("http://localhost/api-dashboard-oportunidades", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "[]",
  });
  const res = await handleRequest(req);
  assertEquals(res.status, 400);
  const body = await res.json();
  assertEquals(body.error.includes("Esperado objeto JSON"), true);
});

Deno.test("handleRequest get sem parâmetros retorna 400 claro", async () => {
  const req = new Request("http://localhost/api-dashboard-oportunidades?action=get", {
    method: "GET",
  });
  const res = await handleRequest(req);
  assertEquals(res.status, 400);
  const body = await res.json();
  assertEquals(body.error.includes("Identificador ausente"), true);
});

// --------------------------------------------------------------------------
// Testes com Mock Client Supabase (list, get, readiness, colunas públicas)
// --------------------------------------------------------------------------

function createMockSupabaseClient(config: {
  listResult?: { data: unknown[]; count: number; error: unknown };
  singleResult?: { data: unknown; error: unknown };
  headCountResult?: { count: number; error: unknown };
  onSelect?: (cols?: string) => void;
}) {
  const thenable = {
    then(onfulfilled?: (v: unknown) => unknown, onrejected?: (e: unknown) => unknown) {
      const res = config.listResult ?? { data: [], count: 0, error: null };
      return Promise.resolve(res).then(onfulfilled, onrejected);
    },
    select(cols?: string) {
      config.onSelect?.(cols);
      return thenable;
    },
    eq() {
      return thenable;
    },
    in() {
      return thenable;
    },
    gte() {
      return thenable;
    },
    lte() {
      return thenable;
    },
    lt() {
      return thenable;
    },
    ilike() {
      return thenable;
    },
    or() {
      return thenable;
    },
    order() {
      return thenable;
    },
    range() {
      return thenable;
    },
    limit() {
      return thenable;
    },
    maybeSingle() {
      return Promise.resolve(config.singleResult ?? { data: null, error: null });
    },
  };

  return {
    from(_table: string) {
      return {
        select(cols?: string, opts?: { count?: string; head?: boolean }) {
          config.onSelect?.(cols);
          if (opts?.head) {
            return Promise.resolve(config.headCountResult ?? { count: 10, error: null });
          }
          return thenable;
        },
      };
    },
  };
}

Deno.test("handleRequest readiness retorna status saudável e contagem", async () => {
  // deno-lint-ignore no-explicit-any
  const mockClient = createMockSupabaseClient({
    headCountResult: { count: 42, error: null },
    singleResult: {
      data: {
        updated_at: "2026-09-28T10:00:00Z",
        last_synced_at: "2026-09-28T09:30:00Z",
      },
      error: null,
    },
  }) as any;

  const req = new Request("http://localhost/api-dashboard-oportunidades?action=readiness", {
    method: "GET",
  });
  const res = await handleRequest(req, { getClient: () => mockClient });
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.ready, true);
  assertEquals(body.total_registros, 42);
  assertEquals(body.ultima_atualizacao, "2026-09-28T10:00:00Z");
});

Deno.test("handleRequest get por id projeta colunas públicas seguras e retorna 200", async () => {
  let selectedCols = "";
  // deno-lint-ignore no-explicit-any
  const mockClient = createMockSupabaseClient({
    onSelect: (cols) => {
      if (cols) selectedCols = cols;
    },
    singleResult: {
      data: {
        id: 101,
        orgao_nome: "Prefeitura Municipal",
        objeto: "Aquisição de Esteiras",
      },
      error: null,
    },
  }) as any;

  const req = new Request("http://localhost/api-dashboard-oportunidades?action=get&id=101", {
    method: "GET",
  });
  const res = await handleRequest(req, { getClient: () => mockClient });
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.item.id, 101);
  assertEquals(selectedCols, PUBLIC_LICITACAO_COLUMNS);
  assertEquals(selectedCols.includes("raw"), false);
  assertEquals(selectedCols.includes("esclarecimentos"), false);
});

Deno.test("handleRequest get por codigo_externo único retorna 200", async () => {
  // deno-lint-ignore no-explicit-any
  const mockClient = createMockSupabaseClient({
    singleResult: {
      data: {
        id: 102,
        codigo_externo: "07486108000185-1-000001/2026",
        objeto: "Compra PNCP única",
      },
      error: null,
    },
  }) as any;

  const req = new Request(
    "http://localhost/api-dashboard-oportunidades?action=get&codigo_externo=07486108000185-1-000001/2026&fonte=pncp",
    { method: "GET" },
  );
  const res = await handleRequest(req, { getClient: () => mockClient });
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.item.id, 102);
  assertEquals(body.item.codigo_externo, "07486108000185-1-000001/2026");
});

Deno.test("handleRequest get por orgao_cnpj e processo_norm retorna coleção (items)", async () => {
  // deno-lint-ignore no-explicit-any
  const mockClient = createMockSupabaseClient({
    listResult: {
      data: [
        { id: 201, objeto: "Compra 1 do processo" },
        { id: 202, objeto: "Compra 2 do processo" },
      ],
      count: 2,
      error: null,
    },
  }) as any;

  const req = new Request(
    "http://localhost/api-dashboard-oportunidades?action=get&orgao_cnpj=07.486.108/0001-85&processo_norm=2026/001",
    { method: "GET" },
  );
  const res = await handleRequest(req, { getClient: () => mockClient });
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.total, 2);
  assertEquals(Array.isArray(body.items), true);
  assertEquals(body.items.length, 2);
  assertEquals(body.items[0].id, 201);
  assertEquals(body.items[1].id, 202);
});

Deno.test("handleRequest get por orgao_cnpj e processo_norm sem registros retorna 404", async () => {
  // deno-lint-ignore no-explicit-any
  const mockClient = createMockSupabaseClient({
    listResult: { data: [], count: 0, error: null },
  }) as any;

  const req = new Request(
    "http://localhost/api-dashboard-oportunidades?action=get&orgao_cnpj=07.486.108/0001-85&processo_norm=999999",
    { method: "GET" },
  );
  const res = await handleRequest(req, { getClient: () => mockClient });
  assertEquals(res.status, 404);
  const body = await res.json();
  assertEquals(body.error.includes("Nenhuma licitação encontrada"), true);
  assertEquals(body.items, []);
});

Deno.test("handleRequest em erro de banco retorna mensagem genérica (não vaza PostgREST)", async () => {
  // deno-lint-ignore no-explicit-any
  const mockClient = createMockSupabaseClient({
    singleResult: {
      data: null,
      error: { message: "relation licitacoes_externas does not exist (internals leaked)" },
    },
  }) as any;

  const req = new Request("http://localhost/api-dashboard-oportunidades?action=get&id=1", {
    method: "GET",
  });
  const res = await handleRequest(req, { getClient: () => mockClient });
  assertEquals(res.status, 400);
  const body = await res.json();
  assertEquals(body.error, "Falha ao consultar licitação");
  assertEquals(JSON.stringify(body).includes("internals leaked"), false);
});

Deno.test("handleRequest list retorna 200 com items e total (inclusive lista vazia)", async () => {
  // deno-lint-ignore no-explicit-any
  const mockClient = createMockSupabaseClient({
    listResult: { data: [], count: 0, error: null },
  }) as any;

  const req = new Request("http://localhost/api-dashboard-oportunidades?action=list&uf=AC", {
    method: "GET",
  });
  const res = await handleRequest(req, { getClient: () => mockClient });
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.action, "list");
  assertEquals(body.total, 0);
  assertEquals(Array.isArray(body.items), true);
  assertEquals(body.items.length, 0);
});

Deno.test("handleRequest list via POST JSON {action: 'list'}", async () => {
  // deno-lint-ignore no-explicit-any
  const mockClient = createMockSupabaseClient({
    listResult: {
      data: [{ id: 1, objeto: "Piso emborrachado" }],
      count: 1,
      error: null,
    },
  }) as any;

  const req = new Request("http://localhost/api-dashboard-oportunidades", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      action: "list",
      uf: "SP",
      interesse_borracha: true,
      limit: 10,
    }),
  });
  const res = await handleRequest(req, { getClient: () => mockClient });
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.action, "list");
  assertEquals(body.total, 1);
  assertEquals(body.items[0].objeto, "Piso emborrachado");
});
