import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { corsHeaders, jsonResponse, requireCronAuth } from "../_shared/http.ts";
import { hashPayload } from "../_shared/pncp/hash.ts";
import { acquireSyncLock } from "../_shared/pncp/lock.ts";
import { createServiceClient } from "../_shared/pncp/supabase-admin.ts";
import {
  codigoRespostaPortal,
  consultarPortal,
  escolherLotePortal,
  parsePortalProcessoUrl,
  situacaoPortal,
  type CandidatoPortal,
} from "../_shared/portal-compras.ts";

const LIMITE_PADRAO = 40;
const LIMITE_LEITURA = 200;

function limiteDe(body: unknown): number {
  if (!body || typeof body !== "object" || Array.isArray(body)) return LIMITE_PADRAO;
  const valor = (body as Record<string, unknown>).limite;
  const n = typeof valor === "number" ? valor : Number(valor);
  if (!Number.isInteger(n) || n < 1) return LIMITE_PADRAO;
  return Math.min(n, LIMITE_PADRAO);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return jsonResponse({ error: "Use POST" }, 405);
  const denied = requireCronAuth(req);
  if (denied) return denied;

  let body: unknown = {};
  const texto = await req.text();
  if (texto.trim()) {
    try {
      body = JSON.parse(texto);
    } catch {
      return jsonResponse({ error: "JSON inválido" }, 400);
    }
  }

  const client = createServiceClient();
  const { runId, alreadyRunning } = await acquireSyncLock(client, "portal-compras", "portal-compras", {});
  if (alreadyRunning) return jsonResponse({ status: "already_running", sync_id: runId });

  const agora = new Date();
  const limite = limiteDe(body);
  const stats = { lidos: 0, atualizados: 0, erros: 0, interrompido: false };

  try {
    const pipeline = await client.from("pipeline_oportunidades").select("licitacao_id").limit(LIMITE_LEITURA);
    const noPipeline = new Set<number>();
    if (!pipeline.error && Array.isArray(pipeline.data)) {
      for (const row of pipeline.data as Array<{ licitacao_id: number }>) {
        noPipeline.add(Number(row.licitacao_id));
      }
    }

    const abertas = await client
      .from("licitacoes_externas")
      .select("id,link_sistema_origem,data_fim")
      .ilike("link_sistema_origem", "%portaldecompraspublicas.com.br/processos/%")
      .gt("data_fim", agora.toISOString())
      .limit(LIMITE_LEITURA);

    const porId = new Map<number, { link: string; dataFim: string | null }>();
    if (abertas.error) {
      return jsonResponse({ error: "Falha ao listar o portal", sync_id: runId }, 500);
    }
    for (const row of (abertas.data ?? []) as Array<Record<string, unknown>>) {
      const id = Number(row.id);
      if (!Number.isInteger(id) || typeof row.link_sistema_origem !== "string") continue;
      porId.set(id, {
        link: row.link_sistema_origem,
        dataFim: typeof row.data_fim === "string" ? row.data_fim : null,
      });
    }

    const faltam = [...noPipeline].filter((id) => !porId.has(id));
    if (faltam.length > 0) {
      const extras = await client
        .from("licitacoes_externas")
        .select("id,link_sistema_origem,data_fim")
        .in("id", faltam);
      if (!extras.error && Array.isArray(extras.data)) {
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

    const consultas = porId.size === 0
      ? { data: [], error: null }
      : await client
        .from("portal_consulta")
        .select("licitacao_id,consultado_em")
        .in("licitacao_id", [...porId.keys()]);
    const consultado = new Map<number, string | null>();
    if (!consultas.error && Array.isArray(consultas.data)) {
      for (const row of consultas.data as Array<Record<string, unknown>>) {
        consultado.set(
          Number(row.licitacao_id),
          typeof row.consultado_em === "string" ? row.consultado_em : null,
        );
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
      const resposta = await consultarPortal(processo.api);
      if (resposta.httpStatus === 429) {
        stats.interrompido = true;
        stats.erros += 1;
        break;
      }
      if (resposta.erro || !resposta.body) {
        stats.erros += 1;
        await client.from("portal_consulta").upsert({
          licitacao_id: licitacaoId,
          url_pagina: processo.pagina,
          codigo_licitacao: processo.codigoLicitacao,
          http_status: resposta.httpStatus,
          erro: resposta.erro,
        }, { onConflict: "licitacao_id" });
        continue;
      }
      await client.from("portal_consulta").upsert({
        licitacao_id: licitacaoId,
        url_pagina: processo.pagina,
        codigo_licitacao: codigoRespostaPortal(resposta.body, processo.codigoLicitacao),
        situacao: situacaoPortal(resposta.body),
        consultado_em: new Date().toISOString(),
        http_status: resposta.httpStatus,
        erro: null,
        payload_hash: await hashPayload(resposta.body),
      }, { onConflict: "licitacao_id" });
      stats.atualizados += 1;
    }

    return jsonResponse({ status: stats.interrompido ? "parcial" : "ok", sync_id: runId, ...stats });
  } catch (err: unknown) {
    console.error("[sync-portal-compras]", err instanceof Error ? err.message : "falha");
    return jsonResponse({ error: "Falha na leitura do portal", sync_id: runId, ...stats }, 500);
  }
});
