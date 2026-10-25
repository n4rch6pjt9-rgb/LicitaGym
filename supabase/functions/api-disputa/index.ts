import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";
import {
  authenticateUser,
  corsHeaders,
  errorDetail,
  isLicitagymAdmin,
  jsonResponse,
} from "../_shared/http.ts";
import { ErroTenantAcesso, lerTenantDoUsuario } from "../_shared/tenant.ts";
import {
  consultarChatSerpro,
  consultarDiligenciasSerpro,
  type MensagemSerpro,
} from "../_shared/serpro.ts";

function getDefaultServiceClient(): SupabaseClient {
  const url = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !serviceKey) {
    throw new Error("Variáveis de ambiente SUPABASE_URL ou SUPABASE_SERVICE_ROLE_KEY não configuradas.");
  }
  return createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
}

Deno.serve(async (req: Request) => {
  // CORS Preflight
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const url = new URL(req.url);
  const caminho = url.pathname.replace(/^\/api-disputa\/?/, "");

  try {
    const user = await authenticateUser(req);
    if (!user) {
      return jsonResponse({ erro: "Não autenticado." }, 401);
    }

    const supabase = getDefaultServiceClient();
    const { tenant: tenantId } = await lerTenantDoUsuario(
      supabase,
      user.id,
      isLicitagymAdmin(user)
    );

    // 1. GET /api-disputa/estrategia?licitacao_id=...
    if (req.method === "GET" && (caminho === "estrategia" || caminho === "")) {
      const licitacaoIdStr = url.searchParams.get("licitacao_id");
      if (!licitacaoIdStr) {
        return jsonResponse({ erro: "Parâmetro licitacao_id obrigatório." }, 400);
      }
      const licitacaoId = parseInt(licitacaoIdStr, 10);

      // Busca dados da licitação e piso dos itens cadastrados para o tenant
      const { data: itens, error: erroItens } = await supabase
        .from("licitacao_itens")
        .select("id, numero_item, descricao, valor_estimado")
        .eq("licitacao_id", licitacaoId);

      if (erroItens) throw erroItens;

      // Busca propostas do tenant (se existirem na etapa Proposta)
      const { data: propostas } = await supabase
        .from("propostas_itens")
        .select("item_numero, piso_centavos, valor_proposta_centavos")
        .eq("tenant_id", tenantId)
        .eq("licitacao_id", licitacaoId);

      const mapaPisos = new Map<number, number>();
      if (propostas) {
        for (const p of propostas) {
          if (typeof p.piso_centavos === "number") {
            mapaPisos.set(p.item_numero, p.piso_centavos);
          }
        }
      }

      // Constrói estratégia consolidada
      const itensEstrategia = (itens || []).map((it) => {
        const itemNum = it.numero_item || 1;
        const pisoCentavos = mapaPisos.get(itemNum) || Math.round((it.valor_estimado || 0) * 0.7 * 100); // fallback conservador se não parametrizado
        return {
          item_numero: itemNum,
          descricao: it.descricao,
          piso_centavos: pisoCentavos,
          intervalo_minimo_reais: 10.0, // R$ 10,00 ou percentual configurado
        };
      });

      return jsonResponse({
        licitacao_id: licitacaoId,
        tenant_id: tenantId,
        modo_disputa: "aberto",
        intervalo_minimo_reais: 10.0,
        piso_centavos: itensEstrategia[0]?.piso_centavos || 0,
        itens: itensEstrategia,
      });
    }

    // 2. POST /api-disputa/auditoria (enviado pela extensão web)
    if (req.method === "POST" && caminho === "auditoria") {
      const body = await req.json();

      const { data, error } = await supabase.from("disputa_lances_auditoria").insert({
        tenant_id: tenantId,
        licitacao_id: body.licitacaoId ? parseInt(body.licitacaoId, 10) : null,
        item_numero: body.item_numero || 1,
        valor_lance_centavos: body.valor ? Math.round(body.valor * 100) : 0,
        piso_referencia_centavos: body.piso ? Math.round(body.piso * 100) : 0,
        melhor_lance_adversario_centavos: body.melhorOferta ? Math.round(body.melhorOferta * 100) : null,
        modo_disputa: body.modo_disputa || "aberto",
        regra_aplicada: body.tipo || "lance_automatico",
        origem: "extensao_operador",
        resultado: body.tipo === "BLOQUEIO_PISO" ? "bloqueado_piso" : "sucesso",
        detalhes: body,
      }).select("id").single();

      if (error) throw error;
      return jsonResponse({ ok: true, id: data.id });
    }

    // 3. GET /api-disputa/chat?licitacao_id=... (consumido pelo Dashboard)
    if (req.method === "GET" && caminho === "chat") {
      const licitacaoIdStr = url.searchParams.get("licitacao_id");
      if (!licitacaoIdStr) {
        return jsonResponse({ erro: "Parâmetro licitacao_id obrigatório." }, 400);
      }

      const { data: mensagens, error } = await supabase
        .from("disputa_mensagens")
        .select("*")
        .eq("tenant_id", tenantId)
        .eq("licitacao_id", parseInt(licitacaoIdStr, 10))
        .order("data_hora_oficial", { ascending: true });

      if (error) throw error;
      return jsonResponse({ ok: true, mensagens });
    }

    // 4. POST /api-disputa/sync-chat (sincroniza com o Serpro sob demanda ou por cron)
    if (req.method === "POST" && caminho === "sync-chat") {
      const body = await req.json();
      const { licitacao_id, chave_compra } = body;

      if (!licitacao_id || !chave_compra) {
        return jsonResponse({ erro: "licitacao_id e chave_compra são obrigatórios." }, 400);
      }

      // Consulta mensagens e diligências no Integra Compras
      const [mensagensChat, diligencias] = await Promise.all([
        consultarChatSerpro(chave_compra),
        consultarDiligenciasSerpro(chave_compra),
      ]);

      const todas: MensagemSerpro[] = [...mensagensChat, ...diligencias];
      let inseridas = 0;

      for (const m of todas) {
        const { error } = await supabase.from("disputa_mensagens").upsert(
          {
            tenant_id: tenantId,
            licitacao_id: licitacao_id,
            chave_compra: chave_compra,
            item_numero: m.item ?? null,
            categoria: m.categoria.toLowerCase(),
            remetente: m.remetente,
            mensagem: m.texto,
            data_hora_oficial: new Date(m.dataHora).toISOString(),
          },
          { onConflict: "tenant_id,chave_compra,data_hora_oficial,mensagem" }
        );

        if (!error) inseridas++;
      }

      return jsonResponse({ ok: true, total_lidas: todas.length, novas_inseridas: inseridas });
    }

    return jsonResponse({ erro: "Rota não encontrada." }, 404);
  } catch (err) {
    if (err instanceof ErroTenantAcesso) {
      return jsonResponse({ erro: err.message }, err.status);
    }
    return jsonResponse({ erro: errorDetail(err) }, 500);
  }
});
