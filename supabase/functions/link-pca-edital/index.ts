import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { corsHeaders, jsonResponse, validateCronAuth } from "./_shared_prod/http.ts";
import { createServiceClient } from "./_shared_prod/pncp/supabase-admin.ts";
import { classesDoCatalogo, resolverClasses } from "../_shared/catalogo-classes.ts";
import { contarPlanosNasClasses, executarLink, falhaLink } from "./casamento.ts";

type LinkBody = {
  /** Janela |prevista − pub| em dias (default 90). */
  janela_dias?: number;
  /** Limite de editais sem vínculo a analisar por chamada. */
  limite?: number;
  /** dry_run=true faz o casamento inteiro e não grava — reporta as decisões únicas que gravaria. */
  dry_run?: boolean;
  /** Classes PCA no fallback PDM. Padrão: as classes efetivas do catálogo CATMAT da empresa; pedidas, só as dele. */
  classes?: string[];
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return jsonResponse({ error: "Use POST" }, 405);
  if (!validateCronAuth(req)) return jsonResponse({ error: "Unauthorized" }, 401);

  const body = (await req.json().catch(() => ({}))) as LinkBody;
  const janelaDias = Math.min(Math.max(body.janela_dias ?? 90, 1), 365);
  const limite = Math.min(Math.max(body.limite ?? 500, 1), 2000);
  const dryRun = body.dry_run === true;
  const ano = new Date().getUTCFullYear();

  const client = createServiceClient();

  let catalogo: string[];
  try {
    catalogo = await classesDoCatalogo(client as never);
  } catch (error) {
    return falhaLink("catálogo", error);
  }
  const resolvidas = resolverClasses(body.classes, catalogo);
  if (!resolvidas.ok) return jsonResponse({ error: resolvidas.erro }, resolvidas.status);
  const classes = resolvidas.classes;

  try {
    const planosNasClasses = await contarPlanosNasClasses(client, classes, ano);
    const { stats, decisions } = await executarLink(client, { janelaDias, limite, dryRun, classes });
    return jsonResponse({
      status: "ok",
      escopo: {
        fonte: "pncp",
        classes,
        origem_classes: body.classes?.length ? "pedido" : "catalogo_catmat",
        ano,
      },
      planos_nas_classes: planosNasClasses,
      ...stats,
      amostra_decisoes: decisions.slice(0, 20),
      nota: stats.vinculados + stats.vinculados_externas === 0
        ? "ainda 0 — sem match unívoco em contratacoes_editais nem em licitacoes_externas. dry_run não grava."
        : dryRun
        ? "dry_run: vinculados e vinculados_externas são as decisões únicas que seriam gravadas; nada foi gravado."
        : null,
    });
  } catch (error) {
    return falhaLink("leitura", error);
  }
});
