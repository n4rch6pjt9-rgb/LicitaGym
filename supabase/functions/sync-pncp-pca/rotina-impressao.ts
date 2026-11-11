import { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { jsonResponse } from "../_shared/http.ts";
import { acquireSyncLock } from "../_shared/pncp/lock.ts";
import { finishSyncRun } from "../_shared/pncp/supabase-admin.ts";
import { type ConsultaPca, descobrirPlanos } from "../_shared/pncp/pca-fila.ts";
import { executarImpressao, type ImpressaoStats, type IntegracaoImpressao } from "../_shared/pncp/pca-impressao.ts";
import { createRequestBudget } from "../_shared/pncp/retry.ts";

/**
 * Spec 0056. `impressao` (camada 1, diária): lê `consolidado/unidades` dos órgãos com plano gravado no ano e põe na
 * fila só o plano novo ou alterado; cada disparo pega os órgãos que ainda não foram lidos no dia. `descoberta`
 * (camada 0, semanal): usa a consulta /v1/pca/ só para achar CNPJ que ainda não tem impressão e lê a impressão dele.
 * A falha da consulta não afeta a impressão (CA-8). Lock próprio (`pca-impressao:{ano}`): não disputa com a carga.
 */
export const ROTINAS_IMPRESSAO = ["impressao", "descoberta"] as const;

const ORCAMENTO_PADRAO_MS = 100_000;
const ORCAMENTO_MAX_MS = 120_000;
const FOLGA_REQUISICAO_MS = 15_000;
const LIMITE_ORGAOS_PADRAO = 300;

function limitar(v: unknown, padrao: number, min: number, max: number): number {
  const n = Number(v);
  return v == null || v === "" || !Number.isFinite(n) ? padrao : Math.min(Math.max(n, min), max);
}

/** CNPJs que a consulta mostra e que ainda não têm impressão no ano. */
async function orgaosNovos(client: SupabaseClient, ano: number, cnpjs: string[]): Promise<string[]> {
  const conhecidos = new Set<string>();
  for (let i = 0; i < cnpjs.length; i += 100) {
    const { data, error } = await client.schema("private").from("pca_impressao_orgao").select("orgao_cnpj")
      .eq("ano", ano).in("orgao_cnpj", cnpjs.slice(i, i + 100));
    if (error) throw error;
    for (const r of (data ?? []) as Record<string, unknown>[]) conhecidos.add(String(r.orgao_cnpj));
  }
  return cnpjs.filter((c) => !conhecidos.has(c));
}

export async function handleRotinaImpressao(params: {
  client: SupabaseClient;
  consulta: ConsultaPca;
  integracao: IntegracaoImpressao;
  body: { rotina?: string; orcamento_ms?: unknown; limite_orgaos?: unknown; [k: string]: unknown };
  ano: number;
  classes: string[];
  tamanhoPagina?: number;
  isAsync: boolean;
}): Promise<Response> {
  const { client, consulta, integracao, body, ano, classes } = params;
  const rotina = body.rotina;
  if (rotina !== "impressao" && rotina !== "descoberta") {
    return jsonResponse({ error: `rotina inválida: use ${ROTINAS_IMPRESSAO.join(", ")}` }, 400);
  }
  const orcamentoMs = limitar(body.orcamento_ms, ORCAMENTO_PADRAO_MS, 10_000, ORCAMENTO_MAX_MS);
  const limiteOrgaos = limitar(body.limite_orgaos, LIMITE_ORGAOS_PADRAO, 1, 2000);
  const { runId, alreadyRunning } = await acquireSyncLock(client, `pca-impressao:${ano}`, "pca", { ...body, ano });
  if (alreadyRunning) return jsonResponse({ status: "already_running", sync_id: runId });

  const inicio = Date.now();
  const prazoEsgotado = () => Date.now() - inicio > orcamentoMs;
  const budget = createRequestBudget(orcamentoMs + FOLGA_REQUISICAO_MS, inicio);

  const executar = async (): Promise<Response> => {
    const resumo: Record<string, unknown> = { rotina, ano };
    try {
      let orgaos: string[] | undefined;
      if (rotina === "descoberta") {
        const desc = await descobrirPlanos(consulta, {
          ano,
          classes,
          tamanhoPagina: params.tamanhoPagina ?? 50,
          prazoEsgotado: () => Date.now() - inicio > orcamentoMs / 2,
          http: { budget, syncRunId: runId },
        });
        const cnpjs = [...new Set([...desc.planos.values()].map((p) => p.orgao_cnpj))];
        orgaos = await orgaosNovos(client, ano, cnpjs);
        resumo.descoberta = { completo: desc.completo, erro: desc.erro, cnpjs: cnpjs.length, novos: orgaos.length };
      }
      const s: ImpressaoStats = await executarImpressao(client, integracao, {
        ano,
        classes,
        limiteOrgaos,
        prazoEsgotado,
        runId,
        orgaos,
        http: { budget },
      });
      resumo.impressao = s;
      const status = s.pausa || s.restantes > 0
        ? "incompleta"
        : s.orgaos_erro > 0
        ? "concluida_com_erros"
        : "concluida";
      await finishSyncRun(client, runId, {
        status,
        totalRecebidos: s.planos_lidos,
        totalNovos: s.enfileirados,
        totalErros: s.orgaos_erro,
        erroPrincipal: s.pausa ?? undefined,
        parametros: { ...body, ano, resumo },
      });
      return jsonResponse({ status, sync_id: runId, ...resumo });
    } catch (error) {
      const mensagem = error instanceof Error ? error.message : String(error);
      await finishSyncRun(client, runId, {
        status: "falhou",
        erroPrincipal: mensagem.slice(0, 500),
        parametros: { ...body, ano, resumo },
      }).catch((e) =>
        console.error(JSON.stringify({
          evento: "pca_impressao_finish_falhou",
          runId,
          erro: e instanceof Error ? e.message : String(e),
        }))
      );
      // A mensagem fica só em pncp_sync_run.erro_principal.
      return jsonResponse({ status: "falhou", sync_id: runId, rotina, ano }, 500);
    }
  };

  if (params.isAsync) {
    const edgeRuntime = (globalThis as unknown as { EdgeRuntime?: { waitUntil?: (p: Promise<unknown>) => void } })
      .EdgeRuntime;
    if (typeof edgeRuntime?.waitUntil === "function") {
      edgeRuntime.waitUntil(executar());
      return jsonResponse({ status: "aceito", sync_id: runId, rotina, ano }, 202);
    }
  }
  return await executar();
}
