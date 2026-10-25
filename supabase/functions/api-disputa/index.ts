import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";
import {
  type AuthenticatedUser,
  authenticateCron,
  authenticateUser,
  corsHeaders,
  isLicitagymAdmin,
  jsonResponse,
} from "../_shared/http.ts";
import { ErroTenantAcesso, lerTenantDoUsuario } from "../_shared/tenant.ts";
import {
  consultarChatSerpro,
  consultarDiligenciasSerpro,
  type MensagemSerpro,
} from "../_shared/serpro.ts";
import { pisoTenantCentavos } from "../_shared/agentes/preco.ts";

export interface ApiDisputaContext {
  getSupabase?: () => SupabaseClient;
  getUser?: (req: Request) => Promise<AuthenticatedUser | null>;
  isCron?: (req: Request) => boolean;
  consultarChat?: (chave: string) => Promise<MensagemSerpro[]>;
  consultarDiligencias?: (chave: string) => Promise<MensagemSerpro[]>;
}

function getDefaultServiceClient(): SupabaseClient {
  const url = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !serviceKey) {
    throw new Error("Variáveis de ambiente SUPABASE_URL ou SUPABASE_SERVICE_ROLE_KEY não configuradas.");
  }
  return createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
}

/** Extrai estritamente a chaveCompra oficial de 17 dígitos do Compras.gov.br. */
export function extrairChaveCompra17Digitos(licitacao: {
  codigo_externo?: string | null;
  link_sistema_origem?: string | null;
  raw?: Record<string, unknown> | null;
}): string | null {
  const COMPRAS_KEY_RE = /^\d{17}$/;
  const rawObj = (licitacao.raw && typeof licitacao.raw === "object") ? licitacao.raw : {};

  // 1. Campo explícito em raw (chaveCompra, chave_compra, idCompra, id_compra, compra)
  const rawCands = [rawObj.chaveCompra, rawObj.chave_compra, rawObj.idCompra, rawObj.id_compra, rawObj.compra];
  for (const c of rawCands) {
    if (typeof c === "string" && COMPRAS_KEY_RE.test(c.trim())) {
      return c.trim();
    }
  }

  // 2. codigo_externo (ex: "COMPRASGOV-PP-15300005000012026" ou direto "15300005000012026")
  if (typeof licitacao.codigo_externo === "string") {
    const cod = licitacao.codigo_externo.trim();
    if (COMPRAS_KEY_RE.test(cod)) return cod;
    if (cod.startsWith("COMPRASGOV-PP-")) {
      const semPrefixo = cod.slice("COMPRASGOV-PP-".length).trim();
      if (COMPRAS_KEY_RE.test(semPrefixo)) return semPrefixo;
    }
  }

  // 3. link_sistema_origem (ex: https://cnetmobile.estaleiro.serpro.gov.br/...compra=15300005000012026)
  if (typeof licitacao.link_sistema_origem === "string") {
    try {
      const url = new URL(licitacao.link_sistema_origem);
      const compraParam = url.searchParams.get("compra");
      if (compraParam && COMPRAS_KEY_RE.test(compraParam.trim())) {
        return compraParam.trim();
      }
    } catch {
      // Ignora erro de parsing de URL
    }
  }

  return null;
}

export async function handleRequest(req: Request, ctx?: ApiDisputaContext): Promise<Response> {
  // CORS Preflight
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const url = new URL(req.url);
  const caminho = url.pathname.replace(/^\/api-disputa\/?/, "");

  try {
    let isCron = false;
    if (ctx?.isCron) {
      isCron = ctx.isCron(req);
    } else {
      try {
        isCron = authenticateCron(req) === "CRON_AUTHENTICATED";
      } catch {
        isCron = false;
      }
    }

    let user: AuthenticatedUser | null = null;
    let tenantId = 0;

    if (isCron) {
      if (caminho !== "sync-chat") {
        return jsonResponse({ erro: "Acesso por cron permitido apenas para /sync-chat." }, 403);
      }
    } else {
      user = ctx?.getUser ? await ctx.getUser(req) : await authenticateUser(req);
      if (!user) {
        return jsonResponse({ erro: "Não autenticado." }, 401);
      }
    }

    const supabase = ctx?.getSupabase ? ctx.getSupabase() : getDefaultServiceClient();

    if (!isCron && user) {
      const tenantRes = await lerTenantDoUsuario(
        supabase,
        user.id,
        isLicitagymAdmin(user)
      );
      tenantId = tenantRes.tenant;
    }

    // 1. GET /api-disputa/estrategia?licitacao_id=...
    if (req.method === "GET" && (caminho === "estrategia" || caminho === "")) {
      const licitacaoIdStr = url.searchParams.get("licitacao_id");
      if (!licitacaoIdStr) {
        return jsonResponse({ erro: "Parâmetro licitacao_id obrigatório." }, 400);
      }
      const licitacaoId = parseInt(licitacaoIdStr, 10);
      if (isNaN(licitacaoId)) {
        return jsonResponse({ erro: "licitacao_id inválido." }, 400);
      }

      // Verifica se a licitação está no pipeline do tenant
      const { data: pipelineRow, error: erroPipeline } = await supabase
        .from("pipeline_oportunidades")
        .select("licitacao_id")
        .eq("tenant_id", tenantId)
        .eq("licitacao_id", licitacaoId)
        .maybeSingle();

      if (erroPipeline) throw erroPipeline;
      if (!pipelineRow) {
        return jsonResponse({ erro: "Oportunidade não encontrada no pipeline do tenant." }, 404);
      }

      // Busca dados dos itens da licitação
      const { data: itens, error: erroItens } = await supabase
        .from("licitacao_itens")
        .select("id, numero_item, descricao, valor_unitario_estimado, valor_total_estimado")
        .eq("licitacao_id", licitacaoId)
        .order("numero_item", { ascending: true });

      if (erroItens) throw erroItens;

      // Busca mapeamento de-para confirmado no catálogo do tenant (determinístico: order by id asc, idêntico a api-agentes)
      const itemIds = (itens || []).map((it) => it.id);
      const deParaMap = new Map<number, number>(); // licitacao_item_id -> produto_id
      if (itemIds.length > 0) {
        const { data: deParaRows, error: erroDePara } = await supabase
          .from("catalogo_de_para")
          .select("id, licitacao_item_id, produto_id")
          .eq("tenant_id", tenantId)
          .in("licitacao_item_id", itemIds)
          .eq("status", "confirmado")
          .order("id", { ascending: true });

        if (erroDePara) throw erroDePara;

        for (const dp of deParaRows || []) {
          if (dp.licitacao_item_id && dp.produto_id) {
            // Mantém o primeiro produto confirmado ordenado por id (compatível com api-agentes repo.ts:398)
            if (!deParaMap.has(dp.licitacao_item_id)) {
              deParaMap.set(dp.licitacao_item_id, dp.produto_id);
            }
          }
        }
      }

      // Busca preços vigentes para os produtos mapeados
      const produtoIds = Array.from(new Set(Array.from(deParaMap.values())));
      const precosPorProduto = new Map<number, { preco_tabela: number; desconto_max_pct: number }>();
      if (produtoIds.length > 0) {
        const hoje = new Date().toISOString().slice(0, 10);
        const { data: precosRows, error: erroPrecos } = await supabase
          .from("catalogo_precos")
          .select("produto_id, preco_tabela, desconto_max_pct, vigencia_inicio, vigencia_fim")
          .eq("tenant_id", tenantId)
          .in("produto_id", produtoIds)
          .lte("vigencia_inicio", hoje)
          .order("vigencia_inicio", { ascending: false });

        if (erroPrecos) throw erroPrecos;

        for (const p of precosRows || []) {
          if (!precosPorProduto.has(p.produto_id)) {
            if (p.vigencia_fim === null || String(p.vigencia_fim) >= hoje) {
              if (typeof p.preco_tabela === "number") {
                precosPorProduto.set(p.produto_id, {
                  preco_tabela: p.preco_tabela,
                  desconto_max_pct: typeof p.desconto_max_pct === "number" ? p.desconto_max_pct : 0,
                });
              }
            }
          }
        }
      }

      // Constrói estratégia determinística estrita (sem alucinar pisos inexistentes)
      const itensEstrategia = (itens || []).map((it) => {
        const itemNum = it.numero_item || 1;
        const produtoId = deParaMap.get(it.id);
        let pisoCentavos: number | null = null;
        let habilitado = false;

        if (produtoId !== undefined) {
          const preco = precosPorProduto.get(produtoId);
          if (preco) {
            const tabelaCentavos = Math.round(preco.preco_tabela * 100);
            pisoCentavos = pisoTenantCentavos(tabelaCentavos, preco.desconto_max_pct);
            habilitado = true;
          }
        }

        return {
          item_numero: itemNum,
          descricao: it.descricao,
          valor_unitario_estimado: it.valor_unitario_estimado,
          valor_total_estimado: it.valor_total_estimado,
          piso_centavos: pisoCentavos,
          habilitado,
          intervalo_minimo_reais: 10.0,
        };
      });

      const primeiroPiso = itensEstrategia[0]?.piso_centavos ?? null;

      return jsonResponse({
        licitacao_id: licitacaoId,
        tenant_id: tenantId,
        modo_disputa: "aberto",
        intervalo_minimo_reais: 10.0,
        piso_centavos: primeiroPiso,
        habilitado: itensEstrategia[0]?.habilitado ?? false,
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
      const licitacaoId = parseInt(licitacaoIdStr, 10);
      if (isNaN(licitacaoId)) {
        return jsonResponse({ erro: "licitacao_id inválido." }, 400);
      }

      // Verifica se a licitação pertence ao pipeline do tenant
      const { data: pipelineRow, error: erroPipeline } = await supabase
        .from("pipeline_oportunidades")
        .select("licitacao_id")
        .eq("tenant_id", tenantId)
        .eq("licitacao_id", licitacaoId)
        .maybeSingle();

      if (erroPipeline) throw erroPipeline;
      if (!pipelineRow) {
        return jsonResponse({ erro: "Oportunidade não encontrada no pipeline do tenant." }, 404);
      }

      const { data: mensagens, error } = await supabase
        .from("disputa_mensagens")
        .select("*")
        .eq("tenant_id", tenantId)
        .eq("licitacao_id", licitacaoId)
        .order("data_hora_oficial", { ascending: true });

      if (error) throw error;
      return jsonResponse({ ok: true, mensagens: mensagens || [] });
    }

    // 4. POST /api-disputa/sync-chat (sincroniza com o Serpro sob demanda ou por cron)
    if (req.method === "POST" && caminho === "sync-chat") {
      const body = await req.json();
      const { licitacao_id, chave_compra } = body;

      if (!licitacao_id) {
        return jsonResponse({ erro: "licitacao_id é obrigatório." }, 400);
      }

      const licitacaoId = parseInt(String(licitacao_id), 10);
      if (isNaN(licitacaoId)) {
        return jsonResponse({ erro: "licitacao_id inválido." }, 400);
      }

      let tenantsAlvo: number[] = [];

      // Se for acionado por cron, resolve todos os tenants com essa licitação no pipeline (ou valida o tenant informado)
      if (isCron) {
        const tenantParam = body.tenant_id ? parseInt(String(body.tenant_id), 10) : null;
        if (tenantParam && !isNaN(tenantParam)) {
          const { data: pipe, error: ePipe } = await supabase
            .from("pipeline_oportunidades")
            .select("tenant_id")
            .eq("tenant_id", tenantParam)
            .eq("licitacao_id", licitacaoId)
            .maybeSingle();
          if (ePipe) throw ePipe;
          if (!pipe) {
            return jsonResponse({ erro: "Licitação não vinculada ao tenant informado no pipeline." }, 404);
          }
          tenantsAlvo = [tenantParam];
        } else {
          const { data: pipes, error: ePipe } = await supabase
            .from("pipeline_oportunidades")
            .select("tenant_id")
            .eq("licitacao_id", licitacaoId);
          if (ePipe) throw ePipe;
          if (!pipes || pipes.length === 0) {
            return jsonResponse({ erro: "Licitação não vinculada a nenhum tenant ativo no pipeline." }, 404);
          }
          tenantsAlvo = Array.from(new Set(pipes.map((p) => p.tenant_id)));
        }
      } else {
        // Para usuário autenticado, verifica se a licitação pertence ao seu tenant
        const { data: pipelineRow, error: erroPipeline } = await supabase
          .from("pipeline_oportunidades")
          .select("licitacao_id")
          .eq("tenant_id", tenantId)
          .eq("licitacao_id", licitacaoId)
          .maybeSingle();

        if (erroPipeline) throw erroPipeline;
        if (!pipelineRow) {
          return jsonResponse({ erro: "Oportunidade não encontrada no pipeline do tenant." }, 404);
        }
        tenantsAlvo = [tenantId];
      }

      // Validação de segurança (K-3 / Anti-Proxy): amarra a chave_compra estritamente ao registro oficial
      const { data: licitacao, error: erroLic } = await supabase
        .from("licitacoes_externas")
        .select("id, codigo_externo, link_sistema_origem, raw")
        .eq("id", licitacaoId)
        .maybeSingle();

      if (erroLic) throw erroLic;
      if (!licitacao) {
        return jsonResponse({ erro: "Licitação não encontrada." }, 404);
      }

      const chaveOficial = extrairChaveCompra17Digitos(licitacao);
      if (!chaveOficial) {
        return jsonResponse({
          erro: "Esta licitação não possui chave oficial de compra do Compras.gov (17 dígitos) para consulta no Integra Compras."
        }, 400);
      }

      // Rejeita estritamente qualquer tentativa de proxy com chave alheia
      if (typeof chave_compra === "string" && chave_compra.trim() && chave_compra.trim() !== chaveOficial) {
        return jsonResponse({ erro: "Chave de compra não corresponde ao registro oficial da licitação." }, 400);
      }

      const chaveFinal = chaveOficial;

      // Consulta mensagens e diligências no Integra Compras
      const fnChat = ctx?.consultarChat ?? consultarChatSerpro;
      const fnDiligencias = ctx?.consultarDiligencias ?? consultarDiligenciasSerpro;

      const [mensagensChat, diligencias] = await Promise.all([
        fnChat(chaveFinal),
        fnDiligencias(chaveFinal),
      ]);

      const todas: MensagemSerpro[] = [...mensagensChat, ...diligencias];
      let inseridas = 0;

      for (const tId of tenantsAlvo) {
        for (const m of todas) {
          const { error: erroUpsert } = await supabase.from("disputa_mensagens").upsert(
            {
              tenant_id: tId,
              licitacao_id: licitacaoId,
              chave_compra: chaveFinal,
              item_numero: m.item ?? null,
              categoria: m.categoria.toLowerCase(),
              remetente: m.remetente,
              mensagem: m.texto,
              data_hora_oficial: new Date(m.dataHora).toISOString(),
            },
            { onConflict: "tenant_id,chave_compra,data_hora_oficial,mensagem" }
          );

          if (erroUpsert) {
            console.error(`[api-disputa] Falha ao persistir mensagem Serpro para tenant ${tId}:`, erroUpsert);
            throw erroUpsert;
          }
          inseridas++;
        }
      }

      return jsonResponse({ ok: true, total_lidas: todas.length, novas_inseridas: inseridas });
    }

    return jsonResponse({ erro: "Rota não encontrada." }, 404);
  } catch (err) {
    if (err instanceof ErroTenantAcesso) {
      return jsonResponse({ erro: err.message }, err.status);
    }
    console.error("[api-disputa] Erro interno:", err instanceof Error ? err.message : err);
    return jsonResponse({ erro: "Erro interno no servidor." }, 500);
  }
}

if (import.meta.main) {
  Deno.serve((req: Request) => handleRequest(req));
}
