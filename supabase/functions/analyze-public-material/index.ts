import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { corsHeaders, errorDetail, jsonResponse } from "./_shared_prod/http.ts";
import { createServiceClient } from "./_shared_prod/pncp/supabase-admin.ts";
import { hashPayload, sha256Hex } from "./_shared_prod/pncp/hash.ts";
import {
  parsePublicMaterialAnalysisRequest,
  type PublicMaterialAnalysisRequest,
} from "./_shared_prod/public-analysis/input.ts";
import {
  MATERIAL_RULE_FILENAME,
  MATERIAL_RULE_ID,
  MATERIAL_RULE_LANGUAGE,
  MATERIAL_RULE_SOURCE,
  MATERIAL_RULE_VERSION,
  parseMaterialRuleOutput,
} from "./_shared_prod/public-analysis/material-rule.ts";
import {
  executeOneCompiler,
  OneCompilerError,
} from "./_shared_prod/public-analysis/onecompiler-client.ts";

async function requireAuthenticatedUser(req: Request): Promise<void> {
  const url = Deno.env.get("SUPABASE_URL");
  const anon = Deno.env.get("SUPABASE_ANON_KEY");
  if (!url || !anon) throw new Error("Supabase env missing");

  const auth = req.headers.get("Authorization") ?? "";
  if (!auth.toLowerCase().startsWith("bearer ")) {
    throw new Error("Authorization Bearer JWT obrigatório");
  }

  const client = createClient(url, anon, {
    global: { headers: { Authorization: auth } },
    auth: { persistSession: false },
  });
  const { data, error } = await client.auth.getUser();
  if (error || !data.user) {
    throw new Error("JWT inválido ou sessão expirada");
  }
}

type CatalogReference = {
  codigo_catmat: string;
  descricao: string;
  codigo_pdm: string | null;
  categoria_licitagym: string | null;
  taxonomias: Record<string, unknown>;
  fonte_curadoria: string;
};

type CatmatCharacteristic = {
  nome_caracteristica: string;
  nome_valor_caracteristica: string | null;
  sigla_unidade_medida: string | null;
};

function readCatalogReference(
  value: Record<string, unknown> | null,
): CatalogReference | null {
  if (!value) return null;
  return {
    codigo_catmat: String(value.codigo_catmat ?? ""),
    descricao: String(value.descricao ?? ""),
    codigo_pdm: value.codigo_pdm == null ? null : String(value.codigo_pdm),
    categoria_licitagym: value.categoria_licitagym == null
      ? null
      : String(value.categoria_licitagym),
    taxonomias: value.taxonomias && typeof value.taxonomias === "object"
      ? value.taxonomias as Record<string, unknown>
      : {},
    fonte_curadoria: String(value.fonte_curadoria ?? "desconhecida"),
  };
}

function readCharacteristics(
  value: Record<string, unknown>[] | Record<string, unknown> | null,
): CatmatCharacteristic[] {
  const rows = Array.isArray(value) ? value : value ? [value] : [];
  return rows.map((row) => ({
    nome_caracteristica: String(row.nome_caracteristica ?? ""),
    nome_valor_caracteristica: row.nome_valor_caracteristica == null
      ? null
      : String(row.nome_valor_caracteristica),
    sigla_unidade_medida: row.sigla_unidade_medida == null
      ? null
      : String(row.sigla_unidade_medida),
  }));
}

async function loadCatmatReference(request: PublicMaterialAnalysisRequest) {
  const codigoItem = request.item.codigo_item;
  if (!codigoItem) {
    return { catalogReference: null, characteristics: [] };
  }

  const client = createServiceClient();
  const [catalogResult, characteristicResult] = await Promise.all([
    client.from("catalogo_itens")
      .select(
        "codigo_catmat, descricao, codigo_pdm, categoria_licitagym, taxonomias, fonte_curadoria",
      )
      .eq("codigo_catmat", codigoItem)
      .maybeSingle(),
    client.from("catmat_item_caracteristicas")
      .select(
        "nome_caracteristica, nome_valor_caracteristica, sigla_unidade_medida",
      )
      .eq("codigo_item", Number(codigoItem))
      .eq("status", true)
      .order("numero_caracteristica", { ascending: true })
      .limit(100),
  ]);

  if (catalogResult.error) throw catalogResult.error;
  if (characteristicResult.error) throw characteristicResult.error;

  return {
    catalogReference: readCatalogReference(
      catalogResult.data as Record<string, unknown> | null,
    ),
    characteristics: readCharacteristics(characteristicResult.data),
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  try {
    await requireAuthenticatedUser(req);

    const contentLength = Number(req.headers.get("content-length") ?? "0");
    if (Number.isFinite(contentLength) && contentLength > 50_000) {
      return jsonResponse({ error: "Payload excede 50 KB" }, 413);
    }

    const body = await req.json().catch(() => null);
    const request = parsePublicMaterialAnalysisRequest(body);
    const { catalogReference, characteristics } = await loadCatmatReference(
      request,
    );
    const ruleInput = {
      source: request.source,
      item: request.item,
      catalog_reference: catalogReference,
      catmat_characteristics: characteristics,
    };

    const apiKey = Deno.env.get("ONECOMPILER_API_KEY")?.trim() ?? "";
    const execution = await executeOneCompiler({
      apiKey,
      language: MATERIAL_RULE_LANGUAGE,
      filename: MATERIAL_RULE_FILENAME,
      source: MATERIAL_RULE_SOURCE,
      stdin: JSON.stringify(ruleInput),
      parseOutput: parseMaterialRuleOutput,
    });

    return jsonResponse({
      analysis_type: request.analysis_type,
      source: request.source,
      input_hash: await hashPayload(ruleInput),
      rule: {
        id: MATERIAL_RULE_ID,
        version: MATERIAL_RULE_VERSION,
        source_hash: await sha256Hex(MATERIAL_RULE_SOURCE),
      },
      reference: {
        catalog_found: catalogReference !== null,
        characteristics_found: characteristics.length,
      },
      result: execution.output,
      execution: {
        provider: "onecompiler",
        language: MATERIAL_RULE_LANGUAGE,
        ...execution.metrics,
      },
    });
  } catch (error) {
    if (error instanceof OneCompilerError) {
      const status = error.code === "configuration" ? 503 : 502;
      return jsonResponse({ error: error.message, code: error.code }, status);
    }
    const message = errorDetail(error);
    if (
      message.includes("Authorization Bearer") ||
      message.includes("JWT inválido")
    ) {
      return jsonResponse({ error: message }, 401);
    }
    const status =
      message.includes("obrigatório") || message.includes("deve") ||
        message.includes("excede") || message.includes("não pertence")
        ? 400
        : 500;
    return jsonResponse({ error: message }, status);
  }
});
