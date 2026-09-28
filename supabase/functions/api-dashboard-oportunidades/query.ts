import type { LicitacaoFiltros } from "./types.ts";
import { getNextDayIso, isDateOnly } from "./validation.ts";

/**
 * Sanitiza termo para busca literal.
 * Regras:
 * - Normaliza para Unicode NFC.
 * - Usa allowlist: caracteres que não sejam letras (\p{L}), números (\p{N}), espaços (\s) ou hífen (-) viram espaço.
 *   (remove curingas %, _, *, barras invertidas \, aspas, vírgulas, parênteses, etc).
 * - Colapsa espaços consecutivos.
 * - Trunca em no máximo 200 caracteres.
 * - Se ficar vazio, retorna undefined (ignora o filtro).
 */
export function sanitizeSearchTerm(val: unknown): string | undefined {
  if (typeof val !== "string") return undefined;
  const nfc = val.normalize("NFC");
  const filtered = nfc.replace(/[^\p{L}\p{N}\s-]/gu, " ");
  const collapsed = filtered.replace(/\s+/g, " ").trim();
  if (collapsed.length === 0) return undefined;
  const truncated = collapsed.slice(0, 200).trim();
  return truncated.length > 0 ? truncated : undefined;
}

/**
 * Interface abstrata do builder Supabase PostgREST para permitir testes unitários
 * sem mockar todo o SDK do Supabase.
 */
export interface FilterableQuery {
  eq(column: string, value: unknown): this;
  in(column: string, values: unknown[]): this;
  gte(column: string, value: unknown): this;
  lte(column: string, value: unknown): this;
  lt(column: string, value: unknown): this;
  ilike(column: string, pattern: string): this;
  or(filters: string): this;
}

export function toUtc3DateBoundary(
  dateOnlyStr: string,
  boundary: "start" | "next_day_start",
): string {
  if (boundary === "start") {
    return `${dateOnlyStr}T00:00:00-03:00`;
  }
  const nextDay = getNextDayIso(dateOnlyStr);
  return `${nextDay}T00:00:00-03:00`;
}

/**
 * Aplica os filtros de LicitacaoFiltros a uma query PostgREST.
 */
export function applyLicitacaoFilters<T extends FilterableQuery>(
  query: T,
  filtros: LicitacaoFiltros,
): T {
  if (filtros.prioridade) {
    query.eq("prioridade", filtros.prioridade);
  }

  if (filtros.uf) {
    query.eq("uf", filtros.uf);
  }

  if (filtros.municipio) {
    query.ilike("municipio", `%${filtros.municipio}%`);
  }

  if (filtros.orgao_cnpj) {
    query.eq("orgao_cnpj", filtros.orgao_cnpj);
  }

  if (filtros.orgao_nome) {
    query.ilike("orgao_nome", `%${filtros.orgao_nome}%`);
  }

  if (filtros.modalidade && filtros.modalidade.length > 0) {
    if (filtros.modalidade.length === 1) {
      query.eq("modalidade", filtros.modalidade[0]);
    } else {
      query.in("modalidade", filtros.modalidade);
    }
  }

  if (filtros.situacao) {
    query.eq("situacao", filtros.situacao);
  }

  if (filtros.fase) {
    query.eq("fase", filtros.fase);
  }

  if (filtros.categoria_escopo) {
    query.eq("categoria_escopo", filtros.categoria_escopo);
  }

  if (filtros.interesse_borracha !== undefined) {
    query.eq("interesse_borracha", filtros.interesse_borracha);
  }

  if (filtros.fonte) {
    query.eq("fonte", filtros.fonte);
  }

  // Intervalo de data_publicacao (America/Sao_Paulo UTC-3 para só-data)
  if (filtros.data_publicacao_inicio) {
    if (isDateOnly(filtros.data_publicacao_inicio)) {
      query.gte("data_publicacao", toUtc3DateBoundary(filtros.data_publicacao_inicio, "start"));
    } else {
      query.gte("data_publicacao", filtros.data_publicacao_inicio);
    }
  }
  if (filtros.data_publicacao_fim) {
    if (isDateOnly(filtros.data_publicacao_fim)) {
      query.lt("data_publicacao", toUtc3DateBoundary(filtros.data_publicacao_fim, "next_day_start"));
    } else {
      query.lte("data_publicacao", filtros.data_publicacao_fim);
    }
  }

  // Intervalo de data_inicio
  if (filtros.data_inicio_min) {
    if (isDateOnly(filtros.data_inicio_min)) {
      query.gte("data_inicio", toUtc3DateBoundary(filtros.data_inicio_min, "start"));
    } else {
      query.gte("data_inicio", filtros.data_inicio_min);
    }
  }
  if (filtros.data_inicio_max) {
    if (isDateOnly(filtros.data_inicio_max)) {
      query.lt("data_inicio", toUtc3DateBoundary(filtros.data_inicio_max, "next_day_start"));
    } else {
      query.lte("data_inicio", filtros.data_inicio_max);
    }
  }

  // Intervalo de data_fim
  if (filtros.data_fim_min) {
    if (isDateOnly(filtros.data_fim_min)) {
      query.gte("data_fim", toUtc3DateBoundary(filtros.data_fim_min, "start"));
    } else {
      query.gte("data_fim", filtros.data_fim_min);
    }
  }
  if (filtros.data_fim_max) {
    if (isDateOnly(filtros.data_fim_max)) {
      query.lt("data_fim", toUtc3DateBoundary(filtros.data_fim_max, "next_day_start"));
    } else {
      query.lte("data_fim", filtros.data_fim_max);
    }
  }

  // Intervalo de data_homologacao
  if (filtros.data_homologacao_min) {
    if (isDateOnly(filtros.data_homologacao_min)) {
      query.gte("data_homologacao", toUtc3DateBoundary(filtros.data_homologacao_min, "start"));
    } else {
      query.gte("data_homologacao", filtros.data_homologacao_min);
    }
  }
  if (filtros.data_homologacao_max) {
    if (isDateOnly(filtros.data_homologacao_max)) {
      query.lt("data_homologacao", toUtc3DateBoundary(filtros.data_homologacao_max, "next_day_start"));
    } else {
      query.lte("data_homologacao", filtros.data_homologacao_max);
    }
  }

  // Faixa de valor_total
  if (filtros.valor_min !== undefined) {
    query.gte("valor_total", filtros.valor_min);
  }
  if (filtros.valor_max !== undefined) {
    query.lte("valor_total", filtros.valor_max);
  }

  // Termo livre em objeto / numero_processo / numero_edital
  if (filtros.busca) {
    // No PostgREST .or(): coluna.ilike.*termo*
    query.or(
      `objeto.ilike.*${filtros.busca}*,numero_processo.ilike.*${filtros.busca}*,numero_edital.ilike.*${filtros.busca}*`,
    );
  }

  return query;
}

export function calculateRange(page: number, limit: number): { from: number; to: number } {
  const safePage = page > 0 ? page : 1;
  const safeLimit = limit > 0 ? limit : 20;
  const from = (safePage - 1) * safeLimit;
  const to = from + safeLimit - 1;
  return { from, to };
}
