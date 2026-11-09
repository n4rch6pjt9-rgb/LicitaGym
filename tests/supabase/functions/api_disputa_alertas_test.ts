// Spec 0039, etapa 1b: GET /api-disputa/alertas (K-5c) e POST /api-disputa/alertas/lido (K-5d).
import { assertEquals } from "jsr:@std/assert@1";
import { handleRequest } from "../../../supabase/functions/api-disputa/index.ts";
import type { AuthenticatedUser } from "../../../supabase/functions/_shared/http.ts";

const USUARIO: AuthenticatedUser = { id: "user-uuid-1", email: "operador@konnen.com.br", app_metadata: {} };
const AGORA = Date.parse("2026-10-14T14:00:00Z");

// deno-lint-ignore no-explicit-any
type Linha = Record<string, any>;

function bancoBase(): Record<string, Linha[]> {
  return {
    tenant_membros: [{ tenant_id: 1, user_id: "user-uuid-1", papel: "operacao", ativo: true }],
    tenants: [{ id: 1, ativo: true }, { id: 2, ativo: true }],
    sessao_alertas: [
      { id: 1, tenant_id: 1, licitacao_id: 2430, tipo: "convocacao_anexos", identificador_item: "G1",
        fornecedor_razao_social: "EMPRESA A LTDA", fornecedor_cnpj: "11222333000181", da_empresa: true,
        prazo: "2026-10-14T15:12:00.000Z", mensagem_em: "2026-10-14T13:11:11.306Z", lido_em: null, lido_por: null },
      { id: 2, tenant_id: 1, licitacao_id: 2430, tipo: "etapa_fechada", identificador_item: "G2",
        fornecedor_razao_social: null, fornecedor_cnpj: null, da_empresa: false,
        prazo: "2026-10-14T11:54:46.000Z", mensagem_em: "2026-10-14T11:49:46.054Z", lido_em: null, lido_por: null },
      { id: 3, tenant_id: 1, licitacao_id: 157, tipo: "etapa_fechada", identificador_item: "14",
        fornecedor_razao_social: null, fornecedor_cnpj: null, da_empresa: false,
        prazo: null, mensagem_em: "2026-10-14T10:00:00Z", lido_em: "2026-10-14T10:05:00Z", lido_por: "user-uuid-1" },
      { id: 9, tenant_id: 2, licitacao_id: 999, tipo: "convocacao_anexos", identificador_item: "1",
        fornecedor_razao_social: "OUTRA LTDA", fornecedor_cnpj: "99888777000166", da_empresa: true,
        prazo: "2026-10-14T18:00:00Z", mensagem_em: "2026-10-14T13:59:00Z", lido_em: null, lido_por: null },
    ],
  };
}

/** Mock do PostgREST para tenant e alertas: eq, is, order, limit, update(...).eq().eq().select(). */
function mock(banco: Record<string, Linha[]>) {
  // deno-lint-ignore no-explicit-any
  const m: any = {
    from: (tabela: string) => {
      const filtros: Array<(r: Linha) => boolean> = [];
      let ordem: { col: string; asc: boolean } | null = null;
      let limite: number | null = null;
      let patch: Linha | null = null;
      // deno-lint-ignore no-explicit-any
      const b: any = {
        select: () => b,
        eq: (c: string, v: unknown) => (filtros.push((r) => r[c] === v), b),
        is: (c: string, v: unknown) => (filtros.push((r) => (r[c] ?? null) === v), b),
        order: (c: string, o?: { ascending?: boolean }) => ((ordem = { col: c, asc: o?.ascending ?? true }), b),
        limit: (n: number) => ((limite = n), b),
        update: (p: Linha) => ((patch = p), b),
        then: (resolve: (v: unknown) => void) => {
          let linhas = (banco[tabela] ?? []).filter((r) => filtros.every((f) => f(r)));
          if (patch) for (const r of linhas) Object.assign(r, patch);
          if (ordem) {
            const { col, asc } = ordem;
            linhas = [...linhas].sort((x, y) => (x[col] < y[col] ? -1 : x[col] > y[col] ? 1 : 0) * (asc ? 1 : -1));
          }
          if (limite !== null) linhas = linhas.slice(0, limite);
          resolve({ data: linhas, error: null });
        },
      };
      return b;
    },
  };
  return m;
}

function ctx(banco: Record<string, Linha[]>, user: AuthenticatedUser | null = USUARIO) {
  return { getSupabase: () => mock(banco), getUser: () => Promise.resolve(user), isCron: () => false, agora: () => AGORA };
}

const get = (q = "") => new Request(`https://x/api-disputa/alertas${q}`, { headers: { Authorization: "Bearer t" } });
const lido = (body: unknown) =>
  new Request("https://x/api-disputa/alertas/lido", {
    method: "POST",
    headers: { Authorization: "Bearer t", "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

Deno.test("CA-7d: lista só os alertas do tenant, do mais novo ao mais velho, com vencido", async () => {
  const res = await handleRequest(get(), ctx(bancoBase()));
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.alertas.map((a: Linha) => a.id), [1, 2, 3]);
  const porId = Object.fromEntries(body.alertas.map((a: Linha) => [a.id, a]));
  assertEquals(porId[1].vencido, false); // prazo 15:12 UTC > 14:00
  assertEquals(porId[2].vencido, true); // prazo 11:54 UTC < 14:00
  assertEquals(porId[3].vencido, null); // sem prazo: desconhecido, nunca inventado
  assertEquals(porId[1].fornecedor_razao_social, "EMPRESA A LTDA");
  assertEquals("tenant_id" in porId[1], false);
});

Deno.test("CA-7d: nao_lidos=true filtra os já lidos", async () => {
  const body = await (await handleRequest(get("?nao_lidos=true"), ctx(bancoBase()))).json();
  assertEquals(body.alertas.map((a: Linha) => a.id), [1, 2]);
});

Deno.test("CA-7d: usuário sem vínculo com empresa ativa recebe 403; sem login 401", async () => {
  const banco = bancoBase();
  banco.tenant_membros = [];
  banco.tenants = [{ id: 1, ativo: true }, { id: 2, ativo: true }];
  assertEquals((await handleRequest(get(), ctx(banco))).status, 403);
  assertEquals((await handleRequest(get(), ctx(bancoBase(), null))).status, 401);
});

Deno.test("CA-7e: marcar alerta de outro tenant dá 404 e não muda nada", async () => {
  const banco = bancoBase();
  const res = await handleRequest(lido({ id: 9 }), ctx(banco));
  assertEquals(res.status, 404);
  assertEquals(banco.sessao_alertas.find((a) => a.id === 9)!.lido_em, null);
});

Deno.test("CA-7e: marcar o próprio grava lido_em e lido_por; id inválido 400", async () => {
  const banco = bancoBase();
  const res = await handleRequest(lido({ id: 1 }), ctx(banco));
  assertEquals(res.status, 200);
  const a = banco.sessao_alertas.find((x) => x.id === 1)!;
  assertEquals(a.lido_em, new Date(AGORA).toISOString());
  assertEquals(a.lido_por, "user-uuid-1");
  assertEquals((await handleRequest(lido({ id: "1; drop" }), ctx(bancoBase()))).status, 400);
  assertEquals((await handleRequest(lido({}), ctx(bancoBase()))).status, 400);
});
