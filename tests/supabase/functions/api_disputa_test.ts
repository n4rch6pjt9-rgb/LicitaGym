import { assertEquals } from "jsr:@std/assert@1";
import { handleRequest } from "../../../supabase/functions/api-disputa/index.ts";
import type { AuthenticatedUser } from "../../../supabase/functions/_shared/http.ts";
import type { MensagemSerpro } from "../../../supabase/functions/_shared/serpro.ts";

const USUARIO_TESTE: AuthenticatedUser = {
  id: "user-uuid-1",
  email: "operador@konnen.com.br",
  app_metadata: {},
};

interface MockDatabase {
  pipeline: Array<{ tenant_id: number; licitacao_id: number }>;
  itens: Array<{
    id: number;
    licitacao_id: number;
    numero_item: number;
    descricao: string;
    valor_unitario_estimado: number | null;
    valor_total_estimado: number | null;
  }>;
  dePara: Array<{
    id?: number;
    tenant_id: number;
    licitacao_item_id: number;
    produto_id: number;
    status: string;
  }>;
  precos: Array<{
    tenant_id: number;
    produto_id: number;
    preco_tabela: number;
    desconto_max_pct: number;
    vigencia_inicio: string;
    vigencia_fim: string | null;
  }>;
  mensagens: Array<Record<string, unknown>>;
  auditoria: Array<Record<string, unknown>>;
  licitacoesExternas?: Array<{ id: number; codigo_externo?: string; raw?: Record<string, unknown> }>;
  failUpsert?: boolean;
}

function createMockSupabase(db: MockDatabase) {
  // deno-lint-ignore no-explicit-any
  return {
    from: (table: string) => {
      const filters: Array<(row: any) => boolean> = [];
      let sortField: string | null = null;
      let sortAsc = true;
      let isSingle = false;
      let isMaybeSingle = false;

      // deno-lint-ignore no-explicit-any
      const builder: any = {
        select: (_fields?: string) => builder,
        eq: (col: string, val: any) => {
          filters.push((row) => row[col] === val);
          return builder;
        },
        in: (col: string, vals: any[]) => {
          filters.push((row) => vals.includes(row[col]));
          return builder;
        },
        lte: (col: string, val: any) => {
          filters.push((row) => row[col] <= val);
          return builder;
        },
        order: (col: string, opts?: { ascending?: boolean }) => {
          sortField = col;
          sortAsc = opts?.ascending ?? true;
          return builder;
        },
        limit: (_n: number) => builder,
        single: () => {
          isSingle = true;
          return builder;
        },
        maybeSingle: () => {
          isMaybeSingle = true;
          return builder;
        },
        insert: (row: any) => {
          if (table === "disputa_lances_auditoria") {
            const id = db.auditoria.length + 1;
            const saved = { id, ...row };
            db.auditoria.push(saved);
            return {
              select: () => ({
                single: () => Promise.resolve({ data: { id }, error: null }),
              }),
            };
          }
          return Promise.resolve({ data: row, error: null });
        },
        upsert: (row: any) => {
          if (db.failUpsert) {
            return Promise.resolve({ data: null, error: new Error("Erro de banco ao inserir mensagem") });
          }
          if (table === "disputa_mensagens") {
            db.mensagens.push(row);
            return Promise.resolve({ data: row, error: null });
          }
          return Promise.resolve({ data: row, error: null });
        },
        then: (resolve: (val: any) => void) => {
          let rows: any[] = [];
          if (table === "tenant_membros") {
            rows = [{ tenant_id: 1, user_id: "user-uuid-1", papel: "operacao", ativo: true }];
          } else if (table === "tenants") {
            rows = [{ id: 1, ativo: true }];
          } else if (table === "pipeline_oportunidades") {
            rows = [...db.pipeline];
          } else if (table === "licitacao_itens") {
            rows = [...db.itens];
          } else if (table === "catalogo_de_para") {
            rows = [...db.dePara];
          } else if (table === "catalogo_precos") {
            rows = [...db.precos];
          } else if (table === "disputa_mensagens") {
            rows = [...db.mensagens];
          } else if (table === "disputa_lances_auditoria") {
            rows = [...db.auditoria];
          } else if (table === "licitacoes_externas") {
            rows = db.licitacoesExternas ?? [
              { id: 100, codigo_externo: "15300005000012026", raw: {} },
              { id: 101, codigo_externo: "15300005000012026", raw: {} },
            ];
          }

          const res = rows.filter((r) => filters.every((f) => f(r)));
          if (sortField) {
            res.sort((a, b) => {
              if (a[sortField!] < b[sortField!]) return sortAsc ? -1 : 1;
              if (a[sortField!] > b[sortField!]) return sortAsc ? 1 : -1;
              return 0;
            });
          }

          if (isSingle) {
            resolve({ data: res[0] ?? null, error: res[0] ? null : new Error("Row not found") });
          } else if (isMaybeSingle) {
            resolve({ data: res[0] ?? null, error: null });
          } else {
            resolve({ data: res, error: null });
          }
        },
      };
      return builder;
    },
  };
}

Deno.test("api-disputa: 401 para requisição sem autenticação", async () => {
  const req = new Request("http://localhost/api-disputa/estrategia?licitacao_id=101", {
    method: "GET",
  });
  const res = await handleRequest(req, {
    getUser: () => Promise.resolve(null),
  });
  assertEquals(res.status, 401);
});

Deno.test("api-disputa: GET /estrategia - 404 se licitação não está no pipeline do tenant", async () => {
  const db: MockDatabase = {
    pipeline: [], // Vazio! Licitação não está no pipeline
    itens: [],
    dePara: [],
    precos: [],
    mensagens: [],
    auditoria: [],
  };

  const req = new Request("http://localhost/api-disputa/estrategia?licitacao_id=999", {
    method: "GET",
  });
  const res = await handleRequest(req, {
    getUser: () => Promise.resolve(USUARIO_TESTE),
    // deno-lint-ignore no-explicit-any
    getSupabase: () => createMockSupabase(db) as any,
  });

  assertEquals(res.status, 404);
  const json = await res.json();
  assertEquals(json.erro, "Oportunidade não encontrada no pipeline do tenant.");
});

Deno.test("api-disputa: GET /estrategia - cálculo determinístico com catálogo e zero alucinação", async () => {
  const db: MockDatabase = {
    pipeline: [{ tenant_id: 1, licitacao_id: 101 }],
    itens: [
      {
        id: 1,
        licitacao_id: 101,
        numero_item: 1,
        descricao: "Esteira Ergométrica Profissional",
        valor_unitario_estimado: 25000.0,
        valor_total_estimado: 25000.0,
      },
      {
        id: 2,
        licitacao_id: 101,
        numero_item: 2,
        descricao: "Bicicleta Ergométrica Eletromagnética",
        valor_unitario_estimado: 15000.0,
        valor_total_estimado: 15000.0,
      },
    ],
    dePara: [
      {
        id: 1,
        tenant_id: 1,
        licitacao_item_id: 1,
        produto_id: 50,
        status: "confirmado",
      },
      // Item 2 NÃO tem mapeamento no de-para
    ],
    precos: [
      {
        tenant_id: 1,
        produto_id: 50,
        preco_tabela: 20000.0, // R$ 20.000,00
        desconto_max_pct: 15.0, // 15% desc -> Piso = R$ 17.000,00 (1.700.000 centavos)
        vigencia_inicio: "2026-01-01",
        vigencia_fim: null,
      },
    ],
    mensagens: [],
    auditoria: [],
  };

  const req = new Request("http://localhost/api-disputa/estrategia?licitacao_id=101", {
    method: "GET",
  });
  const res = await handleRequest(req, {
    getUser: () => Promise.resolve(USUARIO_TESTE),
    // deno-lint-ignore no-explicit-any
    getSupabase: () => createMockSupabase(db) as any,
  });

  assertEquals(res.status, 200);
  const json = await res.json();

  assertEquals(json.licitacao_id, 101);
  assertEquals(json.tenant_id, 1);

  // Item 1: Configurado e mapeado -> R$ 17.000,00 (1700000 centavos)
  assertEquals(json.itens[0].item_numero, 1);
  assertEquals(json.itens[0].piso_centavos, 1700000);
  assertEquals(json.itens[0].habilitado, true);

  // Item 2: Sem mapeamento -> NUNCA presumir 70% nem fabricar dado!
  assertEquals(json.itens[1].item_numero, 2);
  assertEquals(json.itens[1].piso_centavos, null);
  assertEquals(json.itens[1].habilitado, false);

  // Top level: reflete item 1
  assertEquals(json.piso_centavos, 1700000);
  assertEquals(json.habilitado, true);
});

Deno.test("api-disputa: POST /auditoria - grava log de lance supervisionado", async () => {
  const db: MockDatabase = {
    pipeline: [{ tenant_id: 1, licitacao_id: 101 }],
    itens: [],
    dePara: [],
    precos: [],
    mensagens: [],
    auditoria: [],
  };

  const req = new Request("http://localhost/api-disputa/auditoria", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      licitacaoId: 101,
      item_numero: 1,
      valor: 18500.0,
      piso: 17000.0,
      melhorOferta: 18550.0,
      modo_disputa: "aberto",
      tipo: "LANCE_AUTOMATICO",
    }),
  });

  const res = await handleRequest(req, {
    getUser: () => Promise.resolve(USUARIO_TESTE),
    // deno-lint-ignore no-explicit-any
    getSupabase: () => createMockSupabase(db) as any,
  });

  assertEquals(res.status, 200);
  const json = await res.json();
  assertEquals(json.ok, true);
  assertEquals(json.id, 1);
  assertEquals(db.auditoria.length, 1);
  assertEquals(db.auditoria[0].valor_lance_centavos, 1850000);
});

Deno.test("api-disputa: POST /sync-chat - 404 se licitação não está no pipeline", async () => {
  const db: MockDatabase = {
    pipeline: [],
    itens: [],
    dePara: [],
    precos: [],
    mensagens: [],
    auditoria: [],
  };

  const req = new Request("http://localhost/api-disputa/sync-chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      licitacao_id: 999,
      chave_compra: "15300005000012026",
    }),
  });

  const res = await handleRequest(req, {
    getUser: () => Promise.resolve(USUARIO_TESTE),
    // deno-lint-ignore no-explicit-any
    getSupabase: () => createMockSupabase(db) as any,
  });

  assertEquals(res.status, 404);
  const json = await res.json();
  assertEquals(json.erro, "Oportunidade não encontrada no pipeline do tenant.");
});

Deno.test("api-disputa: POST /sync-chat - consome Serpro e sincroniza com idempotência", async () => {
  const db: MockDatabase = {
    pipeline: [{ tenant_id: 1, licitacao_id: 101 }],
    itens: [],
    dePara: [],
    precos: [],
    mensagens: [],
    auditoria: [],
  };

  const mockMensagens: MensagemSerpro[] = [
    {
      id: 1,
      item: 1,
      categoria: "CHAT",
      remetente: "Pregoeiro",
      texto: "Iniciada fase de lances para o item 1.",
      dataHora: 1792900000000,
    },
  ];

  const mockDiligencias: MensagemSerpro[] = [
    {
      id: 2,
      item: 1,
      categoria: "DILIGENCIA",
      remetente: "Pregoeiro",
      texto: "Convocado para envio de proposta ajustada.",
      dataHora: 1792900050000,
    },
  ];

  const req = new Request("http://localhost/api-disputa/sync-chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      licitacao_id: 101,
      chave_compra: "15300005000012026",
    }),
  });

  const res = await handleRequest(req, {
    getUser: () => Promise.resolve(USUARIO_TESTE),
    // deno-lint-ignore no-explicit-any
    getSupabase: () => createMockSupabase(db) as any,
    consultarChat: () => Promise.resolve(mockMensagens),
    consultarDiligencias: () => Promise.resolve(mockDiligencias),
  });

  assertEquals(res.status, 200);
  const json = await res.json();
  assertEquals(json.ok, true);
  assertEquals(json.total_lidas, 2);
  assertEquals(json.novas_inseridas, 2);
  assertEquals(db.mensagens.length, 2);
});

Deno.test("api-disputa: POST /sync-chat - não mascara erro se upsert falhar e retorna 500 higienizado", async () => {
  const db: MockDatabase = {
    pipeline: [{ tenant_id: 1, licitacao_id: 101 }],
    itens: [],
    dePara: [],
    precos: [],
    mensagens: [],
    auditoria: [],
    failUpsert: true, // Simula falha de banco no upsert
  };

  const mockMensagens: MensagemSerpro[] = [
    {
      id: 1,
      categoria: "CHAT",
      remetente: "Pregoeiro",
      texto: "Mensagem qualquer",
      dataHora: 1792900000000,
    },
  ];

  const req = new Request("http://localhost/api-disputa/sync-chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      licitacao_id: 101,
      chave_compra: "15300005000012026",
    }),
  });

  const res = await handleRequest(req, {
    getUser: () => Promise.resolve(USUARIO_TESTE),
    // deno-lint-ignore no-explicit-any
    getSupabase: () => createMockSupabase(db) as any,
    consultarChat: () => Promise.resolve(mockMensagens),
    consultarDiligencias: () => Promise.resolve([]),
  });

  // Deve retornar 500 com mensagem genérica mascarada (sem vazar detalhes internos)
  assertEquals(res.status, 500);
  const json = await res.json();
  assertEquals(json.erro, "Erro interno no servidor.");
});

Deno.test("api-disputa: POST /sync-chat - rejeita proxy se chave_compra divergir da oficial", async () => {
  const db: MockDatabase = {
    pipeline: [{ tenant_id: 1, licitacao_id: 101 }],
    itens: [],
    dePara: [],
    precos: [],
    mensagens: [],
    auditoria: [],
    licitacoesExternas: [
      { id: 101, codigo_externo: "15300005000012026", raw: {} },
    ],
  };

  const req = new Request("http://localhost/api-disputa/sync-chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      licitacao_id: 101,
      chave_compra: "CHAVE_INVASORA_ARBITRARIA",
    }),
  });

  const res = await handleRequest(req, {
    getUser: () => Promise.resolve(USUARIO_TESTE),
    // deno-lint-ignore no-explicit-any
    getSupabase: () => createMockSupabase(db) as any,
  });

  assertEquals(res.status, 400);
  const json = await res.json();
  assertEquals(json.erro, "Chave de compra não corresponde ao registro oficial da licitação.");
});

Deno.test("api-disputa: POST /sync-chat - autentica via cron secret e sincroniza com sucesso", async () => {
  const db: MockDatabase = {
    pipeline: [{ tenant_id: 1, licitacao_id: 101 }],
    itens: [],
    dePara: [],
    precos: [],
    mensagens: [],
    auditoria: [],
    licitacoesExternas: [
      { id: 101, codigo_externo: "15300005000012026", raw: {} },
    ],
  };

  const mockMensagens: MensagemSerpro[] = [
    {
      id: 99,
      item: 1,
      categoria: "AVISO",
      remetente: "Sistema",
      texto: "Aviso de cron automático",
      dataHora: 1792900000000,
    },
  ];

  const req = new Request("http://localhost/api-disputa/sync-chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      licitacao_id: 101,
    }),
  });

  const res = await handleRequest(req, {
    isCron: () => true,
    // deno-lint-ignore no-explicit-any
    getSupabase: () => createMockSupabase(db) as any,
    consultarChat: () => Promise.resolve(mockMensagens),
    consultarDiligencias: () => Promise.resolve([]),
  });

  assertEquals(res.status, 200);
  const json = await res.json();
  assertEquals(json.ok, true);
  assertEquals(json.novas_inseridas, 1);
  assertEquals(db.mensagens.length, 1);
});

Deno.test("api-disputa: GET /estrategia - seleção determinística do menor id de catalogo_de_para compatível com api-agentes", async () => {
  const db: MockDatabase = {
    pipeline: [{ tenant_id: 1, licitacao_id: 101 }],
    itens: [
      {
        id: 1,
        licitacao_id: 101,
        numero_item: 1,
        descricao: "Esteira Ergométrica",
        valor_unitario_estimado: 25000.0,
        valor_total_estimado: 25000.0,
      },
    ],
    // Dois registros confirmados para o mesmo item: id 10 (produto 50) e id 20 (produto 60)
    dePara: [
      {
        id: 20,
        tenant_id: 1,
        licitacao_item_id: 1,
        produto_id: 60,
        status: "confirmado",
      },
      {
        id: 10,
        tenant_id: 1,
        licitacao_item_id: 1,
        produto_id: 50,
        status: "confirmado",
      },
    ],
    precos: [
      {
        tenant_id: 1,
        produto_id: 50,
        preco_tabela: 20000.0,
        desconto_max_pct: 10.0, // Piso = 18.000,00 (1.800.000 centavos)
        vigencia_inicio: "2026-01-01",
        vigencia_fim: null,
      },
      {
        tenant_id: 1,
        produto_id: 60,
        preco_tabela: 15000.0,
        desconto_max_pct: 20.0, // Piso = 12.000,00 (1.200.000 centavos)
        vigencia_inicio: "2026-01-01",
        vigencia_fim: null,
      },
    ],
    mensagens: [],
    auditoria: [],
  };

  const req = new Request("http://localhost/api-disputa/estrategia?licitacao_id=101", {
    method: "GET",
  });
  const res = await handleRequest(req, {
    getUser: () => Promise.resolve(USUARIO_TESTE),
    // deno-lint-ignore no-explicit-any
    getSupabase: () => createMockSupabase(db) as any,
  });

  assertEquals(res.status, 200);
  const json = await res.json();
  // Deve selecionar deterministicamente o produto 50 (menor id de de-para: 10), nunca o produto 60 (id 20)
  const item1 = json.itens.find((i: { item_numero: number }) => i.item_numero === 1);
  assertEquals(item1.piso_centavos, 1800000);
});
