import { assertEquals } from "jsr:@std/assert@1";
import { handleRequest } from "../../../supabase/functions/api-disputa/index.ts";
import { situacaoColeta } from "../../../supabase/functions/api-disputa/sessoes.ts";
import type { AuthenticatedUser } from "../../../supabase/functions/_shared/http.ts";

const USUARIO: AuthenticatedUser = { id: "user-uuid-1", email: "operador@konnen.com.br", app_metadata: {} };
const AGORA = Date.parse("2026-11-09T14:00:00Z");
const H = 3600_000;
const iso = (ms: number) => new Date(ms).toISOString();

// deno-lint-ignore no-explicit-any
type Linha = Record<string, any>;

interface Banco {
  [tabela: string]: Linha[];
}

/** Mock mínimo do PostgREST: eq, in, order, limit, maybeSingle e count exato com head. */
function mockSupabase(banco: Banco, falhar?: string) {
  // deno-lint-ignore no-explicit-any
  const mock: any = {
    schema: (nome: string) => ({ from: (t: string) => mock.from(`${nome}.${t}`) }),
    from: (tabela: string) => {
      const filtros: Array<(r: Linha) => boolean> = [];
      let ordem: { col: string; asc: boolean } | null = null;
      let limite: number | null = null;
      let maybe = false;
      let contar = false;
      // deno-lint-ignore no-explicit-any
      const b: any = {
        select: (_c?: string, opts?: { count?: string; head?: boolean }) => {
          contar = opts?.count === "exact" && opts?.head === true;
          return b;
        },
        eq: (c: string, v: unknown) => (filtros.push((r) => r[c] === v), b),
        in: (c: string, vs: unknown[]) => (filtros.push((r) => vs.includes(r[c])), b),
        order: (c: string, o?: { ascending?: boolean }) => ((ordem = { col: c, asc: o?.ascending ?? true }), b),
        limit: (n: number) => ((limite = n), b),
        maybeSingle: () => ((maybe = true), b),
        then: (resolve: (v: unknown) => void) => {
          if (falhar === tabela) return resolve({ data: null, error: new Error(`falha em ${tabela}`) });
          let linhas = (banco[tabela] ?? []).filter((r) => filtros.every((f) => f(r)));
          if (ordem) {
            const { col, asc } = ordem;
            linhas = [...linhas].sort((x, y) => (x[col] < y[col] ? -1 : x[col] > y[col] ? 1 : 0) * (asc ? 1 : -1));
          }
          if (limite !== null) linhas = linhas.slice(0, limite);
          if (contar) return resolve({ data: null, count: linhas.length, error: null });
          if (maybe) return resolve({ data: linhas[0] ?? null, error: null });
          resolve({ data: linhas, error: null });
        },
      };
      return b;
    },
  };
  return mock;
}

function bancoBase(): Banco {
  return {
    tenant_membros: [{ tenant_id: 1, user_id: "user-uuid-1", papel: "operacao", ativo: true }],
    tenants: [{ id: 1, ativo: true }, { id: 2, ativo: true }],
    pipeline_etapas: [
      { id: 10, tenant_id: 1, nome: "Disputa", desfecho: null },
      { id: 11, tenant_id: 1, nome: "Perdida", desfecho: "perdida" },
      { id: 20, tenant_id: 2, nome: "Disputa", desfecho: null },
    ],
    pipeline_oportunidades: [
      { tenant_id: 1, licitacao_id: 1, etapa_id: 10 }, // em coleta, já consultada
      { tenant_id: 1, licitacao_id: 2, etapa_id: 10 }, // sessão daqui a 2 dias
      { tenant_id: 1, licitacao_id: 3, etapa_id: 10 }, // sem chave oficial
      { tenant_id: 1, licitacao_id: 4, etapa_id: 11 }, // etapa perdida
      { tenant_id: 2, licitacao_id: 5, etapa_id: 20 }, // outra empresa
    ],
    licitacoes_externas: [
      { id: 1, objeto: "Esteiras", orgao_nome: "UFX", uf: "SP", data_fim: iso(AGORA - 3 * H), data_homologacao: null, codigo_externo: "15300005000012026", raw: {} },
      { id: 2, objeto: "Bicicletas", orgao_nome: "UFY", uf: "RJ", data_fim: iso(AGORA + 48 * H), data_homologacao: null, codigo_externo: "15300005000022026", raw: {} },
      { id: 3, objeto: "Halteres", orgao_nome: "Prefeitura", uf: "MG", data_fim: iso(AGORA - H), data_homologacao: null, codigo_externo: "PCP-123", raw: {} },
      { id: 4, objeto: "Piso", orgao_nome: "UFZ", uf: "PR", data_fim: iso(AGORA - 5 * H), data_homologacao: null, codigo_externo: "15300005000042026", raw: {} },
      { id: 5, objeto: "Outra empresa", orgao_nome: "UFW", uf: "BA", data_fim: iso(AGORA - H), data_homologacao: null, codigo_externo: "15300005000052026", raw: {} },
    ],
    "private.integra_compras_run": [
      { chave_compra: "15300005000012026", iniciado_em: iso(AGORA - 2 * H), terminado_em: iso(AGORA - 2 * H + 3000), erro: null },
      { chave_compra: "15300005000012026", iniciado_em: iso(AGORA - H), terminado_em: iso(AGORA - H + 2000), erro: "HTTP 502" },
    ],
    sessao_mensagens: [
      { id: 1, chave_compra: "15300005000012026", data_hora: "2026-11-09T10:00:00Z" },
      { id: 2, chave_compra: "15300005000012026", data_hora: "2026-11-09T11:30:00Z" },
      { id: 3, chave_compra: "15300005000052026", data_hora: "2026-11-09T11:00:00Z" },
    ],
  };
}

async function chamar(banco: Banco, falhar?: string, user: AuthenticatedUser | null = USUARIO) {
  const req = new Request("http://localhost/api-disputa/sessoes", { method: "GET" });
  return await handleRequest(req, {
    getUser: () => Promise.resolve(user),
    isCron: () => false,
    // deno-lint-ignore no-explicit-any
    getSupabase: () => mockSupabase(banco, falhar) as any,
    agora: () => AGORA,
  });
}

Deno.test("sessoes: 401 sem usuário", async () => {
  const res = await chamar(bancoBase(), undefined, null);
  assertEquals(res.status, 401);
});

Deno.test("sessoes: lista só o pipeline da empresa, com situação, contagem e última consulta", async () => {
  const res = await chamar(bancoBase());
  assertEquals(res.status, 200);
  const json = await res.json();
  assertEquals(json.fonte, "integra_compras");
  // deno-lint-ignore no-explicit-any
  const porId = new Map(json.sessoes.map((s: any) => [s.licitacao_id, s]));
  // deno-lint-ignore no-explicit-any
  assertEquals(json.sessoes.map((s: any) => s.licitacao_id), [1, 2, 3, 4]); // em_coleta, aguardando, sem_chave, perdida

  // deno-lint-ignore no-explicit-any
  const s1: any = porId.get(1);
  assertEquals(s1.situacao, "em_coleta");
  assertEquals(s1.chave_compra, "15300005000012026");
  assertEquals(s1.total_mensagens, 2);
  assertEquals(s1.ultima_mensagem_em, "2026-11-09T11:30:00Z");
  assertEquals(s1.ultima_consulta, { iniciado_em: iso(AGORA - H), terminado_em: iso(AGORA - H + 2000), com_erro: true });
  assertEquals(s1.etapa, { nome: "Disputa", desfecho: null });

  // deno-lint-ignore no-explicit-any
  const s2: any = porId.get(2);
  assertEquals(s2.situacao, "aguardando");
  assertEquals(s2.entra_na_coleta_em, iso(AGORA + 46 * H));
  assertEquals(s2.ultima_consulta, null);
  assertEquals(s2.total_mensagens, 0);

  // deno-lint-ignore no-explicit-any
  const s3: any = porId.get(3);
  assertEquals(s3.situacao, "sem_chave");
  assertEquals(s3.chave_compra, null);
  assertEquals(s3.total_mensagens, null);

  // deno-lint-ignore no-explicit-any
  assertEquals((porId.get(4) as any).situacao, "encerrada_no_pipeline");
});

Deno.test("sessoes: pipeline vazio devolve lista vazia, não erro", async () => {
  const banco = bancoBase();
  banco.pipeline_oportunidades = [];
  const res = await chamar(banco);
  assertEquals(res.status, 200);
  assertEquals((await res.json()).sessoes, []);
});

Deno.test("sessoes: erro de banco vira 500, nunca lista vazia", async () => {
  const res = await chamar(bancoBase(), "sessao_mensagens");
  assertEquals(res.status, 500);
});

Deno.test("situacaoColeta: mesma janela de private.sessao_chat_alvos", () => {
  const base = { chave: "15300005000012026", data_homologacao: null, desfecho: null };
  assertEquals(situacaoColeta({ ...base, data_fim: iso(AGORA + 2 * H) }, AGORA), "em_coleta");
  assertEquals(situacaoColeta({ ...base, data_fim: iso(AGORA + 2 * H + 1000) }, AGORA), "aguardando");
  assertEquals(situacaoColeta({ ...base, data_fim: iso(AGORA - 30 * 24 * H) }, AGORA), "em_coleta");
  assertEquals(situacaoColeta({ ...base, data_fim: iso(AGORA - 30 * 24 * H - 1000) }, AGORA), "fora_da_janela");
  assertEquals(situacaoColeta({ ...base, data_fim: null }, AGORA), "sem_data");
  assertEquals(situacaoColeta({ ...base, data_fim: iso(AGORA), data_homologacao: iso(AGORA) }, AGORA), "homologada");
  assertEquals(situacaoColeta({ ...base, data_fim: iso(AGORA), desfecho: "descartada" }, AGORA), "encerrada_no_pipeline");
  assertEquals(situacaoColeta({ ...base, data_fim: iso(AGORA), desfecho: "vencida" }, AGORA), "em_coleta");
});
