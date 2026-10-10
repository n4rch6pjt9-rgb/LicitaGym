import { assertEquals } from "jsr:@std/assert@1";
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { situacaoPortal } from "../../../supabase/functions/_shared/portal-compras.ts";
import { executarSyncPortal } from "../../../supabase/functions/sync-portal-compras/sync.ts";

const FIXTURE = JSON.parse(
  await Deno.readTextFile(new URL("../fixtures/portal_compras_status_objeto.json", import.meta.url)),
);

const LINK =
  "https://www.portaldecompraspublicas.com.br/processos/AC/Secretaria-Municipal-de-Infraestrutura-e-Mobilidade-Urbana-de-Rio-Branco-SEINFRA-5569/RPE-034-2026-2026-499359";

Deno.test("situacaoPortal aceita statusProcesso como objeto (formato real) e mantém número/texto", () => {
  assertEquals(situacaoPortal(FIXTURE), "Recebendo Propostas");
  assertEquals(situacaoPortal({ statusProcesso: { codigo: 7, descricao: "  " } }), "7");
  assertEquals(situacaoPortal({ statusProcesso: { descricao: null } }), null);
  assertEquals(situacaoPortal({ statusProcesso: 13 }), "13");
  assertEquals(situacaoPortal({ statusProcesso: "Suspenso" }), "Suspenso");
  assertEquals(situacaoPortal({ statusProcesso: [] }), null);
});

type Resp = { data?: unknown; error?: { message: string; code: string } | null };

/** Cliente falso: cada tabela devolve a resposta configurada; upserts ficam registrados. */
function clienteFalso(respostas: Record<string, Resp | Resp[]>) {
  const upserts: Array<Record<string, unknown>> = [];
  const contagem: Record<string, number> = {};
  const client = {
    from(tabela: string) {
      const proxima = (): Resp => {
        const r = respostas[tabela];
        if (!Array.isArray(r)) return r ?? { data: [], error: null };
        const i = contagem[tabela] = (contagem[tabela] ?? -1) + 1;
        return r[Math.min(i, r.length - 1)];
      };
      const consulta = {
        select: () => consulta,
        ilike: () => consulta,
        gt: () => consulta,
        limit: () => Promise.resolve(proxima()),
        in: () => Promise.resolve(proxima()),
        upsert: (linha: Record<string, unknown>) => {
          upserts.push(linha);
          return Promise.resolve({ error: respostas[`${tabela}:upsert`] ? (respostas[`${tabela}:upsert`] as Resp).error : null });
        },
      };
      return consulta;
    },
  };
  return { client: client as unknown as SupabaseClient, upserts };
}

function finalizador() {
  const chamadas: Array<Record<string, unknown>> = [];
  const finalizar = (_c: SupabaseClient, runId: string, stats: Record<string, unknown>) => {
    chamadas.push({ runId, ...stats });
    return Promise.resolve();
  };
  return { chamadas, finalizar: finalizar as never };
}

const ABERTA = { id: 5, link_sistema_origem: LINK, data_fim: "2026-10-14T12:00:00Z" };
const AGORA = new Date("2026-10-09T15:00:00Z");

Deno.test("executarSyncPortal fecha a execução como concluida e grava a situação do objeto", async () => {
  const { client, upserts } = clienteFalso({
    pipeline_oportunidades: { data: [], error: null },
    licitacoes_externas: { data: [ABERTA], error: null },
    portal_consulta: { data: [], error: null },
  });
  const { chamadas, finalizar } = finalizador();
  const consultar = () => Promise.resolve({ httpStatus: 200, body: FIXTURE, erro: null });
  const r = await executarSyncPortal(client, "run-1", 40, { consultar, finalizar, agora: AGORA });
  assertEquals(r.status, "ok");
  assertEquals(upserts[0].situacao, "Recebendo Propostas");
  assertEquals(chamadas.length, 1);
  assertEquals(chamadas[0].status, "concluida");
  assertEquals(chamadas[0].totalAtualizados, 1);
});

Deno.test("executarSyncPortal: falha na listagem fecha como falhou", async () => {
  const { client } = clienteFalso({
    pipeline_oportunidades: { data: [], error: null },
    licitacoes_externas: { data: null, error: { message: "timeout", code: "57014" } },
  });
  const { chamadas, finalizar } = finalizador();
  const r = await executarSyncPortal(client, "run-2", 40, { finalizar, agora: AGORA });
  assertEquals(r.status, "erro");
  assertEquals(chamadas.map((c) => c.status), ["falhou"]);
});

Deno.test("executarSyncPortal: erro em leitura de apoio e 429 contam e fecham como concluida_com_erros", async () => {
  const { client } = clienteFalso({
    pipeline_oportunidades: { data: null, error: { message: "x", code: "42501" } },
    licitacoes_externas: { data: [ABERTA], error: null },
    portal_consulta: { data: null, error: { message: "y", code: "42501" } },
  });
  const { chamadas, finalizar } = finalizador();
  const consultar = () => Promise.resolve({ httpStatus: 429, body: null, erro: "429" });
  const r = await executarSyncPortal(client, "run-3", 40, { consultar, finalizar, agora: AGORA });
  assertEquals(r.status, "parcial");
  assertEquals(r.stats.erros, 3);
  assertEquals(r.stats.interrompido, true);
  assertEquals(chamadas.map((c) => c.status), ["concluida_com_erros"]);
});

Deno.test("executarSyncPortal: exceção inesperada fecha como falhou", async () => {
  const client = {
    from() {
      throw new Error("boom");
    },
  } as unknown as SupabaseClient;
  const { chamadas, finalizar } = finalizador();
  const r = await executarSyncPortal(client, "run-4", 40, { finalizar, agora: AGORA });
  assertEquals(r.status, "erro");
  assertEquals(chamadas.map((c) => c.status), ["falhou"]);
});
