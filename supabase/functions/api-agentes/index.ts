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
import { createSupabaseRepo, ErroAgentes, type AgentesRepo, type Dossie, type Execucao, type Pergunta, type Preparacao } from "./repo.ts";
import {
  conferirCitacoes,
  criarServicoPerguntas,
  diaSaoPaulo,
  K_CHUNKS,
  LIMITE_PERGUNTAS_DIA,
  type ServicoPerguntas,
  validarRespostaEdital,
} from "./perguntas.ts";
import { parseActionFromBody } from "./validation.ts";

/**
 * api-agentes: agentes de edital, preço e jurídico (spec 0032), com rota própria e envio para a oportunidade (spec 0035).
 *   oportunidades_buscar (K-0) e documentos_listar (K-1): a rota do agente escolhe a oportunidade e mostra os documentos.
 *   analise_executar (K-2: `agentes` opcional; jurídico roda edital e preço antes), analise_obter (K-5:
 *   `somente_enviadas` para a aba), analise_enviar (K-4) e analise_revisar (K-6: só enviada).
 *   Spec 0038 (fase 2, edital): pergunta_edital (K-1: pergunta livre com citações [n] conferidas; cota de 50 por
 *   empresa por dia), perguntas_listar e pergunta_favoritar (K-5), pergunta_enviar (K-11: nota na oportunidade) e
 *   documentos_ler (K-6: só admin e operação; enfileira a mesma preparação do "Analisar").
 *   Toda ação com licitacao_id exige a licitação no pipeline da empresa (R-1: 404 fora dele); envio e revisão conferem a
 *   empresa pela execução (ou pela pergunta). Qualquer membro da empresa (admin ou operação) e o admin da plataforma.
 */

export interface ApiAgentesContext {
  getRepo?: () => AgentesRepo;
  getUser?: (req: Request) => Promise<AuthenticatedUser | null>;
  /** Spec 0038: cliente do serviço agente-perguntas (padrão: AGENTE_PERGUNTAS_URL e AGENTE_PERGUNTAS_SEGREDO). */
  getServicoPerguntas?: () => ServicoPerguntas;
  /** Relógio da cota do dia (testes). */
  agora?: () => Date;
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
  const precoHash = await hashContexto(precoEntrada);
  const preco = await hashContexto({ ...precoEntrada, referencia_em: new Date().toISOString().slice(0, 10) });
  // R-6: o jurídico leva o preço sem a data do dia, para a análise enviada num dia seguir atual no seguinte.
  const juridico = await hashContexto({
    agente: "juridico",
    regra: REGRA_VERSAO,
    edital,
    preco: precoHash,
    dispositivos: d.dispositivos.map((dispositivo) => [dispositivo.artigo, dispositivo.conferido_oficial]),
  });
  const concorrencia = await hashContexto({
    agente: "concorrencia",
    regra: REGRA_VERSAO,
    preco: precoHash,
  });
  const recomendacao = await hashContexto({
    agente: "recomendacao",
    regra: REGRA_VERSAO,
    edital,
    preco: precoHash,
    juridico,
    concorrencia,
  });
  return { edital, preco, juridico, concorrencia, recomendacao };
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
    case "concorrencia":
    case "recomendacao":
      throw new ErroAgentes(`Agente ${agente} não é executado por esta rota.`, 400);
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
): Promise<{ execucoes: Execucao[]; temChunks: boolean }> {
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
  return { execucoes: saida, temChunks: dossie.chunks.length > 0 };
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

// --- Spec 0038: pergunta livre ao edital (K-1, K-5, K-6, K-11) ----------------------------------------------------

interface Cota {
  usadas: number;
  limite: number;
}

const hoje = (ctx: ApiAgentesContext) => diaSaoPaulo((ctx.agora ?? (() => new Date()))());

async function cotaDoDia(repo: AgentesRepo, tenant: number, ctx: ApiAgentesContext): Promise<Cota> {
  return { usadas: await repo.cotaUsada(tenant, hoje(ctx)), limite: LIMITE_PERGUNTAS_DIA };
}

const emLeitura = (p: Preparacao | null) => p !== null && (p.status === "pending" || p.status === "processing");

function respostaPergunta(p: Pergunta, cota: Cota) {
  return {
    action: "pergunta_edital",
    pergunta_id: p.id,
    resposta: p.resposta,
    motivo_sem_resposta: p.motivo_sem_resposta,
    citacoes: p.citacoes,
    cota,
  };
}

/**
 * K-1. Ordem: pipeline (404) → sem chunks: em leitura (409) ou "sem_documentos" gravado sem chamar o modelo e sem
 * gastar cota (CA-3) → reserva atômica da vaga do dia (429 cheia; agente_cota_reservar) → serviço (503 sem
 * configuração, devolvendo a vaga; 502 em falha, timeout ou formato fora do contrato, sem gravar e sem devolver a
 * vaga: o modelo pode ter cobrado) → conferência das citações (CA-2: [n] inexistente ou malformado, ou chunk de outra
 * licitação, vira "nao_encontrado") → grava e devolve.
 */
async function perguntaEdital(
  repo: AgentesRepo,
  ctx: ApiAgentesContext,
  tenant: number,
  userId: string,
  licitacaoId: number,
  pergunta: string,
): Promise<Response> {
  if (!(await repo.estaNoPipeline(tenant, licitacaoId))) return jsonResponse({ error: "Licitação não encontrada." }, 404);
  const base = { agente: "edital" as const, licitacao_id: licitacaoId, pergunta };

  if ((await repo.contarChunksIndexados(licitacaoId)) === 0) {
    if (emLeitura(await repo.preparacao(tenant, licitacaoId))) {
      return jsonResponse({ error: "Os documentos desta licitação estão em leitura. Pergunte de novo quando terminar." }, 409);
    }
    const gravada = await repo.gravarPergunta(tenant, userId, {
      ...base, resposta: null, motivo_sem_resposta: "sem_documentos", citacoes: [], modelo: null, versao_prompt: null, uso: null,
    });
    console.info("[api-agentes] pergunta_edital", { user: userId, licitacao: licitacaoId, motivo: "sem_documentos" });
    // não chamou o modelo: não gasta cota
    return jsonResponse(respostaPergunta(gravada, await cotaDoDia(repo, tenant, ctx)));
  }

  const dia = hoje(ctx);
  const reservadas = await repo.reservarCota(tenant, dia, LIMITE_PERGUNTAS_DIA);
  if (reservadas === null) {
    const cota = { usadas: await repo.cotaUsada(tenant, dia), limite: LIMITE_PERGUNTAS_DIA };
    return jsonResponse({ error: `Limite de ${LIMITE_PERGUNTAS_DIA} perguntas por dia atingido`, cota }, 429);
  }
  const depois = { usadas: reservadas, limite: LIMITE_PERGUNTAS_DIA };

  let servico: ServicoPerguntas;
  try {
    servico = (ctx.getServicoPerguntas ?? (() => criarServicoPerguntas()))();
  } catch (e) {
    // o serviço nem foi chamado: a vaga volta
    await repo.devolverCota(tenant, dia);
    throw e;
  }
  const r = validarRespostaEdital(await servico.perguntarEdital({ licitacao_id: licitacaoId, pergunta, k: K_CHUNKS }));
  if (!r) {
    console.error("[api-agentes] agente-perguntas fora do contrato", { licitacao: licitacaoId });
    throw new ErroAgentes("falha ao consultar o agente", 502);
  }

  let conferida: ReturnType<typeof conferirCitacoes> = null;
  if (r.resposta !== null) {
    const ids = [...new Set(r.citacoes.map((c) => c.chunk_id))];
    const chunks = new Map((await repo.chunksDaLicitacao(licitacaoId, ids)).map((c) => [c.id, c]));
    const nomes = new Map((await repo.listarDocumentos(tenant, licitacaoId)).map((d) => [d.id, d.nome]));
    conferida = conferirCitacoes(r, chunks, nomes);
    if (!conferida) {
      // resposta sem citação válida não é exibida (spec 0038, Backend 1)
      console.warn("[api-agentes] resposta do agente sem citação válida", { licitacao: licitacaoId, citacoes: r.citacoes.length });
    }
  }
  const gravada = await repo.gravarPergunta(tenant, userId, {
    ...base,
    resposta: conferida?.resposta ?? null,
    motivo_sem_resposta: conferida ? null : "nao_encontrado",
    citacoes: conferida?.citacoes ?? [],
    modelo: r.modelo,
    versao_prompt: r.versao_prompt,
    uso: r.uso,
  });
  console.info("[api-agentes] pergunta_edital", {
    user: userId, licitacao: licitacaoId, pergunta: gravada.id, citacoes: gravada.citacoes.length, motivo: gravada.motivo_sem_resposta,
  });
  return jsonResponse(respostaPergunta(gravada, depois));
}

/**
 * K-6: "Ler os documentos" enfileira o mesmo pedido 'preparar_triagem' do "Analisar" (fila_preparacao_solicitar, spec
 * 0032 CA-1; consumidor coletor.preparar_triagem no Cloud Run a cada 15 min: download, indexação, tarefas).
 * Já em leitura: 409. Tudo lido (chunks e nenhum documento pendente): "lidos". Último pedido concluído sem documento e
 * nada pendente: "sem_documentos" (a fonte não tem o documento; não repete). Senão, enfileira: "em_leitura".
 */
async function documentosLer(repo: AgentesRepo, tenant: number, licitacaoId: number): Promise<Response> {
  if (!(await repo.estaNoPipeline(tenant, licitacaoId))) return jsonResponse({ error: "Licitação não encontrada." }, 404);
  const preparacao = await repo.preparacao(tenant, licitacaoId);
  const jaEmLeitura = () => jsonResponse({ error: "Os documentos desta licitação já estão em leitura." }, 409);
  if (emLeitura(preparacao)) return jaEmLeitura();
  const chunks = await repo.contarChunksIndexados(licitacaoId);
  const naoLidos = await repo.documentosNaoLidos(licitacaoId);
  const estado = (e: "em_leitura" | "lidos" | "sem_documentos") =>
    jsonResponse({ action: "documentos_ler", licitacao_id: licitacaoId, estado: e });
  if (chunks > 0 && naoLidos === 0) return estado("lidos");
  if (chunks === 0 && naoLidos === 0 && preparacao?.status === "completed" && preparacao.resultado === "sem_documento") {
    return estado("sem_documentos");
  }
  if ((await repo.solicitarPreparacao(tenant, licitacaoId)) === "ja_na_fila") return jaEmLeitura();
  return estado("em_leitura");
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
    const { tenant, papel } = await repo.tenantDoUsuario(user.id, isLicitagymAdmin(user));

    switch (params.action) {
      case "analise_executar": {
        // temChunks vem do dossiê: na rota do Jurídico o agente de edital não roda e não serve de sinal
        const { execucoes, temChunks } = await executar(repo, tenant, user.id, params.licitacao_id, params.proposta, params.agentes);
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
      case "pergunta_edital":
        return await perguntaEdital(repo, ctx, tenant, user.id, params.licitacao_id, params.pergunta);
      case "perguntas_listar": {
        // R-1: com licitação, só a do pipeline da empresa
        if (params.licitacao_id !== null && !(await repo.estaNoPipeline(tenant, params.licitacao_id))) {
          return jsonResponse({ error: "Licitação não encontrada." }, 404);
        }
        const { itens, total } = await repo.listarPerguntas(
          tenant,
          { agente: params.agente, licitacao_id: params.licitacao_id, somente_enviadas: params.somente_enviadas },
          params.por_pagina,
          (params.pagina - 1) * params.por_pagina,
        );
        return jsonResponse({
          action: params.action, perguntas: itens, total, pagina: params.pagina, por_pagina: params.por_pagina,
          cota: await cotaDoDia(repo, tenant, ctx),
        });
      }
      case "pergunta_favoritar": {
        const pergunta = await repo.favoritarPergunta(tenant, params.pergunta_id, params.favorita);
        if (!pergunta) return jsonResponse({ error: "Pergunta não encontrada." }, 404);
        return jsonResponse({ action: params.action, pergunta });
      }
      case "pergunta_enviar": {
        const atual = await repo.obterPergunta(tenant, params.pergunta_id);
        if (!atual) return jsonResponse({ error: "Pergunta não encontrada." }, 404);
        if (atual.licitacao_id === null) return jsonResponse({ error: "Pergunta sem licitação não vai para a oportunidade." }, 400);
        if (!(await repo.estaNoPipeline(tenant, atual.licitacao_id))) return jsonResponse({ error: "Pergunta não encontrada." }, 404);
        if (atual.enviada_em) return jsonResponse({ error: "Esta pergunta já foi enviada." }, 409);
        const pergunta = await repo.enviarPergunta(tenant, params.pergunta_id, user.id);
        if (!pergunta) return jsonResponse({ error: "Esta pergunta já foi enviada." }, 409);
        console.info("[api-agentes] pergunta_enviar", { user: user.id, pergunta: pergunta.id, licitacao: pergunta.licitacao_id });
        return jsonResponse({ action: params.action, pergunta });
      }
      case "documentos_ler": {
        // decisão de 22/10: só admin e operação da empresa, e o admin da plataforma
        if (!(isLicitagymAdmin(user) || papel === "admin" || papel === "operacao")) {
          return jsonResponse({ error: "Só admin e operação pedem a leitura dos documentos." }, 403);
        }
        const res = await documentosLer(repo, tenant, params.licitacao_id);
        console.info("[api-agentes] documentos_ler", { user: user.id, licitacao: params.licitacao_id, status: res.status });
        return res;
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
