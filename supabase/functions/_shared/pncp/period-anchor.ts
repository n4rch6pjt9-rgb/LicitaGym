import { SupabaseClient } from "npm:@supabase/supabase-js@2";
import type { PcaSearchPeriodSummary } from "./search-client.ts";
import { parsePncpTimestamp } from "./search-client.ts";

export type PeriodAnchorRow = {
  id: string;
  resource_type: string;
  scope_key: string;
  ano_exercicio: number;
  ultima_data_publicacao: string | null;
  ultima_data_atualizacao: string | null;
  total_indexado: number | null;
  ultima_verificacao: string;
  ultima_carga_completa: string | null;
  metadata: Record<string, unknown>;
};

export type PcaScopedProbe = {
  codigo_classificacao: string;
  total_registros: number;
};

const RESOURCE = "pca_search";
const SCOPE = "pcaorgao";

export function buildTotalRegistrosClasseMap(
  probes: PcaScopedProbe[],
): Record<string, number> {
  return Object.fromEntries(
    probes.map((p) => [p.codigo_classificacao, p.total_registros]),
  );
}

function scopedTotalsChanged(
  anchor: PeriodAnchorRow | null,
  probes: PcaScopedProbe[],
): string | null {
  if (!probes.length || !anchor?.metadata) return null;
  const prev = anchor.metadata.total_registros_classe as
    | Record<string, number>
    | undefined;
  if (!prev || !Object.keys(prev).length) return null;

  for (const probe of probes) {
    const before = prev[probe.codigo_classificacao];
    if (before === undefined) {
      return `classe_nova:${probe.codigo_classificacao}`;
    }
    if (probe.total_registros !== before) {
      return probe.total_registros > before
        ? `total_registros_classe_cresceu:${probe.codigo_classificacao}`
        : `total_registros_classe_diminuiu:${probe.codigo_classificacao}`;
    }
  }
  return null;
}

export async function getPeriodAnchor(
  client: SupabaseClient,
  ano: number,
): Promise<PeriodAnchorRow | null> {
  const { data, error } = await client.schema("private")
    .from("pncp_period_anchor")
    .select("*")
    .eq("resource_type", RESOURCE)
    .eq("scope_key", SCOPE)
    .eq("ano_exercicio", ano)
    .maybeSingle();
  if (error) throw error;
  return data as PeriodAnchorRow | null;
}

/**
 * Decide se pula carga anual. Sinal primário: totalRegistros por classe (Consulta).
 * Sinal secundário: max_data_atualizacao do Search (pcaorgao).
 */
export function shouldSkipAnnualLoad(
  anchor: PeriodAnchorRow | null,
  summary: PcaSearchPeriodSummary | null,
  scopedProbes: PcaScopedProbe[] = [],
): { skip: boolean; reason: string | null } {
  if (!anchor?.ultima_carga_completa) return { skip: false, reason: null };
  const raw = anchor.metadata?.carga_completa;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { skip: false, reason: "carga_anterior_sem_escopo_comprovado" };
  }
  const carga = raw as Record<string, unknown>;
  if (
    carga.version !== 1 || !carga.total_registros_classe || !scopedProbes.length ||
    scopedProbes.some((p) => !Number.isSafeInteger(p.total_registros) || p.total_registros < 0)
  ) {
    return { skip: false, reason: "carga_anterior_sem_escopo_comprovado" };
  }
  if (!summary || !Number.isSafeInteger(summary.total_indexado) || summary.total_indexado < 0) {
    return { skip: false, reason: "search_indisponivel" };
  }
  if (summary.total_indexado !== carga.total_indexado) {
    return { skip: false, reason: "total_indexado_alterado" };
  }
  const scopedChange = scopedTotalsChanged({ ...anchor, metadata: carga }, scopedProbes);
  if (scopedChange) return { skip: false, reason: scopedChange };
  const snapshotTotals = carga.total_registros_classe as Record<string, unknown>;
  if (scopedProbes.some((p) => snapshotTotals[p.codigo_classificacao] !== p.total_registros)) {
    return { skip: false, reason: "escopo_nao_comprovado" };
  }
  const anterior = typeof carga.ultima_data_atualizacao === "string"
    ? parsePncpTimestamp(carga.ultima_data_atualizacao)
    : null;
  const atual = summary.max_data_atualizacao ? parsePncpTimestamp(summary.max_data_atualizacao) : null;
  if (anterior === null || atual === null) {
    const vazio = summary.total_indexado === 0 && scopedProbes.every((p) => p.total_registros === 0);
    return { skip: vazio, reason: vazio ? "periodo_inalterado_desde_ultima_carga" : "data_search_nao_comprovada" };
  }
  if (anterior !== atual) return { skip: false, reason: "indice_search_atualizado" };
  return { skip: true, reason: "periodo_inalterado_desde_ultima_carga" };
}

function summaryMetadata(summary: PcaSearchPeriodSummary | null) {
  if (!summary) return {};
  return {
    min_data_publicacao_amostra: summary.min_data_publicacao_amostra,
    amostra: summary.amostra,
    orgaos_amostra: summary.orgaos_amostra,
  };
}

export async function upsertPeriodProbe(
  client: SupabaseClient,
  summary: PcaSearchPeriodSummary | null,
  extraMetadata: Record<string, unknown> = {},
  anoFallback?: number,
) {
  const ano = summary?.ano ?? anoFallback;
  if (ano === undefined) {
    throw new Error("upsertPeriodProbe: ano obrigatorio");
  }
  const anterior = await getPeriodAnchor(client, ano);
  const now = new Date().toISOString();
  const { error } = await client.schema("private").from("pncp_period_anchor").upsert(
    {
      resource_type: RESOURCE,
      scope_key: SCOPE,
      ano_exercicio: ano,
      ultima_data_publicacao: summary?.max_data_publicacao ?? null,
      ultima_data_atualizacao: summary?.max_data_atualizacao ?? null,
      total_indexado: summary?.total_indexado ?? null,
      ultima_verificacao: now,
      metadata: {
        ...(anterior?.metadata ?? {}),
        ...summaryMetadata(summary),
        ...extraMetadata,
      },
      updated_at: now,
    },
    { onConflict: "resource_type,scope_key,ano_exercicio" },
  );
  if (error) throw error;
}

export async function markPeriodLoadComplete(
  client: SupabaseClient,
  summary: PcaSearchPeriodSummary | null,
  extraMetadata: Record<string, unknown> = {},
  anoFallback?: number,
) {
  const ano = summary?.ano ?? anoFallback;
  if (ano === undefined) {
    throw new Error("markPeriodLoadComplete: ano obrigatorio");
  }
  const now = new Date().toISOString();
  const { error } = await client.schema("private").from("pncp_period_anchor").upsert(
    {
      resource_type: RESOURCE,
      scope_key: SCOPE,
      ano_exercicio: ano,
      ultima_data_publicacao: summary?.max_data_publicacao ?? null,
      ultima_data_atualizacao: summary?.max_data_atualizacao ?? null,
      total_indexado: summary?.total_indexado ?? null,
      ultima_verificacao: now,
      ultima_carga_completa: now,
      metadata: {
        ...summaryMetadata(summary),
        ...extraMetadata,
        carga_completa: {
          version: 1,
          total_indexado: summary?.total_indexado ?? null,
          ultima_data_atualizacao: summary?.max_data_atualizacao ?? null,
          total_registros_classe: extraMetadata.total_registros_classe ?? {},
        },
      },
      updated_at: now,
    },
    { onConflict: "resource_type,scope_key,ano_exercicio" },
  );
  if (error) throw error;
}
