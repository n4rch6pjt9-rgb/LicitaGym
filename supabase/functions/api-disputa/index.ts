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
  ErroIntegraCompras,
  type MensagemIntegra,
  type ResultadoConsultaIntegra,
} from "../_shared/serpro.ts";
import { pisoTenantCentavos, unidadeNorm } from "../_shared/agentes/preco.ts";
import { recomendar, type RecomendacaoLance } from "../_shared/recomendacao.ts";

export interface ApiDisputaContext {
  getSupabase?: () => SupabaseClient;
  getUser?: (req: Request) => Promise<AuthenticatedUser | null>;
  isCron?: (req: Request) => boolean;
  consultarChat?: (chave: string) => Promise<ResultadoConsultaIntegra>;
  consultarDiligencias?: (chave: string) => Promise<ResultadoConsultaIntegra>;
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
        .order("data_hora", { ascending: true });
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
      const body = await req.json();
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

      // K-2: registro da execução (chamadas por código HTTP; 200, 206 e 404 são cobrados).
      const { data: run, error: erroRun } = await supabase
        .schema("private")
        .from("integra_compras_run")
        .insert({ chave_compra: chaveOficial, origem: isCron ? "cron" : "usuario" })
        .select("id")
        .single();
      if (erroRun) throw erroRun;

      const chamadas: Record<string, number> = {};
      const contar = (status: number | null) => {
        const k = status === null ? "sem_resposta" : String(status);
        chamadas[k] = (chamadas[k] ?? 0) + 1;
      };

      const fnChat = ctx?.consultarChat ?? consultarChatSerpro;
      const fnDiligencias = ctx?.consultarDiligencias ?? consultarDiligenciasSerpro;

      const lidas: MensagemIntegra[] = [];
      let erroFonte: ErroIntegraCompras | null = null;
      for (const fn of [fnChat, fnDiligencias]) {
        try {
          const r = await fn(chaveOficial);
          contar(r.status);
          lidas.push(...r.mensagens);
        } catch (e) {
          if (!(e instanceof ErroIntegraCompras)) throw e;
          contar(e.status);
          erroFonte = e;
          break; // 403/502: registra e para a compra (K-3)
        }
      }

      // Grava sem duplicar: chave_mensagem já gravada é ignorada (nada é apagado nem sobrescrito).
      let novas = 0;
      if (lidas.length > 0) {
        const linhas = lidas.map((m) => ({
          chave_compra: chaveOficial,
          id_uasg: m.chaveCompra?.idUasgIdentificacao ?? null,
          id_modalidade: m.chaveCompra?.idModalidade ?? null,
          numero: m.chaveCompra?.numero ?? null,
          ano: m.chaveCompra?.ano ?? null,
          numero_uasg: m.chaveCompra?.numeroUasg ?? null,
          identificador_item: m.identificadorItem,
          chave_mensagem: m.chaveMensagem,
          tipo: m.tipo,
          categoria: m.categoria,
          tipo_remetente: m.tipoRemetente,
          texto: m.texto,
          data_hora: m.dataHora,
          data_hora_fonte: m.dataHoraFonte,
          fonte: "integra_compras",
        }));
        const { data: inseridas, error: erroUpsert } = await supabase
          .from("sessao_mensagens")
          .upsert(linhas, { onConflict: "chave_mensagem", ignoreDuplicates: true })
          .select("chave_mensagem");
        if (erroUpsert) {
          await supabase.schema("private").from("integra_compras_run")
            .update({ terminado_em: new Date().toISOString(), chamadas, mensagens_lidas: lidas.length, erro: "falha ao gravar mensagens" })
            .eq("id", run.id);
          throw erroUpsert;
        }
        novas = (inseridas ?? []).length;
      }

      const { error: erroFim } = await supabase
        .schema("private")
        .from("integra_compras_run")
        .update({
          terminado_em: new Date().toISOString(),
          chamadas,
          mensagens_lidas: lidas.length,
          mensagens_novas: novas,
          erro: erroFonte ? erroFonte.message : null,
        })
        .eq("id", run.id);
      if (erroFim) throw erroFim;

      if (erroFonte) {
        return jsonResponse({
          ok: false,
          erro: `Integra Compras indisponível (HTTP ${erroFonte.status ?? "sem resposta"}). Nada foi apagado.`,
          total_lidas: lidas.length,
          novas_inseridas: novas,
          chamadas,
        }, 502);
      }

      return jsonResponse({ ok: true, total_lidas: lidas.length, novas_inseridas: novas, chamadas });
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
