import type { PropostaItem } from "../_shared/agentes/preco.ts";

export const MAX_PROPOSTA = 500;
const MAX_NOTA = 2000;

export type DecisaoRevisao = "aprovada" | "rejeitada";

export type Acao =
  | { action: "analise_executar"; licitacao_id: number; proposta: PropostaItem[] | null }
  | { action: "analise_obter"; licitacao_id: number }
  | { action: "analise_revisar"; execucao_id: number; decisao: DecisaoRevisao; nota: string | null };

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

const erro = (x: unknown): x is { error: string } => typeof x === "object" && x !== null && "error" in x;

export function parseActionFromBody(body: Record<string, unknown>): Acao | { error: string } {
  switch (body.action) {
    case "analise_executar": {
      const licitacao_id = idPositivo(body.licitacao_id);
      if (!licitacao_id) return { error: "'licitacao_id' deve ser inteiro positivo." };
      const p = proposta(body.proposta);
      if (erro(p)) return p;
      return { action: "analise_executar", licitacao_id, proposta: p };
    }
    case "analise_obter": {
      const licitacao_id = idPositivo(body.licitacao_id);
      if (!licitacao_id) return { error: "'licitacao_id' deve ser inteiro positivo." };
      return { action: "analise_obter", licitacao_id };
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
