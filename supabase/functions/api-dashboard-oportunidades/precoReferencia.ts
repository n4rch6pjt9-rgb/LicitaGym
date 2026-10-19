// PDM e unidade de fornecimento de cada item do acompanhamento (spec 0009, CA-8), para a aba "Inteligência de Preços"
// do Dashboard cruzar o valor unitário estimado com a api-precos (resumo por PDM e unidade).
//
// PDM (fonte oficial manda):
//   1. catalogo_pncp: o item tem código CATMAT oficial (catalogoId 1, material) e public.catmat_itens dá o PDM.
//      Código oficial sem PDM na base local: null com motivo. Não cai no texto (que poderia contradizer o oficial).
//   2. casamento_texto: item sem código oficial; public.licitacao_match (origem texto_item) casou o texto do item com
//      exatamente um PDM. É derivado (padrões de texto do catálogo), por isso a origem vai junto.
//   Serviço, mais de um PDM pelo texto, nenhum PDM, item ainda não carregado em licitacao_itens ou consulta falha:
//   codigoPdm null, com o motivo.
//   O casamento por texto só vale quando está em dia: item em public.licitacao_match_pendente (texto alterado; o
//   trigger mantém as linhas antigas até licitacao_match_atualizar drenar a fila) ou carga nunca feita
//   (licitacao_match_estado.carregado_em nulo) dá "ainda não avaliado", nunca o PDM antigo nem "sem casamento".
// Leitura em lotes pequenos (bem abaixo do max_rows = 1000 do PostgREST); lote que volta cheio conta como falha, para
// uma lista cortada nunca virar "sem PDM" ou um PDM único falso.
// Unidade: o PNCP manda `unidadeMedida` em texto livre ("Unidade", "UND", "UNIDADE (UN)"...); a Pesquisa de Preço usa
//   a sigla de fornecimento do Compras.gov (em 19/10/2026: UN, PAR, P, M2, RO e nula). A sigla sai de um dicionário
//   fechado; embalagem com quantidade ("CAIXA 1,00 PAR"), mistura ou forma desconhecida fica null, para o front não
//   comparar. O texto original continua em `unidade`.
import { SupabaseClient } from "npm:@supabase/supabase-js@2";
import type { ItemAcompanhamento } from "./types.ts";

export type OrigemPdm = "catalogo_pncp" | "casamento_texto";
export const ORIGEM_UNIDADE_SIGLA = "normalizada_da_unidade_pncp";

export const MOTIVO_SERVICO = "Item de serviço: a Pesquisa de Preço do PDM é de material.";
export const MOTIVO_SEM_PDM = "Item sem PDM: sem código CATMAT no PNCP e sem casamento pelo texto.";
export const MOTIVO_INDISPONIVEL = "Consulta do PDM indisponível agora; tente de novo.";
export const MOTIVO_NAO_CARREGADO = "Item ainda não carregado na base: o casamento pelo texto não foi avaliado.";
export const MOTIVO_PENDENTE =
  "Texto do item em recálculo (casamento pendente): o PDM pelo texto ainda não foi avaliado.";
export const MOTIVO_SEM_CARGA =
  "Casamento pelo texto ainda não carregado na base: o PDM pelo texto não foi avaliado.";
export const motivoCodigoSemPdm = (codigo: number) =>
  `Código CATMAT ${codigo} sem PDM na base local (catmat_itens): sem PDM para comparar.`;

/** Lote das consultas `in`: com até 5 PDMs por item, 100 itens ficam abaixo de 1000 linhas. */
export const LOTE = 100;
/** Igual ao max_rows do PostgREST (supabase/config.toml, [api]); mudou lá, muda aqui. */
const MAX_ROWS = 1000;

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
  return s.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toUpperCase().replace(/\s+/g, " ").trim().replace(/\.$/, "");
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
  /** Código CATMAT oficial do item (catalogoId 1, material, numérico); null = não tem. */
  codigoCatmat: number | null;
  /** PDM do código oficial em catmat_itens; null = código ausente da base local. */
  pdmCatalogo: number | null;
  catalogoFalhou: boolean;
  /** O item (numeroItem) existe em licitacao_itens desta licitação. */
  carregado: boolean;
  /** O item está em licitacao_match_pendente (texto_item): as linhas de licitacao_match são as de antes. */
  pendente: boolean;
  /** licitacao_match nunca foi carregado (licitacao_match_estado.carregado_em nulo). */
  semCargaTexto: boolean;
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
  if (e.codigoCatmat !== null) {
    if (e.catalogoFalhou) return sem(MOTIVO_INDISPONIVEL);
    if (e.pdmCatalogo !== null) return { codigoPdm: e.pdmCatalogo, codigoPdmOrigem: "catalogo_pncp", codigoPdmMotivo: null };
    return sem(motivoCodigoSemPdm(e.codigoCatmat));
  }
  if (e.textoFalhou) return sem(MOTIVO_INDISPONIVEL);
  if (e.semCargaTexto) return sem(MOTIVO_SEM_CARGA);
  if (!e.carregado) return sem(MOTIVO_NAO_CARREGADO);
  if (e.pendente) return sem(MOTIVO_PENDENTE);
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

type Linhas = Array<Record<string, unknown>>;

/**
 * Roda `consulta` por lotes de `valores` e junta as linhas. null = falhou: erro, resposta inválida ou lote cheio
 * (PostgREST cortou em max_rows; a lista estaria incompleta).
 */
async function porLotes(
  rotulo: string,
  valores: number[],
  consulta: (lote: number[]) => PromiseLike<{ data: unknown; error: unknown }>,
): Promise<Linhas | null> {
  const linhas: Linhas = [];
  try {
    for (let i = 0; i < valores.length; i += LOTE) {
      const { data, error } = await consulta(valores.slice(i, i + LOTE));
      if (error || !Array.isArray(data)) {
        console.warn(`[api-dashboard-oportunidades] ${rotulo} indisponível:`, error ?? "resposta inválida");
        return null;
      }
      if (data.length >= MAX_ROWS) {
        console.warn(`[api-dashboard-oportunidades] ${rotulo}: lote com ${data.length} linhas (corte do PostgREST)`);
        return null;
      }
      linhas.push(...(data as Linhas));
    }
    return linhas;
  } catch (e) {
    console.warn(`[api-dashboard-oportunidades] ${rotulo} indisponível:`, e instanceof Error ? e.message : String(e));
    return null;
  }
}

/** PDM por código CATMAT oficial (catmat_itens). null = falhou. */
async function pdmsDoCatalogo(client: SupabaseClient, codigos: number[]): Promise<Map<number, number> | null> {
  const linhas = await porLotes(
    "PDM do código CATMAT (catmat_itens)",
    codigos,
    (lote) => client.from("catmat_itens").select("codigo_item,codigo_pdm").in("codigo_item", lote),
  );
  if (linhas === null) return null;
  const mapa = new Map<number, number>();
  for (const r of linhas) {
    const item = inteiroPositivo(r.codigo_item);
    const pdm = inteiroPositivo(r.codigo_pdm);
    if (item !== null && pdm !== null) mapa.set(item, pdm);
  }
  return mapa;
}

interface CasamentoTexto {
  /** PDMs por numero_item; itens fora de licitacao_itens ficam fora do mapa (não carregados). */
  pdms: Map<number, number[]>;
  /** numero_item em licitacao_match_pendente (texto_item). */
  pendentes: Set<number>;
  semCarga: boolean;
}

/** Carga do casamento já feita (licitacao_match_estado). null = falhou. */
async function cargaDoCasamentoFeita(client: SupabaseClient): Promise<boolean | null> {
  try {
    const { data, error } = await client.from("licitacao_match_estado").select("carregado_em");
    if (error || !Array.isArray(data)) {
      console.warn("[api-dashboard-oportunidades] estado do casamento indisponível (licitacao_match_estado):", error ?? "resposta inválida");
      return null;
    }
    return (data as Array<{ carregado_em: unknown }>).some((r) => r.carregado_em !== null && r.carregado_em !== undefined);
  } catch (e) {
    console.warn("[api-dashboard-oportunidades] estado do casamento indisponível:", e instanceof Error ? e.message : String(e));
    return null;
  }
}

/**
 * PDMs casados pelo texto, por numero_item (licitacao_itens + licitacao_match texto_item), com os itens pendentes de
 * recálculo (licitacao_match_pendente). null = falhou.
 */
async function pdmsDoTexto(
  client: SupabaseClient,
  licitacaoId: number,
  numeros: number[],
): Promise<CasamentoTexto | null> {
  const carga = await cargaDoCasamentoFeita(client);
  if (carga === null) return null;
  if (!carga) return { pdms: new Map(), pendentes: new Set(), semCarga: true };
  const itens = await porLotes(
    "itens da licitação (licitacao_itens)",
    numeros,
    (lote) => client.from("licitacao_itens").select("id,numero_item").eq("licitacao_id", licitacaoId).in("numero_item", lote),
  );
  if (itens === null) return null;
  const numeroPorId = new Map<number, number>();
  for (const r of itens) {
    const id = inteiroPositivo(r.id);
    const numero = inteiroPositivo(r.numero_item);
    if (id !== null && numero !== null) numeroPorId.set(id, numero);
  }
  // Fila antes do casamento: se a drenagem acontecer entre as leituras, o item continua pendente (conservador) em vez
  // de sair com as linhas antigas e sem a marca.
  const pendentesRows = await porLotes(
    "itens com casamento pendente (licitacao_match_pendente)",
    [...numeroPorId.keys()],
    (lote) => client.from("licitacao_match_pendente").select("ref_id").eq("origem", "texto_item").in("ref_id", lote),
  );
  if (pendentesRows === null) return null;
  const pendentes = new Set<number>();
  for (const r of pendentesRows) {
    const id = inteiroPositivo(r.ref_id);
    const numero = id === null ? undefined : numeroPorId.get(id);
    if (numero !== undefined) pendentes.add(numero);
  }
  const matches = await porLotes(
    "PDM pelo texto (licitacao_match)",
    [...numeroPorId.keys()],
    (lote) =>
      client.from("licitacao_match").select("item_id,codigo_pdm").eq("licitacao_id", licitacaoId).eq("origem", "texto_item")
        .in("item_id", lote),
  );
  if (matches === null) return null;
  const porNumero = new Map<number, Set<number>>([...numeroPorId.values()].map((n) => [n, new Set<number>()]));
  for (const r of matches) {
    const id = inteiroPositivo(r.item_id);
    const pdm = inteiroPositivo(r.codigo_pdm);
    const numero = id === null ? undefined : numeroPorId.get(id);
    if (numero !== undefined && pdm !== null) porNumero.get(numero)!.add(pdm);
  }
  return {
    pdms: new Map([...porNumero].map(([n, s]) => [n, [...s].sort((a, b) => a - b)])),
    pendentes,
    semCarga: false,
  };
}

/** Acrescenta PDM e sigla da unidade a cada item (cópias; a lista do cache não muda). Nunca lança. */
export async function anexarReferenciaPreco(
  client: SupabaseClient,
  licitacaoId: number,
  itens: ItemAcompanhamento[],
): Promise<ItemAcompanhamento[]> {
  if (itens.length === 0) return itens;
  const codigos = [...new Set(itens.map(codigoCatmat).filter((c): c is number => c !== null))];
  // Texto só para material/desconhecido sem código oficial.
  const numerosTexto = [
    ...new Set(itens.filter((it) => it.materialOuServico !== "S" && codigoCatmat(it) === null).map((it) => it.numeroItem)),
  ].filter((n) => Number.isSafeInteger(n) && n > 0);
  const [catalogo, texto] = await Promise.all([
    pdmsDoCatalogo(client, codigos),
    numerosTexto.length > 0
      ? pdmsDoTexto(client, licitacaoId, numerosTexto)
      : Promise.resolve<CasamentoTexto>({ pdms: new Map(), pendentes: new Set(), semCarga: false }),
  ]);
  return itens.map((it) => {
    const codigo = codigoCatmat(it);
    const pdm = decidirPdmDoItem({
      material: it.materialOuServico,
      codigoCatmat: codigo,
      pdmCatalogo: codigo !== null ? catalogo?.get(codigo) ?? null : null,
      catalogoFalhou: catalogo === null,
      carregado: texto?.pdms.has(it.numeroItem) ?? false,
      pendente: texto?.pendentes.has(it.numeroItem) ?? false,
      semCargaTexto: texto?.semCarga ?? false,
      pdmsTexto: texto?.pdms.get(it.numeroItem) ?? [],
      textoFalhou: texto === null,
    });
    const sigla = siglaUnidadeFornecimento(it.unidade);
    return { ...it, ...pdm, unidadeSigla: sigla, unidadeSiglaOrigem: sigla === null ? null : ORIGEM_UNIDADE_SIGLA };
  });
}
