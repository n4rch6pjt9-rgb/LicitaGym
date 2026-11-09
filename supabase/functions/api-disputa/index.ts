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
import type { ResultadoConsultaIntegra } from "../_shared/serpro.ts";
import { extrairChaveCompra17Digitos, sincronizarCompra } from "../_shared/sessao_chat.ts";
import { pisoTenantCentavos, unidadeNorm } from "../_shared/agentes/preco.ts";
import { recomendar, type RecomendacaoLance } from "../_shared/recomendacao.ts";
import { listarSessoes } from "./sessoes.ts";
import { listarAlertas, marcarAlertaLido } from "./alertas.ts";

/** Intervalo mínimo entre consultas manuais da mesma compra (cada chamada ao Integra Compras é cobrada). */
const INTERVALO_MINIMO_USUARIO_MS = 5 * 60_000;

export interface ApiDisputaContext {
  getSupabase?: () => SupabaseClient;
  getUser?: (req: Request) => Promise<AuthenticatedUser | null>;
  isCron?: (req: Request) => boolean;
  consultarChat?: (chave: string) => Promise<ResultadoConsultaIntegra>;
  consultarDiligencias?: (chave: string) => Promise<ResultadoConsultaIntegra>;
  agora?: () => number;
}

function getDefaultServiceClient(): SupabaseClient {
  const url = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !serviceKey) {
    throw new Error("Variáveis de ambiente SUPABASE_URL ou SUPABASE_SERVICE_ROLE_KEY não configuradas.");
  }
  return createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
}

export { extrairChaveCompra17Digitos };

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

    // 0. GET /api-disputa/sessoes: compras do pipeline com o estado do chat da sessão (tela "Sessão").
    if (req.method === "GET" && caminho === "sessoes") {
      const sessoes = await listarSessoes(supabase, tenantId, ctx?.agora ? ctx.agora() : Date.now());
      return jsonResponse({ ok: true, fonte: "integra_compras", sessoes });
    }

    // 0b. Alertas de convocação do chat (spec 0039, etapa 1b, K-5c e K-5d). Só do tenant de quem chama.
    if (req.method === "GET" && caminho === "alertas") {
      const alertas = await listarAlertas(supabase, tenantId, {
        naoLidos: url.searchParams.get("nao_lidos") === "true",
        agoraMs: ctx?.agora ? ctx.agora() : Date.now(),
      });
      return jsonResponse({ ok: true, alertas });
    }
    if (req.method === "POST" && caminho === "alertas/lido") {
      let corpo: unknown = null;
      try {
        corpo = await req.json();
      } catch {
        return jsonResponse({ erro: "Corpo JSON inválido." }, 400);
      }
      const id = (corpo as { id?: unknown } | null)?.id;
      if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0) {
        return jsonResponse({ erro: "Informe o id do alerta (inteiro positivo)." }, 400);
      }
      if (!user) return jsonResponse({ erro: "Não autenticado." }, 401);
      const marcado = await marcarAlertaLido(supabase, tenantId, id, user.id, ctx?.agora ? ctx.agora() : Date.now());
      if (!marcado) return jsonResponse({ erro: "Alerta não encontrado." }, 404);
      return jsonResponse({ ok: true });
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
        .select("id, numero_item, descricao, valor_unitario_estimado, valor_total_estimado, catalogo_codigo_item, unidade_medida")
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

      // CONTRATO RECOMENDACAO v1: enriquece cada item com RecomendacaoLance
      const recomendacoesPorItem = new Map<number, RecomendacaoLance>();
      for (const item of itens || []) {
        const produtoId = deParaMap.get(item.id);
        if (produtoId === undefined) continue;

        const preco = precosPorProduto.get(produtoId);
        if (!preco) continue;

        const tabelaCentavos = Math.round(preco.preco_tabela * 100);
        const pisoCentavos = pisoTenantCentavos(tabelaCentavos, preco.desconto_max_pct);

        const rec = await recomendar(
          {
            codigo_item: Number(item.catalogo_codigo_item ?? 0),
            unidade: unidadeNorm(item.unidade_medida),
            custo_proprio: pisoCentavos / 100,
            margem_min: 0,
            estimado_edital: Number(item.valor_unitario_estimado ?? 0),
          },
          supabase,
        );

        recomendacoesPorItem.set(item.id, rec);
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

        const recomendacao = recomendacoesPorItem.get(it.id) || null;

        return {
          item_numero: itemNum,
          descricao: it.descricao,
          valor_unitario_estimado: it.valor_unitario_estimado,
          valor_total_estimado: it.valor_total_estimado,
          piso_centavos: pisoCentavos,
          habilitado,
          intervalo_minimo_reais: 10.0,
          recomendacao,
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
        detalhes: {
          ...body,
          recomendacao_id: body.recomendacao_id ?? null,
          regra_version: body.regra_version ?? "bot-guards.v1",
        },
      }).select("id").single();

      if (error) throw error;
      return jsonResponse({ ok: true, id: data.id });
    }

    // 3. GET /api-disputa/chat?licitacao_id=... (consumido pelo Dashboard)
    //    O chat é global (uma cópia por compra); o acesso é amarrado ao pipeline do tenant.
    if (req.method === "GET" && caminho === "chat") {
      const licitacaoIdStr = url.searchParams.get("licitacao_id");
      if (!licitacaoIdStr) {
        return jsonResponse({ erro: "Parâmetro licitacao_id obrigatório." }, 400);
      }
      const licitacaoId = parseInt(licitacaoIdStr, 10);
      if (isNaN(licitacaoId)) {
        return jsonResponse({ erro: "licitacao_id inválido." }, 400);
      }

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

      const { data: licitacao, error: erroLic } = await supabase
        .from("licitacoes_externas")
        .select("id, codigo_externo, link_sistema_origem, raw")
        .eq("id", licitacaoId)
        .maybeSingle();
      if (erroLic) throw erroLic;

      const chaveCompra = licitacao ? extrairChaveCompra17Digitos(licitacao) : null;
      if (!chaveCompra) {
        // Estado explícito: sem chave oficial não há como consultar o chat (nunca lista vazia disfarçada).
        return jsonResponse({
          ok: true,
          fonte: "integra_compras",
          chave_compra: null,
          motivo: "sem_chave_compra",
          ultima_consulta: null,
          mensagens: [],
        });
      }

      const { data: mensagens, error } = await supabase
        .from("sessao_mensagens")
        .select(
          "chave_mensagem, tipo, identificador_item, categoria, tipo_remetente, texto, data_hora, data_hora_fonte, fonte, coletado_em",
        )
        .eq("chave_compra", chaveCompra)
        .order("data_hora", { ascending: true })
        .order("id", { ascending: true });
      if (error) throw error;

      const { data: ultimaRun, error: erroRun } = await supabase
        .schema("private")
        .from("integra_compras_run")
        .select("iniciado_em, terminado_em, erro")
        .eq("chave_compra", chaveCompra)
        .order("iniciado_em", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (erroRun) throw erroRun;

      return jsonResponse({
        ok: true,
        fonte: "integra_compras",
        chave_compra: chaveCompra,
        motivo: null,
        ultima_consulta: ultimaRun
          ? { iniciado_em: ultimaRun.iniciado_em, terminado_em: ultimaRun.terminado_em, com_erro: Boolean(ultimaRun.erro) }
          : null,
        mensagens: mensagens || [],
      });
    }

    // 4. POST /api-disputa/sync-chat (consulta o Integra Compras sob demanda ou por cron)
    if (req.method === "POST" && caminho === "sync-chat") {
      let body: Record<string, unknown>;
      try {
        body = await req.json();
      } catch {
        return jsonResponse({ erro: "Corpo JSON inválido." }, 400);
      }
      const { licitacao_id, chave_compra } = body;

      if (!licitacao_id) {
        return jsonResponse({ erro: "licitacao_id é obrigatório." }, 400);
      }

      const licitacaoId = parseInt(String(licitacao_id), 10);
      if (isNaN(licitacaoId)) {
        return jsonResponse({ erro: "licitacao_id inválido." }, 400);
      }

      // Só compras que estão no pipeline de algum tenant são consultadas (cada chamada é cobrada).
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
        } else {
          const { data: pipes, error: ePipe } = await supabase
            .from("pipeline_oportunidades")
            .select("tenant_id")
            .eq("licitacao_id", licitacaoId);
          if (ePipe) throw ePipe;
          if (!pipes || pipes.length === 0) {
            return jsonResponse({ erro: "Licitação não vinculada a nenhum tenant ativo no pipeline." }, 404);
          }
        }
      } else {
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
      }

      // A chave consultada vem sempre do registro oficial da licitação, nunca do corpo da requisição.
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

      if (typeof chave_compra === "string" && chave_compra.trim() && chave_compra.trim() !== chaveOficial) {
        return jsonResponse({ erro: "Chave de compra não corresponde ao registro oficial da licitação." }, 400);
      }

      // Cada consulta é cobrada: pedido manual repetido na mesma compra espera o intervalo mínimo.
      if (!isCron) {
        const { data: recente, error: erroRecente } = await supabase
          .schema("private")
          .from("integra_compras_run")
          .select("iniciado_em")
          .eq("chave_compra", chaveOficial)
          .order("iniciado_em", { ascending: false })
          .limit(1)
          .maybeSingle();
        if (erroRecente) throw erroRecente;
        const ultima = recente?.iniciado_em ? new Date(String(recente.iniciado_em)).getTime() : NaN;
        if (Number.isFinite(ultima) && Date.now() - ultima < INTERVALO_MINIMO_USUARIO_MS) {
          return jsonResponse({
            erro: "Esta compra foi consultada há pouco. Aguarde alguns minutos para consultar de novo.",
            ultima_consulta: recente!.iniciado_em,
          }, 429);
        }
      }

      const r = await sincronizarCompra(
        supabase,
        { chaveCompra: chaveOficial, licitacaoId, origem: isCron ? "cron" : "usuario" },
        { consultarChat: ctx?.consultarChat, consultarDiligencias: ctx?.consultarDiligencias },
      );

      if (!r.ok) {
        return jsonResponse({
          ok: false,
          erro: `Integra Compras indisponível (HTTP ${r.status_erro ?? "sem resposta"}). Nada foi apagado.`,
          total_lidas: r.total_lidas,
          novas_inseridas: r.novas_inseridas,
          alertas_gerados: r.alertas_gerados,
          chamadas: r.chamadas,
        }, 502);
      }

      return jsonResponse({
        ok: true,
        total_lidas: r.total_lidas,
        novas_inseridas: r.novas_inseridas,
        alertas_gerados: r.alertas_gerados,
        chamadas: r.chamadas,
      });
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
