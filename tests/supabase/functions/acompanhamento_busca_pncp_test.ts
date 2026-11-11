// Spec 0049: busca do PNCP (/api/search/) como 2ª fonte do detalhe quando a Consulta e a /api/pncp/v1 caem.
// Cenário medido em 09/11/2026 (oportunidade #1892, Guararema PE 21/2026, controle 46523262000131-1-000118/2026):
// Consulta e /api/pncp/v1 em 503, busca em 200 com o edital e 10 atas. Fixtures copiadas da resposta medida
// (docs/pncp/schemas-consultas-pncp.md, seção 6), sem o usuário que publicou. Sem chamada real: fetch falso.
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import {
  acompanhamentoCompleto,
  clearAcompanhamentoCache,
  handleAcompanhamento,
} from "../../../supabase/functions/api-dashboard-oportunidades/acompanhamento.ts";
import { ataDaBusca, compraDaBusca } from "../../../supabase/functions/api-dashboard-oportunidades/buscaPncp.ts";
import { handleRequest } from "../../../supabase/functions/api-dashboard-oportunidades/index.ts";
import { UnifiedHttpClient } from "../../../supabase/functions/_shared/http-client/index.ts";

const CONTROLE = "46523262000131-1-000118/2026";

const EDITAL_118 = {
  id: "8418daf0ba6f4268d07ef521901cd7a2",
  title: "Edital nº 21/2026",
  description: "REGISTRO DE PREÇOS DE EQUIPAMENTOS DE ACADEMIA",
  item_url: "/compras/46523262000131/2026/118",
  document_type: "edital",
  numero: "21",
  ano: "2026",
  numero_sequencial: "118",
  numero_controle_pncp: CONTROLE,
  orgao_id: "83243",
  orgao_cnpj: "46523262000131",
  orgao_nome: "MUNICIPIO DE GUARAREMA",
  unidade_codigo: "1",
  unidade_nome: "GERAL",
  esfera_id: "M",
  poder_id: "N",
  municipio_nome: "Guararema",
  codigo_ibge: "3518305",
  uf: "SP",
  modalidade_licitacao_id: "6",
  modalidade_licitacao_nome: "Pregão - Eletrônico",
  situacao_id: "1",
  situacao_nome: "Divulgada no PNCP",
  data_publicacao_pncp: "2026-04-17T09:13:23.177753",
  data_atualizacao_pncp: "2026-08-25T10:26:11.559997",
  data_inicio_vigencia: "2026-06-30T08:00",
  data_fim_vigencia: "2026-07-15T08:00",
  cancelado: false,
  tem_resultado: true,
  srp: true,
  valor_total_estimado: 222420.95,
  valor_total_homologado: 232620.82,
  data_inicio_recebimento_propostas: "",
  data_fim_recebimento_propostas: "",
  link_sistema_origem: null,
  permite_adesao: null,
};

function ata118(seq: number) {
  return {
    title: `Ata nº ${seq + 75}/2026`,
    description: "REGISTRO DE PREÇOS DE EQUIPAMENTOS DE ACADEMIA",
    item_url: `/atas/46523262000131/2026/118/${seq}`,
    document_type: "ata",
    ano: "2026",
    numero_sequencial: String(seq),
    numero_sequencial_compra_ata: "118",
    numero_controle_pncp: `${CONTROLE}-${String(seq).padStart(6, "0")}`,
    orgao_cnpj: "46523262000131",
    data_publicacao_pncp: "2026-09-01T10:42:25.687213269",
    data_atualizacao_pncp: `2026-09-01T10:4${seq % 10}:25.687213269`,
    data_assinatura: "2026-08-28",
    data_inicio_vigencia: "2026-08-28",
    data_fim_vigencia: "2027-08-28",
    permite_adesao: false,
    cancelado: false,
    valor_global: null,
  };
}
const ATAS_118 = Array.from({ length: 10 }, (_, i) => ata118(i + 1));

const ROW_1892 = {
  id: 1892,
  fonte: "pncp",
  codigo_externo: CONTROLE,
  fase: null,
  link_sistema_origem: null,
  pncp_data_atualizacao: "2026-08-25 13:26:11+00",
};

function linhaItem(numero_item: number) {
  return {
    numero_item,
    descricao: `ITEM ${numero_item}`,
    quantidade: "1.0",
    unidade_medida: "UND",
    valor_unitario_estimado: "100.00",
    situacao: "Homologado",
    tem_resultado: true,
    catalogo_codigo_item: null,
    catalogo_id: null,
    material_ou_servico: "M",
    raw: null,
    updated_at: "2026-10-02T02:41:26+00:00",
  };
}

type Tabelas = Record<string, Record<string, unknown>[] | "erro">;

function mockSupabase(row: Record<string, unknown>, tabelas: Tabelas) {
  const builder = (tabela: string) => {
    let faixa: [number, number] | null = null;
    const resultado = () => {
      if (tabela === "licitacoes_externas") return { data: row, error: null };
      const linhas = tabelas[tabela];
      if (linhas === undefined || linhas === "erro") return { data: null, error: { message: `sem mock: ${tabela}` } };
      return { data: faixa ? linhas.slice(faixa[0], faixa[1] + 1) : linhas, error: null };
    };
    const b: Record<string, unknown> = {};
    for (const m of ["select", "eq", "in", "order", "is", "not", "gte", "lte", "limit", "filter", "or"]) {
      b[m] = () => b;
    }
    b.range = (de: number, ate: number) => {
      faixa = [de, ate];
      return b;
    };
    b.maybeSingle = () => Promise.resolve(resultado());
    b.single = () => Promise.resolve(resultado());
    b.then = (ok: (v: unknown) => unknown, falha?: (e: unknown) => unknown) =>
      Promise.resolve(resultado()).then(ok, falha);
    return b;
  };
  return { from: (t: string) => builder(t) };
}

type Cenario = {
  consulta: "fora" | "ok";
  pncpV1: "fora" | "ok";
  busca: "ok" | "fora";
  edital?: Record<string, unknown>;
};

function fetchFalso(c: Cenario, buscas: string[]): typeof fetch {
  const fora = () => new Response("<html><body><h1>503 Service Unavailable</h1></body></html>", { status: 503 });
  const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200 });
  return ((input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (url.pathname.startsWith("/api/search")) {
      buscas.push(url.searchParams.get("tipos_documento") ?? "");
      if (c.busca === "fora") return Promise.resolve(fora());
      if (url.searchParams.get("tipos_documento") === "ata") {
        return Promise.resolve(json({ total: ATAS_118.length, items: ATAS_118 }));
      }
      return Promise.resolve(json({ total: 1, items: [c.edital ?? EDITAL_118] }));
    }
    if (url.pathname.startsWith("/api/consulta/v1/")) {
      return Promise.resolve(
        c.consulta === "fora" ? fora() : json({ situacaoCompraNome: "Divulgada no PNCP", objetoCompra: "OBJETO AO VIVO" }),
      );
    }
    if (c.pncpV1 === "fora") return Promise.resolve(fora());
    if (url.pathname.endsWith("/arquivos")) return Promise.resolve(json([]));
    return Promise.resolve(json([]));
  }) as typeof fetch;
}

function httpClient() {
  return new UnifiedHttpClient({
    hostLease: {
      acquireSlot: () => Promise.resolve({ allowed: true, wait_ms: 0 }),
      reportRateLimit: () => Promise.resolve(),
    },
  });
}

async function chamar(c: Cenario, row: Record<string, unknown> = ROW_1892, tabelas: Tabelas = {}) {
  clearAcompanhamentoCache();
  const buscas: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = fetchFalso(c, buscas);
  try {
    const res = await handleAcompanhamento(
      { action: "acompanhamento", id: Number(row.id) },
      // deno-lint-ignore no-explicit-any
      { getClient: () => mockSupabase(row, tabelas) as any, httpClient: httpClient() },
    );
    return { res, body: await res.json(), buscas };
  } finally {
    globalThis.fetch = original;
    clearAcompanhamentoCache();
  }
}

Deno.test("CA-3: compraDaBusca mapeia o edital medido da 118, sem inventar o que a busca não traz", () => {
  const c = compraDaBusca(EDITAL_118);
  assertEquals(c.valorEstimado, 222420.95);
  assertEquals(c.valorHomologado, 232620.82);
  assertEquals(c.objeto, "REGISTRO DE PREÇOS DE EQUIPAMENTOS DE ACADEMIA");
  assertEquals(c.situacao, "Divulgada no PNCP");
  assertEquals(c.situacaoCompraId, 1);
  assertEquals(c.modalidadeId, 6);
  assertEquals(c.numeroCompra, "21");
  assertEquals(c.srp, true);
  assertEquals(c.existeResultado, true);
  assertEquals(c.datas.aberturaProposta, "2026-06-30T08:00:00-03:00");
  assertEquals(c.datas.encerramentoProposta, "2026-07-15T08:00:00-03:00");
  assertEquals(c.datas.publicacao, "2026-04-17T09:13:23-03:00");
  assertEquals(c.datas.atualizacao, "2026-08-25T10:26:11-03:00");
  assertEquals(c.datas.inclusao, null);
  assertEquals(c.processo, null);
  assertEquals(c.linkSistemaOrigem, null);
});

Deno.test("CA-3: data de recebimento de proposta vazia não vira data; valor ausente fica null", () => {
  const c = compraDaBusca({
    ...EDITAL_118,
    data_fim_vigencia: "",
    data_inicio_vigencia: null,
    valor_total_homologado: null,
    situacao_id: "x",
  });
  assertEquals(c.datas.encerramentoProposta, null);
  assertEquals(c.datas.aberturaProposta, null);
  assertEquals(c.valorHomologado, null);
  assertEquals(c.situacaoCompraId, null);
});

Deno.test("CA-3: ataDaBusca lê número e ano do título e não inventa fornecedor nem valor", () => {
  const a = ataDaBusca(ata118(10));
  assertEquals(a.numero, "85");
  assertEquals(a.ano, 2026);
  assertEquals(a.vigenciaInicio, "2026-08-28");
  assertEquals(a.vigenciaFim, "2027-08-28");
  assertEquals(a.dataAssinatura, "2026-08-28");
  assertEquals(a.cancelado, false);
  assertEquals(a.permiteAdesao, false);
  const semTitulo = ataDaBusca({ ...ata118(1), title: "Documento sem número" });
  assertEquals(semTitulo.numero, null);
  assertEquals(semTitulo.ano, null);
});

Deno.test("CA-4: Consulta em 503 e busca em 200 → Resumo e Atas da busca, com o erro do PNCP e a data do índice", async () => {
  const { body, buscas } = await chamar({ consulta: "fora", pncpV1: "fora", busca: "ok" });
  assertEquals(body.compra.origem, "busca_pncp");
  assertStringIncludes(body.compra.erro, "503");
  assertEquals(body.compra.dados.objeto, "REGISTRO DE PREÇOS DE EQUIPAMENTOS DE ACADEMIA");
  assertEquals(body.compra.busca_atualizado_em, "2026-08-25T10:26:11-03:00");
  assertEquals(body.atas.origem, "busca_pncp");
  assertStringIncludes(body.atas.erro, "503");
  assertEquals(body.atas.dados.length, 10);
  assertEquals(body.atas.total, 10);
  assertEquals(body.atas.busca_atualizado_em, "2026-09-01T10:49:25-03:00");
  // uma busca de edital (resumo + conferência) e uma de atas
  assertEquals(buscas.sort(), ["ata", "edital"]);
});

Deno.test("CA-4: busca também fora → seções como hoje, em erro e sem origem", async () => {
  const { body } = await chamar({ consulta: "fora", pncpV1: "fora", busca: "fora" });
  assertEquals(body.compra.dados, null);
  assertEquals(body.compra.origem, undefined);
  assertStringIncludes(body.compra.erro, "503");
  assertEquals(body.atas.origem, undefined);
  assertEquals(body.atas.dados, []);
});

Deno.test("CA-4: edital da busca de outra compra não entra no Resumo", async () => {
  const { body } = await chamar({
    consulta: "fora",
    pncpV1: "fora",
    busca: "ok",
    edital: { ...EDITAL_118, numero_controle_pncp: "46523262000131-1-000113/2026" },
  });
  assertEquals(body.compra.dados, null);
  assertEquals(body.compra.origem, undefined);
});

Deno.test("CA-5: Consulta e /api/pncp/v1 em 200 → a busca não é chamada e nenhuma seção vem da busca", async () => {
  const { body, buscas } = await chamar({ consulta: "ok", pncpV1: "ok", busca: "ok" });
  assertEquals(buscas.length, 0);
  assertEquals(body.compra.origem, undefined);
  assertEquals(body.compra.dados.objeto, "OBJETO AO VIVO");
  assertEquals(body.atas.origem, undefined);
});

Deno.test("CA-6: itens da cópia e busca com a mesma atualização da gravada → compra_mudou=false", async () => {
  const { body } = await chamar({ consulta: "ok", pncpV1: "fora", busca: "ok" }, ROW_1892, {
    licitacao_itens: [linhaItem(1), linhaItem(2)],
  });
  assertEquals(body.itens.origem, "copia_local");
  assertEquals(body.itens.conferencia_busca, {
    pncp_atualizado_em: "2026-08-25T10:26:11-03:00",
    gravado_em: "2026-08-25T13:26:11.000Z",
    compra_mudou: false,
  });
});

Deno.test("CA-6: busca com atualização posterior à gravada → compra_mudou=true", async () => {
  const { body } = await chamar(
    { consulta: "ok", pncpV1: "fora", busca: "ok", edital: { ...EDITAL_118, data_atualizacao_pncp: "2026-11-01T09:00:00" } },
    ROW_1892,
    { licitacao_itens: [linhaItem(1)] },
  );
  assertEquals(body.itens.conferencia_busca.compra_mudou, true);
});

Deno.test("CA-6: índice atrás da cópia (defasado) → compra_mudou=null, nunca 'a mesma'", async () => {
  const { body } = await chamar({ consulta: "ok", pncpV1: "fora", busca: "ok" }, {
    ...ROW_1892,
    pncp_data_atualizacao: "2026-08-26 13:00:00+00",
  }, { licitacao_itens: [linhaItem(1)] });
  assertEquals(body.itens.conferencia_busca.compra_mudou, null);
  assertEquals(body.itens.conferencia_busca.pncp_atualizado_em, "2026-08-25T10:26:11-03:00");
});

Deno.test("CA-6: sem pncp_data_atualizacao gravada → compra_mudou=null; busca fora → sem conferência", async () => {
  const semData = await chamar({ consulta: "ok", pncpV1: "fora", busca: "ok" }, {
    ...ROW_1892,
    pncp_data_atualizacao: null,
  }, { licitacao_itens: [linhaItem(1)] });
  assertEquals(semData.body.itens.conferencia_busca.compra_mudou, null);
  assertEquals(semData.body.itens.conferencia_busca.gravado_em, null);

  const buscaFora = await chamar({ consulta: "ok", pncpV1: "fora", busca: "fora" }, ROW_1892, {
    licitacao_itens: [linhaItem(1)],
  });
  assertEquals(buscaFora.body.itens.origem, "copia_local");
  assertEquals(buscaFora.body.itens.conferencia_busca, undefined);
});

Deno.test("revisão: com o PNCP fora, abrir o detalhe de novo em 15 s não repete a busca (lease)", async () => {
  clearAcompanhamentoCache();
  const buscas: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = fetchFalso({ consulta: "fora", pncpV1: "fora", busca: "ok" }, buscas);
  try {
    for (let i = 0; i < 2; i++) {
      const res = await handleAcompanhamento(
        { action: "acompanhamento", id: 1892 },
        // deno-lint-ignore no-explicit-any
        { getClient: () => mockSupabase(ROW_1892, {}) as any, httpClient: httpClient() },
      );
      const body = await res.json();
      assertEquals(body.compra.origem, "busca_pncp");
    }
  } finally {
    globalThis.fetch = original;
    clearAcompanhamentoCache();
  }
  assertEquals(buscas.sort(), ["ata", "edital"]);
});

Deno.test("CA-7: resposta com seção da busca não é completa: no-store (regressão do #501)", async () => {
  const { res, body } = await chamar({ consulta: "fora", pncpV1: "fora", busca: "ok" });
  assertEquals(res.headers.get("Cache-Control"), "no-store");
  assert(!acompanhamentoCompleto(body));
});

Deno.test("CA-8: acompanhamento sem Authorization → 401 e nenhuma chamada à busca", async () => {
  const buscas: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = fetchFalso({ consulta: "fora", pncpV1: "fora", busca: "ok" }, buscas);
  try {
    const res = await handleRequest(
      new Request("http://localhost/api-dashboard-oportunidades?action=acompanhamento&id=1892", { method: "GET" }),
    );
    assertEquals(res.status, 401);
    await res.body?.cancel();
  } finally {
    globalThis.fetch = original;
  }
  assertEquals(buscas.length, 0);
});
