/**
 * TRANSITIONAL fitness scope.
 * Uma definição, consumida pelo resolver. Não é tabela e não é migration.
 * 7830 (CORE), 7220, 7810 e 9320 são dados desta configuração, não regras
 * espalhadas nos consumidores. 7810 e 9320 são extensão curada: entram no
 * sync CATMAT, no link CATMAT×PCA, no pcaItemScope e no sync de órgãos.
 * O download do PCA continua só na classe CORE (7830), salvo
 * PNCP_PCA_CLASSIFICACOES. Persistir isso em tabela administrativa fica
 * para um passo posterior.
 */

import {
  chunkValues,
  fetchAllByRange,
  POSTGREST_PAGE_SIZE,
} from "./postgrest-paginate.ts";

export const SCOPE_CONFIG_STATUS = "TRANSITIONAL" as const;

export type ScopePriority = "CORE" | "CURATED_EXTENSION";

export type ScopeClassRule = {
  readonly grupo: string;
  readonly classe: string;
  readonly priority: ScopePriority;
  readonly provenance: "transitional_fitness_scope";
};

export const TRANSITIONAL_FITNESS_SCOPE: readonly ScopeClassRule[] = [
  {
    grupo: "78",
    classe: "7830",
    priority: "CORE",
    provenance: "transitional_fitness_scope",
  },
  {
    grupo: "72",
    classe: "7220",
    priority: "CURATED_EXTENSION",
    provenance: "transitional_fitness_scope",
  },
  {
    grupo: "78",
    classe: "7810",
    priority: "CURATED_EXTENSION",
    provenance: "transitional_fitness_scope",
  },
  {
    grupo: "93",
    classe: "9320",
    priority: "CURATED_EXTENSION",
    provenance: "transitional_fitness_scope",
  },
];

export type PdmRecord = {
  codigo_pdm: number | string;
  codigo_grupo: number | string;
  codigo_classe: number | string;
  status?: boolean | null;
};

export type ItemRecord = {
  codigo_item: number | string | null;
  codigo_pdm: number | string | null;
  /** Ignorado. No banco auditado esta coluna está NULL. A classe vem do PDM. */
  codigo_classe?: number | string | null;
  status_item?: boolean | null;
};

export type EffectivePdm = {
  codigo_pdm: string;
  grupo: string;
  classe: string;
  priority: ScopePriority;
  provenance: ScopeClassRule["provenance"];
};

export type EffectiveMaterialItem = EffectivePdm & {
  codigo_item: string;
};

export type PcaItemScopeInput = {
  codigo_classe_catmat?: number | string | null;
  codigo_item_origem?: number | string | null;
};

export type PcaItemScope = "IN_SCOPE" | "OUT_OF_SCOPE";

type QueryError = { message: string };
type QueryResult<T> = { data: T[] | null; error: QueryError | null };

/** Builder after `.order()` — `.range()` pages past PostgREST max-rows. */
export type CatmatScopeOrderedBuilder = {
  range(
    from: number,
    to: number,
  ): PromiseLike<QueryResult<Record<string, unknown>>>;
};

/** Builder after `.in()` — must `.order(uniqueCol)` before `.range()`. */
export type CatmatScopeFilterBuilder = {
  order(
    column: string,
    options?: { ascending?: boolean },
  ): CatmatScopeOrderedBuilder;
};

export type CatmatScopeReadClient = {
  from(table: "catmat_pdms" | "catmat_itens"): {
    select(columns: string): {
      in(
        column: string,
        values: readonly (string | number)[],
      ): CatmatScopeFilterBuilder;
    };
  };
};

function ruleKey(grupo: number | string, classe: number | string): string {
  return `${String(grupo)}:${String(classe)}`;
}

function policyMap(
  policy: readonly ScopeClassRule[],
): Map<string, ScopeClassRule> {
  return new Map(policy.map((rule) => [ruleKey(rule.grupo, rule.classe), rule]));
}

/** Classes da política. Não lê catmat_classes e não carrega itens. */
export function effectiveClasses(
  policy: readonly ScopeClassRule[] = TRANSITIONAL_FITNESS_SCOPE,
): ScopeClassRule[] {
  return policy.map((rule) => ({ ...rule }));
}

export function effectiveClassCodes(
  policy: readonly ScopeClassRule[] = TRANSITIONAL_FITNESS_SCOPE,
): string[] {
  return effectiveClasses(policy).map((rule) => rule.classe);
}

export function isPolicyPair(
  codigoGrupo: number | string,
  codigoClasse: number | string,
  policy: readonly ScopeClassRule[] = TRANSITIONAL_FITNESS_SCOPE,
): boolean {
  return policyMap(policy).has(ruleKey(codigoGrupo, codigoClasse));
}

/** PDMs cujo par grupo/classe está na política. Classe extra na tabela não entra. */
export function effectivePdms(
  pdms: readonly PdmRecord[],
  policy: readonly ScopeClassRule[] = TRANSITIONAL_FITNESS_SCOPE,
): EffectivePdm[] {
  const rules = policyMap(policy);
  const out: EffectivePdm[] = [];
  for (const pdm of pdms) {
    if (pdm.status === false) continue;
    const rule = rules.get(ruleKey(pdm.codigo_grupo, pdm.codigo_classe));
    if (!rule) continue;
    out.push({
      codigo_pdm: String(pdm.codigo_pdm),
      grupo: rule.grupo,
      classe: rule.classe,
      priority: rule.priority,
      provenance: rule.provenance,
    });
  }
  return out;
}

/**
 * Itens via PDM → classe. Não consulta codigo_classe do item.
 * PCA não deve chamar isto só para saber as classes.
 */
export function effectiveMaterialItems(
  pdms: readonly PdmRecord[],
  itens: readonly ItemRecord[],
  policy: readonly ScopeClassRule[] = TRANSITIONAL_FITNESS_SCOPE,
): EffectiveMaterialItem[] {
  const pdmByCode = new Map(
    effectivePdms(pdms, policy).map((pdm) => [pdm.codigo_pdm, pdm]),
  );
  const out: EffectiveMaterialItem[] = [];
  for (const item of itens) {
    if (item.status_item === false) continue;
    if (item.codigo_item == null || String(item.codigo_item).trim() === "") continue;
    if (item.codigo_pdm == null || String(item.codigo_pdm).trim() === "") continue;
    const pdm = pdmByCode.get(String(item.codigo_pdm));
    if (!pdm) continue;
    out.push({
      ...pdm,
      codigo_item: String(item.codigo_item),
    });
  }
  return out;
}

/**
 * Lê catmat_pdms e catmat_itens. O filtro de classe vai no PDM.
 * A select de item não pede codigo_classe.
 * Pages with `.range()` — PostgREST silently caps at ~1000 rows otherwise.
 */
export async function loadEffectiveMaterialItems(
  client: CatmatScopeReadClient,
  policy: readonly ScopeClassRule[] = TRANSITIONAL_FITNESS_SCOPE,
): Promise<EffectiveMaterialItem[]> {
  const classes = effectiveClasses(policy).map((rule) => Number(rule.classe));
  const { rows: pdmRows } = await fetchAllByRange(
    (from, to) =>
      client
        .from("catmat_pdms")
        .select("codigo_pdm, codigo_grupo, codigo_classe, status")
        .in("codigo_classe", classes)
        .order("codigo_pdm")
        .range(from, to),
    { orderBy: "codigo_pdm" },
  );
  const pdms = pdmRows.map((row) => ({
    codigo_pdm: row.codigo_pdm as number | string,
    codigo_grupo: row.codigo_grupo as number | string,
    codigo_classe: row.codigo_classe as number | string,
    status: row.status as boolean | null | undefined,
  }));
  const scopedPdms = effectivePdms(pdms, policy);
  if (scopedPdms.length === 0) return [];

  const itens: ItemRecord[] = [];
  for (const pdmChunk of chunkValues(
    scopedPdms.map((pdm) => pdm.codigo_pdm),
    POSTGREST_PAGE_SIZE,
  )) {
    const { rows: itemRows } = await fetchAllByRange(
      (from, to) =>
        client
          .from("catmat_itens")
          .select("codigo_item, codigo_pdm, status_item")
          .in("codigo_pdm", pdmChunk)
          .order("codigo_item")
          .range(from, to),
      { orderBy: "codigo_item" },
    );
    for (const row of itemRows) {
      itens.push({
        codigo_item: row.codigo_item as number | string | null,
        codigo_pdm: row.codigo_pdm as number | string | null,
        status_item: row.status_item as boolean | null | undefined,
      });
    }
  }
  return effectiveMaterialItems(pdms, itens, policy);
}

/**
 * Item de PCA sem codigoItem continua no escopo se a classe do item PCA
 * está na política. Ausência de código não vira OUT_OF_SCOPE.
 * catalogo_itens não participa.
 */
export function pcaItemScope(
  item: PcaItemScopeInput,
  policy: readonly ScopeClassRule[] = TRANSITIONAL_FITNESS_SCOPE,
): PcaItemScope {
  if (item.codigo_classe_catmat == null) return "OUT_OF_SCOPE";
  const classe = String(item.codigo_classe_catmat).trim();
  if (!effectiveClassCodes(policy).includes(classe)) return "OUT_OF_SCOPE";
  return "IN_SCOPE";
}

export function orgSyncClasses(
  policy: readonly ScopeClassRule[] = TRANSITIONAL_FITNESS_SCOPE,
): string[] {
  return effectiveClassCodes(policy);
}

export function linkTargetClasses(
  body: { classe_catmat?: string | null },
  policy: readonly ScopeClassRule[] = TRANSITIONAL_FITNESS_SCOPE,
): { ok: true; classes: string[] } | { ok: false; reason: string } {
  const allowed = effectiveClassCodes(policy);
  const requested = body.classe_catmat?.trim();
  if (!requested) return { ok: true, classes: allowed };
  if (!allowed.includes(requested)) {
    return { ok: false, reason: `Classe fora do escopo LicitaGym: ${requested}` };
  }
  return { ok: true, classes: [requested] };
}

export function resolveCatmatIngestTargets(
  body: { codigo_grupo?: number; codigo_classe?: number },
  policy: readonly ScopeClassRule[] = TRANSITIONAL_FITNESS_SCOPE,
): { ok: true; pairs: { grupo: number; classe: number }[] } | { ok: false; reason: string } {
  const hasGrupo = body.codigo_grupo != null;
  const hasClasse = body.codigo_classe != null;
  if (hasGrupo !== hasClasse) {
    return {
      ok: false,
      reason: "codigo_grupo e codigo_classe devem ser informados juntos",
    };
  }
  if (hasGrupo && hasClasse) {
    const grupo = body.codigo_grupo as number;
    const classe = body.codigo_classe as number;
    if (!isPolicyPair(grupo, classe, policy)) {
      return {
        ok: false,
        reason: `CATMAT fora do escopo LicitaGym: ${grupo}/${classe}`,
      };
    }
    return { ok: true, pairs: [{ grupo, classe }] };
  }
  return {
    ok: true,
    pairs: effectiveClasses(policy).map((rule) => ({
      grupo: Number(rule.grupo),
      classe: Number(rule.classe),
    })),
  };
}
