import type { LicitacaoFiltros } from "./types.ts";
import { getNextDayIso, isDateOnly } from "./validation.ts";

/**
 * Sanitiza texto para uso em operadores PostgREST .or() e .ilike()
 * Remove caracteres de controle ou vírgulas/parênteses que quebram o parsing do PostgREST.
 */
export function sanitizeSearchTerm(term: string): string {
  return term.replace(/[,()"]/g, " ").replace(/\s+/g, " ").trim();
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
    query.ilike("municipio", `%${sanitizeSearchTerm(filtros.municipio)}%`);
  }

  if (filtros.orgao_cnpj) {
    query.eq("orgao_cnpj", filtros.orgao_cnpj);
  }

  if (filtros.orgao_nome) {
    query.ilike("orgao_nome", `%${sanitizeSearchTerm(filtros.orgao_nome)}%`);
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

  // Intervalo de data_publicacao
  if (filtros.data_publicacao_inicio) {
    query.gte("data_publicacao", filtros.data_publicacao_inicio);
  }
  if (filtros.data_publicacao_fim) {
    if (isDateOnly(filtros.data_publicacao_fim)) {
      query.lt("data_publicacao", getNextDayIso(filtros.data_publicacao_fim));
    } else {
      query.lte("data_publicacao", filtros.data_publicacao_fim);
    }
  }

  // Intervalo de data_inicio
  if (filtros.data_inicio_min) {
    query.gte("data_inicio", filtros.data_inicio_min);
  }
  if (filtros.data_inicio_max) {
    if (isDateOnly(filtros.data_inicio_max)) {
      query.lt("data_inicio", getNextDayIso(filtros.data_inicio_max));
    } else {
      query.lte("data_inicio", filtros.data_inicio_max);
    }
  }

  // Intervalo de data_fim
  if (filtros.data_fim_min) {
    query.gte("data_fim", filtros.data_fim_min);
  }
  if (filtros.data_fim_max) {
    if (isDateOnly(filtros.data_fim_max)) {
      query.lt("data_fim", getNextDayIso(filtros.data_fim_max));
    } else {
      query.lte("data_fim", filtros.data_fim_max);
    }
  }

  // Intervalo de data_homologacao
  if (filtros.data_homologacao_min) {
    query.gte("data_homologacao", filtros.data_homologacao_min);
  }
  if (filtros.data_homologacao_max) {
    if (isDateOnly(filtros.data_homologacao_max)) {
      query.lt("data_homologacao", getNextDayIso(filtros.data_homologacao_max));
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
    const cleanTerm = sanitizeSearchTerm(filtros.busca);
    if (cleanTerm.length > 0) {
      // No PostgREST .or(): coluna.ilike.*termo*
      query.or(
        `objeto.ilike.*${cleanTerm}*,numero_processo.ilike.*${cleanTerm}*,numero_edital.ilike.*${cleanTerm}*`,
      );
    }
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
