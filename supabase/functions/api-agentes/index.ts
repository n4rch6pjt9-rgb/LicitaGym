import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";
import { hashContexto, validarAchado } from "../_shared/agentes/achados.ts";
import { agenteEdital } from "../_shared/agentes/edital.ts";
import { agenteJuridico } from "../_shared/agentes/juridico.ts";
import { agentePreco, type PropostaItem } from "../_shared/agentes/preco.ts";
import { REGRA_VERSAO, type Achado, type Agente, type ResultadoAgente } from "../_shared/agentes/tipos.ts";
import { type AuthenticatedUser, authenticateUser, corsHeaders, isLicitagymAdmin, jsonResponse } from "../_shared/http.ts";
import { ErroTenantAcesso } from "../_shared/tenant.ts";
import type { ChunkEdital } from "../_shared/agentes/edital.ts";
import { createSupabaseRepo, ErroAgentes, type AgentesRepo, type Dossie, type Execucao, type Preparacao } from "./repo.ts";
import { parseActionFromBody } from "./validation.ts";

/**
 * api-agentes: agentes de edital, preço e jurídico (spec 0032), com rota própria e envio para a oportunidade (spec 0035).
 *   oportunidades_buscar (K-0) e documentos_listar (K-1): a rota do agente escolhe a oportunidade e mostra os documentos.
 *   analise_executar (K-2: `agentes` opcional; jurídico roda edital e preço antes), analise_obter (K-5:
 *   `somente_enviadas` para a aba), analise_enviar (K-4) e analise_revisar (K-6: só enviada).
 *   Toda ação com licitacao_id exige a licitação no pipeline da empresa (R-1: 404 fora dele); envio e revisão conferem a
 *   empresa pela execução. Qualquer membro da empresa (admin ou operação) e o admin da plataforma.
 */

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

async function sha256Hex(texto: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(texto));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Impressão dos chunks analisados: o documento ganha SHA antes do indexador gravar os chunks. */
export async function impressaoChunks(chunks: ChunkEdital[]): Promise<Array<[number, number, number | null, string]>> {
  const ordenados = [...chunks].sort((a, b) => a.id - b.id);
  const saida: Array<[number, number, number | null, string]> = [];
  for (const c of ordenados) saida.push([c.id, c.documento_id, c.pagina, await sha256Hex(c.texto)]);
  return saida;
}

export async function contextos(d: Dossie, proposta: PropostaItem[] | null): Promise<Record<Agente, string>> {
  const edital = await hashContexto({
    agente: "edital",
    regra: REGRA_VERSAO,
    licitacao: d.licitacao.payload_hash,
    abertura: d.licitacao.data_abertura,
    documentos: d.documentos_sha256,
    chunks: await impressaoChunks(d.chunks),
    portal: d.portal_oficial ?? null,
  });
  const precoEntrada = {
    agente: "preco",
    regra: REGRA_VERSAO,
    natureza: d.natureza,
    itens: d.itens.map((item) => [
      item.numero_item,
      item.unidade,
      item.estimado_centavos,
      item.amostras.map((a) => [a.id_compra_item, a.preco_centavos, a.unidade]),
      item.piso_centavos,
    ]),
    proposta,
  };
  const preco = await hashContexto({ ...precoEntrada, referencia_em: new Date().toISOString().slice(0, 10) });
  // R-6: o jurídico leva o preço sem a data do dia, para a análise enviada num dia seguir atual no seguinte.
  const juridico = await hashContexto({
    agente: "juridico",
    regra: REGRA_VERSAO,
    edital,
    preco: await hashContexto(precoEntrada),
    dispositivos: d.dispositivos.map((dispositivo) => [dispositivo.artigo, dispositivo.conferido_oficial]),
  });
  return { edital, preco, juridico };
}

function rodar(agente: Agente, dossie: Dossie, proposta: PropostaItem[] | null, sinais: Achado[]): ResultadoAgente {
  switch (agente) {
    case "edital":
      return agenteEdital({
        chunks: dossie.chunks,
        data_abertura: dossie.licitacao.data_abertura,
        licitacao_id: dossie.licitacao.id,
        portal_oficial: dossie.portal_oficial ?? null,
      });
    case "preco":
      return agentePreco({ natureza: dossie.natureza, itens: dossie.itens, proposta });
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
  agentes: Agente[] | null,
): Promise<Execucao[]> {
  const dossie = await carregarNoPipeline(repo, tenant, licitacaoId);
  const hashes = await contextos(dossie, proposta);
  const sinais: Achado[] = [];
  const saida: Execucao[] = [];
  // a validação já pôs edital e preço antes do jurídico (R-5); a ordem é sempre a de ORDEM
  for (const agente of ORDEM.filter((a) => agentes === null || agentes.includes(a))) {
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

/** R-1: licitação fora do pipeline da empresa é 404, como se não existisse. */
async function carregarNoPipeline(repo: AgentesRepo, tenant: number, licitacaoId: number): Promise<Dossie> {
  if (!(await repo.estaNoPipeline(tenant, licitacaoId))) throw new ErroAgentes("Licitação não encontrada.", 404);
  const dossie = await repo.carregarDossie(tenant, licitacaoId);
  if (!dossie) throw new ErroAgentes("Licitação não encontrada.", 404);
  return dossie;
}

/** Mesma regra do revisar e do enviar: o contexto da execução ainda é o atual. */
async function atual(repo: AgentesRepo, tenant: number, execucao: Execucao): Promise<boolean> {
  if (!ORDEM.includes(execucao.agente)) return false;
  const dossie = await repo.carregarDossie(tenant, execucao.licitacao_id);
  if (!dossie) return false;
  return execucao.contexto_hash === (await contextos(dossie, execucao.entrada.proposta))[execucao.agente];
}

async function enriquecer(repo: AgentesRepo, tenant: number, execucoes: Execucao[]) {
  const saida = [];
  for (const execucao of execucoes) {
    const dossie = await repo.carregarDossie(tenant, execucao.licitacao_id);
    const hashes = dossie ? await contextos(dossie, execucao.entrada.proposta) : null;
    const desatualizada = hashes === null || execucao.contexto_hash !== hashes[execucao.agente];
    const aprovada = await repo.ultimaAprovada(tenant, execucao.licitacao_id, execucao.agente);
    // aprovada e enviada com tarefa nova do agente (outra etapa, ou a oportunidade voltou ao pipeline): pode ir de novo
    // para abrir a revisão da tarefa nova (mesma regra do agente_execucao_enviar)
    let pode_reenviar = false;
    if (execucao.enviada_em && execucao.revisao === "aprovada" && !desatualizada) {
      const tarefa = await repo.tarefaAgenteAberta(tenant, execucao.licitacao_id, execucao.agente);
      pode_reenviar = tarefa !== null && tarefa !== execucao.tarefa_id;
    }
    saida.push({
      ...execucao,
      desatualizada,
      substitui_aprovada_id: aprovada && aprovada.id !== execucao.id ? aprovada.id : null,
      pode_reenviar,
    });
  }
  return saida;
}

/**
 * Estado da preparação do edital (spec 0032, fase 1). "em_preparacao" quando o pedido da fila está pendente ou em
 * andamento e ainda falta ler algum documento: sem nenhum chunk, ou com parte dos documentos ainda sem texto (pedido
 * anterior que falhou no meio, como o 504 do Gemini na 3558). A tarefa mostra "análise em preparação".
 * Falha ao ler o estado não derruba a análise: vira aviso.
 */
interface EstadoPreparacao {
  preparacao?: Preparacao | null;
  em_preparacao?: boolean;
  avisos?: string[];
  /** Interno: há documento ainda sem texto (sempre true sem chunks). Não vai na resposta. */
  faltaLer?: boolean;
}

async function estadoPreparacao(
  repo: AgentesRepo,
  tenant: number,
  licitacaoId: number,
  temChunks: boolean,
): Promise<EstadoPreparacao> {
  try {
    const preparacao: Preparacao | null = await repo.preparacao(tenant, licitacaoId);
    // com chunks, só consulta os documentos quando há pedido que importa (aberto ou falho)
    const importa = preparacao !== null && ["pending", "processing", "failed"].includes(preparacao.status);
    const faltaLer = !temChunks || (importa && (await repo.documentosNaoLidos(licitacaoId)) > 0);
    const em_preparacao = faltaLer && preparacao !== null &&
      (preparacao.status === "pending" || preparacao.status === "processing");
    return { preparacao, em_preparacao, faltaLer };
  } catch (e) {
    // Mesmo contrato da api-pipeline: estado desconhecido não vira "sem pedido". Os campos somem e o aviso explica.
    console.error("[api-agentes] preparação indisponível", { licitacao: licitacaoId, erro: e instanceof Error ? e.message : e });
    return { avisos: ["preparacao_indisponivel"] };
  }
}

/**
 * Spec 0032, fase 1 (CA-1): no clique em "Analisar", edital sem chunks e sem pedido aberto na fila (nenhum, ou o último
 * falhou) é pedido para download e indexação. Com parte dos documentos já lida, o pedido que falhou também é refeito
 * enquanto houver documento sem texto (senão "Analisar de novo" nunca terminaria a leitura). Pedido concluído (ex.:
 * sem_documento) não é repetido: a fonte não tem o documento. Estado ilegível (aviso) não pede: sem saber, não
 * enfileira às cegas. analise_obter nunca pede.
 */
/** Estado da preparação como vai na resposta (sem o campo interno faltaLer). */
function publico({ faltaLer: _, ...prep }: EstadoPreparacao): Omit<EstadoPreparacao, "faltaLer"> {
  return prep;
}

function precisaPreparar(prep: EstadoPreparacao, temChunks: boolean): boolean {
  if (prep.preparacao === undefined) return false;
  if (!temChunks) return prep.preparacao === null || prep.preparacao.status === "failed";
  return prep.preparacao?.status === "failed" && prep.faltaLer === true;
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
    const { tenant } = await repo.tenantDoUsuario(user.id, isLicitagymAdmin(user));

    switch (params.action) {
      case "analise_executar": {
        const execucoes = await executar(repo, tenant, user.id, params.licitacao_id, params.proposta, params.agentes);
        const edital = execucoes.find((e) => e.agente === "edital");
        const temChunks = edital?.situacao !== "sem_documento";
        let prep = await estadoPreparacao(repo, tenant, params.licitacao_id, temChunks);
        const extra: { preparacao_solicitada?: boolean } = {};
        if (precisaPreparar(prep, temChunks)) {
          try {
            await repo.solicitarPreparacao(tenant, params.licitacao_id);
            extra.preparacao_solicitada = true;
            prep = await estadoPreparacao(repo, tenant, params.licitacao_id, temChunks);
          } catch (e) {
            console.error("[api-agentes] preparação não solicitada", {
              licitacao: params.licitacao_id,
              erro: e instanceof Error ? e.message : e,
            });
            prep = { ...prep, avisos: [...(prep.avisos ?? []), "preparacao_nao_solicitada"] };
          }
        }
        console.info("[api-agentes] analise_executar", { user: user.id, licitacao: params.licitacao_id, n: execucoes.length });
        return jsonResponse({ action: params.action, execucoes, ...publico(prep), ...extra });
      }
      case "analise_obter": {
        const dossie = await carregarNoPipeline(repo, tenant, params.licitacao_id);
        const execucoes = await enriquecer(repo, tenant, await repo.ultimasExecucoes(tenant, params.licitacao_id, params.somente_enviadas));
        const prep = await estadoPreparacao(repo, tenant, params.licitacao_id, dossie.chunks.length > 0);
        console.info("[api-agentes] analise_obter", { user: user.id, licitacao: params.licitacao_id, n: execucoes.length });
        return jsonResponse({ action: params.action, execucoes, ...publico(prep) });
      }
      case "analise_revisar": {
        const exec = await repo.obterExecucao(tenant, params.execucao_id);
        // R-1 também aqui: oportunidade que saiu do pipeline não é revisada
        if (!exec || !(await repo.estaNoPipeline(tenant, exec.licitacao_id))) return jsonResponse({ error: "Execução não encontrada." }, 404);
        // K-6: só se revisa o que foi enviado para a oportunidade
        if (!exec.enviada_em) return jsonResponse({ error: "Envie a análise para a oportunidade antes de revisar." }, 409);
        if (exec.revisao !== "aguardando") return jsonResponse({ error: "Esta análise já foi revisada." }, 409);
        if (!(await atual(repo, tenant, exec))) {
          return jsonResponse({ error: "Análise desatualizada. Execute de novo antes de revisar." }, 409);
        }
        const execucao = await repo.revisar(tenant, params.execucao_id, params.decisao, params.nota, user.id);
        if (!execucao) return jsonResponse({ error: "Esta análise já foi revisada." }, 409);
        console.info("[api-agentes] analise_revisar", { user: user.id, execucao: params.execucao_id, decisao: params.decisao });
        return jsonResponse({ action: params.action, execucao });
      }
      case "analise_enviar": {
        const exec = await repo.obterExecucao(tenant, params.execucao_id);
        if (!exec || !(await repo.estaNoPipeline(tenant, exec.licitacao_id))) return jsonResponse({ error: "Execução não encontrada." }, 404);
        // Confere fora da trava da RPC: um documento indexado entre esta leitura e o envio passa, e a revisão confere de
        // novo antes de aprovar (achado aceito na revisão de segurança).
        if (!(await atual(repo, tenant, exec))) {
          return jsonResponse({ error: "Análise desatualizada. Execute de novo antes de enviar." }, 409);
        }
        const execucao = await repo.enviar(tenant, params.execucao_id, user.id);
        console.info("[api-agentes] analise_enviar", { user: user.id, execucao: params.execucao_id, tarefa: execucao.tarefa_id });
        return jsonResponse({ action: params.action, execucao });
      }
      case "oportunidades_buscar": {
        const { itens, total } = await repo.buscarOportunidades(
          tenant, params.agente, params.busca, params.por_pagina, (params.pagina - 1) * params.por_pagina,
        );
        return jsonResponse({ action: params.action, oportunidades: itens, total, pagina: params.pagina, por_pagina: params.por_pagina });
      }
      case "documentos_listar": {
        if (!(await repo.estaNoPipeline(tenant, params.licitacao_id))) return jsonResponse({ error: "Licitação não encontrada." }, 404);
        return jsonResponse({ action: params.action, licitacao_id: params.licitacao_id, documentos: await repo.listarDocumentos(tenant, params.licitacao_id) });
      }
      default: {
        const nunca: never = params;
        throw new Error(`ação desconhecida: ${JSON.stringify(nunca)}`);
      }
    }
  } catch (e) {
    if (e instanceof ErroAgentes || e instanceof ErroTenantAcesso) return jsonResponse({ error: e.message }, e.status);
    console.error("[api-agentes] erro interno:", e instanceof Error ? e.message : e);
    return jsonResponse({ error: "Erro interno no servidor" }, 500);
  }
}

if (import.meta.main) {
  Deno.serve((req) => handleRequest(req));
}
