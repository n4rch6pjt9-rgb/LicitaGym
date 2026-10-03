import { assertEquals } from "jsr:@std/assert@1";
import { contaComoVenda, handleRequest } from "../../../supabase/functions/api-fornecedores-homologados/index.ts";
import { requireUserAuth } from "../../../supabase/functions/_shared/http.ts";
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";

// Dados fictícios (repo público): CNPJ de exemplo e razão social inventada.
const CNPJ_TESTE = "11222333000181";

// deno-lint-ignore no-explicit-any
function createMockDb(queryHandler: (table: string) => any): SupabaseClient {
  return {
    from: (table: string) => queryHandler(table),
  } as unknown as SupabaseClient;
}

function post(body: string, headers: Record<string, string> = {}): Request {
  return new Request("http://localhost", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body,
  });
}

/** Usa o requireUserAuth real (que anexa req.user); só o validador do JWT é trocado por um fake. */
const autenticado = (req: Request) => requireUserAuth(req, () => Promise.resolve({ id: "user-teste" }));

Deno.test("api-fornecedores-homologados: sem JWT retorna 401 (requireUserAuth real, sem injeção)", async () => {
  const res = await handleRequest(post(JSON.stringify({ action: "historico", cnpj: CNPJ_TESTE })), {
    getDb: () => {
      throw new Error("não deveria acessar o banco sem autenticação");
    },
  });
  assertEquals(res.status, 401);
  assertEquals((await res.json()).error, "Unauthorized");
});

Deno.test("api-fornecedores-homologados: Authorization malformado retorna 401 (requireUserAuth real)", async () => {
  const res = await handleRequest(post(JSON.stringify({ action: "historico" }), { Authorization: "Basic abc" }));
  assertEquals(res.status, 401);
});

Deno.test("api-fornecedores-homologados: autentica antes de ler o corpo (JSON inválido sem JWT → 401, não 400)", async () => {
  const req = post("{");
  const res = await handleRequest(req);
  assertEquals(res.status, 401);
  assertEquals(req.bodyUsed, false);
});

Deno.test("api-fornecedores-homologados: JSON inválido com sessão válida → 400", async () => {
  const res = await handleRequest(post("{"), { requireAuth: autenticado });
  assertEquals(res.status, 400);
  assertEquals((await res.json()).error, "Corpo JSON inválido");
});

Deno.test("api-fornecedores-homologados: usa req.user anexado pelo requireUserAuth", async () => {
  let usuarioVisto: string | undefined;
  const res = await handleRequest(post(JSON.stringify({ action: "historico", cnpj: "123" })), {
    requireAuth: async (req) => {
      const negado = await autenticado(req);
      usuarioVisto = (req as Request & { user?: { id: string } }).user?.id;
      return negado;
    },
    getDb: () => createMockDb(() => ({})),
  });
  assertEquals(usuarioVisto, "user-teste");
  assertEquals(res.status, 400); // passou da autenticação e chegou à validação do CNPJ
});

Deno.test("api-fornecedores-homologados: auth que não anexa req.user → 401", async () => {
  const res = await handleRequest(post(JSON.stringify({ action: "historico", cnpj: CNPJ_TESTE })), {
    requireAuth: () => Promise.resolve(null),
    getDb: () => createMockDb(() => ({})),
  });
  assertEquals(res.status, 401);
});

Deno.test("api-fornecedores-homologados: acao historico com CNPJ invalido retorna 400", async () => {
  const res = await handleRequest(post(JSON.stringify({ action: "historico", cnpj: "123" })), {
    requireAuth: autenticado,
    getDb: () => createMockDb(() => ({})),
  });

  assertEquals(res.status, 400);
  const data = await res.json();
  assertEquals(data.error, "CNPJ inválido (deve conter 14 dígitos)");
});

Deno.test("api-fornecedores-homologados: acao historico nao encontrado retorna 404", async () => {
  const mockDb = createMockDb((table) => {
    assertEquals(table, "v_bi_fornecedor_historico");
    return {
      select: () => ({
        eq: () => ({
          maybeSingle: () => Promise.resolve({ data: null, error: null }),
        }),
      }),
    };
  });

  const res = await handleRequest(post(JSON.stringify({ action: "historico", cnpj: CNPJ_TESTE })), {
    requireAuth: autenticado,
    getDb: () => mockDb,
  });

  assertEquals(res.status, 404);
  const data = await res.json();
  assertEquals(data.error, "Fornecedor não encontrado no histórico de compras homologadas");
});

Deno.test("api-fornecedores-homologados: acao historico com sucesso retorna 200 e dados", async () => {
  const fornecedorData = {
    cnpj: CNPJ_TESTE,
    razao_social: "FORNECEDOR FICTICIO DE TESTE LTDA",
    tipo_fornecedor: "revenda",
    tipo_fornecedor_motivo: "cnae_comercio",
    cobertura_predominante: "catmat_oficial",
    valor_homologado_contratacao: 18000.0,
    valor_registrado_ata: null,
  };

  const mockDb = createMockDb((table) => {
    assertEquals(table, "v_bi_fornecedor_historico");
    return {
      select: () => ({
        eq: () => ({
          maybeSingle: () => Promise.resolve({ data: fornecedorData, error: null }),
        }),
      }),
    };
  });

  const res = await handleRequest(post(JSON.stringify({ action: "historico", cnpj: CNPJ_TESTE })), {
    requireAuth: autenticado,
    getDb: () => mockDb,
  });

  assertEquals(res.status, 200);
  const data = await res.json();
  assertEquals(data.data.cnpj, CNPJ_TESTE);
  assertEquals(data.data.razao_social, "FORNECEDOR FICTICIO DE TESTE LTDA");
  assertEquals(data.data.tipo_fornecedor, "revenda");
});

// ---------------------------------------------------------------- só vencedor não cancelado conta como venda

type Chamada = [string, ...unknown[]];

/** Query builder encadeável: registra cada método chamado e resolve com `resultado` (await ou maybeSingle). */
// deno-lint-ignore no-explicit-any
function consulta(resultado: { data: unknown; error: unknown }, chamadas: Chamada[] = []): any {
  // deno-lint-ignore no-explicit-any
  const alvo: any = {};
  return new Proxy(alvo, {
    get(_t, prop) {
      if (prop === "then") return (ok: (v: unknown) => unknown, falha: (e: unknown) => unknown) => Promise.resolve(resultado).then(ok, falha);
      if (prop === "maybeSingle") return () => Promise.resolve(resultado);
      return (...args: unknown[]) => {
        chamadas.push([String(prop), ...args]);
        return consulta(resultado, chamadas);
      };
    },
  });
}

Deno.test("contaComoVenda: vencedor false ou situação Cancelado não contam; NULL conta", () => {
  assertEquals(contaComoVenda({ vencedor: null, situacao: "Informado" }), true);
  assertEquals(contaComoVenda({ vencedor: true, situacao: null }), true);
  assertEquals(contaComoVenda({ vencedor: undefined, situacao: undefined }), true);
  assertEquals(contaComoVenda({ vencedor: false, situacao: "Informado" }), false);
  assertEquals(contaComoVenda({ vencedor: null, situacao: "Cancelado" }), false);
  assertEquals(contaComoVenda({ vencedor: true, situacao: "Cancelado" }), false);
});

Deno.test("api-fornecedores-homologados: get filtra licitacao_resultados por vencedor e situação no banco", async () => {
  const chamadasResultados: Chamada[] = [];
  const mockDb = createMockDb((table) => {
    if (table === "fornecedores_homologados") return consulta({ data: { cnpj: CNPJ_TESTE }, error: null });
    if (table === "fornecedores") return consulta({ data: null, error: null });
    if (table === "homologacoes_itens") return consulta({ data: [], error: null });
    if (table === "licitacao_resultados") {
      return consulta({
        data: [{
          licitacao_id: 7, numero_item: 1, valor_total_homologado: 100, valor_unitario_homologado: 50,
          quantidade_homologada: 2, marca: null, modelo: null, data_resultado: "2026-09-01",
          licitacoes_externas: { id: 7, fonte: "pncp" },
        }],
        error: null,
      }, chamadasResultados);
    }
    throw new Error(`tabela inesperada: ${table}`);
  });

  const res = await handleRequest(post(JSON.stringify({ action: "get", cnpj: CNPJ_TESTE })), {
    requireAuth: autenticado,
    getDb: () => mockDb,
  });

  assertEquals(res.status, 200);
  const nomes = chamadasResultados.map((c) => c[0]);
  assertEquals(chamadasResultados.find((c) => c[0] === "not"), ["not", "vencedor", "is", false]);
  assertEquals(chamadasResultados.find((c) => c[0] === "or"), ["or", "situacao.is.null,situacao.neq.Cancelado"]);
  assertEquals(nomes.indexOf("not") < nomes.indexOf("limit") && nomes.indexOf("or") < nomes.indexOf("limit"), true);
  const body = await res.json();
  assertEquals(body.editais.length, 1);
  assertEquals(body.editais[0].valor_homologado, 100);
});

Deno.test("api-fornecedores-homologados: orgao_get ignora lance perdedor e resultado cancelado", async () => {
  const chamadasLic: Chamada[] = [];
  const A = "11222333000181", B = "44555666000172", C = "77888999000163";
  const mockDb = createMockDb((table) => {
    if (table === "orgaos_compradores") return consulta({ data: { id: "12345678000190", cnpj: "12345678000190" }, error: null });
    if (table === "licitacoes_externas") {
      return consulta({
        data: [
          {
            id: 1, valor_total: 1000,
            licitacao_resultados: [
              { fornecedor_cnpj: A, fornecedor_nome: "A LTDA", valor_total_homologado: 100, vencedor: null, situacao: "Informado" },
              { fornecedor_cnpj: B, fornecedor_nome: "B LTDA", valor_total_homologado: 900, vencedor: false, situacao: "perdida" },
              { fornecedor_cnpj: C, fornecedor_nome: "C LTDA", valor_total_homologado: 500, vencedor: null, situacao: "Cancelado" },
              { fornecedor_cnpj: A, fornecedor_nome: "A LTDA", valor_total_homologado: 20, vencedor: true, situacao: null },
            ],
          },
          {
            id: 2, valor_total: 50,
            licitacao_resultados: [
              { fornecedor_cnpj: C, fornecedor_nome: "C LTDA", valor_total_homologado: 50, vencedor: null, situacao: "Cancelado" },
            ],
          },
        ],
        error: null,
      }, chamadasLic);
    }
    throw new Error(`tabela inesperada: ${table}`);
  });

  const res = await handleRequest(post(JSON.stringify({ action: "orgao_get", id: "12345678000190" })), {
    requireAuth: autenticado,
    getDb: () => mockDb,
  });

  assertEquals(res.status, 200);
  const sel = chamadasLic.find((c) => c[0] === "select")?.[1] as string;
  assertEquals(sel.includes("licitacao_resultados(fornecedor_cnpj,fornecedor_nome,valor_total_homologado,vencedor,situacao)"), true);
  const body = await res.json();
  assertEquals(body.licitacoes.length, 2); // licitação só com resultado cancelado continua listada
  assertEquals(body.licitacoes[0].valor_homologado, 120);
  assertEquals(body.licitacoes[0].vencedores, ["A LTDA"]);
  assertEquals(body.licitacoes[0].licitacao_resultados, undefined);
  assertEquals(body.licitacoes[1].valor_homologado, 0);
  assertEquals(body.licitacoes[1].vencedores, []);
  assertEquals(body.fornecedores, [{ cnpj: A, nome: "A LTDA", valor_homologado: 120, qtd_editais: 1 }]);
});
