import { assertEquals } from "jsr:@std/assert@1";
import {
  ACOMPANHAMENTO_LICITACAO_COLUMNS,
  buildAcompanhamentoUrl,
  clearAcompanhamentoCache,
  handleAcompanhamento,
  linkSistemaOrigemFromRaw,
  mapItemAcompanhamento,
  materialOuServicoDoItem,
  resolvePncpKey,
} from "../../../supabase/functions/api-dashboard-oportunidades/acompanhamento.ts";
import {
  parseActionFromBody,
  parseActionFromUrl,
} from "../../../supabase/functions/api-dashboard-oportunidades/validation.ts";
import { handleRequest } from "../../../supabase/functions/api-dashboard-oportunidades/index.ts";
import { UnifiedHttpClient } from "../../../supabase/functions/_shared/http-client/index.ts";

// -----------------------------------------------------------------------------
// Testes unitários para resolvePncpKey
// -----------------------------------------------------------------------------

Deno.test("resolvePncpKey: resolve a partir de numero_controle_pncp estendido", () => {
  const row = {
    id: 1,
    fonte: "pncp",
    codigo_externo: "45138070000149-1-000559/2026",
  };
  const key = resolvePncpKey(row);
  assertEquals(key, {
    cnpj: "45138070000149",
    ano: 2026,
    sequencial: 559,
    numeroControlePncp: "45138070000149-1-000559/2026",
  });
});

Deno.test("resolvePncpKey: resolve a partir de formato legado e id_externo", () => {
  const row = {
    id: 2,
    numero_controle_pncp: "07486108000185-000001/2026",
  };
  const key = resolvePncpKey(row);
  assertEquals(key, {
    cnpj: "07486108000185",
    ano: 2026,
    sequencial: 1,
    numeroControlePncp: "07486108000185-000001/2026",
  });
});

Deno.test("resolvePncpKey: resolve a partir de colunas separadas orgao_cnpj e raw", () => {
  const row = {
    id: 3,
    orgao_cnpj: "45.138.070/0001-49",
    raw: {
      anoCompra: 2026,
      sequencialCompra: 559,
    },
  };
  const key = resolvePncpKey(row);
  assertEquals(key?.cnpj, "45138070000149");
  assertEquals(key?.ano, 2026);
  assertEquals(key?.sequencial, 559);
});

Deno.test("resolvePncpKey: retorna null para linha não-PNCP sem chave PNCP", () => {
  const row1 = {
    id: 4,
    fonte: "sestsenat",
    id_externo: 999,
  };
  assertEquals(resolvePncpKey(row1), null);

  const row2 = {
    id: 5,
    fonte: "custom",
    objeto: "Sem identificador",
  };
  assertEquals(resolvePncpKey(row2), null);
  assertEquals(resolvePncpKey(null), null);
});

// -----------------------------------------------------------------------------
// Testes unitários para buildAcompanhamentoUrl
// -----------------------------------------------------------------------------

Deno.test("buildAcompanhamentoUrl: validação estrita de host e 17 dígitos", () => {
  // Caso de sucesso (Santa Fé do Sul)
  const validLink = "https://cnetmobile.estaleiro.serpro.gov.br/comprasnet-web/public/landing?destino=quadro-informativo&compra=98703305900102026";
  const url = buildAcompanhamentoUrl(validLink);
  assertEquals(
    url,
    "https://cnetmobile.estaleiro.serpro.gov.br/comprasnet-web/public/landing?destino=acompanhamento-compra&compra=98703305900102026",
  );

  // Inseguro (http)
  assertEquals(
    buildAcompanhamentoUrl("http://cnetmobile.estaleiro.serpro.gov.br/comprasnet-web/public/landing?compra=98703305900102026"),
    null,
  );

  // Host diferente / lookalike
  assertEquals(
    buildAcompanhamentoUrl("https://evil.cnetmobile.estaleiro.serpro.gov.br?compra=98703305900102026"),
    null,
  );
  assertEquals(
    buildAcompanhamentoUrl("https://cnetmobile.estaleiro.serpro.gov.br.evil.com?compra=98703305900102026"),
    null,
  );

  // idCompra inválido (menos ou mais de 17 dígitos, ou letras)
  assertEquals(
    buildAcompanhamentoUrl("https://cnetmobile.estaleiro.serpro.gov.br?compra=12345"),
    null,
  );
  assertEquals(
    buildAcompanhamentoUrl("https://cnetmobile.estaleiro.serpro.gov.br?compra=9870330590010202699"),
    null,
  );
  assertEquals(
    buildAcompanhamentoUrl("https://cnetmobile.estaleiro.serpro.gov.br?compra=9870330590010202A"),
    null,
  );
  assertEquals(buildAcompanhamentoUrl(null), null);
  assertEquals(buildAcompanhamentoUrl(""), null);
});

// -----------------------------------------------------------------------------
// Testes de Integração com Mock HTTP do PNCP (Fixtures, Paginação, Falha Parcial)
// -----------------------------------------------------------------------------

function createMockSupabase(row: Record<string, unknown> | null) {
  return {
    from: (_table: string) => ({
      select: (_cols: string) => ({
        eq: (_col: string, _val: unknown) => ({
          maybeSingle: () => Promise.resolve({ data: row, error: null }),
        }),
      }),
    }),
  };
}

Deno.test("acompanhamento: fluxo completo com paginação, resultados, atas, histórico e arquivos", async () => {
  clearAcompanhamentoCache();

  // Test compra: 45138070000149/2026/559 (Santa Fé do Sul, Pregão 90010/2026)
  const mockRow = {
    id: 100,
    fonte: "pncp",
    codigo_externo: "45138070000149-1-000559/2026",
    numero_edital: "90010/2026",
    raw: {
      linkSistemaOrigem: "https://cnetmobile.estaleiro.serpro.gov.br/comprasnet-web/public/landing?destino=quadro-informativo&compra=98703305900102026",
    },
  };

  const originalFetch = globalThis.fetch;
  const requestedUrls: string[] = [];

  globalThis.fetch = (input: RequestInfo | URL, _init?: RequestInit) => {
    const urlStr = String(input);
    requestedUrls.push(urlStr);

    // 1. Compra metadata
    if (urlStr.includes("/api/consulta/v1/orgaos/45138070000149/compras/2026/559")) {
      return Promise.resolve(new Response(JSON.stringify({
        situacaoCompraNome: "Divulgada no PNCP",
        modalidadeNome: "Pregão - Eletrônico",
        objetoCompra: "Registro de preços para materiais esportivos",
        valorTotalEstimado: 250000.0,
        valorTotalHomologado: 210000.0,
        dataPublicacaoPncp: "2026-06-15T07:04:53",
        dataAberturaProposta: "2026-06-25T08:00:00",
        dataEncerramentoProposta: "2026-06-25T09:00:00",
        dataInclusao: "2026-06-15T07:04:53",
        dataAtualizacaoGlobal: "2026-09-18T08:07:28",
        linkSistemaOrigem: "https://cnetmobile.estaleiro.serpro.gov.br/comprasnet-web/public/landing?destino=quadro-informativo&compra=98703305900102026",
      }), { status: 200, headers: { "Content-Type": "application/json" } }));
    }

    // 2. /itens paginação (página 1 tem 50 itens, página 2 tem 27 itens -> total 77 itens)
    if (urlStr.includes("/itens?pagina=1")) {
      const page1 = Array.from({ length: 50 }, (_, i) => ({
        numeroItem: i + 1,
        descricao: `Item ${i + 1}`,
        quantidade: 10,
        unidadeMedida: "UN",
        valorUnitarioEstimado: 100.0,
        situacaoCompraItemNome: "Homologado",
        temResultado: i === 0, // item 1 tem resultado
      }));
      return Promise.resolve(new Response(JSON.stringify(page1), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }));
    }

    if (urlStr.includes("/itens?pagina=2")) {
      const page2 = Array.from({ length: 27 }, (_, i) => ({
        numeroItem: 50 + i + 1,
        descricao: `Item ${50 + i + 1}`,
        quantidade: 5,
        unidadeMedida: "UN",
        valorUnitarioEstimado: 50.0,
        situacaoCompraItemNome: "Homologado",
        temResultado: false,
      }));
      return Promise.resolve(new Response(JSON.stringify(page2), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }));
    }

    if (urlStr.includes("/itens?pagina=3")) {
      return Promise.resolve(new Response("", { status: 204 }));
    }

    // 3. /itens/1/resultados
    if (urlStr.includes("/itens/1/resultados")) {
      return Promise.resolve(new Response(JSON.stringify([
        {
          numeroItem: 1,
          niFornecedor: "27197345000133",
          nomeRazaoSocialFornecedor: "DAIANE CRISTINA MEIRA ZEGOBIA BARBOSA LTDA",
          valorUnitarioHomologado: 5.4,
          quantidadeHomologada: 90.0,
          dataResultado: "2026-09-18",
        },
      ]), { status: 200, headers: { "Content-Type": "application/json" } }));
    }

    // 4. /atas
    if (urlStr.includes("/atas")) {
      return Promise.resolve(new Response(JSON.stringify({
        totalRegistros: 1,
        totalPaginas: 1,
        paginasRestantes: 0,
        data: [
          {
            numeroAtaRegistroPreco: "151/2026",
            anoAta: 2026,
            dataVigenciaInicio: "2026-09-25",
            dataVigenciaFim: "2027-09-24",
            dataAssinatura: "2026-09-25",
            cancelado: false,
          },
        ],
      }), { status: 200, headers: { "Content-Type": "application/json" } }));
    }

    // 5. /historico
    if (urlStr.includes("/historico?pagina=1")) {
      return Promise.resolve(new Response(JSON.stringify([
        {
          logManutencaoDataInclusao: "2026-06-15T07:04:53",
          categoriaLogManutencaoNome: "Contratação",
          tipoLogManutencaoNome: "Inclusão",
          itemNumero: null,
          documentoTitulo: null,
          justificativa: null,
        },
        {
          logManutencaoDataInclusao: "2026-09-18T08:07:28",
          categoriaLogManutencaoNome: "Item de Contratação",
          tipoLogManutencaoNome: "Retificação",
          itemNumero: 1,
          documentoTitulo: null,
          justificativa: "Inclusão do resultado do item 1",
        },
      ]), { status: 200, headers: { "Content-Type": "application/json" } }));
    }

    if (urlStr.includes("/historico?pagina=2")) {
      return Promise.resolve(new Response("", { status: 204 }));
    }

    // 6. /arquivos
    if (urlStr.includes("/arquivos")) {
      return Promise.resolve(new Response(JSON.stringify([
        {
          titulo: "Edital Pregão 90010/2026",
          tipoDocumentoNome: "Edital",
          url: "https://pncp.gov.br/pncp-api/v1/orgaos/45138070000149/compras/2026/559/arquivos/1",
          sequencialDocumento: 1,
        },
      ]), { status: 200, headers: { "Content-Type": "application/json" } }));
    }

    return Promise.resolve(new Response("Not Found", { status: 404 }));
  };

  try {
    const mockSupabase = createMockSupabase(mockRow);
    const httpClient = new UnifiedHttpClient({
      hostLease: {
        acquireSlot: () => Promise.resolve({ allowed: true, wait_ms: 0 }),
        reportRateLimit: () => Promise.resolve(),
      },
    });

    const res = await handleAcompanhamento(
      { action: "acompanhamento", id: 100 },
      {
        getClient: () => mockSupabase as any,
        httpClient,
      },
    );

    assertEquals(res.status, 200);
    assertEquals(res.headers.get("Cache-Control"), "private, max-age=300");

    const body = await res.json();
    assertEquals(body.disponivel, true);
    assertEquals(body.id, 100);
    assertEquals(body.pncp.cnpj, "45138070000149");
    assertEquals(body.pncp.ano, 2026);
    assertEquals(body.pncp.sequencial, 559);

    // url_edital e url_acompanhamento
    assertEquals(
      body.url_edital,
      "https://pncp.gov.br/app/editais/45138070000149/2026/559",
    );
    assertEquals(
      body.url_acompanhamento,
      "https://cnetmobile.estaleiro.serpro.gov.br/comprasnet-web/public/landing?destino=acompanhamento-compra&compra=98703305900102026",
    );

    // Compra metadata
    assertEquals(body.compra.erro, null);
    assertEquals(body.compra.dados.situacao, "Divulgada no PNCP");
    assertEquals(body.compra.dados.modalidade, "Pregão - Eletrônico");
    assertEquals(body.compra.dados.valorEstimado, 250000);

    // Itens (paginação 50 + 27 = 77 itens)
    assertEquals(body.itens.erro, null);
    assertEquals(body.itens.total, 77);
    assertEquals(body.itens.dados.length, 77);

    // Vencedor do Item 1
    const item1 = body.itens.dados.find((it: any) => it.numeroItem === 1);
    assertEquals(Boolean(item1), true);
    assertEquals(item1.temResultado, true);
    assertEquals(item1.resultados.length, 1);
    assertEquals(item1.resultados[0].fornecedorNome, "DAIANE CRISTINA MEIRA ZEGOBIA BARBOSA LTDA");
    assertEquals(item1.resultados[0].fornecedorCnpj, "27197345000133");
    assertEquals(item1.resultados[0].valorUnitarioHomologado, 5.4);

    // Atas
    assertEquals(body.atas.erro, null);
    assertEquals(body.atas.total, 1);
    assertEquals(body.atas.dados[0].numero, "151/2026");

    // Histórico
    assertEquals(body.historico.erro, null);
    assertEquals(body.historico.total, 2);
    assertEquals(body.historico.dados[1].justificativa, "Inclusão do resultado do item 1");

    // Arquivos
    assertEquals(body.arquivos.erro, null);
    assertEquals(body.arquivos.total, 1);
    assertEquals(body.arquivos.dados[0].url, "https://pncp.gov.br/pncp-api/v1/orgaos/45138070000149/compras/2026/559/arquivos/1");

    // Testa cache em memória no segundo acesso
    const resCached = await handleAcompanhamento(
      { action: "acompanhamento", id: 100 },
      {
        getClient: () => mockSupabase as any,
        httpClient,
      },
    );
    assertEquals(resCached.status, 200);
    const bodyCached = await resCached.json();
    assertEquals(bodyCached.id, 100);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("acompanhamento: falha parcial em endpoints secundários não quebra resposta global", async () => {
  clearAcompanhamentoCache();

  const mockRow = {
    id: 105,
    fonte: "pncp",
    codigo_externo: "45138070000149-1-000559/2026",
  };

  const originalFetch = globalThis.fetch;

  globalThis.fetch = (input: RequestInfo | URL) => {
    const urlStr = String(input);
    if (urlStr.includes("/api/consulta/v1/orgaos/")) {
      return Promise.resolve(new Response(JSON.stringify({
        situacaoCompraNome: "Em Andamento",
        objetoCompra: "Objeto teste",
      }), { status: 200, headers: { "Content-Type": "application/json" } }));
    }
    if (urlStr.includes("/itens")) {
      // Falha 500 no endpoint de itens
      return Promise.resolve(new Response("Internal Server Error", { status: 500 }));
    }
    if (urlStr.includes("/atas")) {
      // 404 de atas (comum quando certame não é SRP ou não tem atas)
      return Promise.resolve(new Response("Not Found", { status: 404 }));
    }
    if (urlStr.includes("/historico")) {
      return Promise.resolve(new Response(JSON.stringify([]), { status: 200 }));
    }
    if (urlStr.includes("/arquivos")) {
      return Promise.resolve(new Response("Internal Server Error", { status: 500 }));
    }
    return Promise.resolve(new Response("Not Found", { status: 404 }));
  };

  try {
    const mockSupabase = createMockSupabase(mockRow);
    const httpClient = new UnifiedHttpClient({
      hostLease: {
        acquireSlot: () => Promise.resolve({ allowed: true, wait_ms: 0 }),
        reportRateLimit: () => Promise.resolve(),
      },
    });

    const res = await handleAcompanhamento(
      { action: "acompanhamento", id: 105 },
      {
        getClient: () => mockSupabase as any,
        httpClient,
      },
    );

    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.disponivel, true);
    assertEquals(body.compra.erro, null);
    assertEquals(body.compra.dados.situacao, "Em Andamento");

    // Itens falhou mas retorna erro sem quebrar
    assertEquals(typeof body.itens.erro, "string");
    assertEquals(body.itens.total, 0);

    // Atas 404 é tratado graciosamente como vazio
    assertEquals(body.atas.erro, null);
    assertEquals(body.atas.total, 0);

    // Arquivos falhou
    assertEquals(typeof body.arquivos.erro, "string");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// -----------------------------------------------------------------------------
// Colunas selecionadas, linkSistemaOrigem via raw e não exposição de raw
// -----------------------------------------------------------------------------

Deno.test("acompanhamento: select não inclui linkSistemaOrigem e usa a lista exportada", async () => {
  clearAcompanhamentoCache();
  assertEquals(ACOMPANHAMENTO_LICITACAO_COLUMNS.includes("linkSistemaOrigem"), false);

  let selectedCols: string | null = null;
  const client = {
    from: (_table: string) => ({
      select: (cols: string) => {
        selectedCols = cols;
        return {
          eq: (_col: string, _val: unknown) => ({
            maybeSingle: () => Promise.resolve({ data: { id: 7, fonte: "sestsenat", id_externo: 1 }, error: null }),
          }),
        };
      },
    }),
  };

  const res = await handleAcompanhamento({ action: "acompanhamento", id: "7" }, { getClient: () => client as any });
  assertEquals(res.status, 200);
  assertEquals(selectedCols, ACOMPANHAMENTO_LICITACAO_COLUMNS.join(","));
});

Deno.test("linkSistemaOrigemFromRaw: lê string de raw e ignora formatos inválidos", () => {
  assertEquals(linkSistemaOrigemFromRaw({ linkSistemaOrigem: "https://x.gov.br/a" }), "https://x.gov.br/a");
  assertEquals(linkSistemaOrigemFromRaw({ linkSistemaOrigem: 123 }), null);
  assertEquals(linkSistemaOrigemFromRaw({ linkSistemaOrigem: "  " }), null);
  assertEquals(linkSistemaOrigemFromRaw({}), null);
  assertEquals(linkSistemaOrigemFromRaw(null), null);
  assertEquals(linkSistemaOrigemFromRaw("https://x.gov.br/a"), null);
  assertEquals(linkSistemaOrigemFromRaw(["https://x.gov.br/a"]), null);
});

Deno.test("acompanhamento: url_acompanhamento vem de raw.linkSistemaOrigem quando a compra falha; raw nunca é exposto", async () => {
  clearAcompanhamentoCache();
  const secret = "SEGREDO_DO_RAW_NAO_EXPOR";
  const row = {
    id: 300,
    fonte: "pncp",
    codigo_externo: "45138070000149-1-000559/2026",
    raw: {
      linkSistemaOrigem:
        "https://cnetmobile.estaleiro.serpro.gov.br/comprasnet-web/public/landing?destino=quadro-informativo&compra=98703305900102026",
      campoInterno: secret,
    },
  };

  const originalFetch = globalThis.fetch;
  // PNCP não devolve a compra (404): a URL só pode vir de raw.
  globalThis.fetch = () => Promise.resolve(new Response("Not Found", { status: 404 }));
  try {
    const httpClient = new UnifiedHttpClient({
      hostLease: {
        acquireSlot: () => Promise.resolve({ allowed: true, wait_ms: 0 }),
        reportRateLimit: () => Promise.resolve(),
      },
    });
    const res = await handleAcompanhamento(
      { action: "acompanhamento", id: "300" },
      { getClient: () => createMockSupabase(row) as any, httpClient },
    );
    assertEquals(res.status, 200);
    const text = await res.text();
    assertEquals(text.includes(secret), false);
    const body = JSON.parse(text);
    assertEquals("raw" in body, false);
    assertEquals(body.disponivel, true);
    assertEquals(
      body.url_acompanhamento,
      "https://cnetmobile.estaleiro.serpro.gov.br/comprasnet-web/public/landing?destino=acompanhamento-compra&compra=98703305900102026",
    );
  } finally {
    globalThis.fetch = originalFetch;
    clearAcompanhamentoCache();
  }
});

// -----------------------------------------------------------------------------
// Validação do parâmetro id (/^\d{1,18}$/)
// -----------------------------------------------------------------------------

Deno.test("validation acompanhamento: id válido (1 a 18 dígitos) via URL e body", () => {
  for (const id of ["1", "101", "000123", "123456789012345678"]) {
    const url = new URL(`http://localhost/api-dashboard-oportunidades?action=acompanhamento&id=${id}`);
    assertEquals(parseActionFromUrl(url), { action: "acompanhamento", id });
    assertEquals(parseActionFromBody({ action: "acompanhamento", id }), { action: "acompanhamento", id });
  }
  assertEquals(parseActionFromBody({ action: "acompanhamento", id: 42 }), { action: "acompanhamento", id: "42" });
  const padded = new URL("http://localhost/api-dashboard-oportunidades?action=acompanhamento&id=%2042%20");
  assertEquals(parseActionFromUrl(padded), { action: "acompanhamento", id: "42" });
});

Deno.test("validation acompanhamento: id inválido retorna erro", () => {
  const invalid = [
    "abc",
    "12a",
    "-1",
    "+1",
    "1.5",
    "1e3",
    "0x10",
    "1234567890123456789", // 19 dígitos
    "1 2",
    "１２３", // dígitos full-width
    "1;drop table x",
  ];
  for (const id of invalid) {
    const url = new URL("http://localhost/api-dashboard-oportunidades");
    url.searchParams.set("action", "acompanhamento");
    url.searchParams.set("id", id);
    const fromUrl = parseActionFromUrl(url);
    assertEquals("error" in fromUrl, true, `URL id=${JSON.stringify(id)} deveria falhar`);
    const fromBody = parseActionFromBody({ action: "acompanhamento", id });
    assertEquals("error" in fromBody, true, `body id=${JSON.stringify(id)} deveria falhar`);
  }
  for (const id of [-1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 2, true, {}, ["1"]]) {
    const fromBody = parseActionFromBody({ action: "acompanhamento", id });
    assertEquals("error" in fromBody, true, `body id=${String(id)} deveria falhar`);
  }
});

Deno.test("acompanhamento: id inválido retorna 400 via handleRequest sem consultar o banco", async () => {
  let dbCalled = false;
  const client = {
    from: () => {
      dbCalled = true;
      throw new Error("não deveria consultar");
    },
  };
  for (const id of ["abc", "-5", "1234567890123456789"]) {
    const reqGet = new Request(
      `http://localhost/api-dashboard-oportunidades?action=acompanhamento&id=${encodeURIComponent(id)}`,
    );
    const resGet = await handleRequest(reqGet, { getClient: () => client as any, requireAuth: () => null });
    assertEquals(resGet.status, 400);
    await resGet.body?.cancel();

    const reqPost = new Request("http://localhost/api-dashboard-oportunidades", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "acompanhamento", id }),
    });
    const resPost = await handleRequest(reqPost, { getClient: () => client as any, requireAuth: () => null });
    assertEquals(resPost.status, 400);
    await resPost.body?.cancel();
  }
  assertEquals(dbCalled, false);
});

// -----------------------------------------------------------------------------
// Catálogo do item (aba Itens PNCP, coluna CATMAT do front; 03/10/2026)
// -----------------------------------------------------------------------------

Deno.test("mapItemAcompanhamento: repassa catálogo Compras.gov.br, código e material", () => {
  const item = mapItemAcompanhamento({
    numeroItem: 3,
    descricao: "Esteira ergométrica",
    quantidade: "2",
    unidadeMedida: "UN",
    valorUnitarioEstimado: 15000,
    situacaoCompraItemNome: "Em andamento",
    temResultado: false,
    materialOuServico: "M",
    materialOuServicoNome: "Material",
    catalogo: { id: 1, nome: "Catálogo do Compras.gov.br" },
    catalogoCodigoItem: 480144,
  });
  assertEquals(item.catalogoCodigoItem, "480144");
  assertEquals(item.catalogoId, 1);
  assertEquals(item.catalogoNome, "Catálogo do Compras.gov.br");
  assertEquals(item.materialOuServico, "M");
  assertEquals(item.quantidade, 2);
  assertEquals(item.resultados, []);
});

Deno.test("mapItemAcompanhamento: catálogo Outros passa o código do órgão com catalogoId 2", () => {
  const item = mapItemAcompanhamento({
    numeroItem: 7,
    descricao: "BOLAS DE BASQUETE INFANTIL PLAYOFF MIRIM",
    materialOuServicoNome: "Material",
    catalogo: { id: 2, nome: "Outros" },
    catalogoCodigoItem: "230525",
  });
  assertEquals(item.catalogoCodigoItem, "230525");
  assertEquals(item.catalogoId, 2);
  assertEquals(item.catalogoNome, "Outros");
  assertEquals(item.materialOuServico, "M");
});

Deno.test("mapItemAcompanhamento: sem catálogo (449/2026) não inventa código a partir do numeroItem", () => {
  const item = mapItemAcompanhamento({
    numeroItem: 7932239,
    descricao: "MESA PING PONG",
    materialOuServico: "M",
    catalogo: null,
    catalogoCodigoItem: null,
  });
  assertEquals(item.numeroItem, 7932239);
  assertEquals(item.catalogoCodigoItem, null);
  assertEquals(item.catalogoId, null);
  assertEquals(item.catalogoNome, null);
});

Deno.test("mapItemAcompanhamento: valores inválidos de catálogo viram null", () => {
  const item = mapItemAcompanhamento({
    numeroItem: 1,
    catalogo: { id: true, nome: "  " },
    catalogoCodigoItem: "   ",
    materialOuServico: "X",
  });
  assertEquals(item.catalogoId, null);
  assertEquals(item.catalogoNome, null);
  assertEquals(item.catalogoCodigoItem, null);
  assertEquals(item.materialOuServico, null);
  assertEquals(mapItemAcompanhamento({ numeroItem: 1, catalogo: { id: "abc" } }).catalogoId, null);
});

Deno.test("materialOuServicoDoItem: código vence o nome; nome sem acento e sem caixa", () => {
  assertEquals(materialOuServicoDoItem({ materialOuServico: "S", materialOuServicoNome: "Material" }), "S");
  assertEquals(materialOuServicoDoItem({ materialOuServicoNome: "Serviço" }), "S");
  assertEquals(materialOuServicoDoItem({ materialOuServicoNome: "MATERIAL" }), "M");
  assertEquals(materialOuServicoDoItem({}), null);
});
