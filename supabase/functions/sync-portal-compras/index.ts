import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { corsHeaders, jsonResponse, requireCronAuth } from "../_shared/http.ts";
import { acquireSyncLock } from "../_shared/pncp/lock.ts";
import { createServiceClient } from "../_shared/pncp/supabase-admin.ts";
import { executarSyncPortal } from "./sync.ts";

const LIMITE_PADRAO = 40;

function limiteDe(body: unknown): number {
  if (!body || typeof body !== "object" || Array.isArray(body)) return LIMITE_PADRAO;
  const valor = (body as Record<string, unknown>).limite;
  const n = typeof valor === "number" ? valor : Number(valor);
  if (!Number.isInteger(n) || n < 1) return LIMITE_PADRAO;
  return Math.min(n, LIMITE_PADRAO);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return jsonResponse({ error: "Use POST" }, 405);
  const denied = requireCronAuth(req);
  if (denied) return denied;

  let body: unknown = {};
  const texto = await req.text();
  if (texto.trim()) {
    try {
      body = JSON.parse(texto);
    } catch {
      return jsonResponse({ error: "JSON inválido" }, 400);
    }
  }

  const client = createServiceClient();
  const { runId, alreadyRunning } = await acquireSyncLock(client, "portal-compras", "portal-compras", {});
  if (alreadyRunning) return jsonResponse({ status: "already_running", sync_id: runId });

  // executarSyncPortal fecha a execução (private.pncp_sync_run) em todos os caminhos.
  const { status, stats } = await executarSyncPortal(client, runId, limiteDe(body));
  if (status === "erro") {
    return jsonResponse({ error: "Falha na leitura do portal", sync_id: runId, ...stats }, 500);
  }
  return jsonResponse({ status, sync_id: runId, ...stats });
});
