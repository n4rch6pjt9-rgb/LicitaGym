// Detalhe da oportunidade com o PNCP fora do ar: Itens e Documentos vêm da cópia gravada pelo coletor, com o erro
// do PNCP mantido, a origem e a data da cópia. Cenário medido em produção em 09/11/2026 (id 125, Credenciamento
// 6/2026 de Pequizeiro-TO): /api/pncp/v1 em 503 para todas as compras, /api/consulta/v1 em 200.
import { assertEquals } from "jsr:@std/assert@1";
import {
  clearAcompanhamentoCache,
  handleAcompanhamento,
} from "../../../supabase/functions/api-dashboard-oportunidades/acompanhamento.ts";
import {
  aplicarCopiaLocal,
  COPIA_LOTE,
  itensDaCopiaLocal,
  RESULTADOS_NAO_CONSULTADOS,
} from "../../../supabase/functions/api-dashboard-oportunidades/copiaLocal.ts";
import { UnifiedHttpClient } from "../../../supabase/functions/_shared/http-client/index.ts";

const ROW_125 = {
  id: 125,
  fonte: "pncp",
  codigo_externo: "31710696000173-1-000003/2026",
  fase: "Recebendo propostas",
  link_sistema_origem: "https://licitanet.com.br/sessao/198679",
};

/**
 * Linha de licitacao_itens como o coletor PNCP grava desde 04/10/2026: colunas estruturadas e raw NULL (o DTO vai
 * para o GCS). LICITANET numera os itens 7932110, 7932111...
 */
function linhaItem(numero_item: number, extra: Record<string, unknown> = {}) {
  return {
    numero_item,
    descricao: `ITEM ${numero_item}`,
    quantidade: "1.0",
    unidade_medida: "UND",
    valor_unitario_estimado: "14.83",
    situacao: "Em andamento",
    tem_resultado: false,
    catalogo_codigo_item: null,
    catalogo_id: null,
    material_ou_servico: "M",
    raw: null,
    updated_at: "2026-10-01T14:56:33.956731+00:00",
    ...extra,
  };
}

type Tabelas = Record<string, Record<string, unknown>[] | "erro">;

/**
 * Cliente Supabase falso: qualquer cadeia de .select/.eq/.order/.range/.in/... resolve para as linhas da tabela
 * (fatiadas pelo .range); tabela sem mock (ou "erro") devolve erro, como o PostgREST.
 */
function mockSupabase(row: Record<string, unknown>, tabelas: Tabelas, leituras: string[] = []) {
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
      leituras.push(`${tabela}:${de}-${ate}`);
      return b;
    };
    b.maybeSingle = () => Promise.resolve(resultado());
    b.single = () => Promise.resolve(resultado());
    b.then = (ok: (v: unknown) => unknown, falha?: (e: unknown) => unknown) => Promise.resolve(resultado()).then(ok, falha);
    return b;
  };
  return { from: (t: string) => builder(t) };
}

function pncpFora(): typeof fetch {
  return (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/api/consulta/v1/")) {
      return Promise.resolve(new Response(JSON.stringify({ situacaoCompraNome: "Divulgada no PNCP" }), { status: 200 }));
    }
    return Promise.resolve(new Response("<html><body><h1>503 Service Unavailable</h1></body></html>", { status: 503 }));
  };
}

function httpClient() {
  return new UnifiedHttpClient({
    hostLease: {
      acquireSlot: () => Promise.resolve({ allowed: true, wait_ms: 0 }),
      reportRateLimit: () => Promise.resolve(),
    },
  });
}

async function chamar(tabelas: Tabelas) {
  clearAcompanhamentoCache();
  const original = globalThis.fetch;
  globalThis.fetch = pncpFora();
  try {
    const res = await handleAcompanhamento(
      { action: "acompanhamento", id: 125 },
      // deno-lint-ignore no-explicit-any
      { getClient: () => mockSupabase(ROW_125, tabelas) as any, httpClient: httpClient() },
    );
    return { res, body: await res.json() };
  } finally {
    globalThis.fetch = original;
    clearAcompanhamentoCache();
  }
}

Deno.test("cópia local: PNCP em 503 mostra os itens gravados (colunas, raw NULL), com erro do PNCP e origem", async () => {
  const { res, body } = await chamar({
    licitacao_itens: [
      linhaItem(7932110),
      // raw congelado com dado velho: vale a coluna, que o coletor atualiza a cada coleta
      linhaItem(7932111, {
        tem_resultado: true,
        catalogo_codigo_item: "150012",
        catalogo_id: 1,
        raw: { numeroItem: 7932111, temResultado: false, valorUnitarioEstimado: 1 },
      }),
    ],
    licitacao_documentos: [],
  });
  assertEquals(res.status, 200);
  // a falha do PNCP continua explícita
  assertEquals(body.itens.erro, "HTTP 503 on pncp.gov.br");
  assertEquals(body.itens.origem, "copia_local");
  // licitacao_itens não guarda quando a linha foi atualizada: data desconhecida, não o default do insert
  assertEquals(body.itens.copia_gravada_em, null);
  assertEquals(body.itens.total, 2);
  assertEquals(body.itens.dados.map((i: { numeroItem: number }) => i.numeroItem), [7932110, 7932111]);
  assertEquals(body.itens.dados[0].unidade, "UND");
  assertEquals(body.itens.dados[0].valorUnitarioEstimado, 14.83);
  assertEquals(body.itens.dados[0].quantidade, 1);
  assertEquals(body.itens.dados[0].materialOuServico, "M");
  assertEquals(body.itens.dados[0].situacaoExibida, "Recebendo Propostas");
  assertEquals(body.itens.dados[1].temResultado, true);
  assertEquals(body.itens.dados[1].valorUnitarioEstimado, 14.83);
  assertEquals(body.itens.dados[1].catalogoCodigoItem, "150012");
  assertEquals(body.itens.dados[1].catalogoId, 1);
  assertEquals(body.itens.dados[1].catalogoNome, null);
  // resultado não consultado não vira "sem vencedor"
  assertEquals(body.itens.dados[1].resultados, []);
  assertEquals(body.itens.dados[1].resultadosErro, RESULTADOS_NAO_CONSULTADOS);
  // sem cópia de documentos: a seção continua só com o erro
  assertEquals(typeof body.arquivos.erro, "string");
  assertEquals(body.arquivos.origem, undefined);
  // histórico não tem cópia local
  assertEquals(typeof body.historico.erro, "string");
  assertEquals(body.historico.origem, undefined);
  // resposta com cópia não é cacheada no navegador: o "Tentar novamente" volta ao PNCP
  assertEquals(res.headers.get("Cache-Control"), "no-store");
});

Deno.test("cópia local: documentos do PNCP gravados aparecem; os de portal e os removidos ficam de fora", async () => {
  const { body } = await chamar({
    licitacao_itens: [],
    licitacao_documentos: [
      {
        id: 1,
        secao: "processo",
        nome_original: "198679_editais_1787310691.zip",
        arquivo_origem: "pncp-1",
        data_documento: "2026-08-21T19:04:22+00:00",
        raw: { url: "https://pncp.gov.br/pncp-api/v1/orgaos/31710696000173/compras/2026/3/arquivos/1", tipo_documento: "Termo de Referência" },
        removido_do_portal_em: null,
        last_seen_at: "2026-11-08T16:13:56.918782+00:00",
      },
      { id: 2, secao: "processo", nome_original: "removido.pdf", arquivo_origem: "pncp-2", raw: {}, removido_do_portal_em: "2026-10-05T00:00:00Z", last_seen_at: "2026-11-09T00:00:00Z" },
      { id: 3, secao: "processo", nome_original: "do-portal.pdf", arquivo_origem: "paradigma", raw: {}, removido_do_portal_em: null, last_seen_at: "2026-11-09T00:00:00Z" },
      // outro coletor com nome "pncp-N" em outra seção não vira documento do PNCP
      { id: 4, secao: "proposta", nome_original: "anexo.pdf", arquivo_origem: "pncp-3", raw: {}, removido_do_portal_em: null, last_seen_at: "2026-11-09T00:00:00Z" },
    ],
  });
  assertEquals(typeof body.arquivos.erro, "string");
  assertEquals(body.arquivos.origem, "copia_local");
  assertEquals(body.arquivos.copia_gravada_em, "2026-11-08T16:13:56.918782+00:00");
  assertEquals(body.arquivos.total, 1);
  assertEquals(body.arquivos.dados[0].titulo, "198679_editais_1787310691.zip");
  assertEquals(body.arquivos.dados[0].tipo, "Termo de Referência");
  assertEquals(body.arquivos.dados[0].sequencialDocumento, 1);
  assertEquals(body.arquivos.dados[0].url, "https://pncp.gov.br/pncp-api/v1/orgaos/31710696000173/compras/2026/3/arquivos/1");
  // sem itens gravados: Itens continua só com o erro (vazio nunca vira "nenhum item")
  assertEquals(body.itens.erro, "HTTP 503 on pncp.gov.br");
  assertEquals(body.itens.origem, undefined);
  assertEquals(body.itens.dados, []);
});

Deno.test("cópia local: falha ao ler a cópia mantém a seção com o erro do PNCP", async () => {
  const { res, body } = await chamar({ licitacao_itens: "erro", licitacao_documentos: "erro" });
  assertEquals(res.status, 200);
  assertEquals(body.itens.erro, "HTTP 503 on pncp.gov.br");
  assertEquals(body.itens.origem, undefined);
  assertEquals(body.itens.total, 0);
  assertEquals(body.arquivos.origem, undefined);
});

Deno.test("cópia local: linha de item sem numero_item válido descarta a cópia (lista cortada não parece completa)", async () => {
  const { body } = await chamar({
    licitacao_itens: [linhaItem(1), linhaItem(2, { numero_item: null })],
    licitacao_documentos: [],
  });
  assertEquals(body.itens.erro, "HTTP 503 on pncp.gov.br");
  assertEquals(body.itens.origem, undefined);
  assertEquals(body.itens.dados, []);
});

Deno.test("aplicarCopiaLocal: seção do PNCP sem erro nunca é trocada pela cópia", () => {
  const secao = { dados: [], total: 0, erro: null };
  const copia = { dados: [1, 2], gravadoEm: "2026-10-01T00:00:00Z" };
  assertEquals(aplicarCopiaLocal(secao, copia), secao);
  const comDados = { dados: [9], total: 1, erro: "HTTP 503 on pncp.gov.br" };
  assertEquals(aplicarCopiaLocal(comDados, copia), comDados);
});

Deno.test("itensDaCopiaLocal: lê em lotes até o lote incompleto (mais de um lote de itens)", async () => {
  const linhas = Array.from({ length: COPIA_LOTE + 3 }, (_, i) => ({
  ...linhaItem(i + 1),
  }));
  const leituras: string[] = [];
  // deno-lint-ignore no-explicit-any
  const copia = await itensDaCopiaLocal(mockSupabase(ROW_125, { licitacao_itens: linhas }, leituras) as any, 125);
  assertEquals(copia?.dados.length, COPIA_LOTE + 3);
  assertEquals(leituras, [`licitacao_itens:0-${COPIA_LOTE - 1}`, `licitacao_itens:${COPIA_LOTE}-${2 * COPIA_LOTE - 1}`]);
});
