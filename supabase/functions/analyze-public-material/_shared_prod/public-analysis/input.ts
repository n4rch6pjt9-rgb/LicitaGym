export const PUBLIC_ANALYSIS_TYPE = "catmat_spec_consistency" as const;

export type PublicSourceName = "pncp" | "compras-gov" | "compras-rj";

export type PublicMaterialAnalysisRequest = {
  analysis_type: typeof PUBLIC_ANALYSIS_TYPE;
  source: {
    name: PublicSourceName;
    record_id: string;
    url: string;
  };
  item: {
    codigo_item?: string;
    description: string;
    attributes: Record<string, string>;
  };
};

const SOURCE_HOSTS: Record<PublicSourceName, readonly string[]> = {
  pncp: ["pncp.gov.br"],
  "compras-gov": [
    "compras.gov.br",
    "dadosabertos.compras.gov.br",
    "compras.dados.gov.br",
    "gov.br",
  ],
  "compras-rj": ["compras.rj.gov.br", "rj.gov.br"],
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requiredString(
  value: unknown,
  field: string,
  maxLength: number,
): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${field} é obrigatório`);
  }
  const normalized = value.trim();
  if (normalized.length > maxLength) {
    throw new Error(`${field} excede ${maxLength} caracteres`);
  }
  return normalized;
}

function optionalCodigoItem(value: unknown): string | undefined {
  if (value == null || value === "") return undefined;
  const codigo = requiredString(value, "item.codigo_item", 30);
  if (!/^\d+$/.test(codigo)) {
    throw new Error("item.codigo_item deve conter somente dígitos");
  }
  return codigo;
}

function parseAttributes(value: unknown): Record<string, string> {
  if (value == null) return {};
  if (!isRecord(value)) throw new Error("item.attributes deve ser um objeto");

  const entries = Object.entries(value);
  if (entries.length > 50) {
    throw new Error("item.attributes excede 50 campos");
  }

  const attributes: Record<string, string> = {};
  for (const [rawKey, rawValue] of entries) {
    const key = requiredString(rawKey, "chave de item.attributes", 80);
    const attributeValue = requiredString(
      rawValue,
      `item.attributes.${key}`,
      500,
    );
    attributes[key] = attributeValue;
  }
  return attributes;
}

function parseOfficialUrl(source: PublicSourceName, value: unknown): string {
  const rawUrl = requiredString(value, "source.url", 2_000);
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("source.url deve ser uma URL válida");
  }

  if (url.protocol !== "https:") {
    throw new Error("source.url deve usar HTTPS");
  }

  const hostname = url.hostname.toLowerCase();
  const allowed = SOURCE_HOSTS[source].some((officialHost) =>
    hostname === officialHost || hostname.endsWith(`.${officialHost}`)
  );
  if (!allowed) {
    throw new Error(`source.url não pertence à fonte oficial ${source}`);
  }

  url.hash = "";
  return url.toString();
}

export function parsePublicMaterialAnalysisRequest(
  value: unknown,
): PublicMaterialAnalysisRequest {
  if (!isRecord(value)) {
    throw new Error("corpo da requisição deve ser um objeto");
  }
  if (value.analysis_type !== PUBLIC_ANALYSIS_TYPE) {
    throw new Error(`analysis_type deve ser ${PUBLIC_ANALYSIS_TYPE}`);
  }
  if (!isRecord(value.source)) throw new Error("source é obrigatório");
  if (!isRecord(value.item)) throw new Error("item é obrigatório");

  const sourceName = value.source.name;
  if (
    sourceName !== "pncp" && sourceName !== "compras-gov" &&
    sourceName !== "compras-rj"
  ) {
    throw new Error("source.name deve ser pncp, compras-gov ou compras-rj");
  }

  return {
    analysis_type: PUBLIC_ANALYSIS_TYPE,
    source: {
      name: sourceName,
      record_id: requiredString(
        value.source.record_id,
        "source.record_id",
        200,
      ),
      url: parseOfficialUrl(sourceName, value.source.url),
    },
    item: {
      codigo_item: optionalCodigoItem(value.item.codigo_item),
      description: requiredString(
        value.item.description,
        "item.description",
        20_000,
      ),
      attributes: parseAttributes(value.item.attributes),
    },
  };
}
