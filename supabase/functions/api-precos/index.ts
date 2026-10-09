// Edge Function api-precos (spec specs/0009-precos-historicos-pesquisa-preco.md): preços homologados da Pesquisa de
// Preço do Compras.gov para o Dashboard (/precos e aba "Inteligência de Preços"). Só leitura, só GET.
// verify_jwt = false no config.toml (como as demais api-*): a sessão do usuário é validada no código
// (requireUserAuth em precos.ts) antes de qualquer cliente service_role.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { corsHeaders, jsonResponse } from "../_shared/http.ts";
import { responderPrecos } from "./precos.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "GET") return jsonResponse({ error: "Method not allowed" }, 405);
  return await responderPrecos(req, new URL(req.url));
});
