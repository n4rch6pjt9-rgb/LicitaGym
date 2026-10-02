import { assertEquals } from "jsr:@std/assert@1";
import { handleRequest } from "../../../supabase/functions/api-fornecedores-homologados/index.ts";
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";

function createMockDb(queryHandler: (table: string) => any): SupabaseClient {
  return {
    from: (table: string) => queryHandler(table),
  } as unknown as SupabaseClient;
}

Deno.test("api-fornecedores-homologados: acao historico com CNPJ invalido retorna 400", async () => {
  const req = new Request("http://localhost", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "historico", cnpj: "123" }),
  });

  const res = await handleRequest(req, {
    requireAuth: () => Promise.resolve(null),
    getUserId: () => Promise.resolve("user-1"),
    getDb: () => createMockDb(() => ({})),
  });

  assertEquals(res.status, 400);
  const data = await res.json();
  assertEquals(data.error, "CNPJ inválido (deve conter 14 dígitos)");
});

Deno.test("api-fornecedores-homologados: acao historico nao encontrado retorna 404", async () => {
  const req = new Request("http://localhost", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "historico", cnpj: "04372852000160" }),
  });

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

  const res = await handleRequest(req, {
    requireAuth: () => Promise.resolve(null),
    getUserId: () => Promise.resolve("user-1"),
    getDb: () => mockDb,
  });

  assertEquals(res.status, 404);
  const data = await res.json();
  assertEquals(data.error, "Fornecedor não encontrado no histórico de compras homologadas");
});

Deno.test("api-fornecedores-homologados: acao historico com sucesso retorna 200 e dados", async () => {
  const fornecedorData = {
    cnpj: "04372852000160",
    razao_social: "W.E.V COMERCIAL LTDA",
    tipo_fornecedor: "revenda",
    tipo_fornecedor_motivo: "cnae_comercio",
    cobertura_predominante: "catmat_oficial",
    valor_homologado_contratacao: 18000.0,
    valor_registrado_ata: null,
  };

  const req = new Request("http://localhost", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "historico", cnpj: "04372852000160" }),
  });

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

  const res = await handleRequest(req, {
    requireAuth: () => Promise.resolve(null),
    getUserId: () => Promise.resolve("user-1"),
    getDb: () => mockDb,
  });

  assertEquals(res.status, 200);
  const data = await res.json();
  assertEquals(data.data.cnpj, "04372852000160");
  assertEquals(data.data.razao_social, "W.E.V COMERCIAL LTDA");
  assertEquals(data.data.tipo_fornecedor, "revenda");
});
