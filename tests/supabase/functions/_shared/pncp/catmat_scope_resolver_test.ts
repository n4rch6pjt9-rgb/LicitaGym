import { assertEquals } from "jsr:@std/assert@1";
import {
  effectiveClasses,
  effectiveMaterialItems,
  loadEffectiveMaterialItems,
  linkTargetClasses,
  orgSyncClasses,
  pcaItemScope,
  resolveCatmatIngestTargets,
  SCOPE_CONFIG_STATUS,
  type CatmatScopeReadClient,
} from "../../../../../supabase/functions/_shared/pncp/catmat-scope-resolver.ts";
import {
  defaultPcaClassificacoes,
  resolvePcaClassificacoes,
} from "../../../../../supabase/functions/_shared/pncp/licitagym-catmat.ts";
import { assertPcaClassificacoesInScope } from "../../../../../supabase/functions/_shared/pncp/licitagym-scope-gate.ts";

const pdms = [
  { codigo_pdm: 2640, codigo_grupo: 78, codigo_classe: 7830, status: true },
  { codigo_pdm: 745, codigo_grupo: 72, codigo_classe: 7220, status: true },
  { codigo_pdm: 1, codigo_grupo: 99, codigo_classe: 1111, status: true },
  { codigo_pdm: 2, codigo_grupo: 78, codigo_classe: 7830, status: false },
];

const itens = [
  { codigo_item: 628785, codigo_pdm: 2640, codigo_classe: null, status_item: true },
  { codigo_item: 27634, codigo_pdm: "745", codigo_classe: 9999, status_item: true },
  { codigo_item: 1, codigo_pdm: 1, status_item: true },
  { codigo_item: null, codigo_pdm: 2640, status_item: true },
  { codigo_item: 50, codigo_pdm: 2, status_item: true },
];

Deno.test("escopo transitório devolve 7830 CORE e 7220 CURATED_EXTENSION", () => {
  assertEquals(SCOPE_CONFIG_STATUS, "TRANSITIONAL");
  const classes = effectiveClasses();
  assertEquals(classes.map((rule) => rule.classe), ["7830", "7220"]);
  assertEquals(classes[0].priority, "CORE");
  assertEquals(classes[0].grupo, "78");
  assertEquals(classes[0].provenance, "transitional_fitness_scope");
  assertEquals(classes[1].priority, "CURATED_EXTENSION");
  assertEquals(classes[1].grupo, "72");
  assertEquals(classes.map((rule) => rule.classe).includes("1111"), false);
});

Deno.test("seed PCA padrão é só CORE 7830; org sync e link mantêm 7220", () => {
  Deno.env.delete("PNCP_PCA_CLASSIFICACOES");
  assertEquals(defaultPcaClassificacoes(), ["7830"]);
  assertEquals(resolvePcaClassificacoes({}), ["7830"]);
  assertEquals(orgSyncClasses(), ["7830", "7220"]);
  const link = linkTargetClasses({});
  assertEquals(link.ok, true);
  if (link.ok) assertEquals(link.classes, ["7830", "7220"]);
});

Deno.test("PCA rejeita classe fora do seed; env explícito libera 7220", () => {
  Deno.env.delete("PNCP_PCA_CLASSIFICACOES");
  assertEquals(assertPcaClassificacoesInScope(["7830"]), null);
  assertEquals(assertPcaClassificacoesInScope(["7830", "1111"])?.includes("1111"), true);
  assertEquals(assertPcaClassificacoesInScope(["7220"])?.includes("7220"), true);
  Deno.env.set("PNCP_PCA_CLASSIFICACOES", "7830,7220");
  try {
    assertEquals(assertPcaClassificacoesInScope(["7830", "7220"]), null);
  } finally {
    Deno.env.delete("PNCP_PCA_CLASSIFICACOES");
  }
});

Deno.test("link e ingest usam a mesma política", () => {
  const one = linkTargetClasses({ classe_catmat: "7220" });
  assertEquals(one.ok && one.classes, ["7220"]);
  const alien = linkTargetClasses({ classe_catmat: "1111" });
  assertEquals(alien.ok, false);

  const both = resolveCatmatIngestTargets({});
  assertEquals(both.ok, true);
  if (both.ok) {
    assertEquals(both.pairs, [
      { grupo: 78, classe: 7830 },
      { grupo: 72, classe: 7220 },
    ]);
  }
  assertEquals(resolveCatmatIngestTargets({ codigo_grupo: 99, codigo_classe: 1111 }).ok, false);
  assertEquals(resolveCatmatIngestTargets({ codigo_grupo: 78 }).ok, false);
});

Deno.test("item resolve classe pelo PDM e ignora codigo_classe do item", () => {
  const rows = effectiveMaterialItems(pdms, itens);
  assertEquals(rows.map((row) => row.codigo_item), ["628785", "27634"]);
  assertEquals(rows[0].classe, "7830");
  assertEquals(rows[0].priority, "CORE");
  assertEquals(rows[1].classe, "7220");
  assertEquals(rows[1].codigo_pdm, "745");
  assertEquals(rows[1].priority, "CURATED_EXTENSION");
  assertEquals(rows.some((row) => row.classe === "1111"), false);
});

Deno.test("item PCA sem codigoItem permanece IN_SCOPE", () => {
  assertEquals(pcaItemScope({
    codigo_classe_catmat: 7830,
    codigo_item_origem: null,
  }), "IN_SCOPE");
  assertEquals(pcaItemScope({
    codigo_classe_catmat: "7220",
  }), "IN_SCOPE");
  assertEquals(pcaItemScope({
    codigo_classe_catmat: 1111,
    codigo_item_origem: 1,
  }), "OUT_OF_SCOPE");
});

Deno.test("carga de itens filtra classe no PDM e não pede codigo_classe do item", async () => {
  const calls: { table: string; columns: string; values: readonly (string | number)[] }[] = [];
  const client: CatmatScopeReadClient = {
    from(table) {
      return {
        select(columns) {
          return {
            in(_column, values) {
              calls.push({ table, columns, values });
              const matched: Record<string, unknown>[] = table === "catmat_pdms"
                ? pdms.filter((row) => new Set(values.map(String)).has(String(row.codigo_classe)))
                : itens.filter((row) => new Set(values.map(String)).has(String(row.codigo_pdm)));
              return {
                order() {
                  return {
                    range(from, to) {
                      return Promise.resolve({ data: matched.slice(from, to + 1), error: null });
                    },
                  };
                },
              };
            },
          };
        },
      };
    },
  };
  const rows = await loadEffectiveMaterialItems(client);
  assertEquals(calls[0].table, "catmat_pdms");
  assertEquals(calls[0].values.map(String), ["7830", "7220"]);
  assertEquals(calls[1].table, "catmat_itens");
  assertEquals(calls[1].columns.includes("codigo_classe"), false);
  assertEquals(rows.map((row) => row.codigo_item), ["628785", "27634"]);
});
