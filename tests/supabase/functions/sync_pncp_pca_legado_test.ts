import { assert, assertEquals } from "jsr:@std/assert@1";
import { FakePostgrest } from "./_shared/pncp/_fake_postgrest.ts";
import { handleRequest } from "../../../supabase/functions/sync-pncp-pca/index.ts";
import { PncpConsultaClient } from "../../../supabase/functions/_shared/pncp/consulta-client.ts";
import { BudgetExhaustedError } from "../../../supabase/functions/_shared/pncp/retry.ts";
import { gravarPaginaPcaEmLote } from "../../../supabase/functions/_shared/pncp/pca-lote.ts";
type Row = Record<string, unknown>;
const ANO = 2026;
const CNPJ = "99000001000101";
function plano(n: number, classe = "7830"): Row {
  return {
    anoPca: ANO,
    orgaoEntidadeCnpj: CNPJ,
    idPcaPncp: `${CNPJ}-0-${String(n).padStart(6, "0")}/2026`,
    dataAtualizacaoGlobalPCA: "2026-10-01T10:00:00",
    itens: [{
      numeroItem: 1,
      classificacaoSuperiorCodigo: classe,
      descricaoItem: "Item sintético",
      quantidadeEstimada: 1,
      valorUnitario: 10,
      valorTotal: 10,
    }],
  };
}
function ambiente() {
  const db = new FakePostgrest();
  let seq = 0;
  const adquirir = (args: Row) => {
    const runs = db.rows("pncp_sync_run");
    const atual = runs.find((r) => r.lock_key === args.p_lock_key && r.status === "executando");
    if (atual) return { already_running: true, run_id: atual.id };
    const anterior = String(args.p_lock_key).includes(":manual:")
      ? undefined
      : runs.filter((r) => r.lock_key === args.p_lock_key && r.status === "incompleta").pop();
    const continuation = (anterior?.parametros as Row | undefined)?.continuation ?? null;
    if (anterior) anterior.status = "retomada";
    const id = `run-${++seq}`;
    runs.push({
      id,
      status: "executando",
      lock_key: args.p_lock_key,
      parametros: { ...(args.p_parametros as Row), ...(continuation ? { continuation } : {}) },
    });
    return { already_running: false, run_id: id, continuation };
  };
  db.rpcs.acquire_sync_lock = adquirir;
  db.rpcs.pca_adquirir_execucao = adquirir;
  const paginas: number[] = [];
  const parser = new PncpConsultaClient();
  let fetchPage = (_classe: string, pagina: number): { status: number; body: unknown; elapsedMs: number } => ({
    status: 200,
    body: { data: [plano(pagina)], numeroPagina: pagina, paginasRestantes: 2 - pagina, totalRegistros: 2 },
    elapsedMs: 1,
  });
  const consulta = {
    probePncpHealth: () => Promise.resolve({ status: "ok" as const, elapsedMs: 1 }),
    probePcaClassificacao: (_ano: number, codigo: string) =>
      Promise.resolve({ status: 200, total_registros: codigo === "7220" ? 1 : 2 }),
    fetchPcaPage: (_ano: number, pagina: number, classe: string) => {
      paginas.push(pagina);
      return Promise.resolve(fetchPage(classe, pagina));
    },
    extractList: (body: unknown) => parser.extractList(body),
    extractPagination: (body: unknown, pagina: number) => parser.extractPagination(body, pagina),
  };
  const summary = {
    ano: ANO,
    total_indexado: 2,
    amostra: 1,
    max_data_atualizacao: "2026-10-01T10:00:00",
    min_data_publicacao_amostra: null,
    max_data_publicacao: null,
    orgaos_amostra: [],
  };
  const search = { summarizePcaPeriod: () => Promise.resolve(summary) };
  const request = async (body: Row = {}) => {
    const secretAntes = Deno.env.get("SYNC_CRON_SECRET");
    const scopeAntes = Deno.env.get("LICITAGYM_SCOPE_GATE");
    Deno.env.set("SYNC_CRON_SECRET", "secret-sintetico");
    Deno.env.set("LICITAGYM_SCOPE_GATE", "off");
    try {
      const res = await handleRequest(
        new Request("http://localhost/sync-pncp-pca", {
          method: "POST",
          headers: { authorization: "Bearer secret-sintetico", "content-type": "application/json" },
          body: JSON.stringify({ ano: ANO, max_paginas: 1, verificar_periodo: false, ...body }),
        }),
        { createServiceClient: () => db as never, consulta: consulta as never, search },
      );
      return { http: res.status, body: await res.json() as Row };
    } finally {
      if (secretAntes === undefined) Deno.env.delete("SYNC_CRON_SECRET");
      else Deno.env.set("SYNC_CRON_SECRET", secretAntes);
      if (scopeAntes === undefined) Deno.env.delete("LICITAGYM_SCOPE_GATE");
      else Deno.env.set("LICITAGYM_SCOPE_GATE", scopeAntes);
    }
  };
  return {
    db,
    paginas,
    request,
    summary,
    consulta,
    setPage: (fn: typeof fetchPage) => {
      fetchPage = fn;
    },
  };
}
Deno.test("legado: max_paginas deixa incompleta e não promove o anchor", async () => {
  const a = ambiente();
  const r = await a.request();
  assertEquals(r.body.status, "incompleta");
  assertEquals(a.db.rows("pncp_sync_run")[0].status, "incompleta");
  assertEquals(a.db.rows("pncp_period_anchor")[0].ultima_carga_completa ?? null, null);
});
Deno.test("legado: segunda chamada retoma página 2 sem repetir página 1", async () => {
  const a = ambiente();
  await a.request();
  const r = await a.request();
  assertEquals(a.paginas, [1, 2]);
  assertEquals(r.body.status, "concluida");
  assert(a.db.rows("pncp_period_anchor")[0].ultima_carga_completa != null);
});
Deno.test("legado: modo completo é bloqueado e preserva outras classes", async () => {
  const a = ambiente();
  await gravarPaginaPcaEmLote(a.db as never, [plano(9, "7220")], { ano: ANO, runId: "antes" });
  const antes = structuredClone(a.db.rows("pca_itens"));
  const r = await a.request({ modo: "completo", max_paginas: 10 });
  assertEquals(r.http, 400);
  assertEquals(a.paginas, []);
  assertEquals(a.db.rows("pca_itens"), antes);
  assertEquals(a.db.rows("pca_planos")[0].ativo, true);
});
Deno.test("legado: HTTP 200 sem envelope não conclui carga vazia", async () => {
  const a = ambiente();
  a.setPage(() => ({ status: 200, body: { message: "resposta inválida" }, elapsedMs: 1 }));
  const r = await a.request();
  assertEquals(r.http, 500);
  assertEquals(a.db.rows("pncp_period_anchor")[0].ultima_carga_completa ?? null, null);
});
Deno.test("legado: orçamento preserva pending e retoma também uma chamada forçada", async () => {
  const a = ambiente();
  let falhar = true;
  a.setPage((_classe, pagina) => {
    if (pagina === 2 && falhar) {
      falhar = false;
      throw new BudgetExhaustedError();
    }
    return {
      status: 200,
      body: { data: [plano(pagina)], numeroPagina: pagina, paginasRestantes: 2 - pagina, totalRegistros: 2 },
      elapsedMs: 1,
    };
  });
  const r1 = await a.request({ forcar: true, max_paginas: 10 });
  assertEquals(r1.http, 503);
  assertEquals(r1.body.run_status, "incompleta");
  assertEquals(a.db.rows("pncp_sync_run")[0].modo, "manual");
  const r2 = await a.request({ forcar: true, max_paginas: 10 });
  assertEquals(a.paginas, [1, 2, 2]);
  assertEquals(r2.body.status, "concluida");
});

Deno.test("legado: várias classes retomam só as páginas pendentes", async () => {
  const a = ambiente();
  const calls: unknown[] = [];
  a.setPage((classe, pagina) => {
    calls.push([classe, pagina]);
    return {
      status: 200,
      body: {
        data: [plano(pagina + (classe === "7220" ? 10 : 0), classe)],
        numeroPagina: pagina,
        paginasRestantes: classe === "7220" ? 0 : 2 - pagina,
        totalRegistros: classe === "7220" ? 1 : 2,
      },
      elapsedMs: 1,
    };
  });
  const body = { codigos_classificacao: ["7830", "7220"] };
  assertEquals((await a.request(body)).body.status, "incompleta");
  assertEquals((await a.request(body)).body.status, "concluida");
  assertEquals(calls, [["7830", 1], ["7220", 1], ["7830", 2]]);
});
Deno.test("legado: probe igual não ignora cadeia forçada que ficou pendente", async () => {
  const a = ambiente();
  await a.request({ max_paginas: 10 });
  await a.request({ forcar: true });
  const r = await a.request({ verificar_periodo: true });
  assertEquals(r.body.status, "concluida");
  assertEquals(a.paginas, [1, 2, 1, 2]);
  assertEquals((await a.request({ verificar_periodo: true })).body.status, "ignorado");
});
Deno.test("legado: somente_verificacao não substitui o snapshot da carga completa", async () => {
  const a = ambiente();
  await a.request({ max_paginas: 10 });
  a.summary.total_indexado = 3;
  const probe = await a.request({ somente_verificacao: true });
  assertEquals(probe.body.carga_necessaria, true);
  const snapshot = (a.db.rows("pncp_period_anchor")[0].metadata as Row).carga_completa as Row;
  assertEquals(snapshot.total_indexado, 2);
  await a.request({ verificar_periodo: true, max_paginas: 10 });
  assertEquals(a.paginas, [1, 2, 1, 2]);
});
Deno.test("legado: último probe não é prova de carga completa em anchor antigo", async () => {
  const a = ambiente();
  a.db.rows("pncp_period_anchor").push({
    resource_type: "pca_search",
    scope_key: "pcaorgao",
    ano_exercicio: ANO,
    ultima_carga_completa: "2026-09-01T10:00:00Z",
    ultima_data_atualizacao: a.summary.max_data_atualizacao,
    total_indexado: 2,
    metadata: { total_registros_classe: { "7830": 2 } },
  });
  const r = await a.request({ verificar_periodo: true, max_paginas: 10 });
  assertEquals(r.body.status, "concluida");
  assertEquals(a.paginas, [1, 2]);
});
Deno.test("legado: começar depois da página 1 não promove carga anual", async () => {
  const a = ambiente();
  const r = await a.request({ pagina_inicial: 2, max_paginas: 10 });
  assertEquals(r.body.carga_anual_completa, false);
  assertEquals(a.db.rows("pncp_period_anchor")[0].ultima_carga_completa ?? null, null);
});
Deno.test("legado: checkpoint inicial falho impede leitura HTTP", async () => {
  const a = ambiente();
  let primeira = true;
  const executar = a.db.executar.bind(a.db);
  a.db.executar = (query) => {
    if (primeira && query.table === "pncp_sync_run" && query.op === "update") {
      primeira = false;
      return { data: null, error: { message: "checkpoint sintético" } };
    }
    return executar(query);
  };
  assertEquals((await a.request()).http, 500);
  assertEquals(a.paginas, []);
});
Deno.test("legado: falha de item mantém a página para retry e impede promoção", async () => {
  const a = ambiente();
  a.db.falhaLinha = (table) => table === "pca_itens";
  const r1 = await a.request({ max_paginas: 10 });
  assertEquals(r1.body.status, "incompleta");
  assertEquals((r1.body.continuation as Row).pagina_por_codigo_pendente, { "7830": 1 });
  assertEquals(a.db.rows("pncp_period_anchor")[0].ultima_carga_completa ?? null, null);
  a.db.falhaLinha = null;
  const r2 = await a.request({ max_paginas: 10 });
  assertEquals(r2.body.status, "concluida");
  assertEquals(a.paginas, [1, 1, 2]);
});
Deno.test("legado: orçamento conserva contagens do que já foi gravado", async () => {
  const a = ambiente();
  a.setPage((_classe, pagina) => {
    if (pagina === 2) throw new BudgetExhaustedError();
    return {
      status: 200,
      body: { data: [plano(1)], numeroPagina: 1, paginasRestantes: 1, totalRegistros: 2 },
      elapsedMs: 1,
    };
  });
  await a.request({ max_paginas: 10 });
  assertEquals(a.db.rows("pncp_sync_run")[0].total_recebidos, 2); // um plano e um item, conforme LoteStats
  const c = (a.db.rows("pncp_sync_run")[0].parametros as Row).continuation as Row;
  assertEquals(c.pending, ["7830"]);
  assertEquals(c.pagina_por_codigo_pendente, { "7830": 2 });
});
Deno.test("legado: tamanho de página é preservado durante a retomada", async () => {
  const a = ambiente();
  const sizes: unknown[] = [];
  const fetch = a.consulta.fetchPcaPage;
  const consulta = a.consulta as unknown as {
    fetchPcaPage: (ano: number, pagina: number, classe: string, tamanho?: number) => ReturnType<typeof fetch>;
  };
  consulta.fetchPcaPage = (ano, pagina, classe, tamanho) => {
    sizes.push(tamanho);
    return fetch(ano, pagina, classe);
  };
  await a.request({ tamanho_pagina: 100 });
  await a.request({ tamanho_pagina: 500 });
  assertEquals(sizes, [100, 100]);
});
Deno.test("legado: controles de paginação inválidos não iniciam execução", async () => {
  for (const body of [{ max_paginas: 0 }, { max_paginas: 1.5 }, { pagina_inicial: 0 }, { pagina_inicial: -1 }]) {
    const a = ambiente();
    assertEquals((await a.request(body)).http, 400);
    assertEquals(a.db.rows("pncp_sync_run"), []);
  }
});
Deno.test("legado: página repetida ou paginação ausente não vira conclusão", async () => {
  for (
    const body of [
      { data: [plano(1)], numeroPagina: 2, paginasRestantes: 0, totalRegistros: 1 },
      { data: [plano(1)] },
      { data: [], numeroPagina: 1, paginasRestantes: 1, totalRegistros: 2 },
    ]
  ) {
    const a = ambiente();
    a.setPage(() => ({ status: 200, body, elapsedMs: 1 }));
    assertEquals((await a.request()).http, 500);
    assertEquals(a.db.rows("pca_planos").length, 0);
    assertEquals(a.db.rows("pncp_period_anchor")[0].ultima_carga_completa ?? null, null);
  }
});
Deno.test("legado: 204 é fim válido e não inativa registros existentes", async () => {
  const a = ambiente();
  await gravarPaginaPcaEmLote(a.db as never, [plano(7)], { ano: ANO, runId: "antes" });
  a.setPage(() => ({ status: 204, body: null, elapsedMs: 1 }));
  assertEquals((await a.request()).body.status, "concluida");
  assertEquals(a.db.rows("pca_itens")[0].ativo, true);
});
Deno.test("legado: async sem waitUntil aguarda o resultado real", async () => {
  const a = ambiente();
  const r = await a.request({ async: true, max_paginas: 10 });
  assertEquals(r.http, 200);
  assertEquals(r.body.status, "concluida");
});

Deno.test("B6 legado: default limita a 100 páginas mesmo começando depois de 200", async () => {
  const a = ambiente();
  a.setPage((_classe, pagina) => ({
    status: 200,
    body: {
      data: [plano(pagina)],
      numeroPagina: pagina,
      paginasRestantes: 1000 - pagina,
      totalRegistros: 1000,
    },
    elapsedMs: 1,
  }));
  const r = await a.request({ max_paginas: undefined, pagina_inicial: 251 });
  assertEquals(r.body.status, "incompleta");
  assertEquals(a.paginas.length, 100);
  assertEquals([a.paginas[0], a.paginas.at(-1)], [251, 350]);
  assertEquals((r.body.continuation as Row).pagina_por_codigo_pendente, { "7830": 351 });
});
