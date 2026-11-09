// Cópia local das seções Itens e Documentos do detalhe da oportunidade, usada só quando o PNCP falha.
//
// O detalhe consulta o PNCP ao vivo (acompanhamento.ts). Em 09/11/2026 a família /api/pncp/v1 do PNCP respondia
// 503 para todas as compras (id 125: itens, atas, histórico e arquivos em 503; /api/consulta/v1 em 200) e as abas
// Itens e Documentos ficavam vazias, embora o coletor já tivesse gravado o DTO do PNCP em public.licitacao_itens.raw
// (148 itens) e o Termo de Referência em public.licitacao_documentos.
//
// Regras:
// - Só entra quando a seção do PNCP veio com `erro` e sem dados. O `erro` do PNCP é mantido (a falha não vira
//   sucesso): o front mostra a cópia com o aviso de que o PNCP está fora e a data em que ela foi gravada.
// - `origem: "copia_local"` e `copia_gravada_em` (maior updated_at das linhas usadas) marcam a seção.
// - Itens: o mesmo normalizador do PNCP (mapItemAcompanhamento) sobre o DTO gravado em `raw`; sem resultados
//   (o /resultados não foi consultado): item com temResultado leva `resultadosErro`.
// - Documentos: só os de origem PNCP (arquivo_origem "pncp-N"), não removidos do portal.
// - Falha ao ler a cópia (ou cópia vazia) devolve a seção do PNCP como veio: erro explícito, nunca vazio silencioso.
// - Histórico e atas não têm cópia local: continuam com o erro do PNCP.
import { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { mapItemAcompanhamento } from "./acompanhamento.ts";
import type { AcompanhamentoSection, ArquivoAcompanhamento, ItemAcompanhamento } from "./types.ts";

/** Lote de leitura, abaixo do max_rows = 1000 do PostgREST: lote que volta cheio pede a página seguinte. */
export const COPIA_LOTE = 500;
/** Teto de lotes (5.000 itens): passou disso, a cópia é tratada como incompleta e não é usada. */
const COPIA_MAX_LOTES = 10;

export const RESULTADOS_NAO_CONSULTADOS = "PNCP indisponível: resultados do item não consultados (cópia local)";

type ComTotal<T> = AcompanhamentoSection<T> & { total: number };

interface Copia<T> {
  dados: T[];
  gravadoEm: string | null;
}

function maiorData(atual: string | null, v: unknown): string | null {
  if (typeof v !== "string" || v.trim() === "") return atual;
  if (atual === null) return v;
  return Date.parse(v) > Date.parse(atual) ? v : atual;
}

/** Lê todas as linhas de uma tabela da licitação em lotes; null = falha ou leitura incompleta. */
async function lerLinhas(
  client: SupabaseClient,
  tabela: string,
  colunas: string,
  licitacaoId: number,
  ordem: string,
): Promise<Record<string, unknown>[] | null> {
  const linhas: Record<string, unknown>[] = [];
  for (let lote = 0; lote < COPIA_MAX_LOTES; lote++) {
    const inicio = lote * COPIA_LOTE;
    const { data, error } = await client
      .from(tabela)
      .select(colunas)
      .eq("licitacao_id", licitacaoId)
      .order(ordem, { ascending: true })
      .range(inicio, inicio + COPIA_LOTE - 1);
    if (error || !Array.isArray(data)) {
      console.warn(`[api-dashboard-oportunidades] cópia local indisponível (${tabela}):`, error ?? "resposta inválida");
      return null;
    }
    linhas.push(...(data as unknown as Record<string, unknown>[]));
    if (data.length < COPIA_LOTE) return linhas;
  }
  console.warn(`[api-dashboard-oportunidades] cópia local acima de ${COPIA_LOTE * COPIA_MAX_LOTES} linhas (${tabela})`);
  return null;
}

/** Itens gravados pelo coletor (DTO do /itens do PNCP em `raw`). null = falha na leitura. */
export async function itensDaCopiaLocal(
  client: SupabaseClient,
  licitacaoId: number,
): Promise<Copia<ItemAcompanhamento> | null> {
  try {
    const linhas = await lerLinhas(client, "licitacao_itens", "numero_item,raw,updated_at", licitacaoId, "numero_item");
    if (!linhas) return null;
    let gravadoEm: string | null = null;
    const dados: ItemAcompanhamento[] = [];
    for (const linha of linhas) {
      const raw = linha.raw;
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
      const dto = raw as Record<string, unknown>;
      // numeroItem do DTO; sem ele, o numero_item gravado (mesmo valor na carga do coletor).
      const item = mapItemAcompanhamento(dto.numeroItem == null ? { ...dto, numeroItem: linha.numero_item } : dto);
      if (!Number.isFinite(item.numeroItem)) continue;
      if (item.temResultado) item.resultadosErro = RESULTADOS_NAO_CONSULTADOS;
      dados.push(item);
      gravadoEm = maiorData(gravadoEm, linha.updated_at);
    }
    return { dados, gravadoEm };
  } catch (err: unknown) {
    console.warn("[api-dashboard-oportunidades] cópia local de itens falhou:", err);
    return null;
  }
}

const ORIGEM_PNCP_RE = /^pncp-(\d+)$/;

/** Documentos do PNCP gravados em licitacao_documentos (arquivo_origem "pncp-N"). null = falha na leitura. */
export async function arquivosDaCopiaLocal(
  client: SupabaseClient,
  licitacaoId: number,
  pncp: { cnpj: string; ano: number; sequencial: number },
): Promise<Copia<ArquivoAcompanhamento> | null> {
  try {
    const linhas = await lerLinhas(
      client,
      "licitacao_documentos",
      "id,nome_original,arquivo_origem,data_documento,raw,removido_do_portal_em,updated_at",
      licitacaoId,
      "id",
    );
    if (!linhas) return null;
    let gravadoEm: string | null = null;
    const dados: ArquivoAcompanhamento[] = [];
    for (const linha of linhas) {
      const m = typeof linha.arquivo_origem === "string" ? linha.arquivo_origem.match(ORIGEM_PNCP_RE) : null;
      if (!m || linha.removido_do_portal_em) continue;
      const seqDoc = Number(m[1]);
      const raw = (linha.raw && typeof linha.raw === "object" && !Array.isArray(linha.raw))
        ? linha.raw as Record<string, unknown>
        : {};
      const arquivo: ArquivoAcompanhamento = {
        titulo: typeof linha.nome_original === "string" ? linha.nome_original : null,
        tipo: typeof raw.tipo_documento === "string" ? raw.tipo_documento : null,
        url: typeof raw.url === "string"
          ? raw.url
          : `https://pncp.gov.br/pncp-api/v1/orgaos/${pncp.cnpj}/compras/${pncp.ano}/${pncp.sequencial}/arquivos/${seqDoc}`,
        sequencialDocumento: seqDoc,
      };
      if (typeof linha.data_documento === "string") arquivo.dataPublicacaoPncp = linha.data_documento;
      dados.push(arquivo);
      gravadoEm = maiorData(gravadoEm, linha.updated_at);
    }
    return { dados, gravadoEm };
  } catch (err: unknown) {
    console.warn("[api-dashboard-oportunidades] cópia local de documentos falhou:", err);
    return null;
  }
}

/** A seção do PNCP falhou sem trazer dados: só aí a cópia local entra. */
export function precisaDaCopia(secao: AcompanhamentoSection<unknown[]>): boolean {
  return secao.erro !== null && (!Array.isArray(secao.dados) || secao.dados.length === 0);
}

/**
 * Seção com a cópia local, mantendo o `erro` do PNCP. Sem cópia (falha ou nenhuma linha): a seção como veio.
 * `total` é o da cópia; o total do PNCP é desconhecido enquanto ele estiver fora.
 */
export function aplicarCopiaLocal<T, S extends ComTotal<T[]>>(
  secao: S,
  copia: Copia<T> | null,
): S & { origem?: "copia_local"; copia_gravada_em?: string | null } {
  if (!precisaDaCopia(secao) || !copia || copia.dados.length === 0) return secao;
  return {
    ...secao,
    dados: copia.dados,
    total: copia.dados.length,
    origem: "copia_local",
    copia_gravada_em: copia.gravadoEm,
  };
}
