// PDM e unidade de fornecimento de cada item do acompanhamento (spec 0009, CA-8), para a aba "Inteligência de Preços"
// do Dashboard cruzar o valor unitário estimado com a api-precos (resumo por PDM e unidade).
//
// PDM, por ordem (fonte oficial manda):
//   1. catalogo_pncp: o item tem código CATMAT oficial (catalogoId 1, material) e public.catmat_itens dá o PDM;
//   2. casamento_texto: senão, public.licitacao_match (origem texto_item) casou o texto do item com exatamente um PDM.
//      É derivado (padrões de texto do catálogo), por isso a origem vai junto.
//   Serviço, mais de um PDM pelo texto, nenhum PDM ou consulta falha: codigoPdm null, com o motivo.
//   Consulta falha não cai na outra fonte (o texto poderia contradizer o código oficial).
// Unidade: o PNCP manda `unidadeMedida` em texto livre ("Unidade", "UND", "UNIDADE (UN)"...); a Pesquisa de Preço usa
//   a sigla de fornecimento do Compras.gov (UN, PAR, M2, RO). A sigla sai de um dicionário fechado; embalagem com
//   quantidade ("CAIXA 1,00 PAR"), mistura ou forma desconhecida fica null, para o front não comparar. O texto original
//   continua em `unidade`.
import { SupabaseClient } from "npm:@supabase/supabase-js@2";
import type { ItemAcompanhamento } from "./types.ts";

export type OrigemPdm = "catalogo_pncp" | "casamento_texto";
export const ORIGEM_UNIDADE_SIGLA = "normalizada_da_unidade_pncp";

export const MOTIVO_SERVICO = "Item de serviço: a Pesquisa de Preço do PDM é de material.";
export const MOTIVO_SEM_PDM = "Item sem PDM: sem código CATMAT no PNCP e sem casamento pelo texto.";
export const MOTIVO_INDISPONIVEL = "Consulta do PDM indisponível agora; tente de novo.";

/** Forma escrita (sem acento, maiúscula, sem ponto final) → sigla de fornecimento da Pesquisa de Preço. */
const SIGLAS: Record<string, string> = {
  UN: "UN",
  UND: "UN",
  UNID: "UN",
  UNI: "UN",
  UNIDADE: "UN",
  UNIDADES: "UN",
  PAR: "PAR",
  PARES: "PAR",
  M2: "M2",
  MT2: "M2",
  "METRO QUADRADO": "M2",
  "METROS QUADRADOS": "M2",
  RO: "RO",
  ROLO: "RO",
  ROLOS: "RO",
};

function chave(s: string): string {
  return s.normalize("NFKD").replace(/[̀-ͯ]/g, "").toUpperCase().replace(/\s+/g, " ").trim().replace(/\.$/, "");
}

/**
 * Sigla de fornecimento da unidade do PNCP, ou null quando não dá para afirmar. Aceita a forma simples ("Unidade") e
 * as duplas "X (Y)" e "X - Y" só quando as duas partes dão a mesma sigla.
 */
export function siglaUnidadeFornecimento(unidade: string | null | undefined): string | null {
  if (typeof unidade !== "string") return null;
  const k = chave(unidade);
  if (!k) return null;
  if (k in SIGLAS) return SIGLAS[k];
  const dupla = k.match(/^(.+?)\s*\((.+)\)$/) ?? k.match(/^(.+?)\s+-\s+(.+)$/);
  if (!dupla) return null;
  const a = SIGLAS[chave(dupla[1])];
  const b = SIGLAS[chave(dupla[2])];
  return a && a === b ? a : null;
}

export interface EntradaPdm {
  material: "M" | "S" | null;
  /** Item com código CATMAT oficial (catalogoId 1, material, código numérico). */
  temCodigoCatmat: boolean;
  /** PDM do código oficial em catmat_itens; null = código ausente da base local. */
  pdmCatalogo: number | null;
  catalogoFalhou: boolean;
  /** PDMs distintos casados pelo texto do item, em ordem crescente. */
  pdmsTexto: number[];
  textoFalhou: boolean;
}

export interface PdmDoItem {
  codigoPdm: number | null;
  codigoPdmOrigem: OrigemPdm | null;
  codigoPdmMotivo: string | null;
}

export function decidirPdmDoItem(e: EntradaPdm): PdmDoItem {
  const sem = (motivo: string): PdmDoItem => ({ codigoPdm: null, codigoPdmOrigem: null, codigoPdmMotivo: motivo });
  if (e.material === "S") return sem(MOTIVO_SERVICO);
  if (e.temCodigoCatmat) {
    if (e.catalogoFalhou) return sem(MOTIVO_INDISPONIVEL);
    if (e.pdmCatalogo !== null) return { codigoPdm: e.pdmCatalogo, codigoPdmOrigem: "catalogo_pncp", codigoPdmMotivo: null };
  }
  if (e.textoFalhou) return sem(MOTIVO_INDISPONIVEL);
  if (e.pdmsTexto.length === 1) return { codigoPdm: e.pdmsTexto[0], codigoPdmOrigem: "casamento_texto", codigoPdmMotivo: null };
  if (e.pdmsTexto.length > 1) {
    return sem(`Mais de um PDM casou pelo texto do item (${e.pdmsTexto.join(", ")}): sem PDM único para comparar.`);
  }
  return sem(MOTIVO_SEM_PDM);
}

function inteiroPositivo(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" && /^\d+$/.test(v.trim()) ? Number(v.trim()) : NaN;
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

function codigoCatmat(it: ItemAcompanhamento): number | null {
  if (it.catalogoId !== 1 || it.materialOuServico !== "M") return null;
  return inteiroPositivo(it.catalogoCodigoItem);
}

/** PDM por código CATMAT oficial (catmat_itens). null = falhou. */
async function pdmsDoCatalogo(client: SupabaseClient, codigos: number[]): Promise<Map<number, number> | null> {
  const mapa = new Map<number, number>();
  if (codigos.length === 0) return mapa;
  try {
    const { data, error } = await client.from("catmat_itens").select("codigo_item,codigo_pdm").in("codigo_item", codigos);
    if (error || !Array.isArray(data)) {
      console.warn("[api-dashboard-oportunidades] PDM do código CATMAT indisponível (catmat_itens):", error ?? "resposta inválida");
      return null;
    }
    for (const r of data as Array<{ codigo_item: unknown; codigo_pdm: unknown }>) {
      const item = inteiroPositivo(r.codigo_item);
      const pdm = inteiroPositivo(r.codigo_pdm);
      if (item !== null && pdm !== null) mapa.set(item, pdm);
    }
    return mapa;
  } catch (e) {
    console.warn("[api-dashboard-oportunidades] PDM do código CATMAT indisponível:", e instanceof Error ? e.message : String(e));
    return null;
  }
}

/** PDMs casados pelo texto, por numero_item da licitação (licitacao_itens + licitacao_match). null = falhou. */
async function pdmsDoTexto(client: SupabaseClient, licitacaoId: number): Promise<Map<number, number[]> | null> {
  try {
    const [itensRes, matchRes] = await Promise.all([
      client.from("licitacao_itens").select("id,numero_item").eq("licitacao_id", licitacaoId),
      client.from("licitacao_match").select("item_id,codigo_pdm,origem").eq("licitacao_id", licitacaoId).eq("origem", "texto_item"),
    ]);
    if (itensRes.error || !Array.isArray(itensRes.data) || matchRes.error || !Array.isArray(matchRes.data)) {
      console.warn(
        "[api-dashboard-oportunidades] PDM pelo texto indisponível (licitacao_itens/licitacao_match):",
        itensRes.error ?? matchRes.error ?? "resposta inválida",
      );
      return null;
    }
    const numeroPorId = new Map<number, number>();
    for (const r of itensRes.data as Array<{ id: unknown; numero_item: unknown }>) {
      const id = inteiroPositivo(r.id);
      const numero = inteiroPositivo(r.numero_item);
      if (id !== null && numero !== null) numeroPorId.set(id, numero);
    }
    const porNumero = new Map<number, Set<number>>();
    for (const r of matchRes.data as Array<{ item_id: unknown; codigo_pdm: unknown }>) {
      const id = inteiroPositivo(r.item_id);
      const pdm = inteiroPositivo(r.codigo_pdm);
      const numero = id === null ? undefined : numeroPorId.get(id);
      if (numero === undefined || pdm === null) continue;
      if (!porNumero.has(numero)) porNumero.set(numero, new Set());
      porNumero.get(numero)!.add(pdm);
    }
    return new Map([...porNumero].map(([n, s]) => [n, [...s].sort((a, b) => a - b)]));
  } catch (e) {
    console.warn("[api-dashboard-oportunidades] PDM pelo texto indisponível:", e instanceof Error ? e.message : String(e));
    return null;
  }
}

/** Acrescenta PDM e sigla da unidade a cada item (cópias; a lista do cache não muda). Nunca lança. */
export async function anexarReferenciaPreco(
  client: SupabaseClient,
  licitacaoId: number,
  itens: ItemAcompanhamento[],
): Promise<ItemAcompanhamento[]> {
  if (itens.length === 0) return itens;
  const codigos = [...new Set(itens.map(codigoCatmat).filter((c): c is number => c !== null))];
  const precisaTexto = itens.some((it) => it.materialOuServico !== "S");
  const [catalogo, texto] = await Promise.all([
    pdmsDoCatalogo(client, codigos),
    precisaTexto ? pdmsDoTexto(client, licitacaoId) : Promise.resolve(new Map<number, number[]>()),
  ]);
  return itens.map((it) => {
    const codigo = codigoCatmat(it);
    const pdm = decidirPdmDoItem({
      material: it.materialOuServico,
      temCodigoCatmat: codigo !== null,
      pdmCatalogo: codigo !== null ? catalogo?.get(codigo) ?? null : null,
      catalogoFalhou: catalogo === null,
      pdmsTexto: texto?.get(it.numeroItem) ?? [],
      textoFalhou: texto === null,
    });
    const sigla = siglaUnidadeFornecimento(it.unidade);
    return { ...it, ...pdm, unidadeSigla: sigla, unidadeSiglaOrigem: sigla === null ? null : ORIGEM_UNIDADE_SIGLA };
  });
}
