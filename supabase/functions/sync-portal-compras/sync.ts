import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { hashPayload } from "../_shared/pncp/hash.ts";
import { finishSyncRun } from "../_shared/pncp/supabase-admin.ts";
import {
  codigoRespostaPortal,
  consultarPortal,
  escolherLotePortal,
  parsePortalProcessoUrl,
  situacaoPortal,
  type CandidatoPortal,
} from "../_shared/portal-compras.ts";

export const LIMITE_LEITURA = 200;

export type StatsPortal = { lidos: number; atualizados: number; erros: number; interrompido: boolean };

export type ResultadoSyncPortal = {
  /** ok = tudo lido; parcial = 429 ou erro em alguma leitura/gravação; erro = a listagem falhou. */
  status: "ok" | "parcial" | "erro";
  stats: StatsPortal;
};

export type DepsSyncPortal = {
  consultar?: typeof consultarPortal;
  finalizar?: typeof finishSyncRun;
  agora?: Date;
};

type ErroSupabase = { message?: string; code?: string } | null | undefined;

/** Log do erro do Supabase sem payload: só código e mensagem. */
function logErro(contexto: string, error: ErroSupabase | unknown): void {
  const e = (error ?? {}) as { message?: unknown; code?: unknown };
  const code = typeof e.code === "string" ? e.code : "?";
  const message = typeof e.message === "string" ? e.message.slice(0, 200) : "falha";
  console.error(`[sync-portal-compras] ${contexto}: ${code} ${message}`);
}

/**
 * Uma execução de sync-portal-compras: lê compras abertas do Portal de Compras Públicas (e as do pipeline),
 * consulta o portal num lote e grava portal_consulta. Fecha a execução (private.pncp_sync_run) em todos os
 * caminhos: concluida (ok), concluida_com_erros (parcial: 429 ou erro de leitura/gravação) e falhou (erro).
 * Erro numa leitura de apoio (pipeline_oportunidades, portal_consulta, extras) conta em `erros`; não é ignorado.
 */
export async function executarSyncPortal(
  client: SupabaseClient,
  runId: string,
  limite: number,
  deps: DepsSyncPortal = {},
): Promise<ResultadoSyncPortal> {
  const consultar = deps.consultar ?? consultarPortal;
  const finalizar = deps.finalizar ?? finishSyncRun;
  const agora = deps.agora ?? new Date();
  const stats: StatsPortal = { lidos: 0, atualizados: 0, erros: 0, interrompido: false };

  const fechar = async (status: string, erroPrincipal?: string) => {
    try {
      await finalizar(client, runId, {
        status,
        totalRecebidos: stats.lidos,
        totalAtualizados: stats.atualizados,
        totalErros: stats.erros,
        erroPrincipal,
        parametros: { limite, interrompido: stats.interrompido },
      });
    } catch (err: unknown) {
      logErro("falha ao fechar a execução", err);
    }
  };

  try {
    const pipeline = await client.from("pipeline_oportunidades").select("licitacao_id").limit(LIMITE_LEITURA);
    const noPipeline = new Set<number>();
    if (pipeline.error) {
      stats.erros += 1;
      logErro("leitura de pipeline_oportunidades", pipeline.error);
    } else if (Array.isArray(pipeline.data)) {
      for (const row of pipeline.data as Array<{ licitacao_id: number }>) noPipeline.add(Number(row.licitacao_id));
    }

    const abertas = await client
      .from("licitacoes_externas")
      .select("id,link_sistema_origem,data_fim")
      .ilike("link_sistema_origem", "%portaldecompraspublicas.com.br/processos/%")
      .gt("data_fim", agora.toISOString())
      .limit(LIMITE_LEITURA);
    if (abertas.error) {
      stats.erros += 1;
      logErro("listagem de licitacoes_externas", abertas.error);
      await fechar("falhou", "Falha ao listar o portal");
      return { status: "erro", stats };
    }

    const porId = new Map<number, { link: string; dataFim: string | null }>();
    for (const row of (abertas.data ?? []) as Array<Record<string, unknown>>) {
      const id = Number(row.id);
      if (!Number.isInteger(id) || typeof row.link_sistema_origem !== "string") continue;
      porId.set(id, { link: row.link_sistema_origem, dataFim: typeof row.data_fim === "string" ? row.data_fim : null });
    }

    const faltam = [...noPipeline].filter((id) => !porId.has(id));
    if (faltam.length > 0) {
      const extras = await client.from("licitacoes_externas").select("id,link_sistema_origem,data_fim").in(
        "id",
        faltam,
      );
      if (extras.error) {
        stats.erros += 1;
        logErro("leitura das compras do pipeline", extras.error);
      } else if (Array.isArray(extras.data)) {
        for (const row of extras.data as Array<Record<string, unknown>>) {
          const id = Number(row.id);
          if (!Number.isInteger(id) || typeof row.link_sistema_origem !== "string") continue;
          if (!parsePortalProcessoUrl(row.link_sistema_origem)) continue;
          porId.set(id, {
            link: row.link_sistema_origem,
            dataFim: typeof row.data_fim === "string" ? row.data_fim : null,
          });
        }
      }
    }

    const consultado = new Map<number, string | null>();
    if (porId.size > 0) {
      const consultas = await client.from("portal_consulta").select("licitacao_id,consultado_em").in("licitacao_id", [
        ...porId.keys(),
      ]);
      if (consultas.error) {
        stats.erros += 1;
        logErro("leitura de portal_consulta", consultas.error);
      } else if (Array.isArray(consultas.data)) {
        for (const row of consultas.data as Array<Record<string, unknown>>) {
          consultado.set(
            Number(row.licitacao_id),
            typeof row.consultado_em === "string" ? row.consultado_em : null,
          );
        }
      }
    }

    const candidatos: CandidatoPortal[] = [...porId.entries()].map(([id, linha]) => ({
      id,
      link: linha.link,
      dataFim: linha.dataFim,
      emPipeline: noPipeline.has(id),
      consultadoEm: consultado.get(id) ?? null,
    }));
    const lote = escolherLotePortal(candidatos, agora, limite);
    const idPorPagina = new Map<string, number>();
    for (const [id, linha] of porId) {
      const processo = parsePortalProcessoUrl(linha.link);
      if (processo) idPorPagina.set(processo.pagina, id);
    }

    for (const processo of lote) {
      const licitacaoId = idPorPagina.get(processo.pagina);
      if (!licitacaoId) continue;
      stats.lidos += 1;
      const resposta = await consultar(processo.api);
      if (resposta.httpStatus === 429) {
        stats.interrompido = true;
        stats.erros += 1;
        break;
      }
      const linha: Record<string, unknown> = resposta.erro || !resposta.body
        ? {
          licitacao_id: licitacaoId,
          url_pagina: processo.pagina,
          codigo_licitacao: processo.codigoLicitacao,
          http_status: resposta.httpStatus,
          erro: resposta.erro,
        }
        : {
          licitacao_id: licitacaoId,
          url_pagina: processo.pagina,
          codigo_licitacao: codigoRespostaPortal(resposta.body, processo.codigoLicitacao),
          situacao: situacaoPortal(resposta.body),
          consultado_em: new Date().toISOString(),
          http_status: resposta.httpStatus,
          erro: null,
          payload_hash: await hashPayload(resposta.body),
        };
      if (resposta.erro || !resposta.body) stats.erros += 1;
      const gravado = await client.from("portal_consulta").upsert(linha, { onConflict: "licitacao_id" });
      if (gravado?.error) {
        stats.erros += 1;
        logErro("gravação de portal_consulta", gravado.error);
        continue;
      }
      if (!(resposta.erro || !resposta.body)) stats.atualizados += 1;
    }

    const parcial = stats.interrompido || stats.erros > 0;
    await fechar(
      parcial ? "concluida_com_erros" : "concluida",
      stats.interrompido ? "Portal respondeu 429; lote interrompido" : undefined,
    );
    return { status: parcial ? "parcial" : "ok", stats };
  } catch (err: unknown) {
    stats.erros += 1;
    logErro("exceção", err);
    await fechar("falhou", "Falha na leitura do portal");
    return { status: "erro", stats };
  }
}
