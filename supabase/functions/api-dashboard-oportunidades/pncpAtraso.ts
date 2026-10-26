import { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { buildOrigemUrl } from "../_shared/edital-url.ts";
import { resolverPortalOficial } from "../_shared/portal-oficial.ts";
import type { PortalSecao } from "../_shared/portal-compras.ts";
import type {
  AcompanhamentoSection,
  ArquivoAcompanhamento,
  CompraMetadata,
  HistoricoEvento,
} from "./types.ts";

export interface PortalOficialDetalhes {
  nome: string | null;
  url: string | null;
  host: string | null;
  metodo: string;
  consultado_em: string | null;
  situacao: string | null;
}

export interface MensagemDisputaDB {
  categoria: string;
  remetente: string;
  mensagem: string;
  data_hora_oficial: string;
  item_numero?: number | null;
}

/**
 * Normaliza timestamp ISO para milissegundos. Retorna null se inválido.
 */
function parseTimestamp(ts: unknown): number | null {
  if (typeof ts !== "string" || !ts.trim()) return null;
  const time = new Date(ts).getTime();
  return Number.isNaN(time) ? null : time;
}

/**
 * Compara se o PNCP está com dados em atraso em relação ao portal oficial da disputa.
 * Critérios:
 * 1. O portal oficial possui eventos/mensagens com timestamp posterior à última atualização do PNCP.
 * 2. O PNCP falhou em carregar arquivos ou histórico (erro 422/500/timeout de CDN/S3), mas o portal está disponível.
 * 3. O portal oficial possui mensagens registradas no Serpro Integra Compras enquanto o histórico do PNCP está sem novidades.
 */
export function compararAtrasoPncp(
  pncpData: string | null,
  portalData: string | null,
  temFalhaPncp: boolean,
  temEventosPortal: boolean,
): boolean {
  if (temFalhaPncp) return true;

  const tPncp = parseTimestamp(pncpData);
  const tPortal = parseTimestamp(portalData);

  // Se o portal tem registro temporal e o PNCP tem registro temporal
  if (tPortal !== null && tPncp !== null) {
    // Se o portal possui evento com pelo menos 1 minuto de antecedência/novidade sobre o PNCP
    if (tPortal > tPncp + 60_000) return true;
  } else if (tPortal !== null && tPncp === null && temEventosPortal) {
    return true;
  }

  // Se o portal possui mensagens em tempo real da sessão e o histórico do PNCP não foi atualizado na mesma data
  if (temEventosPortal && tPncp !== null && tPortal !== null && tPortal >= tPncp) {
    return true;
  }

  return false;
}

/**
 * Mescla eventos do PNCP com mensagens e avisos do portal oficial da disputa.
 * Mantém todos os eventos oficiais sem fabricar dados e ordena por data decrescente (mais recentes primeiro).
 */
export function mesclarHistoricoPortal(
  eventosPncp: readonly HistoricoEvento[],
  mensagensPortal: readonly MensagemDisputaDB[],
  portalNome: string | null,
): HistoricoEvento[] {
  if (mensagensPortal.length === 0) {
    return eventosPncp.map((ev) => ({
      ...ev,
      origem: "pncp" as const,
    }));
  }

  const resultado: HistoricoEvento[] = eventosPncp.map((ev) => ({
    ...ev,
    origem: "pncp" as const,
  }));

  // Converte mensagens da disputa do portal oficial para HistoricoEvento
  const nomeExibicao = portalNome || "Portal Oficial";
  for (const msg of mensagensPortal) {
    let tipoNome = "Mensagem do Pregoeiro";
    if (msg.categoria === "diligencia") {
      tipoNome = "Diligência Oficial";
    } else if (msg.categoria === "aviso") {
      tipoNome = "Aviso da Sessão";
    } else if (msg.categoria === "sistema") {
      tipoNome = "Sistema de Disputa";
    }

    resultado.push({
      data: msg.data_hora_oficial,
      categoria: `Portal Oficial (${nomeExibicao})`,
      tipo: tipoNome,
      item: msg.item_numero != null ? Number(msg.item_numero) : null,
      documentoTitulo: null,
      justificativa: `[${msg.remetente}] ${msg.mensagem}`,
      origem: "portal_oficial",
    });
  }

  return resultado;
}

/**
 * Anexa o link do portal oficial a cada documento para permitir fallback imediato
 * caso a CDN/S3 do PNCP falhe com erro 422.
 */
export function enriquecerArquivosComPortal(
  arquivos: readonly ArquivoAcompanhamento[],
  portalUrl: string | null,
): ArquivoAcompanhamento[] {
  return arquivos.map((arq) => ({
    ...arq,
    url_portal_oficial: portalUrl,
  }));
}

/**
 * Processa a sincronização entre PNCP e o portal oficial da disputa:
 * - Resolve a URL e metadados do portal oficial
 * - Consulta mensagens da sessão pública gravadas e snapshots
 * - Compara se o PNCP está com atraso de informações
 * - Atualiza a seção de histórico com avisos em tempo real da disputa
 * - Atualiza a seção de documentos com link de contingência para o portal oficial
 */
export async function sincronizarPortalOficialEAtraso(
  client: SupabaseClient,
  licitacaoId: number,
  row: Record<string, unknown>,
  urlAcompanhamentoAtual: string | null,
  portalSecao: PortalSecao | null,
  compraSection: AcompanhamentoSection<CompraMetadata>,
  historicoSection: AcompanhamentoSection<HistoricoEvento[]> & { total: number },
  arquivosSection: AcompanhamentoSection<ArquivoAcompanhamento[]> & {
    total: number;
    url_portal_oficial?: string | null;
  },
): Promise<{
  urlAcompanhamento: string | null;
  pncpEmAtraso: boolean;
  portalOficial: PortalOficialDetalhes | null;
  historicoAtualizado: AcompanhamentoSection<HistoricoEvento[]> & { total: number };
  arquivosAtualizados: AcompanhamentoSection<ArquivoAcompanhamento[]> & {
    total: number;
    url_portal_oficial?: string | null;
  };
}> {
  // 1. Resolve portal oficial
  const portalInfo = resolverPortalOficial(row);
  const rawLink = typeof row.link_sistema_origem === "string" ? row.link_sistema_origem : null;
  const origemResolvida = buildOrigemUrl(rawLink ?? portalInfo.url, row.fonte);

  const urlFinal = origemResolvida?.url ?? portalInfo.url ?? urlAcompanhamentoAtual;
  const nomeFinal = portalInfo.nome ?? (portalSecao ? "Portal de Compras Públicas" : null);
  const hostFinal = portalInfo.host ?? (urlFinal ? new URL(urlFinal).hostname.toLowerCase() : null);

  // 2. Consulta em paralelo mensagens da disputa e snapshot do portal oficial no banco
  const mensagensPortal: MensagemDisputaDB[] = [];
  let consultadoEm: string | null = portalSecao?.consultado_em ?? null;
  let situacaoPortal: string | null = portalSecao?.situacao ?? null;

  try {
    const consultaBuilder = client
      .from("portal_consulta")
      .select("consultado_em, situacao, codigo_licitacao, erro")
      .eq("licitacao_id", licitacaoId);
    const consultaResult = typeof (consultaBuilder as unknown as { maybeSingle?: () => Promise<{ error: unknown; data: Record<string, unknown> | null }> }).maybeSingle === "function"
      ? await (consultaBuilder as unknown as { maybeSingle: () => Promise<{ error: unknown; data: Record<string, unknown> | null }> }).maybeSingle()
      : null;

    if (consultaResult && !consultaResult.error && consultaResult.data) {
      consultadoEm = consultadoEm ?? (consultaResult.data.consultado_em as string | null);
      situacaoPortal = situacaoPortal ?? (consultaResult.data.situacao as string | null);
    }
  } catch (e) {
    console.warn("[sincronizarPortalOficialEAtraso] Falha ao ler dados complementares do portal:", e);
  }

  // 3. Obtém timestamp mais recente do PNCP
  const eventosPncp = Array.isArray(historicoSection.dados) ? historicoSection.dados : [];
  let tMaisRecentePncpStr = compraSection.dados?.datas?.atualizacao ??
    compraSection.dados?.datas?.inclusao ??
    compraSection.dados?.datas?.publicacao ??
    null;
  if (!tMaisRecentePncpStr && eventosPncp.length > 0) {
    tMaisRecentePncpStr = eventosPncp[0]?.data ?? null;
  }

  // 4. Obtém timestamp mais recente de eventos oficiais do Portal Oficial
  // Não utiliza consultadoEm (data de execução da consulta/robô) para evitar falsos positivos
  // de atraso quando o conteúdo do certame no portal não sofreu alteração.
  let tMaisRecentePortalStr: string | null = null;
  if (mensagensPortal.length > 0 && mensagensPortal[0]?.data_hora_oficial) {
    tMaisRecentePortalStr = mensagensPortal[0].data_hora_oficial;
  }

  // 5. Avalia se o PNCP está com atraso de informações ou falha
  const temFalhaPncp = arquivosSection.erro !== null || historicoSection.erro !== null;
  const temEventosPortal = mensagensPortal.length > 0;
  const pncpEmAtraso = compararAtrasoPncp(
    tMaisRecentePncpStr,
    tMaisRecentePortalStr,
    temFalhaPncp,
    temEventosPortal,
  );

  // 6. Atualiza Histórico mesclando avisos e chat do portal oficial
  const historicoMesclado = mesclarHistoricoPortal(eventosPncp, mensagensPortal, nomeFinal);
  const historicoAtualizado = {
    ...historicoSection,
    dados: historicoMesclado,
    total: historicoMesclado.length,
  };

  // 7. Atualiza Arquivos anexando link do portal oficial
  const arquivosLista = Array.isArray(arquivosSection.dados) ? arquivosSection.dados : [];
  const arquivosEnriquecidos = enriquecerArquivosComPortal(arquivosLista, urlFinal);
  const arquivosAtualizados = {
    ...arquivosSection,
    dados: arquivosEnriquecidos,
    url_portal_oficial: urlFinal,
  };

  const portalOficial: PortalOficialDetalhes | null = (urlFinal || nomeFinal)
    ? {
      nome: nomeFinal,
      url: urlFinal,
      host: hostFinal,
      metodo: portalInfo.metodo,
      consultado_em: consultadoEm,
      situacao: situacaoPortal,
    }
    : null;

  return {
    urlAcompanhamento: urlFinal,
    pncpEmAtraso,
    portalOficial,
    historicoAtualizado,
    arquivosAtualizados,
  };
}
