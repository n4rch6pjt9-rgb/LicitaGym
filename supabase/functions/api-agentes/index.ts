import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";
import { hashContexto, validarAchado } from "../_shared/agentes/achados.ts";
import { agenteEdital } from "../_shared/agentes/edital.ts";
import { agenteJuridico } from "../_shared/agentes/juridico.ts";
import { agentePreco, type PropostaItem } from "../_shared/agentes/preco.ts";
import { REGRA_VERSAO, type Achado, type Agente, type ResultadoAgente } from "../_shared/agentes/tipos.ts";
import { type AuthenticatedUser, authenticateUser, corsHeaders, jsonResponse } from "../_shared/http.ts";
import { createSupabaseRepo, ErroAgentes, type AgentesRepo, type Dossie, type Execucao } from "./repo.ts";
import { parseActionFromBody } from "./validation.ts";

export interface ApiAgentesContext {
  getRepo?: () => AgentesRepo;
  getUser?: (req: Request) => Promise<AuthenticatedUser | null>;
}

const ORDEM: Agente[] = ["edital", "preco", "juridico"];

function getDefaultServiceClient(): SupabaseClient {
  const url = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !serviceKey) throw new Error("Variáveis de ambiente SUPABASE_URL ou SUPABASE_SERVICE_ROLE_KEY não configuradas");
  return createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
}

export async function contextos(d: Dossie, proposta: PropostaItem[] | null): Promise<Record<Agente, string>> {
  const edital = await hashContexto({
    agente: "edital",
    regra: REGRA_VERSAO,
    licitacao: d.licitacao.payload_hash,
    abertura: d.licitacao.data_abertura,
    documentos: d.documentos_sha256,
  });
  const preco = await hashContexto({
    agente: "preco",
    regra: REGRA_VERSAO,
    itens: d.itens.map((item) => [
      item.numero_item,
      item.estimado_centavos,
      item.amostras.map((a) => [a.id_compra_item, a.preco_centavos, a.unidade]),
      item.piso_centavos,
    ]),
    proposta,
    referencia_em: new Date().toISOString().slice(0, 10),
  });
  const juridico = await hashContexto({
    agente: "juridico",
    regra: REGRA_VERSAO,
    edital,
    preco,
    dispositivos: d.dispositivos.map((dispositivo) => [dispositivo.artigo, dispositivo.conferido_oficial]),
  });
  return { edital, preco, juridico };
}

function rodar(agente: Agente, dossie: Dossie, proposta: PropostaItem[] | null, sinais: Achado[]): ResultadoAgente {
  switch (agente) {
    case "edital":
      return agenteEdital({ chunks: dossie.chunks, data_abertura: dossie.licitacao.data_abertura });
    case "preco":
      return agentePreco({ natureza: "bens_servicos_gerais", itens: dossie.itens, proposta });
    case "juridico":
      return agenteJuridico({ sinais, dispositivos: dossie.dispositivos });
    default: {
      const nunca: never = agente;
      throw new Error(`agente desconhecido: ${nunca}`);
    }
  }
}

async function executar(
  repo: AgentesRepo,
  tenant: number,
  userId: string,
  licitacaoId: number,
  proposta: PropostaItem[] | null,
): Promise<Execucao[]> {
  const dossie = await repo.carregarDossie(tenant, licitacaoId);
  if (!dossie) throw new ErroAgentes("Licitação não encontrada.", 404);
  const hashes = await contextos(dossie, proposta);
  const sinais: Achado[] = [];
  const saida: Execucao[] = [];
  for (const agente of ORDEM) {
    const existente = await repo.buscarExecucao(tenant, licitacaoId, agente, hashes[agente]);
    if (existente) {
      saida.push(existente);
      if (agente !== "juridico") sinais.push(...existente.achados);
      continue;
    }
    const resultado = rodar(agente, dossie, proposta, sinais);
    for (const achado of resultado.achados) {
      const erro = validarAchado(achado);
      if (erro) throw new Error(erro);
    }
    const gravada = await repo.gravarExecucao(tenant, userId, licitacaoId, hashes[agente], proposta, resultado);
    saida.push(gravada);
    if (agente !== "juridico") sinais.push(...resultado.achados);
  }
  return saida;
}

async function enriquecer(repo: AgentesRepo, tenant: number, execucoes: Execucao[]) {
  const saida = [];
  for (const execucao of execucoes) {
    const dossie = await repo.carregarDossie(tenant, execucao.licitacao_id);
    const hashes = dossie ? await contextos(dossie, execucao.entrada.proposta) : null;
    const desatualizada = hashes === null || execucao.contexto_hash !== hashes[execucao.agente];
    const aprovada = await repo.ultimaAprovada(tenant, execucao.licitacao_id, execucao.agente);
    saida.push({
      ...execucao,
      desatualizada,
      substitui_aprovada_id: aprovada && aprovada.id !== execucao.id ? aprovada.id : null,
    });
  }
  return saida;
}

export async function handleRequest(req: Request, ctx: ApiAgentesContext = {}): Promise<Response> {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return jsonResponse({ error: "Método não permitido. Utilize POST." }, 405);

  const user = await (ctx.getUser ?? authenticateUser)(req);
  if (!user) return jsonResponse({ error: "Unauthorized" }, 401);

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "Corpo JSON inválido." }, 400);
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return jsonResponse({ error: "Corpo JSON inválido. Esperado objeto JSON." }, 400);
  }

  const params = parseActionFromBody(body as Record<string, unknown>);
  if ("error" in params) return jsonResponse({ error: params.error }, 400);

  try {
    const repo = (ctx.getRepo ?? (() => createSupabaseRepo(getDefaultServiceClient())))();
    const tenant = await repo.tenantDoUsuario(user.id);

    switch (params.action) {
      case "analise_executar": {
        const execucoes = await executar(repo, tenant, user.id, params.licitacao_id, params.proposta);
        console.info("[api-agentes] analise_executar", { user: user.id, licitacao: params.licitacao_id, n: execucoes.length });
        return jsonResponse({ action: params.action, execucoes });
      }
      case "analise_obter": {
        const dossie = await repo.carregarDossie(tenant, params.licitacao_id);
        if (!dossie) throw new ErroAgentes("Licitação não encontrada.", 404);
        const execucoes = await enriquecer(repo, tenant, await repo.ultimasExecucoes(tenant, params.licitacao_id));
        console.info("[api-agentes] analise_obter", { user: user.id, licitacao: params.licitacao_id, n: execucoes.length });
        return jsonResponse({ action: params.action, execucoes });
      }
      case "analise_revisar": {
        const atual = await repo.obterExecucao(tenant, params.execucao_id);
        if (!atual) return jsonResponse({ error: "Execução não encontrada." }, 404);
        if (atual.revisao !== "aguardando") return jsonResponse({ error: "Esta análise já foi revisada." }, 409);
        const dossie = await repo.carregarDossie(tenant, atual.licitacao_id);
        if (!dossie) return jsonResponse({ error: "Licitação não encontrada." }, 404);
        const hashes = await contextos(dossie, atual.entrada.proposta);
        if (atual.contexto_hash !== hashes[atual.agente]) {
          return jsonResponse({ error: "Análise desatualizada. Execute de novo antes de revisar." }, 409);
        }
        const execucao = await repo.revisar(tenant, params.execucao_id, params.decisao, params.nota, user.id);
        if (!execucao) return jsonResponse({ error: "Esta análise já foi revisada." }, 409);
        console.info("[api-agentes] analise_revisar", { user: user.id, execucao: params.execucao_id, decisao: params.decisao });
        return jsonResponse({ action: params.action, execucao });
      }
      default: {
        const nunca: never = params;
        throw new Error(`ação desconhecida: ${JSON.stringify(nunca)}`);
      }
    }
  } catch (e) {
    if (e instanceof ErroAgentes) return jsonResponse({ error: e.message }, e.status);
    console.error("[api-agentes] erro interno:", e instanceof Error ? e.message : e);
    return jsonResponse({ error: "Erro interno no servidor" }, 500);
  }
}

if (import.meta.main) {
  Deno.serve((req) => handleRequest(req));
}
