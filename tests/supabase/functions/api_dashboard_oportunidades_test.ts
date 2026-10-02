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
  applyOportunidadesScope,
  calculateRange,
  sanitizeSearchTerm,
  type FilterableQuery,
} from "../../../supabase/functions/api-dashboard-oportunidades/query.ts";
import {
  handleRequest,
  OPORTUNIDADES_VIEW,
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
    // Espaço como separador deve ser rejeitado (só literal 'T' é aceito)
    assertEquals(sanitizeDate("2026-09-28 12:00:00Z"), undefined);
    assertEquals(sanitizeDate("2026-09-28 12:00:00-03:00"), undefined);
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
  rpcResult?: { data: unknown[] | null; error: unknown };
  pdmNomes?: Array<{ codigo_pdm: number; nome_pdm: string }>;
  /** Consulta de escopo do recorte CATMAT (select("id") na view): ids que ficam. Padrão: todos. */
  escopoIds?: (ids: number[]) => number[];
  escopoError?: unknown;
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
    rpc(fn: string, args: unknown) {
      calls.push({ method: "rpc", args: [fn, args] });
      let rpcRange: [number, number] | undefined;
      const rpcQuery = {
        order(column: string, options: unknown) {
          calls.push({ method: "rpc.order", args: [column, options] });
          return rpcQuery;
        },
        range(from: number, to: number) {
          rpcRange = [from, to];
          calls.push({ method: "rpc.range", args: [from, to] });
          return rpcQuery;
        },
        then(onfulfilled?: (v: unknown) => unknown, onrejected?: (e: unknown) => unknown) {
          const result = config.rpcResult ?? { data: [], error: null };
          const [from, to] = rpcRange ?? [0, Number.MAX_SAFE_INTEGER];
          const data = result.data?.slice(from, to + 1) ?? null;
          return Promise.resolve({ data, error: result.error }).then(onfulfilled, onrejected);
        },
      };
      return rpcQuery;
    },
    from(table: string) {
      calls.push({ method: "from", args: [table] });
      if (table === "catmat_pdms") {
        // Nomes dos PDMs do recorte CATMAT
        return {
          select: (cols?: string) => {
            calls.push({ method: "catmat_pdms.select", args: [cols] });
            return {
              in: (col: string, vals: unknown[]) => {
                calls.push({ method: "catmat_pdms.in", args: [col, vals] });
                return Promise.resolve({ data: config.pdmNomes ?? [], error: null });
              },
            };
          },
        };
      }
      return {
        select(cols?: string, opts?: { count?: string; head?: boolean }) {
          calls.push({ method: "select", args: [cols, opts] });
          if (cols === "id" && !opts) {
            // Escopo do recorte CATMAT: select("id").in("id", lote).eq|or(...)
            let lote: number[] = [];
            const escopo: Record<string, unknown> = {
              then(onfulfilled?: (v: unknown) => unknown, onrejected?: (e: unknown) => unknown) {
                const res = config.escopoError
                  ? { data: null, error: config.escopoError }
                  : { data: (config.escopoIds ?? ((x: number[]) => x))(lote).map((id) => ({ id })), error: null };
                return Promise.resolve(res).then(onfulfilled, onrejected);
              },
            };
            for (const m of ["eq", "in", "or"]) {
              escopo[m] = (...args: unknown[]) => {
                calls.push({ method: `escopo.${m}`, args });
                if (m === "in") lote = args[1] as number[];
                return escopo;
              };
            }
            return escopo;
          }
          if (opts?.head) {
            // Contagem (head): aceita os mesmos filtros encadeados e resolve com headCountResult
            const headResult = config.headCountResult ?? { count: 10, error: null };
            const headThenable: Record<string, unknown> = {
              then(onfulfilled?: (v: unknown) => unknown, onrejected?: (e: unknown) => unknown) {
                return Promise.resolve(headResult).then(onfulfilled, onrejected);
              },
            };
            for (const m of ["eq", "in", "gte", "lte", "lt", "ilike", "or"]) {
              headThenable[m] = (...args: unknown[]) => {
                calls.push({ method: `head.${m}`, args });
                return headThenable;
              };
            }
            return headThenable;
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
  assertEquals(fromCall, { method: "from", args: [OPORTUNIDADES_VIEW] });

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
  assertEquals(body.item.url_edital, null);

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
  const body = await res.json();
  assertEquals(body.item.id, 103);
  assertEquals(body.item.url_edital, "https://pncp.gov.br/app/editais/07486108000185/2026/1");

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
  assertEquals(body.items[0].url_edital, null);
  assertEquals(body.items[1].url_edital, null);

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
  assertEquals(body.items[0].url_edital, null);
});

Deno.test("requireUserAuth rejeita token inválido com 401 via mock determinístico e seguro offline", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = () =>
      Promise.resolve(
        new Response(JSON.stringify({ message: "Invalid JWT" }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        }),
      );

    const req = new Request("http://localhost/api?action=list", {
      headers: { Authorization: "Bearer some-token" },
    });
    // Invoca handleRequest sem bypass para exercitar o fluxo real de requireUserAuth
    const res = await handleRequest(req);
    assertEquals(res.status, 401);
    const body = await res.json();
    assertEquals(body.error, "Unauthorized");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("index.ts possui bloco if (import.meta.main) que envolve Deno.serve", async () => {
  const content = await Deno.readTextFile("./supabase/functions/api-dashboard-oportunidades/index.ts");
  assertEquals(content.includes("if (import.meta.main) {\n  Deno.serve((req) => handleRequest(req));\n}"), true);
});

Deno.test("migration D1.2 revoga SELECT de authenticated em licitacoes_externas e atualiza comment", async () => {
  const sql = await Deno.readTextFile("./supabase/migrations/20260928140000_licitacoes_externas_revoke_authenticated.sql");
  assertEquals(sql.includes("drop policy if exists licitacoes_externas_select on public.licitacoes_externas;"), true);
  assertEquals(sql.includes("revoke all on table public.licitacoes_externas from authenticated, anon, PUBLIC;"), true);
  assertEquals(sql.includes("alter table public.licitacoes_externas enable row level security;"), true);
  assertEquals(sql.includes("comment on table public.licitacoes_externas is"), true);
  assertEquals(sql.includes("api-dashboard-oportunidades"), true);
  assertEquals(sql.includes("coletores"), true);
  assertEquals(sql.includes("service_role"), true);
});

Deno.test("script de verificacao de ACL efetiva supabase/tests/licitacoes_externas_acl_check.sql existe e contem assercoes", async () => {
  const sql = await Deno.readTextFile("./supabase/tests/licitacoes_externas_acl_check.sql");
  assertEquals(sql.includes("has_table_privilege('anon', 'public.licitacoes_externas', 'SELECT')"), true);
  assertEquals(sql.includes("has_table_privilege('authenticated', 'public.licitacoes_externas', 'SELECT')"), true);
  assertEquals(sql.includes("has_table_privilege('service_role', 'public.licitacoes_externas', 'SELECT')"), true);
  assertEquals(sql.includes("pg_policies"), true);
  assertEquals(sql.includes("relrowsecurity"), true);
  assertEquals(sql.includes("coletores"), true);
});

Deno.test("handleRequest enriquece resposta de list e get com url_edital derivada na leitura", async () => {
  const mockClient = createRecordingMockClient({
    singleResult: {
      data: {
        id: 501,
        fonte: "pncp",
        codigo_externo: "07486108000185-1-000001/2026",
        objeto: "Lote Teste Edital",
      },
      error: null,
    },
    listResult: {
      data: [
        {
          id: 601,
          fonte: "pncp",
          codigo_externo: "44892693000140-1-000157/2026",
          objeto: "Borracha Granulada",
        },
        {
          id: 602,
          fonte: "comprasgov_pesquisa_preco",
          codigo_externo: "COMPRASGOV-PP-98703305900102026",
          objeto: "Material Esportivo",
        },
        {
          id: 603,
          fonte: "custom_sem_link",
          objeto: "Sem Link",
        },
      ],
      count: 3,
      error: null,
    },
  });

  // 1. Testa GET detalhe
  const reqGet = new Request("http://localhost/api-dashboard-oportunidades?action=get&id=501", {
    method: "GET",
  });
  // deno-lint-ignore no-explicit-any
  const resGet = await handleRequest(reqGet, {
    getClient: () => mockClient as any,
    requireAuth: () => null,
  });
  assertEquals(resGet.status, 200);
  const bodyGet = await resGet.json();
  assertEquals(bodyGet.item.id, 501);
  assertEquals(bodyGet.item.url_edital, "https://pncp.gov.br/app/editais/07486108000185/2026/1");

  // 2. Testa GET list
  const reqList = new Request("http://localhost/api-dashboard-oportunidades?action=list", {
    method: "GET",
  });
  // deno-lint-ignore no-explicit-any
  const resList = await handleRequest(reqList, {
    getClient: () => mockClient as any,
    requireAuth: () => null,
  });
  assertEquals(resList.status, 200);
  const bodyList = await resList.json();
  assertEquals(bodyList.items.length, 3);
  assertEquals(bodyList.items[0].url_edital, "https://pncp.gov.br/app/editais/44892693000140/2026/157");
  assertEquals(
    bodyList.items[1].url_edital,
    "https://cnetmobile.estaleiro.serpro.gov.br/comprasnet-web/public/compras/acompanhamento-compra?compra=98703305900102026",
  );
  assertEquals(bodyList.items[2].url_edital, null);
});

// --------------------------------------------------------------------------
// Testes para a Ação `acompanhamento`
// --------------------------------------------------------------------------

Deno.test("acompanhamento: requer autenticação de usuário (401 sem token)", async () => {
  const req = new Request("http://localhost/api-dashboard-oportunidades?action=acompanhamento&id=101", {
    method: "GET",
  });
  const res = await handleRequest(req, {
    requireAuth: () => new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 }),
  });
  assertEquals(res.status, 401);
  const body = await res.json();
  assertEquals(body.error, "Unauthorized");
});

Deno.test("acompanhamento: validação de ID ausente retorna 400", async () => {
  const reqGet = new Request("http://localhost/api-dashboard-oportunidades?action=acompanhamento", {
    method: "GET",
  });
  const resGet = await handleRequest(reqGet, { requireAuth: () => null });
  assertEquals(resGet.status, 400);

  const reqPost = new Request("http://localhost/api-dashboard-oportunidades", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "acompanhamento" }),
  });
  const resPost = await handleRequest(reqPost, { requireAuth: () => null });
  assertEquals(resPost.status, 400);
});

Deno.test("acompanhamento: oportunidade não encontrada retorna 404", async () => {
  const mockClient = createRecordingMockClient({
    singleResult: { data: null, error: null },
  });

  const req = new Request("http://localhost/api-dashboard-oportunidades?action=acompanhamento&id=9999", {
    method: "GET",
  });
  const res = await handleRequest(req, {
    getClient: () => mockClient as any,
    requireAuth: () => null,
  });
  assertEquals(res.status, 404);
  const body = await res.json();
  assertEquals(body.error, "Licitação não encontrada");
});

Deno.test("acompanhamento: linha não-PNCP retorna 200 com disponivel: false", async () => {
  const mockClient = createRecordingMockClient({
    singleResult: {
      data: {
        id: 202,
        fonte: "sestsenat",
        modulo: 59,
        id_externo: 12345,
        objeto: "Contratação SEST SENAT",
      },
      error: null,
    },
  });

  const req = new Request("http://localhost/api-dashboard-oportunidades?action=acompanhamento&id=202", {
    method: "GET",
  });
  const res = await handleRequest(req, {
    getClient: () => mockClient as any,
    requireAuth: () => null,
  });
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.disponivel, false);
  assertEquals(body.id, 202);
  assertEquals(typeof body.motivo, "string");
});



Deno.test("list além do fim (PGRST103) devolve 200 com items vazio e total da contagem com os mesmos filtros", async () => {
  const mockClient = createRecordingMockClient({
    listResult: {
      data: null as unknown as unknown[],
      count: null,
      error: { code: "PGRST103", message: "Requested range not satisfiable", details: "An offset of 100 was requested, but there are only 47 rows." },
    },
    headCountResult: { count: 47, error: null },
  });

  const req = new Request("http://localhost/api-dashboard-oportunidades", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "list", page: 2, limit: 100, uf: "SP", order_by: "data_fim", order_direction: "desc" }),
  });
  // deno-lint-ignore no-explicit-any
  const res = await handleRequest(req, { getClient: () => mockClient as any, requireAuth: () => null });

  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.items, []);
  assertEquals(body.total, 47);
  assertEquals(body.page, 2);
  assertEquals(body.limit, 100);
  // A contagem aplica o mesmo filtro de UF da lista
  assertEquals(mockClient.calls.some((c) => c.method === "head.eq" && c.args[0] === "uf" && c.args[1] === "SP"), true);
});

Deno.test("list com outro erro do PostgREST continua 500", async () => {
  const mockClient = createRecordingMockClient({
    listResult: { data: null as unknown as unknown[], count: null, error: { code: "42P01", message: "relation does not exist" } },
  });
  const req = new Request("http://localhost/api-dashboard-oportunidades?action=list&page=2&limit=100", { method: "GET" });
  // deno-lint-ignore no-explicit-any
  const res = await handleRequest(req, { getClient: () => mockClient as any, requireAuth: () => null });
  assertEquals(res.status, 500);
});

Deno.test("list além do fim com contagem indisponível devolve 500", async () => {
  const mockClient = createRecordingMockClient({
    listResult: { data: null as unknown as unknown[], count: null, error: { code: "PGRST103", message: "Requested range not satisfiable" } },
    headCountResult: { count: null, error: { message: "timeout" } },
  });
  const req = new Request("http://localhost/api-dashboard-oportunidades?action=list&page=3&limit=100", { method: "GET" });
  // deno-lint-ignore no-explicit-any
  const res = await handleRequest(req, { getClient: () => mockClient as any, requireAuth: () => null });
  assertEquals(res.status, 500);
});


// --------------------------------------------------------------------------
// Recorte CATMAT (catmat_grupo/classe/pdm/item e catalogo)
// --------------------------------------------------------------------------

Deno.test("list: parâmetros CATMAT aceitam CSV e array, recusam código inválido e mais de 50", async () => {
  const { parseActionFromUrl, parseActionFromBody } = await import("../../../supabase/functions/api-dashboard-oportunidades/validation.ts");
  const url = parseActionFromUrl(new URL("http://x/?action=list&catmat_pdm=7115,2638,7115&catmat_classe=7830&catalogo=true"));
  assertEquals((url as { filtros: { catmat_pdm: number[] } }).filtros.catmat_pdm, [7115, 2638]);
  assertEquals((url as { filtros: { catmat_classe: number[] } }).filtros.catmat_classe, [7830]);
  assertEquals((url as { filtros: { catalogo: boolean } }).filtros.catalogo, true);
  const body = parseActionFromBody({ action: "list", catmat_item: [373980, "319134"] });
  assertEquals((body as { filtros: { catmat_item: number[] } }).filtros.catmat_item, [373980, 319134]);
  assertEquals("error" in parseActionFromUrl(new URL("http://x/?action=list&catmat_pdm=abc")), true);
  assertEquals("error" in parseActionFromUrl(new URL("http://x/?action=list&catmat_pdm=0")), true);
  const muitos = Array.from({ length: 51 }, (_, i) => i + 1).join(",");
  assertEquals("error" in parseActionFromUrl(new URL(`http://x/?action=list&catmat_pdm=${muitos}`)), true);
  // ids nunca vem do cliente
  const forjado = parseActionFromBody({ action: "list", ids: [1, 2, 3] });
  assertEquals((forjado as { filtros: { ids?: number[] } }).filtros.ids, undefined);
});

Deno.test("list com recorte CATMAT: resolve pela RPC, filtra por id e anexa catmat_match", async () => {
  const mockClient = createRecordingMockClient({
    rpcResult: {
      data: [
        { licitacao_id: 11, codigo_pdm: 7115, codigo_item: null, motivo: "texto_item" },
        { licitacao_id: 11, codigo_pdm: 7115, codigo_item: null, motivo: "texto_objeto" },
        { licitacao_id: 12, codigo_pdm: 2638, codigo_item: 602725, motivo: "codigo" },
      ],
      error: null,
    },
    pdmNomes: [{ codigo_pdm: 7115, nome_pdm: "ESTEIRA ELÉTRICA" }, { codigo_pdm: 2638, nome_pdm: "APARELHO / ACESSÓRIO" }],
    listResult: { data: [{ id: 11, objeto: "esteira" }, { id: 12, objeto: "acessorios" }], count: 2, error: null },
  });
  const req = new Request("http://localhost/api-dashboard-oportunidades", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "list", catmat_classe: [7830], catalogo: true, uf: "SP" }),
  });
  // deno-lint-ignore no-explicit-any
  const res = await handleRequest(req, { getClient: () => mockClient as any, requireAuth: () => null });
  assertEquals(res.status, 200);
  const body = await res.json();

  const rpc = mockClient.calls.find((c) => c.method === "rpc");
  assertEquals(rpc?.args[0], "licitacoes_ids_por_catmat");
  assertEquals(rpc?.args[1], { p_grupos: null, p_classes: [7830], p_pdms: null, p_itens: null, p_somente_catalogo: true });
  const inId = mockClient.calls.find((c) => c.method === "in" && c.args[0] === "id");
  assertEquals((inId?.args[1] as number[]).sort(), [11, 12]);
  assertEquals(mockClient.calls.some((c) => c.method === "eq" && c.args[0] === "uf" && c.args[1] === "SP"), true);

  assertEquals(body.total, 2);
  const l11 = body.items.find((i: { id: number }) => i.id === 11);
  assertEquals(l11.catmat_match.length, 2);
  assertEquals(l11.catmat_match[0].nome_pdm, "ESTEIRA ELÉTRICA");
  const l12 = body.items.find((i: { id: number }) => i.id === 12);
  assertEquals(l12.catmat_match, [{ codigo_pdm: 2638, nome_pdm: "APARELHO / ACESSÓRIO", codigo_item: 602725, motivo: "codigo" }]);
});

Deno.test("list com recorte CATMAT sem nenhuma licitação: 200 vazio, sem consultar licitacoes_externas", async () => {
  const mockClient = createRecordingMockClient({ rpcResult: { data: [], error: null } });
  const req = new Request("http://localhost/api-dashboard-oportunidades?action=list&catmat_pdm=7115", { method: "GET" });
  // deno-lint-ignore no-explicit-any
  const res = await handleRequest(req, { getClient: () => mockClient as any, requireAuth: () => null });
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.items, []);
  assertEquals(body.total, 0);
  assertEquals(mockClient.calls.some((c) => c.method === "from" && c.args[0] === "licitacoes_externas"), false);
});

Deno.test("list com recorte CATMAT: statement_timeout (57014) na RPC vira 503 'filtro de catálogo indisponível'", async () => {
  const mockClient = createRecordingMockClient({
    rpcResult: { data: null, error: { code: "57014", message: "canceling statement due to statement timeout" } },
  });
  const req = new Request("http://localhost/api-dashboard-oportunidades?action=list&catalogo=true", { method: "GET" });
  // deno-lint-ignore no-explicit-any
  const res = await handleRequest(req, { getClient: () => mockClient as any, requireAuth: () => null });
  assertEquals(res.status, 503);
  assertEquals(await res.json(), { error: "filtro de catálogo indisponível" });
  assertEquals(mockClient.calls.some((c) => c.method === "rpc" && c.args[0] === "licitacoes_ids_por_catmat"), true);
  assertEquals(mockClient.calls.some((c) => c.method === "from" && c.args[0] === OPORTUNIDADES_VIEW), false);
});

Deno.test("list com recorte CATMAT: outro erro da RPC continua 500 genérico", async () => {
  const mockClient = createRecordingMockClient({ rpcResult: { data: null, error: { code: "42P01", message: "x" } } });
  const req = new Request("http://localhost/api-dashboard-oportunidades?action=list&catalogo=true", { method: "GET" });
  // deno-lint-ignore no-explicit-any
  const res = await handleRequest(req, { getClient: () => mockClient as any, requireAuth: () => null });
  assertEquals(res.status, 500);
  assertEquals(await res.json(), { error: "Erro interno no servidor" });
});

Deno.test("list com recorte CATMAT acima de 1000 licitações: 422", async () => {
  const data = Array.from({ length: 1001 }, (_, i) => ({ licitacao_id: i + 1, codigo_pdm: 7115, codigo_item: null, motivo: "texto_item" }));
  const mockClient = createRecordingMockClient({ rpcResult: { data, error: null } });
  const req = new Request("http://localhost/api-dashboard-oportunidades?action=list&catmat_grupo=78", { method: "GET" });
  // deno-lint-ignore no-explicit-any
  const res = await handleRequest(req, { getClient: () => mockClient as any, requireAuth: () => null });
  assertEquals(res.status, 422);
});

Deno.test("list sem recorte CATMAT (ou catalogo=false) não chama a RPC nem anexa catmat_match", async () => {
  for (const qs of ["action=list&uf=SP", "action=list&catalogo=false"]) {
    const mockClient = createRecordingMockClient({ listResult: { data: [{ id: 1 }], count: 1, error: null } });
    const req = new Request(`http://localhost/api-dashboard-oportunidades?${qs}`, { method: "GET" });
    // deno-lint-ignore no-explicit-any
    const res = await handleRequest(req, { getClient: () => mockClient as any, requireAuth: () => null });
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(mockClient.calls.some((c) => c.method === "rpc"), false, qs);
    assertEquals("catmat_match" in body.items[0], false, qs);
  }
});

Deno.test("list com recorte CATMAT e página além do fim: a contagem também filtra pelos ids", async () => {
  const mockClient = createRecordingMockClient({
    rpcResult: { data: [{ licitacao_id: 5, codigo_pdm: 7115, codigo_item: null, motivo: "texto_item" }], error: null },
    listResult: { data: null as unknown as unknown[], count: null, error: { code: "PGRST103", message: "Requested range not satisfiable" } },
    headCountResult: { count: 1, error: null },
  });
  const req = new Request("http://localhost/api-dashboard-oportunidades?action=list&catmat_pdm=7115&page=2&limit=100", { method: "GET" });
  // deno-lint-ignore no-explicit-any
  const res = await handleRequest(req, { getClient: () => mockClient as any, requireAuth: () => null });
  assertEquals(res.status, 200);
  assertEquals((await res.json()).total, 1);
  assertEquals(mockClient.calls.some((c) => c.method === "head.in" && c.args[0] === "id"), true);
});


// --------------------------------------------------------------------------
// Oportunidades sem historico (decisão de produto 30/09/2026): prioridade efetiva da view,
// historico fora do list e da contagem; get devolve historico normalmente.
// Dados fictícios.
// --------------------------------------------------------------------------

const ESCOPO_OPORTUNIDADES = "prioridade.is.null,prioridade.neq.historico";

function listReq(qs: string): Request {
  return new Request(`http://localhost/api-dashboard-oportunidades?action=list${qs}`, { method: "GET" });
}

Deno.test("OPORTUNIDADES_VIEW é a view da prioridade efetiva", () => {
  assertEquals(OPORTUNIDADES_VIEW, "licitacoes_externas_prioridade_efetiva");
});

Deno.test("applyOportunidadesScope: sem prioridade exclui historico e mantém NULL; com prioridade não mexe", () => {
  const semFiltro = new MockQueryBuilder();
  applyOportunidadesScope(semFiltro, {});
  assertEquals(semFiltro.calls, [{ method: "or", args: [ESCOPO_OPORTUNIDADES] }]);

  const leads = new MockQueryBuilder();
  applyOportunidadesScope(leads, { prioridade: "leads" });
  assertEquals(leads.calls, []);
});

Deno.test("list padrão lê a view e exclui historico na lista", async () => {
  const mockClient = createRecordingMockClient({ listResult: { data: [], count: 0, error: null } });
  // deno-lint-ignore no-explicit-any
  const res = await handleRequest(listReq("&uf=BA"), { getClient: () => mockClient as any, requireAuth: () => null });
  assertEquals(res.status, 200);
  assertEquals(mockClient.calls.filter((c) => c.method === "from"), [{ method: "from", args: [OPORTUNIDADES_VIEW] }]);
  const ors = mockClient.calls.filter((c) => c.method === "or");
  assertEquals(ors, [{ method: "or", args: [ESCOPO_OPORTUNIDADES] }]);
  assertEquals(mockClient.calls.some((c) => c.method === "eq" && c.args[0] === "prioridade"), false);
});

Deno.test("list padrão com busca: escopo e busca são dois or (AND no PostgREST)", async () => {
  const mockClient = createRecordingMockClient({ listResult: { data: [], count: 0, error: null } });
  // deno-lint-ignore no-explicit-any
  await handleRequest(listReq("&busca=piso"), { getClient: () => mockClient as any, requireAuth: () => null });
  const ors = mockClient.calls.filter((c) => c.method === "or").map((c) => c.args[0]);
  assertEquals(ors.length, 2);
  assertEquals(ors.includes(ESCOPO_OPORTUNIDADES), true);
  assertEquals(ors.some((o) => String(o).startsWith("objeto.ilike.*piso*")), true);
});

Deno.test("list com prioridade=leads filtra a prioridade efetiva sem o or do escopo", async () => {
  const mockClient = createRecordingMockClient({ listResult: { data: [], count: 0, error: null } });
  // deno-lint-ignore no-explicit-any
  await handleRequest(listReq("&prioridade=leads"), { getClient: () => mockClient as any, requireAuth: () => null });
  assertEquals(mockClient.calls.filter((c) => c.method === "eq" && c.args[0] === "prioridade"), [
    { method: "eq", args: ["prioridade", "leads"] },
  ]);
  assertEquals(mockClient.calls.some((c) => c.method === "or"), false);
});

Deno.test("list com prioridade=historico responde 200 vazio sem consultar o banco (nem o recorte CATMAT)", async () => {
  const mockClient = createRecordingMockClient({
    listResult: { data: [{ id: 1, prioridade: "historico" }], count: 1, error: null },
    rpcResult: { data: [{ licitacao_id: 1, codigo_pdm: 1, codigo_item: null, motivo: "texto" }], error: null },
  });
  const res = await handleRequest(listReq("&prioridade=historico&catmat_pdm=1&page=2&limit=10"), {
    // deno-lint-ignore no-explicit-any
    getClient: () => mockClient as any,
    requireAuth: () => null,
  });
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.action, "list");
  assertEquals(body.items, []);
  assertEquals(body.total, 0);
  assertEquals(body.page, 2);
  assertEquals(body.limit, 10);
  assertEquals(mockClient.calls, []);
});

Deno.test("list além do fim (PGRST103): a contagem também exclui historico e lê a view", async () => {
  const mockClient = createRecordingMockClient({
    listResult: { data: null as unknown as unknown[], count: null, error: { code: "PGRST103", message: "range" } },
    headCountResult: { count: 3, error: null },
  });
  // deno-lint-ignore no-explicit-any
  const res = await handleRequest(listReq("&page=5&limit=100"), { getClient: () => mockClient as any, requireAuth: () => null });
  assertEquals(res.status, 200);
  assertEquals((await res.json()).total, 3);
  assertEquals(mockClient.calls.filter((c) => c.method === "from").map((c) => c.args[0]), [OPORTUNIDADES_VIEW, OPORTUNIDADES_VIEW]);
  assertEquals(mockClient.calls.some((c) => c.method === "head.or" && c.args[0] === ESCOPO_OPORTUNIDADES), true);
});

Deno.test("get por id de uma compra historico devolve 200 com a prioridade efetiva (links do BI)", async () => {
  const mockClient = createRecordingMockClient({
    singleResult: { data: { id: 9001, fonte: "pncp", prioridade: "historico", objeto: "Piso emborrachado (fictício)" }, error: null },
  });
  const req = new Request("http://localhost/api-dashboard-oportunidades?action=get&id=9001", { method: "GET" });
  // deno-lint-ignore no-explicit-any
  const res = await handleRequest(req, { getClient: () => mockClient as any, requireAuth: () => null });
  assertEquals(res.status, 200);
  assertEquals((await res.json()).item.prioridade, "historico");
  assertEquals(mockClient.calls.filter((c) => c.method === "from"), [{ method: "from", args: [OPORTUNIDADES_VIEW] }]);
  assertEquals(mockClient.calls.some((c) => c.method === "or"), false);
});

Deno.test("get por codigo_externo e por orgao_cnpj + processo_norm leem a view, sem excluir historico", async () => {
  for (
    const qs of [
      "codigo_externo=11111111000100-1-000001/2026&fonte=pncp",
      "orgao_cnpj=11111111000100&processo_norm=0001202600001",
    ]
  ) {
    const mockClient = createRecordingMockClient({
      singleResult: { data: { id: 9001, prioridade: "historico" }, error: null },
      listResult: { data: [{ id: 9001, prioridade: "historico" }], count: 1, error: null },
    });
    const req = new Request(`http://localhost/api-dashboard-oportunidades?action=get&${qs}`, { method: "GET" });
    // deno-lint-ignore no-explicit-any
    const res = await handleRequest(req, { getClient: () => mockClient as any, requireAuth: () => null });
    assertEquals(res.status, 200, qs);
    assertEquals(mockClient.calls.filter((c) => c.method === "from"), [{ method: "from", args: [OPORTUNIDADES_VIEW] }]);
    assertEquals(mockClient.calls.some((c) => c.method === "or"), false);
  }
});


// --------------------------------------------------------------------------
// Recorte CATMAT x escopo de Oportunidades (review do #108): o teto MAX_IDS_CATMAT vale sobre as
// Oportunidades do recorte, depois de tirar historico. Dados fictícios.
// --------------------------------------------------------------------------

function rpcComIds(n: number) {
  return {
    data: Array.from({ length: n }, (_, i) => ({ licitacao_id: i + 1, codigo_pdm: 7115, codigo_item: null, motivo: "texto_item" })),
    error: null,
  };
}

Deno.test("CATMAT: 1200 historico + 300 atuais não dá 422; lista só as atuais, escopo em lotes de 500", async () => {
  // ids 1..1200 historico, 1201..1500 atuais (leads/monitorar)
  const atuais = (ids: number[]) => ids.filter((id) => id > 1200);
  const mockClient = createRecordingMockClient({
    rpcResult: rpcComIds(1500),
    escopoIds: atuais,
    listResult: { data: [{ id: 1201 }, { id: 1202 }], count: 300, error: null },
  });
  const req = new Request("http://localhost/api-dashboard-oportunidades?action=list&catmat_grupo=78&limit=2", { method: "GET" });
  // deno-lint-ignore no-explicit-any
  const res = await handleRequest(req, { getClient: () => mockClient as any, requireAuth: () => null });
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.total, 300);
  assertEquals(body.items.map((i: { id: number }) => i.id), [1201, 1202]);
  assertEquals(body.items[0].catmat_match.length, 1);

  // escopo: 3 lotes (500+500+500) na view, cada um com o or que exclui historico
  assertEquals(mockClient.calls.filter((c) => c.method === "rpc.range").map((c) => c.args), [[0, 999], [1000, 1999]]);
  const lotes = mockClient.calls.filter((c) => c.method === "escopo.in");
  assertEquals(lotes.map((c) => (c.args[1] as number[]).length), [500, 500, 500]);
  assertEquals(lotes.every((c) => c.args[0] === "id"), true);
  assertEquals(mockClient.calls.filter((c) => c.method === "escopo.or").map((c) => c.args[0]), [
    ESCOPO_OPORTUNIDADES,
    ESCOPO_OPORTUNIDADES,
    ESCOPO_OPORTUNIDADES,
  ]);
  assertEquals(mockClient.calls.some((c) => c.method === "escopo.eq"), false);
  // consulta principal filtra pelos 300 ids atuais (e aplica o escopo de novo)
  const inPrincipal = mockClient.calls.find((c) => c.method === "in" && c.args[0] === "id");
  assertEquals((inPrincipal?.args[1] as number[]).length, 300);
  assertEquals(Math.min(...(inPrincipal?.args[1] as number[])), 1201);
  assertEquals(mockClient.calls.filter((c) => c.method === "from").map((c) => c.args[0]).filter((t) => t !== "catmat_pdms").every((t) => t === OPORTUNIDADES_VIEW), true);
});

Deno.test("CATMAT: mais de 1000 atuais depois do escopo continua 422 (com a contagem de oportunidades)", async () => {
  // 1300 ids, 200 historico: sobram 1100 atuais
  const mockClient = createRecordingMockClient({ rpcResult: rpcComIds(1300), escopoIds: (ids) => ids.filter((id) => id > 200) });
  const req = new Request("http://localhost/api-dashboard-oportunidades?action=list&catmat_grupo=78", { method: "GET" });
  // deno-lint-ignore no-explicit-any
  const res = await handleRequest(req, { getClient: () => mockClient as any, requireAuth: () => null });
  assertEquals(res.status, 422);
  assertEquals((await res.json()).error.includes("1100 oportunidades"), true);
  // a consulta principal nem roda
  assertEquals(mockClient.calls.some((c) => c.method === "select" && c.args[0] === PUBLIC_LICITACAO_COLUMNS), false);
});

Deno.test("CATMAT com prioridade=leads acima do teto: escopo filtra eq(prioridade, leads), sem o or", async () => {
  const mockClient = createRecordingMockClient({
    rpcResult: rpcComIds(1001),
    escopoIds: (ids) => ids.filter((id) => id % 2 === 0),
    listResult: { data: [], count: 0, error: null },
  });
  const req = new Request("http://localhost/api-dashboard-oportunidades?action=list&catmat_grupo=78&prioridade=leads", { method: "GET" });
  // deno-lint-ignore no-explicit-any
  const res = await handleRequest(req, { getClient: () => mockClient as any, requireAuth: () => null });
  assertEquals(res.status, 200);
  assertEquals(mockClient.calls.filter((c) => c.method === "escopo.eq").map((c) => c.args), [
    ["prioridade", "leads"],
    ["prioridade", "leads"],
    ["prioridade", "leads"],
  ]);
  assertEquals(mockClient.calls.some((c) => c.method === "escopo.or"), false);
  const inPrincipal = mockClient.calls.find((c) => c.method === "in" && c.args[0] === "id");
  assertEquals((inPrincipal?.args[1] as number[]).length, 500);
});

Deno.test("CATMAT acima do teto só com historico: 200 vazio sem a consulta principal", async () => {
  const mockClient = createRecordingMockClient({ rpcResult: rpcComIds(1500), escopoIds: () => [] });
  const req = new Request("http://localhost/api-dashboard-oportunidades?action=list&catmat_grupo=78", { method: "GET" });
  // deno-lint-ignore no-explicit-any
  const res = await handleRequest(req, { getClient: () => mockClient as any, requireAuth: () => null });
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.total, 0);
  assertEquals(body.items, []);
  assertEquals(mockClient.calls.some((c) => c.method === "select" && c.args[0] === PUBLIC_LICITACAO_COLUMNS), false);
});

Deno.test("CATMAT até o teto não faz a consulta de escopo (a consulta principal já recorta)", async () => {
  const mockClient = createRecordingMockClient({ rpcResult: rpcComIds(1000), listResult: { data: [], count: 0, error: null } });
  const req = new Request("http://localhost/api-dashboard-oportunidades?action=list&catmat_grupo=78", { method: "GET" });
  // deno-lint-ignore no-explicit-any
  const res = await handleRequest(req, { getClient: () => mockClient as any, requireAuth: () => null });
  assertEquals(res.status, 200);
  assertEquals(mockClient.calls.some((c) => c.method.startsWith("escopo.")), false);
  assertEquals(mockClient.calls.some((c) => c.method === "or" && c.args[0] === ESCOPO_OPORTUNIDADES), true);
});

Deno.test("CATMAT acima do teto com falha na consulta de escopo: 500 genérico", async () => {
  const mockClient = createRecordingMockClient({ rpcResult: rpcComIds(1001), escopoError: { message: "timeout" } });
  const req = new Request("http://localhost/api-dashboard-oportunidades?action=list&catmat_grupo=78", { method: "GET" });
  // deno-lint-ignore no-explicit-any
  const res = await handleRequest(req, { getClient: () => mockClient as any, requireAuth: () => null });
  assertEquals(res.status, 500);
  assertEquals((await res.json()).error, "Erro interno no servidor");
});
