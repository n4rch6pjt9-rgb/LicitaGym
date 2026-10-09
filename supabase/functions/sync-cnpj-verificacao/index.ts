import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { corsHeaders, errorDetail, jsonResponse, requireCronAuth } from "../_shared/http.ts";

/**
 * sync-cnpj-verificacao (spec specs/0008-verificacao-cnpj-brasilapi.md, entrega 1).
 *   POST {} -> { resultado: { dv_invalido, aguardando_consulta, total, executado_em }, consulta_externa: false }
 * Acesso: só o cron (SYNC_CRON_SECRET). Recalcula os alvos com private.cnpj_verificacao_atualizar() (verificação
 * local de DV, órgão sem nome e PGC sem par). Nesta entrega não há chamada HTTP externa: a consulta à BrasilAPI entra
 * na entrega 2, quando o PGC for carregado.
 */

export type ResultadoVerificacao = Record<string, unknown>;

export interface Contexto {
  atualizar?: () => Promise<ResultadoVerificacao>;
}

async function atualizarNoBanco(): Promise<ResultadoVerificacao> {
  const url = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !serviceKey) throw new Error("SUPABASE_URL ou SUPABASE_SERVICE_ROLE_KEY não configuradas");
  const client = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data, error } = await client.schema("private").rpc("cnpj_verificacao_atualizar");
  if (error) throw new Error(`cnpj_verificacao_atualizar: ${errorDetail(error)}`);
  if (!data || typeof data !== "object") throw new Error("cnpj_verificacao_atualizar: retorno vazio");
  return data as ResultadoVerificacao;
}

export async function handleRequest(req: Request, ctx: Contexto = {}): Promise<Response> {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return jsonResponse({ error: "Método não permitido. Utilize POST." }, 405);

  const negado = requireCronAuth(req);
  if (negado) return negado;

  try {
    const resultado = await (ctx.atualizar ?? atualizarNoBanco)();
    return jsonResponse({ resultado, consulta_externa: false });
  } catch (error) {
    // Detalhe do banco fica só no log.
    console.error("[sync-cnpj-verificacao]", errorDetail(error));
    return jsonResponse({ error: "Falha na verificação de CNPJ." }, 500);
  }
}

if (import.meta.main) {
  Deno.serve((req) => handleRequest(req));
}
