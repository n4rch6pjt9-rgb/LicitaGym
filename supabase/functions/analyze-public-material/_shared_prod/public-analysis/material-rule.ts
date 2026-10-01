export const MATERIAL_RULE_ID = "material-spec-consistency";
export const MATERIAL_RULE_VERSION = "0.1.0";
export const MATERIAL_RULE_LANGUAGE = "nodejs";
export const MATERIAL_RULE_FILENAME = "main.js";

// Programa fixo e versionado. A API nunca aceita código fornecido pelo usuário.
export const MATERIAL_RULE_SOURCE = String.raw`"use strict";

const RULE_ID = "material-spec-consistency";
const RULE_VERSION = "0.1.0";

function normalize(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function withoutNegatedRubber(value) {
  return value.replace(/\b(?:nao|sem)\s+(?:e\s+)?(?:de\s+)?borracha\b/g, " ");
}

function detectMaterials(value) {
  const text = withoutNegatedRubber(normalize(value));
  const found = new Set();
  if (/\b(?:borracha|epdm|sbr|rubber)\b/.test(text)) found.add("borracha");
  if (/\b(?:polipropileno|polypropylene|pp)\b/.test(text)) found.add("polipropileno");
  if (/\b(?:pvc|vinil|vinilico)\b/.test(text)) found.add("vinilico");
  if (/\b(?:eva|etileno vinil acetato)\b/.test(text)) found.add("eva");
  if (/\b(?:madeira|wood)\b/.test(text)) found.add("madeira");
  return [...found].sort();
}

function detectCategory(value, materials) {
  const text = normalize(value);
  if (/\b(?:quadra|poliesportiv|esportiv)\w*\b/.test(text)) return "piso_quadra";
  if (materials.includes("borracha")) return "piso_borracha";
  if (/\b(?:piso|revestimento|placa modular)\b/.test(text)) return "piso_outro";
  return "outro";
}

function uniqueMatches(value, expression, formatter) {
  const results = new Set();
  for (const match of normalize(value).matchAll(expression)) {
    results.add(formatter(match));
  }
  return [...results].sort();
}

function analyze(input) {
  const item = input.item || {};
  const catalog = input.catalog_reference || null;
  const characteristics = Array.isArray(input.catmat_characteristics)
    ? input.catmat_characteristics
    : [];

  const attributeText = Object.entries(item.attributes || {})
    .map(([key, value]) => key + ": " + value)
    .join("; ");
  const observedText = [item.description, attributeText].filter(Boolean).join("; ");

  const characteristicText = characteristics
    .map((entry) => [
      entry.nome_caracteristica,
      entry.nome_valor_caracteristica,
      entry.sigla_unidade_medida,
    ].filter(Boolean).join(": "))
    .join("; ");
  const catalogText = catalog
    ? [catalog.descricao, JSON.stringify(catalog.taxonomias || {})].filter(Boolean).join("; ")
    : "";
  const expectedText = [catalogText, characteristicText].filter(Boolean).join("; ");

  const observedMaterials = detectMaterials(observedText);
  const expectedMaterials = detectMaterials(expectedText);
  const category = detectCategory(observedText, observedMaterials);

  let consistency = "not_verifiable";
  const conflicts = [];
  if (expectedMaterials.length > 0 && observedMaterials.length > 0) {
    const overlap = observedMaterials.filter((material) => expectedMaterials.includes(material));
    if (overlap.length > 0) {
      consistency = "consistent";
    } else {
      consistency = "divergent";
      conflicts.push({
        field: "material",
        expected: expectedMaterials,
        observed: observedMaterials,
        reason: "Material da descrição oficial diverge da referência CATMAT disponível.",
      });
    }
  }

  const dimensions = uniqueMatches(
    observedText,
    /\b(\d+(?:[.,]\d+)?)\s*[x×]\s*(\d+(?:[.,]\d+)?)\s*(mm|cm|m)\b/g,
    (match) => match[1].replace(",", ".") + "x" + match[2].replace(",", ".") + " " + match[3],
  );
  const thicknesses = uniqueMatches(
    observedText,
    /\b(\d+(?:[.,]\d+)?)\s*mm\b/g,
    (match) => match[1].replace(",", ".") + " mm",
  );

  const evidence = [
    ...observedMaterials.map((value) => ({ source: "official_record", field: "material", value })),
    ...expectedMaterials.map((value) => ({ source: "catmat_reference", field: "material", value })),
    ...dimensions.map((value) => ({ source: "official_record", field: "dimensions", value })),
    ...thicknesses.map((value) => ({ source: "official_record", field: "thickness", value })),
  ];

  return {
    schema_version: "1",
    rule_id: RULE_ID,
    rule_version: RULE_VERSION,
    classification: {
      category,
      observed_materials: observedMaterials,
    },
    consistency,
    reference_found: Boolean(catalog || characteristics.length > 0),
    conflicts,
    evidence,
  };
}

let stdin = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { stdin += chunk; });
process.stdin.on("end", () => {
  try {
    const input = JSON.parse(stdin);
    process.stdout.write(JSON.stringify(analyze(input)));
  } catch (error) {
    process.stderr.write(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
});
`;

export type MaterialRuleOutput = {
  schema_version: "1";
  rule_id: typeof MATERIAL_RULE_ID;
  rule_version: typeof MATERIAL_RULE_VERSION;
  classification: {
    category: "piso_quadra" | "piso_borracha" | "piso_outro" | "outro";
    observed_materials: string[];
  };
  consistency: "consistent" | "divergent" | "not_verifiable";
  reference_found: boolean;
  conflicts: Array<{
    field: string;
    expected: string[];
    observed: string[];
    reason: string;
  }>;
  evidence: Array<{
    source: "official_record" | "catmat_reference";
    field: string;
    value: string;
  }>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) &&
    value.every((entry) => typeof entry === "string");
}

export function parseMaterialRuleOutput(value: unknown): MaterialRuleOutput {
  if (!isRecord(value)) throw new Error("saída da regra deve ser um objeto");
  if (
    value.schema_version !== "1" || value.rule_id !== MATERIAL_RULE_ID ||
    value.rule_version !== MATERIAL_RULE_VERSION
  ) {
    throw new Error("identificação ou versão da regra inválida");
  }
  if (!isRecord(value.classification)) {
    throw new Error("classification inválida");
  }
  if (
    value.classification.category !== "piso_quadra" &&
    value.classification.category !== "piso_borracha" &&
    value.classification.category !== "piso_outro" &&
    value.classification.category !== "outro"
  ) {
    throw new Error("classification.category inválida");
  }
  if (!isStringArray(value.classification.observed_materials)) {
    throw new Error("classification.observed_materials inválida");
  }
  if (
    value.consistency !== "consistent" && value.consistency !== "divergent" &&
    value.consistency !== "not_verifiable"
  ) {
    throw new Error("consistency inválida");
  }
  if (typeof value.reference_found !== "boolean") {
    throw new Error("reference_found inválido");
  }
  if (!Array.isArray(value.conflicts) || !Array.isArray(value.evidence)) {
    throw new Error("conflicts ou evidence inválido");
  }

  for (const conflict of value.conflicts) {
    if (
      !isRecord(conflict) || typeof conflict.field !== "string" ||
      !isStringArray(conflict.expected) || !isStringArray(conflict.observed) ||
      typeof conflict.reason !== "string"
    ) {
      throw new Error("conflito inválido");
    }
  }
  for (const evidence of value.evidence) {
    if (
      !isRecord(evidence) ||
      (evidence.source !== "official_record" &&
        evidence.source !== "catmat_reference") ||
      typeof evidence.field !== "string" || typeof evidence.value !== "string"
    ) {
      throw new Error("evidência inválida");
    }
  }

  return value as MaterialRuleOutput;
}
