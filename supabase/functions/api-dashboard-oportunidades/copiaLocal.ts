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
// - `origem: "copia_local"` e `copia_gravada_em` marcam a seção. `copia_gravada_em` só sai quando há data confiável:
//   documentos usam last_seen_at (o coletor grava a cada passada); licitacao_itens não tem coluna de data mantida
//   (updated_at fica no default do insert, sem trigger), então nos itens a data é null = desconhecida.
// - Itens: das colunas estruturadas que o coletor atualiza a cada coleta (coletor/pncp.py). NÃO de `raw`: desde
//   04/10/2026 o DTO vai para o GCS, linha nova tem raw NULL e linha antiga tem raw congelado (em 09/11/2026,
//   182.588 de 280.204 itens com raw NULL). Sem resultados (o /resultados não foi consultado): item com
//   tem_resultado leva `resultadosErro`. catalogoNome não tem coluna: null.
// - Documentos: só os do coletor PNCP (secao "processo", arquivo_origem "pncp-N"), não removidos do portal.
// - Falha ao ler a cópia (ou cópia vazia) devolve a seção do PNCP como veio: erro explícito, nunca vazio silencioso.
// - Histórico e atas não têm cópia local: continuam com o erro do PNCP.
import { SupabaseClient } from "npm:@supabase/supabase-js@2";
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

function numeroOuNull(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function textoOuNull(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v : null;
}

/** Linha de licitacao_itens (colunas que o coletor PNCP mantém) no formato da seção Itens do PNCP. */
export function itemDaLinha(linha: Record<string, unknown>): ItemAcompanhamento | null {
  const numeroItem = numeroOuNull(linha.numero_item);
  if (numeroItem === null || !Number.isInteger(numeroItem)) return null;
  const catalogoId = numeroOuNull(linha.catalogo_id);
  const mos = linha.material_ou_servico;
  const temResultado = linha.tem_resultado === true;
  const item: ItemAcompanhamento = {
    numeroItem,
    descricao: textoOuNull(linha.descricao),
    quantidade: numeroOuNull(linha.quantidade),
    unidade: textoOuNull(linha.unidade_medida),
    valorUnitarioEstimado: numeroOuNull(linha.valor_unitario_estimado),
    situacaoCompraItemNome: textoOuNull(linha.situacao),
    temResultado,
    resultados: [],
    catalogoCodigoItem: textoOuNull(linha.catalogo_codigo_item),
    catalogoId: catalogoId !== null && Number.isInteger(catalogoId) && catalogoId > 0 ? catalogoId : null,
    catalogoNome: null,
    materialOuServico: mos === "M" || mos === "S" ? mos : null,
  };
  if (temResultado) item.resultadosErro = RESULTADOS_NAO_CONSULTADOS;
  return item;
}

export const COLUNAS_ITENS_COPIA =
  "numero_item,descricao,quantidade,unidade_medida,valor_unitario_estimado,situacao,tem_resultado," +
  "catalogo_codigo_item,catalogo_id,material_ou_servico";

/**
 * Itens gravados pelo coletor. null = falha na leitura ou linha sem numero_item válido (cópia que não dá para
 * mostrar inteira não é mostrada: lista cortada pareceria completa).
 */
export async function itensDaCopiaLocal(
  client: SupabaseClient,
  licitacaoId: number,
): Promise<Copia<ItemAcompanhamento> | null> {
  try {
    const linhas = await lerLinhas(client, "licitacao_itens", COLUNAS_ITENS_COPIA, licitacaoId, "numero_item");
    if (!linhas) return null;
    const dados: ItemAcompanhamento[] = [];
    for (const linha of linhas) {
      const item = itemDaLinha(linha);
      if (!item) {
        console.warn("[api-dashboard-oportunidades] cópia local de itens com linha inválida; cópia descartada");
        return null;
      }
      dados.push(item);
    }
    // licitacao_itens não guarda quando a linha foi atualizada: data desconhecida (nunca inventada).
    return { dados, gravadoEm: null };
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
      "id,secao,nome_original,arquivo_origem,data_documento,raw,removido_do_portal_em,last_seen_at",
      licitacaoId,
      "id",
    );
    if (!linhas) return null;
    let gravadoEm: string | null = null;
    const dados: ArquivoAcompanhamento[] = [];
    for (const linha of linhas) {
      const m = typeof linha.arquivo_origem === "string" ? linha.arquivo_origem.match(ORIGEM_PNCP_RE) : null;
      if (linha.secao !== "processo" || !m || linha.removido_do_portal_em) continue;
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
      // last_seen_at: última passada do coletor que viu o documento no PNCP
      gravadoEm = maiorData(gravadoEm, linha.last_seen_at);
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
): S & { origem?: "copia_local" | "busca_pncp"; copia_gravada_em?: string | null } {
  if (!precisaDaCopia(secao) || !copia || copia.dados.length === 0) return secao;
  return {
    ...secao,
    dados: copia.dados,
    total: copia.dados.length,
    origem: "copia_local",
    copia_gravada_em: copia.gravadoEm,
  };
}
