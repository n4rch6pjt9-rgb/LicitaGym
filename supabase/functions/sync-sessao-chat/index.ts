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
 *   POST { limite?, max_chamadas_dia? } -> { alvos, consultadas, puladas_recentes, limite_diario_atingido, resultados }
 * Acesso: só o cron (SYNC_CRON_SECRET).
 *
 * Alvos: compras do Compras.gov.br (chave oficial de 17 dígitos) que estão no pipeline de algum tenant, sem data de
 * homologação, com a sessão prevista ou aberta: fim do recebimento de propostas (data_fim) entre 30 dias atrás e
 * 2 horas à frente. Mais recentes primeiro.
 *
 * Custo (cada consulta = 2 chamadas cobradas, chat e diligências):
 * - compra consultada há menos de 25 min (por cron ou usuário) fica para a próxima rodada;
 * - teto de chamadas por dia (horário de Brasília), somando o que já está em private.integra_compras_run;
 * - no máximo `limite` compras por rodada.
 */

const LIMITE_PADRAO = 10;
const LIMITE_MAX = 30;
const MAX_CHAMADAS_DIA_PADRAO = 300;
const MAX_CHAMADAS_DIA_TETO = 2000;
const CHAMADAS_POR_COMPRA = 2;
const INTERVALO_MINIMO_MS = 25 * 60_000;
const JANELA_PASSADO_MS = 30 * 24 * 3600_000;
const JANELA_FUTURO_MS = 2 * 3600_000;
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

/** Compras do pipeline com sessão prevista ou aberta e chave oficial. */
export async function selecionarAlvos(supabase: SupabaseClient, agora: Date): Promise<Alvo[]> {
  const { data: pipe, error: ePipe } = await supabase.from("pipeline_oportunidades").select("licitacao_id");
  if (ePipe) throw ePipe;
  const ids = [...new Set((pipe ?? []).map((p: { licitacao_id: number }) => p.licitacao_id))];
  if (ids.length === 0) return [];

  const { data: lics, error: eLic } = await supabase
    .from("licitacoes_externas")
    .select("id, codigo_externo, link_sistema_origem, raw, data_fim, data_homologacao")
    .in("id", ids)
    .is("data_homologacao", null);
  if (eLic) throw eLic;

  const min = agora.getTime() - JANELA_PASSADO_MS;
  const max = agora.getTime() + JANELA_FUTURO_MS;
  const porChave = new Map<string, Alvo>();
  for (const l of lics ?? []) {
    if (l.data_homologacao) continue;
    const fim = l.data_fim ? new Date(String(l.data_fim)).getTime() : NaN;
    if (!Number.isFinite(fim) || fim < min || fim > max) continue;
    const chave = extrairChaveCompra17Digitos(l);
    if (!chave) continue;
    const atual = porChave.get(chave);
    // Duas licitações com a mesma compra: uma consulta só, pela de menor id.
    if (!atual || l.id < atual.licitacaoId) {
      porChave.set(chave, { licitacaoId: l.id, chaveCompra: chave, dataFim: new Date(fim).toISOString() });
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

    const inicioDia = inicioDoDiaBrasilia(agora);
    const corteRecente = new Date(agora.getTime() - INTERVALO_MINIMO_MS).toISOString();
    const desde = corteRecente < inicioDia ? corteRecente : inicioDia;
    const { data: runs, error: eRuns } = await supabase
      .schema("private")
      .from("integra_compras_run")
      .select("chave_compra, iniciado_em, chamadas")
      .gte("iniciado_em", desde);
    if (eRuns) throw eRuns;

    const recentes = new Set<string>();
    let chamadasHoje = 0;
    for (const r of runs ?? []) {
      const iniciado = String(r.iniciado_em);
      if (iniciado >= corteRecente) recentes.add(String(r.chave_compra));
      if (iniciado >= inicioDia && r.chamadas && typeof r.chamadas === "object") {
        for (const n of Object.values(r.chamadas as Record<string, unknown>)) {
          if (typeof n === "number" && Number.isFinite(n)) chamadasHoje += n;
        }
      }
    }

    const sincronizar = ctx.sincronizar ??
      ((s: SupabaseClient, a: Alvo) =>
        sincronizarCompra(s, { chaveCompra: a.chaveCompra, licitacaoId: a.licitacaoId, origem: "cron" }));

    const resultados: Array<Record<string, unknown>> = [];
    let puladasRecentes = 0;
    let limiteDiario = false;
    for (const alvo of alvos) {
      if (recentes.has(alvo.chaveCompra)) {
        puladasRecentes++;
        continue;
      }
      if (resultados.length >= limite) break;
      if (chamadasHoje + CHAMADAS_POR_COMPRA > maxDia) {
        limiteDiario = true;
        break;
      }
      try {
        const r = await sincronizar(supabase, alvo);
        for (const n of Object.values(r.chamadas)) chamadasHoje += n;
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
        chamadasHoje += CHAMADAS_POR_COMPRA; // conta pelo pior caso: as chamadas podem ter sido feitas
        resultados.push({ licitacao_id: alvo.licitacaoId, chave_compra: alvo.chaveCompra, ok: false, erro: "falha interna" });
      }
    }

    return jsonResponse({
      alvos: alvos.length,
      consultadas: resultados.length,
      puladas_recentes: puladasRecentes,
      limite_diario_atingido: limiteDiario,
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
