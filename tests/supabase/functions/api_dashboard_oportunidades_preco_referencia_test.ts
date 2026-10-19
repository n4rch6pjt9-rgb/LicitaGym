// Spec 0009, CA-8 (backend): o detalhe da oportunidade (ação acompanhamento) expõe, por item, o PDM e a sigla da
// unidade de fornecimento, com proveniência, para a aba "Inteligência de Preços" cruzar com a api-precos.
import { assertEquals } from "jsr:@std/assert@1";
import {
  clearAcompanhamentoCache,
  handleAcompanhamento,
} from "../../../supabase/functions/api-dashboard-oportunidades/acompanhamento.ts";
import {
  decidirPdmDoItem,
  siglaUnidadeFornecimento,
} from "../../../supabase/functions/api-dashboard-oportunidades/precoReferencia.ts";
import { UnifiedHttpClient } from "../../../supabase/functions/_shared/http-client/index.ts";

// -----------------------------------------------------------------------------
// Unidade: só siglas que a Pesquisa de Preço usa, por dicionário fechado; o resto fica null (não adivinha)
// -----------------------------------------------------------------------------

Deno.test("CA-8: siglaUnidadeFornecimento reconhece as formas comuns de UN, PAR, M2 e RO", () => {
  for (const u of ["UN", "un", " Unidade  ", "UNIDADE", "Unidades", "UND", "Und.", "UNID", "UNIDADE (UN)", "UN - UNIDADE", "Unidade - Un"]) {
    assertEquals(siglaUnidadeFornecimento(u), "UN", u);
  }
  for (const u of ["PAR", "Par", "PARES", "PAR (PAR)"]) assertEquals(siglaUnidadeFornecimento(u), "PAR", u);
  for (const u of ["M2", "M²", "m²", "Metro Quadrado", "METROS QUADRADOS", "METRO QUADRADO (M2)", "MT2"]) {
    assertEquals(siglaUnidadeFornecimento(u), "M2", u);
  }
  for (const u of ["ROLO", "Rolo"]) assertEquals(siglaUnidadeFornecimento(u), "RO", u);
});

Deno.test("CA-8: siglaUnidadeFornecimento devolve null para embalagem, quantidade, mistura ou desconhecida", () => {
  for (
    const u of [
      null,
      "",
      "   ",
      "KIT",
      "Jogo",
      "1,00 UNIDADE",
      "EMBALAGEM 1.0 UNIDADE",
      "CAIXA 1,00 PAR",
      "Caixa 12 Unidade",
      "UNIDADE (PAR)",
      "M²,M³,M,UND,KG,PAR,M2",
      "PR",
      "Peça",
    ]
  ) {
    assertEquals(siglaUnidadeFornecimento(u), null, String(u));
  }
});

// -----------------------------------------------------------------------------
// PDM do item: catálogo oficial do PNCP primeiro; casamento por texto só sem código oficial e com um PDM; serviço nunca
// -----------------------------------------------------------------------------

const BASE_PDM = {
  material: "M" as const,
  codigoCatmat: null,
  pdmCatalogo: null,
  catalogoFalhou: false,
  carregado: true,
  pdmsTexto: [] as number[],
  textoFalhou: false,
};

Deno.test("CA-8: decidirPdmDoItem usa o PDM do código CATMAT oficial", () => {
  assertEquals(
    decidirPdmDoItem({ ...BASE_PDM, codigoCatmat: 150001, pdmCatalogo: 4321, pdmsTexto: [999] }),
    { codigoPdm: 4321, codigoPdmOrigem: "catalogo_pncp", codigoPdmMotivo: null },
  );
  // Falha só do texto não atrapalha quem tem código oficial.
  assertEquals(
    decidirPdmDoItem({ ...BASE_PDM, codigoCatmat: 150001, pdmCatalogo: 4321, textoFalhou: true }).codigoPdm,
    4321,
  );
});

Deno.test("CA-8: código CATMAT oficial sem PDM na base local não cai no texto", () => {
  assertEquals(
    decidirPdmDoItem({ ...BASE_PDM, codigoCatmat: 150001, pdmCatalogo: null, pdmsTexto: [777] }),
    {
      codigoPdm: null,
      codigoPdmOrigem: null,
      codigoPdmMotivo: "Código CATMAT 150001 sem PDM na base local (catmat_itens): sem PDM para comparar.",
    },
  );
});

Deno.test("CA-8: decidirPdmDoItem usa o casamento por texto só com um PDM", () => {
  assertEquals(
    decidirPdmDoItem({ ...BASE_PDM, pdmsTexto: [777] }),
    { codigoPdm: 777, codigoPdmOrigem: "casamento_texto", codigoPdmMotivo: null },
  );
  const varios = decidirPdmDoItem({ ...BASE_PDM, material: null, pdmsTexto: [5, 7] });
  assertEquals(varios.codigoPdm, null);
  assertEquals(varios.codigoPdmOrigem, null);
  assertEquals(varios.codigoPdmMotivo, "Mais de um PDM casou pelo texto do item (5, 7): sem PDM único para comparar.");
});

Deno.test("CA-8: decidirPdmDoItem não dá PDM a serviço, a item sem casamento nem a item não carregado", () => {
  const servico = decidirPdmDoItem({ ...BASE_PDM, material: "S", pdmsTexto: [777] });
  assertEquals(servico.codigoPdm, null);
  assertEquals(servico.codigoPdmMotivo, "Item de serviço: a Pesquisa de Preço do PDM é de material.");
  const nada = decidirPdmDoItem({ ...BASE_PDM });
  assertEquals(nada.codigoPdm, null);
  assertEquals(nada.codigoPdmMotivo, "Item sem PDM: sem código CATMAT no PNCP e sem casamento pelo texto.");
  const naoCarregado = decidirPdmDoItem({ ...BASE_PDM, carregado: false });
  assertEquals(naoCarregado.codigoPdm, null);
  assertEquals(naoCarregado.codigoPdmMotivo, "Item ainda não carregado na base: o casamento pelo texto não foi avaliado.");
});

Deno.test("CA-8: decidirPdmDoItem com consulta falha diz que está indisponível, sem cair em outra fonte", () => {
  const catFalhou = decidirPdmDoItem({ ...BASE_PDM, codigoCatmat: 150001, catalogoFalhou: true, pdmsTexto: [777] });
  assertEquals(catFalhou.codigoPdm, null);
  assertEquals(catFalhou.codigoPdmMotivo, "Consulta do PDM indisponível agora; tente de novo.");
  const textoFalhou = decidirPdmDoItem({ ...BASE_PDM, textoFalhou: true });
  assertEquals(textoFalhou.codigoPdm, null);
  assertEquals(textoFalhou.codigoPdmMotivo, "Consulta do PDM indisponível agora; tente de novo.");
});

// -----------------------------------------------------------------------------
// Ação acompanhamento: os campos chegam em cada item
// -----------------------------------------------------------------------------

type Tabelas = Record<string, Array<Record<string, unknown>> | "erro">;

/** Query builder mínimo: aceita a cadeia usada pelo handler e devolve as linhas da tabela, filtradas por eq/in. */
function mockSupabase(row: Record<string, unknown>, tabelas: Tabelas, chamadas: string[]) {
  return {
    from(tabela: string) {
      const filtros: Array<(r: Record<string, unknown>) => boolean> = [];
      const resultado = () => {
        if (tabela === "licitacoes_externas") return { data: row, error: null };
        const t = tabelas[tabela];
        if (t === "erro" || t === undefined) return { data: null, error: { message: `falha em ${tabela}` } };
        // PostgREST corta em max_rows = 1000.
        return { data: t.filter((r) => filtros.every((f) => f(r))).slice(0, 1000), error: null };
      };
      const q: Record<string, unknown> = {
        select: (cols: string) => {
          chamadas.push(`${tabela}:${cols}`);
          return q;
        },
        eq: (c: string, v: unknown) => {
          filtros.push((r) => String(r[c]) === String(v));
          return q;
        },
        in: (c: string, vs: unknown[]) => {
          chamadas.push(`${tabela}.in(${c}):${vs.join(",")}`);
          filtros.push((r) => vs.map(String).includes(String(r[c])));
          return q;
        },
        not: () => q,
        order: () => q,
        range: () => q,
        limit: () => q,
        maybeSingle: () => Promise.resolve(resultado()),
        then: (ok: (v: unknown) => unknown, nok?: (e: unknown) => unknown) => Promise.resolve(resultado()).then(ok, nok),
      };
      return q;
    },
  };
}

const ROW = { id: 200, fonte: "pncp", codigo_externo: "45138070000149-1-000560/2026", numero_edital: "90011/2026" };

const ITENS_PNCP = [
  // 1: CATMAT oficial (catálogo 1, material) com PDM na base
  { numeroItem: 1, descricao: "Esteira", unidadeMedida: "Unidade", valorUnitarioEstimado: 9000, materialOuServico: "M", catalogo: { id: 1, nome: "Catálogo" }, catalogoCodigoItem: "150001" },
  // 2: sem código, um PDM pelo texto
  { numeroItem: 2, descricao: "Anilha", unidadeMedida: "PAR", valorUnitarioEstimado: 80, materialOuServico: "M" },
  // 3: sem código, dois PDMs pelo texto
  { numeroItem: 3, descricao: "Kit halteres e anilhas", unidadeMedida: "KIT", valorUnitarioEstimado: 300, materialOuServico: "M" },
  // 4: serviço
  { numeroItem: 4, descricao: "Manutenção de esteira", unidadeMedida: "SERVIÇO", valorUnitarioEstimado: 500, materialOuServico: "S" },
  // 5: nada
  { numeroItem: 5, descricao: "Cadeira", unidadeMedida: "UN", valorUnitarioEstimado: 120, materialOuServico: "M" },
];

function fetchPncp(itens: unknown[]) {
  return (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/itens?pagina=1")) {
      return Promise.resolve(new Response(JSON.stringify(itens), { status: 200, headers: { "Content-Type": "application/json" } }));
    }
    return Promise.resolve(new Response("", { status: 204 }));
  };
}

function httpClient() {
  return new UnifiedHttpClient({
    hostLease: { acquireSlot: () => Promise.resolve({ allowed: true, wait_ms: 0 }), reportRateLimit: () => Promise.resolve() },
  });
}

Deno.test("CA-8: acompanhamento devolve codigoPdm, origem, motivo e unidadeSigla por item", async () => {
  clearAcompanhamentoCache();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetchPncp(ITENS_PNCP) as typeof fetch;
  const chamadas: string[] = [];
  try {
    const client = mockSupabase(ROW, {
      catmat_itens: [{ codigo_item: 150001, codigo_pdm: "4321" }],
      licitacao_itens: [
        { id: 11, licitacao_id: 200, numero_item: 1 },
        { id: 12, licitacao_id: 200, numero_item: 2 },
        { id: 13, licitacao_id: 200, numero_item: 3 },
        { id: 14, licitacao_id: 200, numero_item: 4 },
        { id: 15, licitacao_id: 200, numero_item: 5 },
      ],
      licitacao_match: [
        { licitacao_id: 200, item_id: 11, codigo_pdm: 999, origem: "texto_item" },
        { licitacao_id: 200, item_id: 12, codigo_pdm: 777, origem: "texto_item" },
        { licitacao_id: 200, item_id: 13, codigo_pdm: 5, origem: "texto_item" },
        { licitacao_id: 200, item_id: 13, codigo_pdm: 7, origem: "texto_item" },
        { licitacao_id: 200, item_id: 14, codigo_pdm: 777, origem: "texto_item" },
        // casamento pelo objeto (sem item) não conta para o item
        { licitacao_id: 200, item_id: null, codigo_pdm: 888, origem: "texto_objeto" },
      ],
    }, chamadas);
    // deno-lint-ignore no-explicit-any
    const res = await handleAcompanhamento({ action: "acompanhamento", id: 200 }, { getClient: () => client as any, httpClient: httpClient() });
    assertEquals(res.status, 200);
    const body = await res.json();
    const porNumero = (n: number) => body.itens.dados.find((it: { numeroItem: number }) => it.numeroItem === n);

    assertEquals(porNumero(1).codigoPdm, 4321);
    assertEquals(porNumero(1).codigoPdmOrigem, "catalogo_pncp");
    assertEquals(porNumero(1).unidade, "Unidade");
    assertEquals(porNumero(1).unidadeSigla, "UN");
    assertEquals(porNumero(1).unidadeSiglaOrigem, "normalizada_da_unidade_pncp");

    assertEquals(porNumero(2).codigoPdm, 777);
    assertEquals(porNumero(2).codigoPdmOrigem, "casamento_texto");
    assertEquals(porNumero(2).unidadeSigla, "PAR");

    assertEquals(porNumero(3).codigoPdm, null);
    assertEquals(porNumero(3).codigoPdmMotivo, "Mais de um PDM casou pelo texto do item (5, 7): sem PDM único para comparar.");
    assertEquals(porNumero(3).unidadeSigla, null);
    assertEquals(porNumero(3).unidadeSiglaOrigem, null);

    assertEquals(porNumero(4).codigoPdm, null);
    assertEquals(porNumero(4).codigoPdmMotivo, "Item de serviço: a Pesquisa de Preço do PDM é de material.");

    assertEquals(porNumero(5).codigoPdm, null);
    assertEquals(porNumero(5).codigoPdmMotivo, "Item sem PDM: sem código CATMAT no PNCP e sem casamento pelo texto.");
    assertEquals(porNumero(5).unidadeSigla, "UN");

    // Só o código CATMAT oficial vai ao catmat_itens; só itens sem código oficial (e não serviço) vão ao texto.
    assertEquals(chamadas.filter((c) => c.startsWith("catmat_itens.in")), ["catmat_itens.in(codigo_item):150001"]);
    assertEquals(chamadas.filter((c) => c.startsWith("licitacao_itens.in")), ["licitacao_itens.in(numero_item):2,3,5"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("CA-8: falha do banco no PDM não derruba o acompanhamento; o item diz que está indisponível", async () => {
  clearAcompanhamentoCache();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetchPncp(ITENS_PNCP) as typeof fetch;
  try {
    const client = mockSupabase(ROW, { catmat_itens: "erro", licitacao_itens: "erro", licitacao_match: "erro" }, []);
    // deno-lint-ignore no-explicit-any
    const res = await handleAcompanhamento({ action: "acompanhamento", id: 200 }, { getClient: () => client as any, httpClient: httpClient() });
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.itens.dados.length, 5);
    for (const n of [1, 2, 3, 5]) {
      const it = body.itens.dados.find((i: { numeroItem: number }) => i.numeroItem === n);
      assertEquals(it.codigoPdm, null, `item ${n}`);
      assertEquals(it.codigoPdmMotivo, "Consulta do PDM indisponível agora; tente de novo.", `item ${n}`);
    }
    // A unidade não depende do banco.
    assertEquals(body.itens.dados.find((i: { numeroItem: number }) => i.numeroItem === 1).unidadeSigla, "UN");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("CA-8: a segunda leitura (cache do PNCP) também traz o PDM", async () => {
  clearAcompanhamentoCache();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetchPncp(ITENS_PNCP) as typeof fetch;
  try {
    const tabelas: Tabelas = {
      catmat_itens: [{ codigo_item: 150001, codigo_pdm: "4321" }],
      licitacao_itens: [],
      licitacao_match: [],
    };
    const client = mockSupabase(ROW, tabelas, []);
    // deno-lint-ignore no-explicit-any
    await handleAcompanhamento({ action: "acompanhamento", id: 200 }, { getClient: () => client as any, httpClient: httpClient() });
    // deno-lint-ignore no-explicit-any
    const res = await handleAcompanhamento({ action: "acompanhamento", id: 200 }, { getClient: () => client as any, httpClient: httpClient() });
    const body = await res.json();
    assertEquals(body.itens.dados.find((i: { numeroItem: number }) => i.numeroItem === 1).codigoPdm, 4321);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("CA-8: lista cortada pelo PostgREST (1000 linhas) vira indisponível, nunca PDM único falso", async () => {
  clearAcompanhamentoCache();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetchPncp([ITENS_PNCP[1]]) as typeof fetch;
  try {
    // Item 2 casa com os PDMs 777 e 778, mas 1000 linhas repetidas do 777 vêm antes: o lote volta cheio e o 778 some.
    const ruido = Array.from({ length: 1000 }, (_, i) => ({ licitacao_id: 200, item_id: 12, codigo_pdm: 777, origem: "texto_item", i }));
    const client = mockSupabase(ROW, {
      catmat_itens: [],
      licitacao_itens: [{ id: 12, licitacao_id: 200, numero_item: 2 }],
      licitacao_match: [...ruido, { licitacao_id: 200, item_id: 12, codigo_pdm: 778, origem: "texto_item" }],
    }, []);
    // deno-lint-ignore no-explicit-any
    const res = await handleAcompanhamento({ action: "acompanhamento", id: 200 }, { getClient: () => client as any, httpClient: httpClient() });
    const body = await res.json();
    const it = body.itens.dados[0];
    assertEquals(it.codigoPdm, null);
    assertEquals(it.codigoPdmMotivo, "Consulta do PDM indisponível agora; tente de novo.");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("CA-8: item do PNCP ainda não carregado em licitacao_itens não é dado como sem casamento", async () => {
  clearAcompanhamentoCache();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetchPncp([ITENS_PNCP[4]]) as typeof fetch;
  try {
    const client = mockSupabase(ROW, { catmat_itens: [], licitacao_itens: [], licitacao_match: [] }, []);
    // deno-lint-ignore no-explicit-any
    const res = await handleAcompanhamento({ action: "acompanhamento", id: 200 }, { getClient: () => client as any, httpClient: httpClient() });
    const body = await res.json();
    assertEquals(body.itens.dados[0].codigoPdmMotivo, "Item ainda não carregado na base: o casamento pelo texto não foi avaliado.");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
