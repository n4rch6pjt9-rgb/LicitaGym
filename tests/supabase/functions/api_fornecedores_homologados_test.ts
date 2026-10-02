import { assertEquals } from "jsr:@std/assert@1";
import { handleRequest } from "../../../supabase/functions/api-fornecedores-homologados/index.ts";
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
