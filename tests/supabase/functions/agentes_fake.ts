// Ambiente em memória da api-agentes (specs 0032 e 0035), compartilhado pelos testes da função.
import type { PropostaItem } from "../../../supabase/functions/_shared/agentes/preco.ts";
import { type ApiAgentesContext, handleRequest } from "../../../supabase/functions/api-agentes/index.ts";
import {
  type AgentesRepo,
  categoriaErro,
  type DocumentoAgente,
  type Dossie,
  ErroAgentes,
  type Execucao,
  type OportunidadeAgente,
  type Pergunta,
  type Preparacao,
} from "../../../supabase/functions/api-agentes/repo.ts";
import type { ChunkEdital } from "../../../supabase/functions/_shared/agentes/edital.ts";
import type { ServicoPerguntas } from "../../../supabase/functions/api-agentes/perguntas.ts";

/** Pergunta como gravada (spec 0038): com a empresa e o uso, que não saem pela API. */
export type PerguntaGravada = Pergunta & { tenant_id: number; uso: Record<string, unknown> | null };

export function ambiente() {
  let seq = 0;
  const execucoes: Execucao[] = [];
  const dossie: Dossie = {
    licitacao: { id: 101, payload_hash: "h1", data_abertura: "2026-10-21T09:00:00-03:00" },
    documentos_sha256: ["d1"],
    chunks: [{ id: 1, documento_id: 9, pagina: 1, texto: "Apresentar amostra do equipamento." }],
    natureza: null,
    itens: [{ numero_item: 1, unidade: "UN", estimado_centavos: 1_000_000, amostras: [], piso_centavos: 600_000 }],
    dispositivos: [
      { norma: "LEI_14133_2021", artigo: 59, texto: "texto 59", conferido_oficial: false },
      { norma: "LEI_14133_2021", artigo: 164, texto: "texto 164", conferido_oficial: false },
    ],
  };

  const estado: {
    preparacao: Preparacao | null | Error;
    solicitacoes: number;
    falhaSolicitar: Error | null;
    naoLidos: number;
    consultasNaoLidos: number;
  } = {
    preparacao: null,
    solicitacoes: 0,
    falhaSolicitar: null,
    naoLidos: 0,
    consultasNaoLidos: 0,
  };
  // pipeline da empresa (R-1), busca (K-0), documentos (K-1) e a tarefa aberta do agente (R-8)
  const pipeline = new Set([101]);
  const oportunidades: OportunidadeAgente[] = [];
  const chamadasBusca: Array<{ agente: string; busca: string | null; limite: number; deslocamento: number }> = [];
  const documentosBrutos: Array<Omit<DocumentoAgente, "entra_na_analise" | "erro"> & { erro: string | null }> = [];
  let tarefaAberta: number | null = 77;
  let seqEnvio = 0;
  // spec 0038: perguntas gravadas (de todas as empresas)
  const perguntas: PerguntaGravada[] = [];
  /** agente_cota_dia: "tenant|dia" → usadas. */
  const cotas = new Map<string, number>();
  let seqPergunta = 0;
  let relogio = Date.UTC(2026, 9, 22, 15, 0, 0);
  const publica = ({ tenant_id: _t, uso: _u, ...p }: PerguntaGravada): Pergunta => ({ ...p });
  const repo: AgentesRepo = {
    tenantDoUsuario: () => Promise.resolve({ tenant: 1, papel: null }),
    preparacao: () => (estado.preparacao instanceof Error ? Promise.reject(estado.preparacao) : Promise.resolve(estado.preparacao)),
    // Como a RPC fila_preparacao_solicitar: pedido aberto não duplica; sem pedido ou failed, cria um pending.
    solicitarPreparacao: () => {
      if (estado.falhaSolicitar) return Promise.reject(estado.falhaSolicitar);
      estado.solicitacoes++;
      const atual = estado.preparacao instanceof Error ? null : estado.preparacao;
      if (atual && (atual.status === "pending" || atual.status === "processing")) return Promise.resolve("ja_na_fila" as const);
      estado.preparacao = { status: "pending", resultado: null, erro: null, atualizado_em: "agora" };
      return Promise.resolve("enfileirado" as const);
    },
    documentosNaoLidos: () => {
      estado.consultasNaoLidos++;
      return Promise.resolve(estado.naoLidos);
    },
    carregarDossie: (_t, id) => Promise.resolve(id === dossie.licitacao.id ? dossie : null),
    buscarExecucao: (_t, licitacaoId, agente, contextoHash) =>
      Promise.resolve(execucoes.find((e) => e.licitacao_id === licitacaoId && e.agente === agente && e.contexto_hash === contextoHash) ?? null),
    gravarExecucao: (_t, userId, licitacaoId, contextoHash, proposta, r) => {
      const row: Execucao = {
        id: ++seq,
        licitacao_id: licitacaoId,
        agente: r.agente,
        situacao: r.situacao,
        contexto_hash: contextoHash,
        regra_versao: r.regra_versao,
        entrada: { proposta },
        achados: r.achados,
        revisao: "aguardando",
        revisao_nota: null,
        revisado_por: null,
        revisado_em: null,
        solicitado_por: userId,
        created_at: new Date(seq * 1000).toISOString(),
        enviada_em: null,
        enviada_por: null,
        tarefa_id: null,
        revisoes_anteriores: [],
      };
      execucoes.push(row);
      return Promise.resolve(row);
    },
    ultimasExecucoes: (_t, licitacaoId, somenteEnviadas = false) => {
      const ordem = ["edital", "preco", "juridico"] as const;
      return Promise.resolve(ordem.flatMap((agente) => {
        const lista = execucoes.filter((e) => e.licitacao_id === licitacaoId && e.agente === agente && (!somenteEnviadas || e.enviada_em))
          .sort((a, b) => somenteEnviadas ? String(a.enviada_em).localeCompare(String(b.enviada_em)) || a.id - b.id : a.id - b.id);
        const ultima = lista[lista.length - 1];
        return ultima ? [ultima] : [];
      }));
    },
    estaNoPipeline: (_t, licitacaoId) => Promise.resolve(pipeline.has(licitacaoId)),
    buscarOportunidades: (_t, agente, busca, limite, deslocamento) => {
      chamadasBusca.push({ agente, busca, limite, deslocamento });
      return Promise.resolve({ itens: oportunidades.slice(deslocamento, deslocamento + limite), total: oportunidades.length });
    },
    listarDocumentos: (_t, licitacaoId) => {
      if (!pipeline.has(licitacaoId)) return Promise.reject(new ErroAgentes("Licitação não encontrada.", 404));
      return Promise.resolve(documentosBrutos.map((d): DocumentoAgente => ({ ...d, entra_na_analise: d.secao === "processo", erro: categoriaErro(d.erro) })));
    },
    // Como agente_execucao_enviar: LG003 (409) se já enviada e não rejeitada; reenvio de rejeitada guarda a revisão.
    enviar: (_t, id, userId) => {
      const row = execucoes.find((e) => e.id === id);
      if (!row) return Promise.reject(new ErroAgentes("Execução não encontrada.", 404));
      const novaTarefa = row.revisao === "aprovada" && tarefaAberta !== null && tarefaAberta !== row.tarefa_id;
      if (row.enviada_em && row.revisao !== "rejeitada" && !novaTarefa) {
        return Promise.reject(new ErroAgentes("Esta análise já foi enviada.", 409));
      }
      if (row.revisao !== "aguardando") {
        row.revisoes_anteriores = [...row.revisoes_anteriores, {
          decisao: row.revisao, nota: row.revisao_nota, por: row.revisado_por, em: row.revisado_em, enviada_em: row.enviada_em,
        }];
      }
      Object.assign(row, {
        revisao: "aguardando", revisao_nota: null, revisado_por: null, revisado_em: null,
        enviada_em: new Date(Date.UTC(2026, 9, 21, 12, 0, ++seqEnvio)).toISOString(), enviada_por: userId, tarefa_id: tarefaAberta,
      });
      return Promise.resolve(row);
    },
    tarefaAgenteAberta: () => Promise.resolve(tarefaAberta),
    obterExecucao: (_t, id) => Promise.resolve(execucoes.find((e) => e.id === id) ?? null),
    ultimaAprovada: (_t, licitacaoId, agente) => {
      const lista = execucoes.filter((e) => e.licitacao_id === licitacaoId && e.agente === agente && e.revisao === "aprovada");
      return Promise.resolve(lista[lista.length - 1] ?? null);
    },
    revisar: (_t, id, decisao, nota, userId) => {
      const row = execucoes.find((e) => e.id === id);
      if (!row) return Promise.reject(new ErroAgentes("Execução não encontrada.", 404));
      if (row.revisao !== "aguardando") return Promise.resolve(null);
      row.revisao = decisao;
      row.revisao_nota = nota;
      row.revisado_por = userId;
      row.revisado_em = "t";
      return Promise.resolve(row);
    },
    // Como agente_cota_reservar: incremento atômico (síncrono aqui) só abaixo do limite; null = cheia.
    reservarCota: (tenant, dia, limite) => {
      const chave = `${tenant}|${dia}`;
      const atual = cotas.get(chave) ?? 0;
      if (atual >= limite) return Promise.resolve(null);
      cotas.set(chave, atual + 1);
      return Promise.resolve(atual + 1);
    },
    devolverCota: (tenant, dia) => {
      const chave = `${tenant}|${dia}`;
      if (cotas.has(chave)) cotas.set(chave, Math.max(0, cotas.get(chave)! - 1));
      return Promise.resolve();
    },
    cotaUsada: (tenant, dia) => Promise.resolve(cotas.get(`${tenant}|${dia}`) ?? 0),
    contarChunksIndexados: (licitacaoId) => Promise.resolve(licitacaoId === dossie.licitacao.id ? dossie.chunks.length : 0),
    // Como o select com licitacao_id + in(id): só os chunks do dossiê da licitação; id de outra licitação não volta
    chunksDaLicitacao: (licitacaoId, ids) =>
      Promise.resolve((licitacaoId === dossie.licitacao.id ? dossie.chunks : []).filter((c: ChunkEdital) => ids.includes(c.id))),
    gravarPergunta: (tenant, userId, p) => {
      if ((p.resposta === null) === (p.motivo_sem_resposta === null)) return Promise.reject(new Error("check resposta xor motivo"));
      const row: PerguntaGravada = {
        id: ++seqPergunta,
        tenant_id: tenant,
        ...p,
        perguntado_por: userId,
        created_at: new Date(relogio).toISOString(),
        favorita: false,
        enviada_em: null,
        enviada_por: null,
      };
      perguntas.push(row);
      return Promise.resolve(publica(row));
    },
    listarPerguntas: (tenant, filtro, limite, deslocamento) => {
      const lista = perguntas
        .filter((p) =>
          p.tenant_id === tenant && (filtro.agente === null || p.agente === filtro.agente) &&
          (filtro.licitacao_id === null || p.licitacao_id === filtro.licitacao_id) && (!filtro.somente_enviadas || p.enviada_em !== null)
        )
        .sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id - a.id);
      return Promise.resolve({ itens: lista.slice(deslocamento, deslocamento + limite).map(publica), total: lista.length });
    },
    obterPergunta: (tenant, id) => {
      const row = perguntas.find((p) => p.tenant_id === tenant && p.id === id);
      return Promise.resolve(row ? publica(row) : null);
    },
    favoritarPergunta: (tenant, id, favorita) => {
      const row = perguntas.find((p) => p.tenant_id === tenant && p.id === id);
      if (!row) return Promise.resolve(null);
      row.favorita = favorita;
      return Promise.resolve(publica(row));
    },
    enviarPergunta: (tenant, id, userId) => {
      const row = perguntas.find((p) => p.tenant_id === tenant && p.id === id && p.enviada_em === null);
      if (!row) return Promise.resolve(null);
      Object.assign(row, { enviada_em: new Date(relogio).toISOString(), enviada_por: userId });
      return Promise.resolve(publica(row));
    },
  };
  return {
    repo, dossie, execucoes, estado, pipeline, oportunidades, chamadasBusca, documentosBrutos, perguntas, cotas,
    /** Relógio das perguntas gravadas (o mesmo instante vai para ctx.agora nos testes da cota). */
    relogio: () => new Date(relogio),
    avancar: (ms: number) => (relogio += ms),
    semTarefa: () => (tarefaAberta = null),
    novaTarefa: (id: number) => (tarefaAberta = id),
  };
}

export const USUARIO = { id: "u-1", app_metadata: {} };

export function ctx(repo: AgentesRepo, user: typeof USUARIO | null = USUARIO): ApiAgentesContext {
  return { getRepo: () => repo, getUser: () => Promise.resolve(user) };
}

/** Serviço agente-perguntas falso (spec 0038): devolve o corpo pedido e guarda as chamadas. */
export function servicoFalso(corpo: unknown | (() => unknown)) {
  const chamadas: Array<{ licitacao_id: number; pergunta: string; k: number }> = [];
  const servico: ServicoPerguntas = {
    perguntarEdital: (entrada) => {
      chamadas.push(entrada);
      try {
        return Promise.resolve(typeof corpo === "function" ? (corpo as () => unknown)() : corpo);
      } catch (e) {
        return Promise.reject(e);
      }
    },
  };
  return { servico, chamadas };
}

export async function chamar(c: ApiAgentesContext, body: unknown) {
  const res = await handleRequest(new Request("http://x/api-agentes", { method: "POST", body: JSON.stringify(body) }), c);
  return { status: res.status, json: await res.json() };
}

export const P: PropostaItem[] = [{ numero_item: 1, preco_unitario_centavos: 400_000 }];

