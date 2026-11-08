import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { corsHeaders, jsonResponse, requireCronAuth } from "../_shared/http.ts";

// Aposentada pela spec 0042 (08/11/2026). A raspagem de páginas-índice gravava links de navegação como "vigente" e
// falhava toda semana (planalto.gov.br recusa a conexão vinda do Supabase). O cron foi desagendado pela migration
// 20261109000000_legislacao_aposenta_sync; a legislação passou a ser corpus curado
// (services/coletor-externo/coletor/data/legislacao_corpus.json) vigiado pelo verificador trimestral no Cloud Run.
// A função continua publicada só para responder 410 a quem ainda a chamar; a remoção é da spec 0043.

export interface SyncLegislationContext {
  validarCron: (req: Request) => boolean;
}

const contextoPadrao: SyncLegislationContext = {
  validarCron: (req) => requireCronAuth(req) === null,
};

export function handleRequest(req: Request, ctx: SyncLegislationContext = contextoPadrao): Response {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (!ctx.validarCron(req)) return jsonResponse({ error: "Unauthorized" }, 401);
  return jsonResponse({ error: "aposentada pela spec 0042" }, 410);
}

if (import.meta.main) Deno.serve((req) => handleRequest(req));
