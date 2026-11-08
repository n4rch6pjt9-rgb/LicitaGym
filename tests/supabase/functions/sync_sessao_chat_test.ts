// Spec 0039, etapa 1, K-3: coleta agendada do chat da sessão (sync-sessao-chat).
import { assertEquals } from "jsr:@std/assert@1";
import {
  type Alvo,
  handleRequest,
  inicioDoDiaBrasilia,
} from "../../../supabase/functions/sync-sessao-chat/index.ts";
import { sincronizarCompra } from "../../../supabase/functions/_shared/sessao_chat.ts";
import type { ResultadoSincronizacao } from "../../../supabase/functions/_shared/sessao_chat.ts";

Deno.env.set("SYNC_CRON_SECRET", "segredo-de-teste");

const AGORA = new Date("2026-11-10T15:00:00.000Z"); // 12:00 em Brasília

function post(body: unknown = {}, auth: string | null = "Bearer segredo-de-teste") {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (auth !== null) headers.Authorization = auth;
  return new Request("https://x.supabase.co/functions/v1/sync-sessao-chat", {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

interface Db {
  /** Linhas que private.sessao_chat_alvos devolve (o filtro SQL é testado no _check.sql). */
  alvos: Array<Record<string, unknown>>;
  runs: Array<Record<string, unknown>>;
  mensagens?: Array<Record<string, unknown>>;
}

/** Mock mínimo do supabase-js para as consultas desta função. */
function mock(db: Db) {
  db.mensagens ??= [];
  // deno-lint-ignore no-explicit-any
  const m: any = {
    schema: (s: string) => ({
      from: (t: string) => m.from(`${s}.${t}`),
      rpc: (nome: string) =>
        Promise.resolve(
          nome === "sessao_chat_alvos" ? { data: db.alvos, error: null } : { data: null, error: new Error(nome) },
        ),
    }),
    from: (tabela: string) => {
      // deno-lint-ignore no-explicit-any
      const filtros: Array<(r: any) => boolean> = [];
      const fonte = () => tabela === "private.integra_compras_run" ? db.runs : db.mensagens!;
      // deno-lint-ignore no-explicit-any
      const b: any = {
        select: () => b,
        // deno-lint-ignore no-explicit-any
        in: (c: string, v: any[]) => (filtros.push((r) => v.includes(r[c])), b),
        // deno-lint-ignore no-explicit-any
        is: (c: string, v: any) => (filtros.push((r) => (r[c] ?? null) === v), b),
        // deno-lint-ignore no-explicit-any
        gte: (c: string, v: any) => (filtros.push((r) => r[c] >= v), b),
        // deno-lint-ignore no-explicit-any
        then: (ok: any, err: any) =>
          Promise.resolve({ data: fonte().filter((r) => filtros.every((f) => f(r))), error: null }).then(ok, err),
        // deno-lint-ignore no-explicit-any
        insert: (row: any) => {
          const id = db.runs.length + 1;
          db.runs.push({ id, ...row });
          return { select: () => ({ single: () => Promise.resolve({ data: { id }, error: null }) }) };
        },
        // deno-lint-ignore no-explicit-any
        update: (patch: any) => ({
          // deno-lint-ignore no-explicit-any
          eq: (c: string, v: any) => {
            for (const r of db.runs) if (r[c] === v) Object.assign(r, patch);
            return Promise.resolve({ data: null, error: null });
          },
        }),
        // deno-lint-ignore no-explicit-any
        upsert: (rows: any[]) => ({
          select: () => {
            const novas = rows.filter((r) => !db.mensagens!.some((x) => x.chave_mensagem === r.chave_mensagem));
            db.mensagens!.push(...novas);
            return Promise.resolve({ data: novas.map((r) => ({ chave_mensagem: r.chave_mensagem })), error: null });
          },
        }),
      };
      return b;
    },
  };
  return m;
}

function lic(id: number, chave: string | null, dataFim: string | null, extra: Record<string, unknown> = {}) {
  return {
    licitacao_id: id,
    codigo_externo: `pncp-${id}`,
    link_sistema_origem: chave
      ? `https://cnetmobile.estaleiro.serpro.gov.br/comprasnet-web/public/compras/acompanhamento-compra?compra=${chave}`
      : null,
    raw: {},
    data_fim: dataFim,
    ...extra,
  };
}

const OK: ResultadoSincronizacao = {
  ok: true,
  total_lidas: 0,
  novas_inseridas: 0,
  chamadas: { "404": 2 },
  erro: null,
  status_erro: null,
};

function rodar(db: Db, body: unknown = {}, sincronizar?: (a: Alvo) => Promise<ResultadoSincronizacao>) {
  const consultados: Alvo[] = [];
  const p = handleRequest(post(body), {
    getSupabase: () => mock(db),
    agora: () => AGORA,
    sincronizar: (_s, a) => {
      consultados.push(a);
      return sincronizar ? sincronizar(a) : Promise.resolve(OK);
    },
  });
  return p.then(async (res) => ({ res, json: await res.json(), consultados }));
}

Deno.test("sync-sessao-chat: sem o segredo do cron responde 401 e não consulta nada", async () => {
  for (const auth of [null, "Bearer errado"]) {
    let n = 0;
    const res = await handleRequest(post({}, auth), {
      getSupabase: () => mock({ alvos: [], runs: [] }),
      sincronizar: () => (n++, Promise.resolve(OK)),
    });
    assertEquals(res.status, 401);
    assertEquals(n, 0);
  }
});

Deno.test("sync-sessao-chat: GET responde 405; corpo inválido ou limite fora da faixa responde 400", async () => {
  const get = await handleRequest(new Request("https://x/sync-sessao-chat", { method: "GET" }));
  assertEquals(get.status, 405);
  const db = { alvos: [], runs: [] };
  assertEquals((await rodar(db, "não é json")).res.status, 400);
  assertEquals((await rodar(db, { limite: 0 })).res.status, 400);
  assertEquals((await rodar(db, { limite: 1000 })).res.status, 400);
  assertEquals((await rodar(db, { max_chamadas_dia: -1 })).res.status, 400);
});

Deno.test("K-3: só alvos com chave oficial do Compras.gov.br, uma consulta por compra, sessão mais recente primeiro", async () => {
  const db: Db = {
    alvos: [
      lic(1, "18017805000292026", "2026-11-10T12:00:00Z"),
      lic(2, "18016005003122026", "2026-11-10T16:30:00Z"),
      lic(5, null, "2026-11-10T12:00:00Z"), // sem chave do Compras.gov.br
      lic(6, "11111111111112026", "2026-11-09T12:00:00Z"),
      lic(9, "11111111111112026", "2026-11-09T12:00:00Z"), // mesma compra em outra licitação: uma consulta
      lic(10, "22222222222222026", null), // sem data_fim
    ],
    runs: [],
  };
  const { res, json, consultados } = await rodar(db);
  assertEquals(res.status, 200);
  assertEquals(consultados.map((a) => a.licitacaoId), [2, 1, 6]);
  assertEquals(json.alvos, 3);
  assertEquals(json.consultadas, 3);
});

Deno.test("K-3: rodízio, compras além do limite entram na rodada seguinte e quem foi consultado vai para o fim", async () => {
  const db: Db = {
    alvos: [1, 2, 3, 4].map((i) => lic(i, `1801780500029202${i}`.slice(0, 17), `2026-11-10T1${i}:00:00Z`)),
    runs: [],
  };
  // rodada 1: as 2 sessões mais recentes (4 e 3)
  const r1 = await rodar(db, { limite: 2 });
  assertEquals(r1.consultados.map((a) => a.licitacaoId), [4, 3]);
  // registra as consultas como se a rodada tivesse gravado, há 60 min
  for (const a of r1.consultados) {
    db.runs.push({ chave_compra: a.chaveCompra, iniciado_em: "2026-11-10T14:00:00.000Z", terminado_em: "x", chamadas: { "404": 2 } });
  }
  // rodada 2: nunca consultadas primeiro (2 e 1)
  const r2 = await rodar(db, { limite: 2 });
  assertEquals(r2.consultados.map((a) => a.licitacaoId), [2, 1]);
  assertEquals(r2.json.parada, "limite");
});

Deno.test("K-3: compra consultada há menos de 55 min (cron ou usuário) fica para a próxima rodada", async () => {
  const db: Db = {
    alvos: [
      lic(1, "18017805000292026", "2026-11-10T12:00:00Z"),
      lic(2, "18016005003122026", "2026-11-10T12:00:00Z"),
    ],
    runs: [
      { chave_compra: "18017805000292026", iniciado_em: "2026-11-10T14:10:00+00:00", terminado_em: "x", chamadas: { "200": 2 } },
      { chave_compra: "18016005003122026", iniciado_em: "2026-11-10T13:59:00+00:00", terminado_em: "x", chamadas: { "200": 2 } },
    ],
  };
  const { json, consultados } = await rodar(db);
  assertEquals(consultados.map((a) => a.licitacaoId), [2]);
  assertEquals(json.puladas_recentes, 1);
});

Deno.test("K-3: teto diário de chamadas conta o que já foi gasto hoje (Brasília) e para antes de passar", async () => {
  const db: Db = {
    alvos: [
      lic(1, "18017805000292026", "2026-11-10T12:00:00Z"),
      lic(2, "18016005003122026", "2026-11-10T11:00:00Z"),
      lic(3, "18017405000472026", "2026-11-10T10:00:00Z"),
    ],
    runs: [
      // ontem em Brasília (02:59Z = 23:59 de 09/11): não conta
      { chave_compra: "99999999999992026", iniciado_em: "2026-11-10T02:59:00.000Z", terminado_em: "x", chamadas: { "200": 50 } },
      // hoje: 4 chamadas fechadas
      { chave_compra: "99999999999992026", iniciado_em: "2026-11-10T03:01:00.000Z", terminado_em: "x", chamadas: { "200": 2, "404": 2 } },
      // hoje: execução morta por timeout, sem contagem: conta 2 (pior caso)
      { chave_compra: "88888888888882026", iniciado_em: "2026-11-10T09:00:00.000Z", terminado_em: null, chamadas: {} },
    ],
  };
  const { json, consultados } = await rodar(db, { max_chamadas_dia: 10 });
  assertEquals(consultados.length, 2); // 6 + 2 + 2 = 10; a terceira passaria do teto
  assertEquals(json.limite_diario_atingido, true);
  assertEquals(json.chamadas_hoje, 10);
});

Deno.test("K-3: limite de compras por rodada", async () => {
  const db: Db = {
    alvos: [
      lic(1, "18017805000292026", "2026-11-10T12:00:00Z"),
      lic(2, "18016005003122026", "2026-11-10T11:00:00Z"),
      lic(3, "18017405000472026", "2026-11-10T10:00:00Z"),
    ],
    runs: [],
  };
  const { json, consultados } = await rodar(db, { limite: 2 });
  assertEquals(consultados.length, 2);
  assertEquals(json.limite_diario_atingido, false);
});

Deno.test("K-3: falha numa compra não impede as outras e não expõe detalhe interno", async () => {
  const db: Db = {
    alvos: [
      lic(1, "18017805000292026", "2026-11-10T12:00:00Z"),
      lic(2, "18016005003122026", "2026-11-10T11:00:00Z"),
    ],
    runs: [],
  };
  const { res, json } = await rodar(db, {}, (a) =>
    a.licitacaoId === 1
      ? Promise.reject(new Error("permission denied for table sessao_mensagens"))
      : Promise.resolve({ ...OK, ok: false, erro: "Integra Compras respondeu HTTP 502.", chamadas: { "502": 1 } }));
  assertEquals(res.status, 200);
  assertEquals(json.resultados.length, 2);
  assertEquals(json.resultados[0].erro, "falha interna");
  assertEquals(json.resultados[1].erro, "Integra Compras respondeu HTTP 502.");
  assertEquals(JSON.stringify(json).includes("permission denied"), false);
});

Deno.test("K-3 (fim a fim com a fixture oficial): cron grava as mensagens e o registro leva a licitação", async () => {
  const exemplo = JSON.parse(
    await Deno.readTextFile(new URL("../fixtures/integra_compras_chat_exemplo.json", import.meta.url)),
  );
  const db: Db = {
    alvos: [lic(1, "99998803000012026", "2026-11-10T12:00:00Z")],
    runs: [],
  };
  const consultas = {
    consultarChat: () =>
      Promise.resolve({
        status: 200,
        // deno-lint-ignore no-explicit-any
        mensagens: exemplo.map((m: any, i: number) => ({
          tipo: "mensagem" as const,
          chaveMensagem: m.chaveMensagem,
          identificadorItem: m.identificadorItem ?? null,
          texto: m.texto,
          categoria: String(m.categoria),
          tipoRemetente: String(m.tipoRemetente),
          dataHora: `2026-02-05T19:15:0${i}.000Z`,
          dataHoraFonte: m.dataHora,
          chaveCompra: null,
        })),
      }),
    // O cliente real devolve 404 como "sem mensagens", sem erro.
    consultarDiligencias: () => Promise.resolve({ status: 404, mensagens: [] }),
  };
  const res = await handleRequest(post(), {
    getSupabase: () => mock(db),
    agora: () => AGORA,
    sincronizar: (s, a) =>
      sincronizarCompra(s, { chaveCompra: a.chaveCompra, licitacaoId: a.licitacaoId, origem: "cron" }, consultas),
  });
  const json = await res.json();
  assertEquals(json.resultados[0].ok, true);
  assertEquals(json.resultados[0].novas_inseridas, 3);
  assertEquals(db.mensagens!.length, 3);
  assertEquals(db.runs[0].origem, "cron");
  assertEquals(db.runs[0].licitacao_id, 1);
  assertEquals(db.runs[0].chamadas, { "200": 1, "404": 1 });
});

Deno.test("inicioDoDiaBrasilia: meia-noite de Brasília em UTC", () => {
  assertEquals(inicioDoDiaBrasilia(new Date("2026-11-10T15:00:00Z")), "2026-11-10T03:00:00.000Z");
  assertEquals(inicioDoDiaBrasilia(new Date("2026-11-10T02:00:00Z")), "2026-11-09T03:00:00.000Z");
});

Deno.test("K-3: orçamento de tempo, nenhuma compra nova depois de 90 s", async () => {
  const db: Db = {
    alvos: [
      lic(1, "18017805000292026", "2026-11-10T12:00:00Z"),
      lic(2, "18016005003122026", "2026-11-10T11:00:00Z"),
    ],
    runs: [],
  };
  let t = 0;
  const consultados: number[] = [];
  const res = await handleRequest(post(), {
    getSupabase: () => mock(db),
    agora: () => AGORA,
    relogioMs: () => t,
    sincronizar: (_s, a) => {
      consultados.push(a.licitacaoId);
      t += 95_000;
      return Promise.resolve(OK);
    },
  });
  const json = await res.json();
  assertEquals(consultados, [1]);
  assertEquals(json.parada, "tempo");
});
