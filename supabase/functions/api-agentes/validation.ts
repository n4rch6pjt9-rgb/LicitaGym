import type { PropostaItem } from "../_shared/agentes/preco.ts";
import type { Agente } from "../_shared/agentes/tipos.ts";
import { sanitizeSearchTerm } from "../_shared/busca.ts";

export const MAX_PROPOSTA = 500;
const MAX_NOTA = 2000;
/** Agentes que a Edge executa (spec 0035, R-4): o catálogo só mostra; código fora desta lista dá 400. */
export const AGENTES_EXECUTAVEIS: readonly Agente[] = ["edital", "preco", "juridico"];
/** Agentes com rota própria e busca de oportunidade (K-0). */
export const AGENTES_COM_ROTA = ["edital", "juridico"] as const;
export type AgenteComRota = typeof AGENTES_COM_ROTA[number];
export const POR_PAGINA = 20;
export const MAX_POR_PAGINA = 50;

export type DecisaoRevisao = "aprovada" | "rejeitada";

export type Acao =
  | { action: "analise_executar"; licitacao_id: number; proposta: PropostaItem[] | null; agentes: Agente[] | null }
  | { action: "analise_obter"; licitacao_id: number; somente_enviadas: boolean }
  | { action: "analise_revisar"; execucao_id: number; decisao: DecisaoRevisao; nota: string | null }
  | { action: "analise_enviar"; execucao_id: number }
  | { action: "oportunidades_buscar"; agente: AgenteComRota; busca: string | null; pagina: number; por_pagina: number }
  | { action: "documentos_listar"; licitacao_id: number };

const idPositivo = (v: unknown): number | null =>
  typeof v === "number" && Number.isInteger(v) && v > 0 ? v : null;

function proposta(v: unknown): PropostaItem[] | null | { error: string } {
  if (v === undefined || v === null) return null;
  if (!Array.isArray(v)) return { error: "'proposta' deve ser uma lista." };
  if (v.length > MAX_PROPOSTA) return { error: `'proposta' aceita no máximo ${MAX_PROPOSTA} itens.` };
  const vistos = new Set<number>();
  const itens: PropostaItem[] = [];
  for (const bruto of v) {
    if (typeof bruto !== "object" || bruto === null || Array.isArray(bruto)) return { error: "Item de proposta inválido." };
    const item = bruto as Record<string, unknown>;
    const numero = idPositivo(item.numero_item);
    if (!numero) return { error: "'numero_item' da proposta deve ser inteiro positivo." };
    if (vistos.has(numero)) return { error: "'numero_item' repetido na proposta." };
    if (typeof item.preco_unitario_centavos !== "number" || !Number.isInteger(item.preco_unitario_centavos) || item.preco_unitario_centavos <= 0) {
      return { error: "'preco_unitario_centavos' deve ser inteiro positivo." };
    }
    if (item.custo_zero !== undefined && typeof item.custo_zero !== "boolean") {
      return { error: "'custo_zero' deve ser booleano." };
    }
    vistos.add(numero);
    itens.push({
      numero_item: numero,
      preco_unitario_centavos: item.preco_unitario_centavos,
      ...(item.custo_zero === undefined ? {} : { custo_zero: item.custo_zero }),
    });
  }
  return itens;
}

function nota(v: unknown, obrigatoria: boolean): string | null | { error: string } {
  if (v === undefined || v === null) {
    return obrigatoria ? { error: "Rejeitar exige nota." } : null;
  }
  if (typeof v !== "string") return { error: "'nota' deve ser texto." };
  const texto = v.trim();
  if (texto.length > MAX_NOTA) return { error: `'nota' aceita até ${MAX_NOTA} caracteres.` };
  if (obrigatoria && texto.length === 0) return { error: "Rejeitar exige nota." };
  return texto.length === 0 ? null : texto;
}

/** K-2 / R-5: lista opcional de agentes. `juridico` puxa edital e preço (usa os sinais dos dois); `preco` sem
 * `juridico` não entra nesta spec. null = os três (comportamento anterior). */
function agentes(v: unknown): Agente[] | null | { error: string } {
  if (v === undefined || v === null) return null;
  if (!Array.isArray(v) || v.length === 0) return { error: "'agentes' deve ser uma lista não vazia." };
  const pedidos = new Set<Agente>();
  for (const a of v) {
    if (typeof a !== "string" || !(AGENTES_EXECUTAVEIS as readonly string[]).includes(a)) {
      return { error: `Agente desconhecido: ${typeof a === "string" ? a.slice(0, 40) : String(a)}.` };
    }
    pedidos.add(a as Agente);
  }
  if (pedidos.has("preco") && !pedidos.has("juridico")) return { error: "O agente de preço sozinho ainda não roda por esta ação." };
  if (pedidos.has("juridico")) pedidos.add("edital").add("preco");
  return AGENTES_EXECUTAVEIS.filter((a) => pedidos.has(a));
}

function pagina(v: unknown, padrao: number, max: number): number | null {
  if (v === undefined || v === null) return padrao;
  return typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= max ? v : null;
}

const erro = (x: unknown): x is { error: string } => typeof x === "object" && x !== null && "error" in x;

export function parseActionFromBody(body: Record<string, unknown>): Acao | { error: string } {
  switch (body.action) {
    case "analise_executar": {
      const licitacao_id = idPositivo(body.licitacao_id);
      if (!licitacao_id) return { error: "'licitacao_id' deve ser inteiro positivo." };
      const p = proposta(body.proposta);
      if (erro(p)) return p;
      const a = agentes(body.agentes);
      if (erro(a)) return a;
      return { action: "analise_executar", licitacao_id, proposta: p, agentes: a };
    }
    case "analise_obter": {
      const licitacao_id = idPositivo(body.licitacao_id);
      if (!licitacao_id) return { error: "'licitacao_id' deve ser inteiro positivo." };
      if (body.somente_enviadas !== undefined && typeof body.somente_enviadas !== "boolean") {
        return { error: "'somente_enviadas' deve ser true ou false." };
      }
      return { action: "analise_obter", licitacao_id, somente_enviadas: body.somente_enviadas === true };
    }
    case "analise_enviar": {
      const execucao_id = idPositivo(body.execucao_id);
      if (!execucao_id) return { error: "'execucao_id' deve ser inteiro positivo." };
      return { action: "analise_enviar", execucao_id };
    }
    case "oportunidades_buscar": {
      if (!(AGENTES_COM_ROTA as readonly unknown[]).includes(body.agente)) {
        return { error: `'agente' deve ser um de: ${AGENTES_COM_ROTA.join(", ")}.` };
      }
      if (body.busca !== undefined && body.busca !== null && typeof body.busca !== "string") return { error: "'busca' deve ser texto." };
      const pag = pagina(body.pagina, 1, 10_000);
      if (pag === null) return { error: "'pagina' deve ser inteiro positivo." };
      const por = pagina(body.por_pagina, POR_PAGINA, MAX_POR_PAGINA);
      if (por === null) return { error: `'por_pagina' deve ser inteiro de 1 a ${MAX_POR_PAGINA}.` };
      return { action: "oportunidades_buscar", agente: body.agente as AgenteComRota, busca: sanitizeSearchTerm(body.busca) ?? null, pagina: pag, por_pagina: por };
    }
    case "documentos_listar": {
      const licitacao_id = idPositivo(body.licitacao_id);
      if (!licitacao_id) return { error: "'licitacao_id' deve ser inteiro positivo." };
      return { action: "documentos_listar", licitacao_id };
    }
    case "analise_revisar": {
      const execucao_id = idPositivo(body.execucao_id);
      if (!execucao_id) return { error: "'execucao_id' deve ser inteiro positivo." };
      if (body.decisao !== "aprovada" && body.decisao !== "rejeitada") return { error: "'decisao' deve ser aprovada ou rejeitada." };
      const n = nota(body.nota, body.decisao === "rejeitada");
      if (erro(n)) return n;
      return { action: "analise_revisar", execucao_id, decisao: body.decisao, nota: n };
    }
    default:
      return { error: "Ação inválida." };
  }
}
