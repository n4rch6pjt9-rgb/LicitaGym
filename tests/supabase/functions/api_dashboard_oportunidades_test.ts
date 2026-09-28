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

// Helper mock para testar montagem de query em applyLicitacaoFilters
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
// Sanitizers e Utilitários de Data & Número
// --------------------------------------------------------------------------

Deno.test("sanitizeString lida com tipos variados e vazios", () => {
  assertEquals(sanitizeString("  teste  "), "teste");
  assertEquals(sanitizeString(""), undefined);
  assertEquals(sanitizeString("   "), undefined);
  assertEquals(sanitizeString(123), undefined);
  assertEquals(sanitizeString(null), undefined);
  assertEquals(sanitizeString(undefined), undefined);
});

Deno.test("sanitizeDate valida formato de data ISO e rejeita datas impossíveis por rolagem", () => {
  // Datas válidas só-dia
  assertEquals(sanitizeDate("2026-09-28"), "2026-09-28");
  assertEquals(sanitizeDate("2024-02-29"), "2024-02-29"); // ano bissexto válido
  assertEquals(sanitizeDate("2026-02-28"), "2026-02-28");

  // Rejeição de datas impossíveis por rolagem
  assertEquals(sanitizeDate("2026-02-29"), undefined); // 2026 não é bissexto
  assertEquals(sanitizeDate("2026-02-30"), undefined);
  assertEquals(sanitizeDate("2026-04-31"), undefined);
  assertEquals(sanitizeDate("2026-13-01"), undefined);
  assertEquals(sanitizeDate("2026-00-10"), undefined);
  assertEquals(sanitizeDate("2026-01-00"), undefined);
  assertEquals(sanitizeDate("2026-01-32"), undefined);

    // Timestamps completos válidos e inválidos
    assertEquals(sanitizeDate("2026-09-28T12:00:00Z"), "2026-09-28T12:00:00Z");
    assertEquals(sanitizeDate("2026-09-28T12:00:00.000Z"), "2026-09-28T12:00:00.000Z");
    assertEquals(sanitizeDate("2026-09-28T12:00:00-03:00"), "2026-09-28T12:00:00-03:00");
    assertEquals(sanitizeDate("2026-09-28T12:00:00+02:00"), "2026-09-28T12:00:00+02:00");
    // Sem Z ou offset deve ser rejeitado (dá undefined)
    assertEquals(sanitizeDate("2026-09-28 12:00:00"), undefined);
    assertEquals(sanitizeDate("2026-09-28T12:00:00"), undefined);
    assertEquals(sanitizeDate("2026-02-30T12:00:00Z"), undefined);

  // Outros inválidos
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

Deno.test("sanitizeNumber usa Number() estrito, rejeitando alfanuméricos parciais e espaços", () => {
  assertEquals(sanitizeNumber(42), 42);
  assertEquals(sanitizeNumber(0), 0);
  assertEquals(sanitizeNumber(-15.5), -15.5);
  assertEquals(sanitizeNumber("123.45"), 123.45);
  assertEquals(sanitizeNumber("  42 "), 42);
  assertEquals(sanitizeNumber("1e3"), 1000);

  // Casos estritos: rejeitar strings parciais e vazios
  assertEquals(sanitizeNumber("   "), undefined);
  assertEquals(sanitizeNumber(""), undefined);
  assertEquals(sanitizeNumber("12abc"), undefined);
  assertEquals(sanitizeNumber("abc12"), undefined);
  assertEquals(sanitizeNumber("abc"), undefined);
  assertEquals(sanitizeNumber(NaN), undefined);
  assertEquals(sanitizeNumber(Infinity), undefined);
  assertEquals(sanitizeNumber(-Infinity), undefined);
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

  assertEquals("error" in result, false);
  if (!("error" in result)) {
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
  }
});

Deno.test("parseListParams respeita MAX_LIMIT de 100 e rejeita maior", () => {
  const resultOk = parseListParams({ limit: "100" });
  assertEquals("error" in resultOk, false);
  if (!("error" in resultOk)) {
    assertEquals(resultOk.limit, 100);
  }

  const resultErr = parseListParams({ limit: "500" });
  assertEquals("error" in resultErr, true);
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
    "http://localhost/api?action=get&codigo_externo=07486108000185-1-000001/2026&fonte=pncp",
  );
  const getCodigoRes = parseActionFromUrl(getCodigoUrl);
  assertEquals("error" in getCodigoRes, false);
  if (!("error" in getCodigoRes)) {
    assertEquals(getCodigoRes.action, "get");
    if (getCodigoRes.action === "get") {
      assertEquals(getCodigoRes.codigo_externo, "07486108000185-1-000001/2026");
      assertEquals(getCodigoRes.fonte, "pncp");
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
    fonte: "pncp",
  });
  assertEquals("error" in getBody, false);
  if (!("error" in getBody)) {
    assertEquals(getBody.action, "get");
    if (getBody.action === "get") {
      assertEquals(getBody.codigo_externo, "12345678000199-1-000001/2026");
      assertEquals(getBody.fonte, "pncp");
    }
  }

  const readBody = parseActionFromBody({ action: "readiness" });
  assertEquals("error" in readBody, false);
  if (!("error" in readBody)) {
    assertEquals(readBody.action, "readiness");
  }
});

// --------------------------------------------------------------------------
// Montagem de Query e Assertividade Completa de TODOS os Filtros
// --------------------------------------------------------------------------

Deno.test("calculateRange calcula limites PostgREST corretos", () => {
  assertEquals(calculateRange(1, 20), { from: 0, to: 19 });
  assertEquals(calculateRange(2, 20), { from: 20, to: 39 });
  assertEquals(calculateRange(3, 10), { from: 20, to: 29 });
});

Deno.test("applyLicitacaoFilters asserte coluna e valor de TODOS os filtros", () => {
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

  // Asserção exata de cada chamada individual com UTC-3
  assertEquals(mock.calls, [
    { method: "eq", args: ["prioridade", "leads"] },
    { method: "eq", args: ["uf", "RJ"] },
    { method: "ilike", args: ["municipio", "%Niteroi%"] },
    { method: "eq", args: ["orgao_cnpj", "12345678000199"] },
    { method: "ilike", args: ["orgao_nome", "%Prefeitura%"] },
    { method: "in", args: ["modalidade", ["Pregão", "Dispensa"]] },
    { method: "eq", args: ["situacao", "Aberta"] },
    { method: "eq", args: ["fase", "Julgamento"] },
    { method: "eq", args: ["categoria_escopo", "catmat"] },
    { method: "eq", args: ["interesse_borracha", true] },
    { method: "eq", args: ["fonte", "pncp"] },
    { method: "gte", args: ["data_publicacao", "2026-01-01T00:00:00-03:00"] },
    { method: "lt", args: ["data_publicacao", "2026-04-01T00:00:00-03:00"] },
    { method: "gte", args: ["data_inicio", "2026-02-01T00:00:00-03:00"] },
    { method: "lt", args: ["data_inicio", "2026-03-01T00:00:00-03:00"] },
    { method: "gte", args: ["data_fim", "2026-03-01T00:00:00-03:00"] },
    { method: "lt", args: ["data_fim", "2026-03-16T00:00:00-03:00"] },
    { method: "gte", args: ["data_homologacao", "2026-04-01T00:00:00-03:00"] },
    { method: "lt", args: ["data_homologacao", "2026-05-01T00:00:00-03:00"] },
    { method: "gte", args: ["valor_total", 1000] },
    { method: "lte", args: ["valor_total", 50000] },
    {
      method: "or",
      args: [
        "objeto.ilike.*anilhas crossfit*,numero_processo.ilike.*anilhas crossfit*,numero_edital.ilike.*anilhas crossfit*",
      ],
    },
  ]);
});

Deno.test("applyLicitacaoFilters modalidade única usa eq em vez de in", () => {
  const mock = new MockQueryBuilder();
  applyLicitacaoFilters(mock, { modalidade: ["Pregão Eletrônico"] });
  assertEquals(mock.calls, [{ method: "eq", args: ["modalidade", "Pregão Eletrônico"] }]);
});

Deno.test("applyLicitacaoFilters usa lte para datas com timestamp completo", () => {
  const mock = new MockQueryBuilder();

  applyLicitacaoFilters(mock, {
    data_publicacao_fim: "2026-03-31T23:59:59Z",
    data_fim_max: "2026-04-15T18:00:00-03:00",
  });

  assertEquals(mock.calls, [
    { method: "lte", args: ["data_publicacao", "2026-03-31T23:59:59Z"] },
    { method: "lte", args: ["data_fim", "2026-04-15T18:00:00-03:00"] },
  ]);
});

Deno.test("sanitizeSearchTerm usa allowlist [^\\p{L}\\p{N}\\s-], NFC, colapsa espaços e trunca em 200", () => {
  assertEquals(sanitizeSearchTerm("teste, (123) \"algo\""), "teste 123 algo");
  // Curingas %, _, *, barras invertidas \ e pontos devem virar espaço
  assertEquals(sanitizeSearchTerm("busca%com_underline*asterisco\\barra.ponto"), "busca com underline asterisco barra ponto");
  // Hífen e caracteres acentuados são preservados
  assertEquals(sanitizeSearchTerm("pré-moldado de concreto"), "pré-moldado de concreto");
  // String com apenas caracteres inválidos vira undefined (ignora filtro)
  assertEquals(sanitizeSearchTerm("%_*\\,.()"), undefined);
  assertEquals(sanitizeSearchTerm("   "), undefined);
  // Truncamento em 200 caracteres
  const longo = "a".repeat(250);
  const sanitizadoLongo = sanitizeSearchTerm(longo);
  assertEquals(sanitizadoLongo?.length, 200);
});

// --------------------------------------------------------------------------
// Contrato HTTP (OPTIONS, CORS, Autenticação, Método não permitido, Erros de Validação e JSON)
// --------------------------------------------------------------------------

Deno.test("handleRequest com OPTIONS responde 200 com Access-Control-Allow-Methods exato", async () => {
  const req = new Request("http://localhost/api-dashboard-oportunidades", {
    method: "OPTIONS",
  });
  const res = await handleRequest(req);
  assertEquals(res.status, 200);
  assertEquals(res.headers.get("Access-Control-Allow-Origin"), "*");
  assertEquals(
    res.headers.get("Access-Control-Allow-Methods"),
    "GET, POST, OPTIONS",
  );
});

Deno.test("handleRequest readiness permanece público e responde 200 sem auth retornando contagem exata", async () => {
  const mockClient = createRecordingMockClient({
    headCountResult: { count: 15, error: null },
    singleResult: {
      data: { updated_at: "2026-09-28T10:00:00Z", last_synced_at: null },
      error: null,
    },
  });

  const req = new Request("http://localhost/api-dashboard-oportunidades?action=readiness", {
    method: "GET",
  });
  // deno-lint-ignore no-explicit-any
  const res = await handleRequest(req, { getClient: () => mockClient as any });
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.ready, true);
  assertEquals(body.total_registros, 15);
});

Deno.test("handleRequest list sem Authorization retorna 401 via requireUserAuth padrão", async () => {
  const req = new Request("http://localhost/api-dashboard-oportunidades?action=list", {
    method: "GET",
  });
  const res = await handleRequest(req);
  assertEquals(res.status, 401);
  const body = await res.json();
  assertEquals(body.error, "Unauthorized");
});

Deno.test("handleRequest get sem Authorization retorna 401 via requireUserAuth padrão", async () => {
  const req = new Request("http://localhost/api-dashboard-oportunidades?action=get&id=1", {
    method: "GET",
  });
  const res = await handleRequest(req);
  assertEquals(res.status, 401);
  const body = await res.json();
  assertEquals(body.error, "Unauthorized");
});

Deno.test("handleRequest list com Bearer inválido retorna 401", async () => {
  const req = new Request("http://localhost/api-dashboard-oportunidades?action=list", {
    method: "GET",
    headers: { Authorization: "Bearer invalid-token" },
  });
  const res = await handleRequest(req);
  assertEquals(res.status, 401);
  const body = await res.json();
  assertEquals(body.error, "Unauthorized");
});

Deno.test("handleRequest rejeita métodos não permitidos com 405 (com auth bypass)", async () => {
  const req = new Request("http://localhost/api-dashboard-oportunidades", {
    method: "DELETE",
  });
  const res = await handleRequest(req, { requireAuth: () => null });
  assertEquals(res.status, 405);
  const body = await res.json();
  assertEquals(body.error, "Método não permitido. Utilize GET ou POST.");
});

Deno.test("handleRequest rejeita ação inválida com 400 (com auth bypass)", async () => {
  const req = new Request("http://localhost/api-dashboard-oportunidades?action=invalid", {
    method: "GET",
  });
  const res = await handleRequest(req, { requireAuth: () => null });
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
  const res = await handleRequest(req, { requireAuth: () => null });
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
  const res = await handleRequest(req, { requireAuth: () => null });
  assertEquals(res.status, 400);
  const body = await res.json();
  assertEquals(body.error.includes("Esperado objeto JSON"), true);
});

Deno.test("handleRequest get sem parâmetros retorna 400 claro", async () => {
  const req = new Request("http://localhost/api-dashboard-oportunidades?action=get", {
    method: "GET",
  });
  const res = await handleRequest(req, { requireAuth: () => null });
  assertEquals(res.status, 400);
  const body = await res.json();
  assertEquals(body.error.includes("Identificador ausente"), true);
});

Deno.test("handleRequest get com codigo_externo sem fonte retorna 400 claro", async () => {
  const req = new Request(
    "http://localhost/api-dashboard-oportunidades?action=get&codigo_externo=07486108000185-1-000001/2026",
    { method: "GET" },
  );
  const res = await handleRequest(req, { requireAuth: () => null });
  assertEquals(res.status, 400);
  const body = await res.json();
  assertEquals(
    body.error,
    "Parâmetro 'fonte' é obrigatório ao consultar por 'codigo_externo'",
  );
});

Deno.test("validatePagination e parseListParams rejeitam paginação inválida com 400", () => {
  // Fração
  const fracRes = parseListParams({ page: "1.5" });
  assertEquals("error" in fracRes, true);

  // Zero
  const zeroRes = parseListParams({ page: "0" });
  assertEquals("error" in zeroRes, true);

  // Negativo
  const negRes = parseListParams({ page: "-1" });
  assertEquals("error" in negRes, true);

  // Limit > 100
  const limitBigRes = parseListParams({ limit: "101" });
  assertEquals("error" in limitBigRes, true);

  // Offset > 10000: page = 102, limit = 100 -> offset = 10100
  const offsetBigRes = parseListParams({ page: "102", limit: "100" });
  assertEquals("error" in offsetBigRes, true);
  if ("error" in offsetBigRes) {
    assertEquals(offsetBigRes.error.includes("excede o limite máximo permitido de 10000"), true);
  }

  // Offset dentro do limite: page = 101, limit = 100 -> offset = 10000
  const offsetOkRes = parseListParams({ page: "101", limit: "100" });
  assertEquals("error" in offsetOkRes, false);
});

// --------------------------------------------------------------------------
// Mock Estruturado do Cliente Supabase com Gravação Completa de Chamadas
// --------------------------------------------------------------------------

interface RecordedCall {
  method: string;
  args: unknown[];
}

function createRecordingMockClient(config: {
  listResult?: { data: unknown[]; count: number | null; error: unknown };
  singleResult?: { data: unknown; error: unknown };
  headCountResult?: { count: number | null; error: unknown };
}) {
  const calls: RecordedCall[] = [];

  const thenable = {
    then(onfulfilled?: (v: unknown) => unknown, onrejected?: (e: unknown) => unknown) {
      const res = config.listResult ?? { data: [], count: 0, error: null };
      return Promise.resolve(res).then(onfulfilled, onrejected);
    },
    select(cols?: string, opts?: { count?: string; head?: boolean }) {
      calls.push({ method: "select", args: [cols, opts] });
      return thenable;
    },
    eq(col: string, val: unknown) {
      calls.push({ method: "eq", args: [col, val] });
      return thenable;
    },
    in(col: string, vals: unknown[]) {
      calls.push({ method: "in", args: [col, vals] });
      return thenable;
    },
    gte(col: string, val: unknown) {
      calls.push({ method: "gte", args: [col, val] });
      return thenable;
    },
    lte(col: string, val: unknown) {
      calls.push({ method: "lte", args: [col, val] });
      return thenable;
    },
    lt(col: string, val: unknown) {
      calls.push({ method: "lt", args: [col, val] });
      return thenable;
    },
    ilike(col: string, pat: string) {
      calls.push({ method: "ilike", args: [col, pat] });
      return thenable;
    },
    or(filters: string) {
      calls.push({ method: "or", args: [filters] });
      return thenable;
    },
    order(col: string, opts: unknown) {
      calls.push({ method: "order", args: [col, opts] });
      return thenable;
    },
    range(from: number, to: number) {
      calls.push({ method: "range", args: [from, to] });
      return thenable;
    },
    limit(limit: number) {
      calls.push({ method: "limit", args: [limit] });
      return thenable;
    },
    maybeSingle() {
      calls.push({ method: "maybeSingle", args: [] });
      return Promise.resolve(config.singleResult ?? { data: null, error: null });
    },
  };

  const client = {
    calls,
    from(table: string) {
      calls.push({ method: "from", args: [table] });
      return {
        select(cols?: string, opts?: { count?: string; head?: boolean }) {
          calls.push({ method: "select", args: [cols, opts] });
          if (opts?.head) {
            return Promise.resolve(config.headCountResult ?? { count: 10, error: null });
          }
          return thenable;
        },
      };
    },
  };

  return client;
}

// --------------------------------------------------------------------------
// Testes com Asserção de Chamadas do Mock, Filtros e Projeções
// --------------------------------------------------------------------------

Deno.test("handleRequest list com filtro uf asserte eq('uf', 'AC') e PUBLIC_LICITACAO_COLUMNS", async () => {
  const mockClient = createRecordingMockClient({
    listResult: { data: [], count: 0, error: null },
  });

  const req = new Request("http://localhost/api-dashboard-oportunidades?action=list&uf=AC", {
    method: "GET",
  });
  // deno-lint-ignore no-explicit-any
  const res = await handleRequest(req, {
    getClient: () => mockClient as any,
    requireAuth: () => null,
  });
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.action, "list");
  assertEquals(body.items, []);

  // Asserção das chamadas ao mock
  const fromCall = mockClient.calls.find((c) => c.method === "from");
  assertEquals(fromCall, { method: "from", args: ["licitacoes_externas"] });

  const selectCall = mockClient.calls.find((c) => c.method === "select");
  assertEquals(selectCall?.args[0], PUBLIC_LICITACAO_COLUMNS);
  // Asserção exata da allowlist esperada
  const EXPECTED_PROJECTION = [
    "id",
    "fonte",
    "modulo",
    "id_externo",
    "codigo_externo",
    "numero_processo",
    "processo_norm",
    "numero_edital",
    "objeto",
    "unidade_compradora",
    "modalidade",
    "fase",
    "situacao",
    "data_inicio",
    "data_fim",
    "valor_total",
    "orgao_cnpj",
    "orgao_nome",
    "municipio",
    "uf",
    "data_publicacao",
    "data_homologacao",
    "categoria_escopo",
    "interesse_borracha",
    "prioridade",
    "termos_busca",
    "created_at",
    "updated_at",
    "last_synced_at",
  ].join(",");
  assertEquals(selectCall?.args[0], EXPECTED_PROJECTION);

  const eqUfCall = mockClient.calls.find((c) => c.method === "eq" && c.args[0] === "uf");
  assertEquals(eqUfCall, { method: "eq", args: ["uf", "AC"] });

  // Asserção de desempate determinístico por id
  const orderCalls = mockClient.calls.filter((c) => c.method === "order");
  assertEquals(orderCalls, [
    { method: "order", args: ["data_fim", { ascending: false, nullsFirst: false }] },
    { method: "order", args: ["id", { ascending: true }] },
  ]);
});

Deno.test("handleRequest get por id asserte eq('id', 101) e maybeSingle", async () => {
  const mockClient = createRecordingMockClient({
    singleResult: {
      data: { id: 101, objeto: "Equipamento Teste" },
      error: null,
    },
  });

  const req = new Request("http://localhost/api-dashboard-oportunidades?action=get&id=101", {
    method: "GET",
  });
  // deno-lint-ignore no-explicit-any
  const res = await handleRequest(req, {
    getClient: () => mockClient as any,
    requireAuth: () => null,
  });
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.item.id, 101);

  const selectCall = mockClient.calls.find((c) => c.method === "select");
  assertEquals(selectCall?.args[0], PUBLIC_LICITACAO_COLUMNS);
  assertEquals((selectCall?.args[0] as string).includes("modulo"), true);
  assertEquals((selectCall?.args[0] as string).includes("id_externo"), true);
  assertEquals((selectCall?.args[0] as string).includes("raw"), false);

  const eqIdCall = mockClient.calls.find((c) => c.method === "eq");
  assertEquals(eqIdCall, { method: "eq", args: ["id", "101"] });

  const maybeSingleCall = mockClient.calls.find((c) => c.method === "maybeSingle");
  assertEquals(Boolean(maybeSingleCall), true);
});

Deno.test("handleRequest list e get em erro de banco retornam status 500 com mensagem genérica", async () => {
  const mockClient = createRecordingMockClient({
    listResult: {
      data: [],
      count: null,
      error: { message: "database timeout or connection refused (leak check)" },
    },
  });

  const req = new Request("http://localhost/api-dashboard-oportunidades?action=list", {
    method: "GET",
  });
  // deno-lint-ignore no-explicit-any
  const res = await handleRequest(req, {
    getClient: () => mockClient as any,
    requireAuth: () => null,
  });
  assertEquals(res.status, 500);
  const body = await res.json();
  assertEquals(body.error, "Falha ao consultar lista de oportunidades");
  assertEquals(JSON.stringify(body).includes("leak check"), false);
});

Deno.test("handleRequest get por codigo_externo sem fonte retorna 400", async () => {
  const req = new Request(
    "http://localhost/api-dashboard-oportunidades?action=get&codigo_externo=07486108000185-1-000001/2026",
    { method: "GET" },
  );
  const res = await handleRequest(req, { requireAuth: () => null });
  assertEquals(res.status, 400);
  const body = await res.json();
  assertEquals(
    body.error,
    "Parâmetro 'fonte' é obrigatório ao consultar por 'codigo_externo'",
  );
});

Deno.test("handleRequest get por codigo_externo com fonte asserte eq('codigo_externo') e eq('fonte')", async () => {
  const mockClient = createRecordingMockClient({
    singleResult: {
      data: { id: 103, codigo_externo: "07486108000185-1-000001/2026", fonte: "pncp" },
      error: null,
    },
  });

  const req = new Request(
    "http://localhost/api-dashboard-oportunidades?action=get&codigo_externo=07486108000185-1-000001/2026&fonte=pncp",
    { method: "GET" },
  );
  // deno-lint-ignore no-explicit-any
  const res = await handleRequest(req, {
    getClient: () => mockClient as any,
    requireAuth: () => null,
  });
  assertEquals(res.status, 200);

  const eqCalls = mockClient.calls.filter((c) => c.method === "eq");
  assertEquals(eqCalls, [
    { method: "eq", args: ["codigo_externo", "07486108000185-1-000001/2026"] },
    { method: "eq", args: ["fonte", "pncp"] },
  ]);

  const maybeSingleCall = mockClient.calls.find((c) => c.method === "maybeSingle");
  assertEquals(Boolean(maybeSingleCall), true);
});

Deno.test("handleRequest get por orgao_cnpj + processo_norm asserte eq nos dois campos, paginacao e SEM maybeSingle", async () => {
  const mockClient = createRecordingMockClient({
    listResult: {
      data: [
        { id: 201, objeto: "Lote 1" },
        { id: 202, objeto: "Lote 2" },
      ],
      count: 2,
      error: null,
    },
  });

  const req = new Request(
    "http://localhost/api-dashboard-oportunidades?action=get&orgao_cnpj=07.486.108/0001-85&processo_norm=2026/001&page=1&limit=10",
    { method: "GET" },
  );
  // deno-lint-ignore no-explicit-any
  const res = await handleRequest(req, {
    getClient: () => mockClient as any,
    requireAuth: () => null,
  });
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.page, 1);
  assertEquals(body.limit, 10);
  assertEquals(body.total, 2);
  assertEquals(body.items.length, 2);

  const selectCall = mockClient.calls.find((c) => c.method === "select");
  assertEquals(selectCall?.args[0], PUBLIC_LICITACAO_COLUMNS);
  assertEquals(selectCall?.args[1], { count: "exact" });

  const rangeCall = mockClient.calls.find((c) => c.method === "range");
  assertEquals(rangeCall, { method: "range", args: [0, 9] });

  // Asserção de desempate determinístico por id no get por processo
  const orderCalls = mockClient.calls.filter((c) => c.method === "order");
  assertEquals(orderCalls, [
    { method: "order", args: ["data_publicacao", { ascending: false, nullsFirst: false }] },
    { method: "order", args: ["id", { ascending: true }] },
  ]);

  const eqCalls = mockClient.calls.filter((c) => c.method === "eq");
  assertEquals(eqCalls, [
    { method: "eq", args: ["orgao_cnpj", "07486108000185"] },
    { method: "eq", args: ["processo_norm", "2026001"] },
  ]);

  // NÃO deve conter chamada a maybeSingle
  const maybeSingleCall = mockClient.calls.find((c) => c.method === "maybeSingle");
  assertEquals(maybeSingleCall, undefined);
});

Deno.test("handleRequest mock com count nulo em list retorna status 500 por indisponibilidade", async () => {
  const mockClient = createRecordingMockClient({
    listResult: { data: [{ id: 1 }], count: null, error: null },
  });

  const req = new Request("http://localhost/api-dashboard-oportunidades?action=list", {
    method: "GET",
  });
  // deno-lint-ignore no-explicit-any
  const res = await handleRequest(req, {
    getClient: () => mockClient as any,
    requireAuth: () => null,
  });
  assertEquals(res.status, 500);
  const body = await res.json();
  assertEquals(body.error, "Falha ao consultar lista de oportunidades");
});

Deno.test("handleRequest mock com count nulo em get por processo retorna status 500 por indisponibilidade", async () => {
  const mockClient = createRecordingMockClient({
    listResult: { data: [{ id: 1 }], count: null, error: null },
  });

  const req = new Request(
    "http://localhost/api-dashboard-oportunidades?action=get&orgao_cnpj=07.486.108/0001-85&processo_norm=2026/001",
    { method: "GET" },
  );
  // deno-lint-ignore no-explicit-any
  const res = await handleRequest(req, {
    getClient: () => mockClient as any,
    requireAuth: () => null,
  });
  assertEquals(res.status, 500);
  const body = await res.json();
  assertEquals(body.error, "Falha ao consultar compras do processo");
});

Deno.test("handleRequest mock com count nulo em readiness retorna unhealthy e ready:false (status 503)", async () => {
  const mockClient = createRecordingMockClient({
    headCountResult: { count: null, error: null },
    singleResult: {
      data: { updated_at: "2026-09-28T10:00:00Z", last_synced_at: null },
      error: null,
    },
  });

  const req = new Request("http://localhost/api-dashboard-oportunidades?action=readiness", {
    method: "GET",
  });
  // deno-lint-ignore no-explicit-any
  const res = await handleRequest(req, {
    getClient: () => mockClient as any,
    requireAuth: () => null,
  });
  assertEquals(res.status, 503);
  const body = await res.json();
  assertEquals(body.ready, false);
  assertEquals(body.status, "unhealthy");
});

Deno.test("handleRequest em erro de banco retorna mensagem genérica com status 500 (não vaza PostgREST)", async () => {
  const mockClient = createRecordingMockClient({
    singleResult: {
      data: null,
      error: { message: "relation licitacoes_externas does not exist (internals leaked)" },
    },
  });

  const req = new Request("http://localhost/api-dashboard-oportunidades?action=get&id=1", {
    method: "GET",
  });
  // deno-lint-ignore no-explicit-any
  const res = await handleRequest(req, {
    getClient: () => mockClient as any,
    requireAuth: () => null,
  });
  assertEquals(res.status, 500);
  const body = await res.json();
  assertEquals(body.error, "Falha ao consultar licitação");
  assertEquals(JSON.stringify(body).includes("internals leaked"), false);
});

Deno.test("handleRequest com requireUserAuth simulado autenticado em list avança com sucesso", async () => {
  const mockClient = createRecordingMockClient({
    listResult: { data: [{ id: 1, objeto: "Licitação Teste" }], count: 1, error: null },
  });

  const req = new Request("http://localhost/api-dashboard-oportunidades?action=list", {
    method: "GET",
    headers: { Authorization: "Bearer valid-user-token" },
  });

  const res = await handleRequest(req, {
    getClient: () => mockClient as any,
    requireAuth: (r) => {
      // Simula requireUserAuth aceitando token de teste
      if (r.headers.get("Authorization") === "Bearer valid-user-token") return null;
      return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
    },
  });

  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.action, "list");
  assertEquals(body.total, 1);
});

Deno.test("authenticateUserWithFallback aceita SUPABASE_PUBLISHABLE_KEY como fallback", async () => {
  const originalUrl = Deno.env.get("SUPABASE_URL");
  const originalAnon = Deno.env.get("SUPABASE_ANON_KEY");
  const originalPub = Deno.env.get("SUPABASE_PUBLISHABLE_KEY");

  try {
    Deno.env.set("SUPABASE_URL", "https://example.supabase.co");
    Deno.env.delete("SUPABASE_ANON_KEY");
    Deno.env.set("SUPABASE_PUBLISHABLE_KEY", "sb_pub_fallback_key");

    const req = new Request("http://localhost/api?action=list", {
      headers: { Authorization: "Bearer some-token" },
    });
    // Sem backend real vai falhar ao chamar getUser ou devolver 401, mas não quebra por env ausente
    const res = await (await import("../../../supabase/functions/api-dashboard-oportunidades/index.ts")).authenticateUserWithFallback(req);
    assertEquals(res?.status, 401);
  } finally {
    if (originalUrl) Deno.env.set("SUPABASE_URL", originalUrl);
    else Deno.env.delete("SUPABASE_URL");
    if (originalAnon) Deno.env.set("SUPABASE_ANON_KEY", originalAnon);
    else Deno.env.delete("SUPABASE_ANON_KEY");
    if (originalPub) Deno.env.set("SUPABASE_PUBLISHABLE_KEY", originalPub);
    else Deno.env.delete("SUPABASE_PUBLISHABLE_KEY");
  }
});

Deno.test("index.ts possui bloco if (import.meta.main) que envolve Deno.serve", async () => {
  const content = await Deno.readTextFile("./supabase/functions/api-dashboard-oportunidades/index.ts");
  assertEquals(content.includes("if (import.meta.main) {\n  Deno.serve((req) => handleRequest(req));\n}"), true);
});
