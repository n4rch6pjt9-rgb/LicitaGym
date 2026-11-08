/**
 * GET /api-disputa/sessoes (spec 0039, etapa 1): lista as compras do pipeline da empresa com o estado do chat da sessão.
 * Alimenta a tela "Sessão" do Dashboard. Só lê: nenhuma chamada ao Integra Compras sai daqui.
 *
 * A situação da coleta repete a regra de private.sessao_chat_alvos() (migration 20261108130000): sem homologação,
 * fora das etapas perdida/descartada e com o fim do recebimento de propostas entre 30 dias atrás e 2 h à frente.
 * Diferença conhecida: a etapa olhada aqui é a da empresa que chama. O cron coleta se qualquer empresa ativa ainda
 * tem a compra em aberto; "encerrada_no_pipeline" quer dizer encerrada no pipeline desta empresa.
 */
import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { extrairChaveCompra17Digitos } from "../_shared/sessao_chat.ts";

export const JANELA_ANTES_MS = 2 * 3600_000;
/** Ids por `in (...)` (URL curta no PostgREST). */
const LOTE_IN = 200;
/** Compras consultadas em paralelo. */
const LOTE_CONCORRENCIA = 10;

function emLotes<T>(lista: T[], tamanho: number): T[][] {
  const lotes: T[][] = [];
  for (let i = 0; i < lista.length; i += tamanho) lotes.push(lista.slice(i, i + tamanho));
  return lotes;
}
export const JANELA_DEPOIS_MS = 30 * 86400_000;

export type SituacaoColeta =
  | "em_coleta"
  | "aguardando"
  | "sem_chave"
  | "homologada"
  | "encerrada_no_pipeline"
  | "sem_data"
  | "fora_da_janela";

export function situacaoColeta(
  l: { chave: string | null; data_fim: string | null; data_homologacao: string | null; desfecho: string | null },
  agoraMs: number,
): SituacaoColeta {
  if (!l.chave) return "sem_chave";
  if (l.data_homologacao) return "homologada";
  if (l.desfecho === "perdida" || l.desfecho === "descartada") return "encerrada_no_pipeline";
  const fim = l.data_fim ? Date.parse(l.data_fim) : NaN;
  if (!Number.isFinite(fim)) return "sem_data";
  if (fim > agoraMs + JANELA_ANTES_MS) return "aguardando";
  if (fim < agoraMs - JANELA_DEPOIS_MS) return "fora_da_janela";
  return "em_coleta";
}

const ORDEM_SITUACAO: Record<SituacaoColeta, number> = {
  em_coleta: 0,
  aguardando: 1,
  sem_chave: 2,
  sem_data: 3,
  homologada: 4,
  encerrada_no_pipeline: 5,
  fora_da_janela: 6,
};

export interface SessaoResumo {
  licitacao_id: number;
  objeto: string | null;
  orgao_nome: string | null;
  uf: string | null;
  data_fim: string | null;
  data_homologacao: string | null;
  etapa: { nome: string; desfecho: string | null } | null;
  chave_compra: string | null;
  situacao: SituacaoColeta;
  /**
   * Início da janela da coleta automática (2 h antes do fim do recebimento); só em "aguardando". Não é o horário da
   * coleta: o cron roda de 30 em 30 min, das 8h às 19h30 de Brasília, de segunda a sexta.
   */
  entra_na_coleta_em: string | null;
  ultima_consulta: { iniciado_em: string; terminado_em: string | null; com_erro: boolean } | null;
  /** null = sem chave (não há o que contar); 0 = consultada ou não, nenhuma mensagem gravada. */
  total_mensagens: number | null;
  ultima_mensagem_em: string | null;
}

// deno-lint-ignore no-explicit-any
type Linha = Record<string, any>;

export async function listarSessoes(
  supabase: SupabaseClient,
  tenantId: number,
  agoraMs: number,
): Promise<SessaoResumo[]> {
  const { data: pipeline, error: erroPipe } = await supabase
    .from("pipeline_oportunidades")
    .select("licitacao_id, etapa_id")
    .eq("tenant_id", tenantId);
  if (erroPipe) throw erroPipe;
  const linhasPipe = (pipeline ?? []) as Linha[];
  if (linhasPipe.length === 0) return [];

  const idsLic = [...new Set(linhasPipe.map((p) => Number(p.licitacao_id)))];
  const idsEtapa = [...new Set(linhasPipe.map((p) => p.etapa_id).filter((v) => v !== null && v !== undefined))];

  const lics: Linha[] = [];
  for (const lote of emLotes(idsLic, LOTE_IN)) {
    const { data, error } = await supabase
      .from("licitacoes_externas")
      .select("id, objeto, orgao_nome, uf, data_fim, data_homologacao, codigo_externo, link_sistema_origem, raw")
      .in("id", lote);
    if (error) throw error;
    lics.push(...((data ?? []) as Linha[]));
  }

  let etapas: Linha[] = [];
  if (idsEtapa.length > 0) {
    const { data, error } = await supabase
      .from("pipeline_etapas")
      .select("id, nome, desfecho")
      .eq("tenant_id", tenantId)
      .in("id", idsEtapa);
    if (error) throw error;
    etapas = (data ?? []) as Linha[];
  }
  const etapaPorId = new Map(etapas.map((e) => [e.id, e]));
  const etapaPorLic = new Map(linhasPipe.map((p) => [Number(p.licitacao_id), etapaPorId.get(p.etapa_id) ?? null]));

  const base = lics.map((l) => ({
    l,
    chave: extrairChaveCompra17Digitos(l),
    etapa: etapaPorLic.get(Number(l.id)) ?? null,
  }));

  const chaves = [...new Set(base.map((b) => b.chave).filter((c): c is string => c !== null))];
  const ultimaPorChave = new Map<string, Linha>();
  const mensagensPorChave = new Map<string, { total: number; ultima: string | null }>();
  // Por compra: a última execução e a contagem exata de mensagens (sem trazer as linhas). Cada consulta usa o índice
  // por chave_compra; em lotes, para não abrir centenas de requisições ao mesmo tempo.
  for (const lote of emLotes(chaves, LOTE_CONCORRENCIA)) {
    await Promise.all(lote.map(async (chave) => {
      const { data: run, error: erroRun } = await supabase
        .schema("private")
        .from("integra_compras_run")
        .select("chave_compra, iniciado_em, terminado_em, erro")
        .eq("chave_compra", chave)
        .order("iniciado_em", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (erroRun) throw erroRun;
      if (run) ultimaPorChave.set(chave, run as Linha);

      const { count, error: erroCount } = await supabase
        .from("sessao_mensagens")
        .select("id", { count: "exact", head: true })
        .eq("chave_compra", chave);
      if (erroCount) throw erroCount;
      let ultima: string | null = null;
      if ((count ?? 0) > 0) {
        const { data, error: erroUltima } = await supabase
          .from("sessao_mensagens")
          .select("data_hora")
          .eq("chave_compra", chave)
          .order("data_hora", { ascending: false })
          .limit(1)
          .maybeSingle();
        if (erroUltima) throw erroUltima;
        ultima = (data as Linha | null)?.data_hora ?? null;
      }
      mensagensPorChave.set(chave, { total: count ?? 0, ultima });
    }));
  }

  const sessoes: SessaoResumo[] = base.map(({ l, chave, etapa }) => {
    const situacao = situacaoColeta(
      { chave, data_fim: l.data_fim ?? null, data_homologacao: l.data_homologacao ?? null, desfecho: etapa?.desfecho ?? null },
      agoraMs,
    );
    const run = chave ? ultimaPorChave.get(chave) : undefined;
    const msgs = chave ? mensagensPorChave.get(chave) : undefined;
    return {
      licitacao_id: Number(l.id),
      objeto: l.objeto ?? null,
      orgao_nome: l.orgao_nome ?? null,
      uf: l.uf ?? null,
      data_fim: l.data_fim ?? null,
      data_homologacao: l.data_homologacao ?? null,
      etapa: etapa ? { nome: etapa.nome, desfecho: etapa.desfecho ?? null } : null,
      chave_compra: chave,
      situacao,
      entra_na_coleta_em: situacao === "aguardando"
        ? new Date(Date.parse(l.data_fim) - JANELA_ANTES_MS).toISOString()
        : null,
      ultima_consulta: run
        ? { iniciado_em: run.iniciado_em, terminado_em: run.terminado_em ?? null, com_erro: Boolean(run.erro) }
        : null,
      total_mensagens: chave ? (msgs?.total ?? 0) : null,
      ultima_mensagem_em: msgs?.ultima ?? null,
    };
  });

  const fimMs = (s: SessaoResumo) => (s.data_fim ? Date.parse(s.data_fim) : 0);
  sessoes.sort((a, b) => {
    const d = ORDEM_SITUACAO[a.situacao] - ORDEM_SITUACAO[b.situacao];
    if (d !== 0) return d;
    // Aguardando: a próxima sessão primeiro; o resto: a mais recente primeiro.
    return a.situacao === "aguardando" ? fimMs(a) - fimMs(b) : fimMs(b) - fimMs(a);
  });
  return sessoes;
}
