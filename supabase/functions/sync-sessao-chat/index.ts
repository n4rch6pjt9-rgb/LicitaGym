import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";
import { corsHeaders, errorDetail, jsonResponse, requireCronAuth } from "../_shared/http.ts";
import {
  extrairChaveCompra17Digitos,
  type ResultadoSincronizacao,
  sincronizarCompra,
} from "../_shared/sessao_chat.ts";

/**
 * sync-sessao-chat (spec 0039, etapa 1, K-3): coleta agendada do chat da sessão no Integra Compras.
 *   POST { limite?, max_chamadas_dia? }
 *     -> { alvos, consultadas, puladas_recentes, limite_diario_atingido, parada, chamadas_hoje, resultados }
 * Acesso: só o cron (SYNC_CRON_SECRET), direto ou pela tela de Syncs (api-syncs, admin da plataforma).
 *
 * Alvos (private.sessao_chat_alvos): compras do Compras.gov.br (chave oficial de 17 dígitos) no pipeline de empresa
 * ativa, fora das etapas perdida e descartada, sem homologação e com o fim do recebimento de propostas (data_fim)
 * entre 30 dias atrás e 2 horas à frente.
 *
 * Custo (cada consulta = 2 chamadas cobradas, chat e diligências):
 * - rodízio: a compra consultada há mais tempo (ou nunca) vem primeiro;
 * - compra consultada há menos de 55 min (por cron ou usuário) fica para a próxima rodada: com o cron a cada 30 min,
 *   cada compra é lida cerca de uma vez por hora;
 * - teto de chamadas por dia (horário de Brasília), somando o que já está em private.integra_compras_run, inclusive
 *   consultas manuais; execução sem contagem (morta por timeout) conta pelo pior caso;
 * - no máximo `limite` compras por rodada e nenhuma compra nova depois de 90 s.
 */

const LIMITE_PADRAO = 10;
const LIMITE_MAX = 30;
const MAX_CHAMADAS_DIA_PADRAO = 300;
const MAX_CHAMADAS_DIA_TETO = 2000;
const CHAMADAS_POR_COMPRA = 2;
const INTERVALO_MINIMO_MS = 55 * 60_000;
const JANELA_ULTIMA_CONSULTA_MS = 24 * 3600_000;
/** Para de abrir compra nova depois disso: o cron espera 150 s e cada compra pode levar ~40 s no pior caso. */
const ORCAMENTO_TEMPO_MS = 90_000;
const FUSO_BRASILIA_MS = 3 * 3600_000;

export interface Alvo {
  licitacaoId: number;
  chaveCompra: string;
  dataFim: string;
}

export interface Contexto {
  getSupabase?: () => SupabaseClient;
  sincronizar?: (supabase: SupabaseClient, alvo: Alvo) => Promise<ResultadoSincronizacao>;
  agora?: () => Date;
  relogioMs?: () => number;
}

function somaChamadas(chamadas: Record<string, unknown>): number {
  let n = 0;
  for (const v of Object.values(chamadas)) if (typeof v === "number" && Number.isFinite(v)) n += v;
  return n;
}

/**
 * Chamadas de uma execução para o teto diário. Execução sem `chamadas` (ainda rodando, ou morta por timeout antes
 * de fechar) conta pelo pior caso, porque as chamadas podem ter sido feitas e cobradas.
 */
function chamadasDaExecucao(r: { terminado_em?: unknown; chamadas?: unknown }): number {
  const c = r.chamadas && typeof r.chamadas === "object" ? r.chamadas as Record<string, unknown> : {};
  const n = somaChamadas(c);
  return n > 0 ? n : (r.terminado_em ? 0 : CHAMADAS_POR_COMPRA);
}

function clienteServico(): SupabaseClient {
  const url = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !serviceKey) throw new Error("SUPABASE_URL ou SUPABASE_SERVICE_ROLE_KEY não configuradas");
  return createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
}

/** Meia-noite de hoje em Brasília (UTC-3), em ISO UTC. */
export function inicioDoDiaBrasilia(agora: Date): string {
  const local = new Date(agora.getTime() - FUSO_BRASILIA_MS);
  local.setUTCHours(0, 0, 0, 0);
  return new Date(local.getTime() + FUSO_BRASILIA_MS).toISOString();
}

function inteiroEntre(v: unknown, padrao: number, min: number, max: number): number | null {
  if (v === undefined || v === null) return padrao;
  if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) return null;
  return v;
}

/**
 * Compras do pipeline com sessão prevista ou aberta e chave oficial. O filtro (empresa ativa, etapa sem desfecho
 * perdida/descartada, sem homologação, janela de data_fim) fica em private.sessao_chat_alvos.
 */
export async function selecionarAlvos(supabase: SupabaseClient, agora: Date): Promise<Alvo[]> {
  const { data: lics, error } = await supabase
    .schema("private")
    .rpc("sessao_chat_alvos", { p_agora: agora.toISOString() });
  if (error) throw error;

  const porChave = new Map<string, Alvo>();
  for (const l of (lics ?? []) as Array<Record<string, unknown> & { licitacao_id: number }>) {
    const fim = l.data_fim ? Date.parse(String(l.data_fim)) : NaN;
    if (!Number.isFinite(fim)) continue;
    const chave = extrairChaveCompra17Digitos({
      codigo_externo: l.codigo_externo as string | null,
      link_sistema_origem: l.link_sistema_origem as string | null,
      raw: l.raw as Record<string, unknown> | null,
    });
    if (!chave) continue;
    const atual = porChave.get(chave);
    // Duas licitações com a mesma compra: uma consulta só, pela de menor id.
    if (!atual || l.licitacao_id < atual.licitacaoId) {
      porChave.set(chave, { licitacaoId: l.licitacao_id, chaveCompra: chave, dataFim: new Date(fim).toISOString() });
    }
  }
  return [...porChave.values()].sort((a, b) => b.dataFim.localeCompare(a.dataFim) || a.licitacaoId - b.licitacaoId);
}

export async function handleRequest(req: Request, ctx: Contexto = {}): Promise<Response> {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return jsonResponse({ error: "Método não permitido. Utilize POST." }, 405);

  const negado = requireCronAuth(req);
  if (negado) return negado;

  let body: Record<string, unknown> = {};
  try {
    const texto = await req.text();
    if (texto.trim()) body = JSON.parse(texto);
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("corpo");
  } catch {
    return jsonResponse({ error: "Corpo JSON inválido." }, 400);
  }
  const limite = inteiroEntre(body.limite, LIMITE_PADRAO, 1, LIMITE_MAX);
  const maxDia = inteiroEntre(body.max_chamadas_dia, MAX_CHAMADAS_DIA_PADRAO, 0, MAX_CHAMADAS_DIA_TETO);
  if (limite === null || maxDia === null) {
    return jsonResponse({
      error: `limite deve ser inteiro de 1 a ${LIMITE_MAX}; max_chamadas_dia, inteiro de 0 a ${MAX_CHAMADAS_DIA_TETO}.`,
    }, 400);
  }

  try {
    const supabase = ctx.getSupabase ? ctx.getSupabase() : clienteServico();
    const agora = ctx.agora ? ctx.agora() : new Date();
    const alvos = await selecionarAlvos(supabase, agora);

    const inicioDiaMs = Date.parse(inicioDoDiaBrasilia(agora));
    const corteRecenteMs = agora.getTime() - INTERVALO_MINIMO_MS;
    const desdeMs = Math.min(inicioDiaMs, agora.getTime() - JANELA_ULTIMA_CONSULTA_MS);
    const { data: runs, error: eRuns } = await supabase
      .schema("private")
      .from("integra_compras_run")
      .select("chave_compra, iniciado_em, terminado_em, chamadas")
      .gte("iniciado_em", new Date(desdeMs).toISOString());
    if (eRuns) throw eRuns;

    const ultimaConsulta = new Map<string, number>();
    let chamadasHoje = 0;
    for (const r of runs ?? []) {
      const iniciado = Date.parse(String(r.iniciado_em));
      if (!Number.isFinite(iniciado)) continue;
      const chave = String(r.chave_compra);
      if (iniciado > (ultimaConsulta.get(chave) ?? -Infinity)) ultimaConsulta.set(chave, iniciado);
      if (iniciado >= inicioDiaMs) chamadasHoje += chamadasDaExecucao(r);
    }

    // Rodízio: quem não foi consultado (ou foi há mais tempo) vem primeiro; empate, sessão mais recente.
    const fila = [...alvos].sort((a, b) =>
      (ultimaConsulta.get(a.chaveCompra) ?? -Infinity) - (ultimaConsulta.get(b.chaveCompra) ?? -Infinity)
    );

    const sincronizar = ctx.sincronizar ??
      ((s: SupabaseClient, a: Alvo) =>
        sincronizarCompra(s, { chaveCompra: a.chaveCompra, licitacaoId: a.licitacaoId, origem: "cron" }));
    const relogio = ctx.relogioMs ?? (() => Date.now());
    const inicioRodada = relogio();

    const resultados: Array<Record<string, unknown>> = [];
    let puladasRecentes = 0;
    let parada: "limite" | "limite_diario" | "tempo" | null = null;
    for (const alvo of fila) {
      if ((ultimaConsulta.get(alvo.chaveCompra) ?? -Infinity) >= corteRecenteMs) {
        puladasRecentes++;
        continue;
      }
      if (parada) continue; // só conta as puladas por intervalo
      if (resultados.length >= limite) {
        parada = "limite";
        continue;
      }
      if (chamadasHoje + CHAMADAS_POR_COMPRA > maxDia) {
        parada = "limite_diario";
        continue;
      }
      if (relogio() - inicioRodada > ORCAMENTO_TEMPO_MS) {
        parada = "tempo";
        continue;
      }
      try {
        const r = await sincronizar(supabase, alvo);
        chamadasHoje += Math.max(somaChamadas(r.chamadas), 0);
        resultados.push({
          licitacao_id: alvo.licitacaoId,
          chave_compra: alvo.chaveCompra,
          ok: r.ok,
          novas_inseridas: r.novas_inseridas,
          chamadas: r.chamadas,
          erro: r.erro,
        });
      } catch (e) {
        // Falha de banco numa compra não impede as outras; o detalhe fica só no log.
        console.error("[sync-sessao-chat]", alvo.chaveCompra, errorDetail(e));
        chamadasHoje += CHAMADAS_POR_COMPRA; // pior caso: as chamadas podem ter sido feitas
        resultados.push({ licitacao_id: alvo.licitacaoId, chave_compra: alvo.chaveCompra, ok: false, erro: "falha interna" });
      }
    }

    return jsonResponse({
      alvos: alvos.length,
      consultadas: resultados.length,
      puladas_recentes: puladasRecentes,
      limite_diario_atingido: parada === "limite_diario",
      parada,
      chamadas_hoje: chamadasHoje,
      resultados,
    });
  } catch (error) {
    console.error("[sync-sessao-chat]", errorDetail(error));
    return jsonResponse({ error: "Falha na coleta do chat da sessão." }, 500);
  }
}

if (import.meta.main) {
  Deno.serve((req) => handleRequest(req));
}
