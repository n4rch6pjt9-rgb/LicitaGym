// Setup type definitions for built-in Supabase Runtime APIs
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "jsr:@supabase/server@^1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

type RouteRequest = Record<string, unknown>;

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json; charset=utf-8",
    },
  });
}

function getApiUrl() {
  const configuredUrl = Deno.env.get("WEBROUTER_API")?.trim();

  if (!configuredUrl) {
    throw new Error("Secret WEBROUTER_API não configurado");
  }

  // Aceita a URL base ou o endpoint REST completo.
  // Produção: https://way.webrouter.com.br/RouterService
  // Homologação: https://way-hml.webrouter.com.br/RouterService
  if (/\/router\/api\/calcular\/?$/i.test(configuredUrl)) {
    return configuredUrl.replace(/\/+$/, "");
  }

  return `${configuredUrl.replace(/\/+$/, "")}/router/api/calcular`;
}

function getProviderHeaders() {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
  };

  // Opcional: configure estes secrets se o contrato exigir autenticação.
  const authHeader = Deno.env.get("WEBROUTER_AUTH_HEADER")?.trim();
  const authToken = Deno.env.get("WEBROUTER_AUTH_TOKEN")?.trim();

  if (authHeader && authToken) {
    headers[authHeader] = authToken;
  }

  return headers;
}

function normalizeRouteResponse(data: any) {
  const route = Array.isArray(data?.rotas) ? data.rotas[0] : null;
  const path = route?.path ?? {};
  const tolls = route?.informacaoPedagios?.result ?? {};
  const summary = route?.resumo ?? {};
  const costs = route?.custos ?? {};

  const numberOrNull = (value: unknown) => {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  };

  return {
    status: data?.status ?? route?.status ?? null,
    distanciaKm: numberOrNull(path.distanciaKM),
    distanciaMetros: numberOrNull(path.distanciaMetros),
    distanciaRodoviariaKm: numberOrNull(path.distanciaRodoviariaKM),
    distanciaRodoviariaMetros: numberOrNull(path.distanciaRodoviariaMetros),
    distanciaUrbanaKm: numberOrNull(path.distanciaUrbanaKM),
    duracaoSegundos: numberOrNull(path.tempoSegundos),
    tempoFormatado: path.tempoFormatado ?? null,
    pedagios: Array.isArray(tolls.pedagios) ? tolls.pedagios : [],
    quantidadePedagios:
      numberOrNull(summary.quantidadePedagios) ??
      (Array.isArray(tolls.pedagios) ? tolls.pedagios.length : 0),
    valorPedagio:
      numberOrNull(costs.pedagio) ?? numberOrNull(tolls.totalPedagio),
    valorPedagioTag:
      numberOrNull(costs.pedagioTag) ?? numberOrNull(tolls.totalPedagioTag),
    rota: route,
  };
}

console.info("calculate-distance-webrouter started");

export default {
  fetch: withSupabase(
    { auth: ["publishable", "secret"] },
    async (req) => {
      if (req.method === "OPTIONS") {
        return new Response("ok", { headers: corsHeaders });
      }

      if (req.method !== "POST") {
        return jsonResponse({ error: "Use o método POST." }, 405);
      }

      try {
        const payload = (await req.json()) as RouteRequest;

        if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
          return jsonResponse(
            { error: "O corpo da requisição deve ser um JSON de objeto." },
            400,
          );
        }

        const response = await fetch(getApiUrl(), {
          method: "POST",
          headers: getProviderHeaders(),
          body: JSON.stringify(payload),
        });

        const rawText = await response.text();
        let providerData: unknown;

        try {
          providerData = rawText ? JSON.parse(rawText) : {};
        } catch {
          return jsonResponse(
            {
              error: "O WebRouter retornou uma resposta que não é JSON.",
              providerStatus: response.status,
              providerResponse: rawText.slice(0, 2000),
            },
            502,
          );
        }

        const normalized = normalizeRouteResponse(providerData);

        if (!response.ok) {
          return jsonResponse(
            {
              error: "O WebRouter recusou a consulta.",
              providerStatus: response.status,
              ...normalized,
              providerResponse: providerData,
            },
            502,
          );
        }

        if (normalized.status && normalized.status !== "SUCESSO") {
          return jsonResponse(
            {
              error: "O WebRouter não conseguiu calcular a rota.",
              ...normalized,
              providerResponse: providerData,
            },
            422,
          );
        }

        return jsonResponse({
          success: true,
          ...normalized,
          providerResponse: providerData,
        });
      } catch (error) {
        return jsonResponse(
          {
            error: error instanceof Error
              ? error.message
              : "Erro interno ao calcular a rota.",
          },
          500,
        );
      }
    },
  ),
};
