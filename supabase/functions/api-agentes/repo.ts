import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import type { Achado, Agente, ResultadoAgente, Situacao } from "../_shared/agentes/tipos.ts";
import type { ChunkEdital } from "../_shared/agentes/edital.ts";
import { NORMA, type Dispositivo } from "../_shared/agentes/juridico.ts";
import {
  JANELA_MESES,
  LIMITE_AMOSTRAS,
  type ItemPreco,
  type NaturezaContratacao,
  pisoTenantCentavos,
  type PropostaItem,
} from "../_shared/agentes/preco.ts";
import { lerTenantDoUsuario, type TenantResolvido } from "../_shared/tenant.ts";
import { type PortalOficial, resolverPortalOficial } from "../_shared/portal-oficial.ts";
import type { CitacaoPergunta, MotivoSemResposta } from "./perguntas.ts";

export interface Dossie {
  licitacao: { id: number; payload_hash: string | null; data_abertura: string | null };
  documentos_sha256: string[];
  chunks: ChunkEdital[];
  /** null: natureza da contratação não verificada em dado oficial. */
  natureza: NaturezaContratacao;
  itens: ItemPreco[];
  dispositivos: Dispositivo[];
  /** Portal oficial da disputa (link de origem, derivado ou só o nome). Ausente em dossiê montado à mão. */
  portal_oficial?: PortalOficial;
}

export interface Execucao {
  id: number;
  licitacao_id: number;
  agente: Agente;
  situacao: Situacao;
  contexto_hash: string;
  regra_versao: string;
  entrada: { proposta: PropostaItem[] | null };
  achados: Achado[];
  revisao: "aguardando" | "aprovada" | "rejeitada";
  revisao_nota: string | null;
  revisado_por: string | null;
  revisado_em: string | null;
  solicitado_por: string;
  created_at: string;
  /** Spec 0035 (K-3/K-4): enviada para a aba da oportunidade. Nula: só aparece na rota do agente. */
  enviada_em: string | null;
  enviada_por: string | null;
  /** Tarefa do agente ligada no envio (R-8); nula sem tarefa aberta na etapa atual. */
  tarefa_id: number | null;
  /** Revisões rejeitadas antes de um reenvio (R-9). */
  revisoes_anteriores: Array<{ decisao: string; nota: string | null; por: string | null; em: string | null; enviada_em: string | null }>;
}

/** Oportunidade da busca da rota do agente (K-0). */
export interface OportunidadeAgente {
  licitacao_id: number;
  numero_edital: string | null;
  numero_processo: string | null;
  orgao_nome: string | null;
  municipio: string | null;
  uf: string | null;
  objeto: string | null;
  modalidade: string | null;
  data_fim: string | null;
  etapa: { id: number; nome: string };
}

/** Categoria do erro de processamento (R-3): nunca o texto livre, que pode trazer URI de storage. */
export type CategoriaErro = "download" | "extracao" | "indexacao" | "outro";

/** Documento oficial da licitação na rota do agente (K-1), com colunas fixas. */
export interface DocumentoAgente {
  id: number;
  secao: string;
  nome: string;
  data_documento: string | null;
  status_processamento: "pendente" | "baixado" | "extraido" | "indexado" | "erro" | "ignorado";
  /** Páginas distintas indexadas; null se o documento não tem texto indexado. */
  paginas: number | null;
  /** Só a seção "processo" vira texto para o agente (licitacao_chunks.secao = 'processo'). */
  entra_na_analise: boolean;
  erro: CategoriaErro | null;
}

/** Último pedido da fila de preparação (download + indexação do edital) da licitação na empresa. Spec 0018/0032. */
export interface Preparacao {
  status: "pending" | "processing" | "completed" | "failed" | string;
  resultado: string | null;
  erro: string | null;
  atualizado_em: string | null;
}

/** Pergunta livre ao agente (spec 0038, K-5), como sai da api-agentes. `uso` (tokens) fica só no banco. */
export interface Pergunta {
  id: number;
  agente: Agente;
  /** null: pergunta sem licitação (jurídico avulso). */
  licitacao_id: number | null;
  pergunta: string;
  resposta: string | null;
  motivo_sem_resposta: MotivoSemResposta | null;
  citacoes: CitacaoPergunta[];
  modelo: string | null;
  versao_prompt: string | null;
  perguntado_por: string;
  created_at: string;
  favorita: boolean;
  /** K-11: enviada para a oportunidade como nota (sem revisão, sem virar achado). */
  enviada_em: string | null;
  enviada_por: string | null;
}

export interface NovaPergunta {
  agente: Agente;
  licitacao_id: number | null;
  pergunta: string;
  resposta: string | null;
  motivo_sem_resposta: MotivoSemResposta | null;
  citacoes: CitacaoPergunta[];
  modelo: string | null;
  versao_prompt: string | null;
  uso: Record<string, unknown> | null;
}

export interface FiltroPerguntas {
  agente: Agente | null;
  licitacao_id: number | null;
  somente_enviadas: boolean;
}

/** Mesmos filtros da agente_chunks_licitacao (migration 20261022130000). */
const NIVEIS_FORA = "(suspeito,bloqueado,parte_interessada)";
const MODELO_EMBEDDING = "text-multilingual-embedding-002";

/** Colunas que saem (lista fixa, sem `uso`). */
const COLUNAS_PERGUNTA =
  "id,agente,licitacao_id,pergunta,resposta,motivo_sem_resposta,citacoes,modelo,versao_prompt,perguntado_por,created_at,favorita,enviada_em,enviada_por";

const STATUS_DOCUMENTO = new Set(["pendente", "baixado", "extraido", "indexado", "erro", "ignorado"]);

/** R-3: categoria fixa do erro gravado pelo coletor/indexador. Texto sem padrão conhecido vira "outro". */
export function categoriaErro(texto: string | null): CategoriaErro | null {
  if (texto === null || texto.trim() === "") return null;
  if (/texto aproveit|extra[cç]/i.test(texto)) return "extracao";
  // antes de "index" e "pdf": o erro HTTP traz a URL do arquivo (".../index.php", ".../edital.pdf")
  if (/\b[45]\d\d\b|url|download|baix|timeout|tempo esgotado|conex/i.test(texto)) return "download";
  if (/index|chunk|embedding/i.test(texto)) return "indexacao";
  if (/ocr|pdf|zip|corrompid/i.test(texto)) return "extracao";
  return "outro";
}

export class ErroAgentes extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

export interface AgentesRepo {
  /** Regra de _shared/tenant.ts (#263); ErroTenantAcesso vira 403/409. */
  tenantDoUsuario(userId: string, desenvolvedor: boolean): Promise<TenantResolvido>;
  carregarDossie(tenant: number, licitacaoId: number): Promise<Dossie | null>;
  /** null: não há pedido de preparação para esta licitação na empresa. */
  preparacao(tenant: number, licitacaoId: number): Promise<Preparacao | null>;
  /** Pede o download e a indexação do edital (fila 'preparar_triagem'); nunca duplica o pedido aberto. Spec 0032 CA-1. */
  solicitarPreparacao(tenant: number, licitacaoId: number): Promise<"enfileirado" | "ja_na_fila">;
  /**
   * Documentos da licitação ainda sem texto (pendente ou baixado, fora os removidos do portal): a preparação lê esses.
   * 'erro' fica de fora de propósito: o erro gravado pode ser determinístico (arquivo corrompido) e cada clique em
   * "Analisar de novo" reenfileiraria sem fim; erro antigo de indexação se refaz pelo indexador.
   */
  documentosNaoLidos(licitacaoId: number): Promise<number>;
  buscarExecucao(tenant: number, licitacaoId: number, agente: Agente, contextoHash: string): Promise<Execucao | null>;
  gravarExecucao(
    tenant: number,
    userId: string,
    licitacaoId: number,
    contextoHash: string,
    proposta: PropostaItem[] | null,
    r: ResultadoAgente,
  ): Promise<Execucao>;
  /** Última execução por agente; com `somenteEnviadas`, a mais recente **enviada** por agente (R-10). */
  ultimasExecucoes(tenant: number, licitacaoId: number, somenteEnviadas?: boolean): Promise<Execucao[]>;
  /** R-1: a licitação está no pipeline da empresa (fora dele, 404 sem vazar dado). */
  estaNoPipeline(tenant: number, licitacaoId: number): Promise<boolean>;
  /** K-0 (agente_oportunidades_buscar): página de oportunidades e o total. */
  buscarOportunidades(
    tenant: number,
    agente: string,
    busca: string | null,
    limite: number,
    deslocamento: number,
  ): Promise<{ itens: OportunidadeAgente[]; total: number }>;
  /** K-1 (agente_documentos_listar): P0002 vira 404. */
  listarDocumentos(tenant: number, licitacaoId: number): Promise<DocumentoAgente[]>;
  /** K-4 (agente_execucao_enviar): LG003 vira 409, P0002 vira 404. */
  enviar(tenant: number, id: number, userId: string): Promise<Execucao>;
  /** Tarefa aberta do agente na etapa atual (agente_tarefa_aberta); null sem tarefa. */
  tarefaAgenteAberta(tenant: number, licitacaoId: number, agente: Agente): Promise<number | null>;
  obterExecucao(tenant: number, id: number): Promise<Execucao | null>;
  ultimaAprovada(tenant: number, licitacaoId: number, agente: Agente): Promise<Execucao | null>;
  revisar(
    tenant: number,
    id: number,
    decisao: "aprovada" | "rejeitada",
    nota: string | null,
    userId: string,
  ): Promise<Execucao | null>;
  // --- Spec 0038: pergunta livre (K-1, K-5, K-11) -----------------------------------------------------------------
  /** Reserva atômica de uma pergunta na cota do dia (agente_cota_reservar): usadas depois da reserva; null = cheia. */
  reservarCota(tenant: number, dia: string, limite: number): Promise<number | null>;
  /** Devolve a vaga (agente_cota_devolver), só quando o serviço nem foi chamado. */
  devolverCota(tenant: number, dia: string): Promise<void>;
  /** Perguntas que já gastaram a cota do dia (0 sem linha). */
  cotaUsada(tenant: number, dia: string): Promise<number>;
  /**
   * Chunks que agente_chunks_licitacao pode devolver (mesmos filtros: seção 'processo', com vetor do modelo do
   * indexador, fora suspeito/bloqueado/parte interessada). 0: "sem_documentos" (CA-3).
   */
  contarChunksIndexados(licitacaoId: number): Promise<number>;
  /** Chunks citáveis da licitação (seção 'processo', mesma confiança da RPC) entre os ids pedidos; de outra licitação não volta. */
  chunksDaLicitacao(licitacaoId: number, ids: number[]): Promise<ChunkEdital[]>;
  gravarPergunta(tenant: number, userId: string, p: NovaPergunta): Promise<Pergunta>;
  /** Mais recentes primeiro; com `somente_enviadas`, as notas enviadas para a oportunidade. */
  listarPerguntas(tenant: number, filtro: FiltroPerguntas, limite: number, deslocamento: number): Promise<{ itens: Pergunta[]; total: number }>;
  obterPergunta(tenant: number, id: number): Promise<Pergunta | null>;
  /** null: a pergunta não é da empresa. */
  favoritarPergunta(tenant: number, id: number, favorita: boolean): Promise<Pergunta | null>;
  /** Marca o envio só se ainda não foi enviada; null se outra chamada enviou antes (409). */
  enviarPergunta(tenant: number, id: number, userId: string): Promise<Pergunta | null>;
}

const AGENTES: Agente[] = ["edital", "preco", "juridico"];

function comoExecucao(row: Record<string, unknown>): Execucao {
  const entrada = row.entrada as { proposta?: PropostaItem[] | null } | null;
  return {
    id: Number(row.id),
    licitacao_id: Number(row.licitacao_id),
    agente: row.agente as Agente,
    situacao: row.situacao as Situacao,
    contexto_hash: String(row.contexto_hash),
    regra_versao: String(row.regra_versao),
    entrada: { proposta: entrada?.proposta ?? null },
    achados: (row.achados as Achado[]) ?? [],
    revisao: row.revisao as Execucao["revisao"],
    revisao_nota: (row.revisao_nota as string | null) ?? null,
    revisado_por: (row.revisado_por as string | null) ?? null,
    revisado_em: (row.revisado_em as string | null) ?? null,
    solicitado_por: String(row.solicitado_por),
    created_at: String(row.created_at),
    enviada_em: (row.enviada_em as string | null) ?? null,
    enviada_por: (row.enviada_por as string | null) ?? null,
    tarefa_id: row.tarefa_id == null ? null : Number(row.tarefa_id),
    revisoes_anteriores: Array.isArray(row.revisoes_anteriores) ? row.revisoes_anteriores as Execucao["revisoes_anteriores"] : [],
  };
}

function comoPergunta(row: Record<string, unknown>): Pergunta {
  return {
    id: Number(row.id),
    agente: row.agente as Agente,
    licitacao_id: row.licitacao_id == null ? null : Number(row.licitacao_id),
    pergunta: String(row.pergunta),
    resposta: (row.resposta as string | null) ?? null,
    motivo_sem_resposta: (row.motivo_sem_resposta as MotivoSemResposta | null) ?? null,
    citacoes: Array.isArray(row.citacoes) ? row.citacoes as CitacaoPergunta[] : [],
    modelo: (row.modelo as string | null) ?? null,
    versao_prompt: (row.versao_prompt as string | null) ?? null,
    perguntado_por: String(row.perguntado_por),
    created_at: String(row.created_at),
    favorita: row.favorita === true,
    enviada_em: (row.enviada_em as string | null) ?? null,
    enviada_por: (row.enviada_por as string | null) ?? null,
  };
}

function centavos(valor: unknown): number | null {
  if (typeof valor !== "number" || !Number.isFinite(valor)) return null;
  const c = Math.round(valor * 100);
  return c > 0 ? c : null;
}

function codigoCatalogo(valor: unknown): number | null {
  if (typeof valor === "number" && Number.isInteger(valor) && valor > 0) return valor;
  if (typeof valor === "string" && /^\d+$/.test(valor)) return Number(valor);
  return null;
}

export function createSupabaseRepo(client: SupabaseClient): AgentesRepo {
  return {
    tenantDoUsuario(userId, desenvolvedor) {
      return lerTenantDoUsuario(client, userId, desenvolvedor);
    },

    async preparacao(tenant, licitacaoId) {
      const { data, error } = await client.rpc("pipeline_preparacao_estado", { p_tenant: tenant, p_licitacoes: [licitacaoId] });
      if (error) throw new Error(error.message);
      const row = ((data ?? []) as Array<Record<string, unknown>>)[0];
      if (!row) return null;
      return {
        status: String(row.status),
        resultado: (row.resultado as string | null) ?? null,
        erro: (row.erro as string | null) ?? null,
        atualizado_em: (row.atualizado_em as string | null) ?? null,
      };
    },

    async solicitarPreparacao(tenant, licitacaoId) {
      const { data, error } = await client.rpc("fila_preparacao_solicitar", { p_tenant: tenant, p_licitacao: licitacaoId });
      if (error) throw new Error(error.message);
      if (data !== "enfileirado" && data !== "ja_na_fila") throw new Error(`fila_preparacao_solicitar devolveu ${String(data)}`);
      return data;
    },

    async documentosNaoLidos(licitacaoId) {
      const { count, error } = await client
        .from("licitacao_documentos")
        .select("id", { count: "exact", head: true })
        .eq("licitacao_id", licitacaoId)
        .in("status_processamento", ["pendente", "baixado"])
        .is("removido_do_portal_em", null);
      if (error) throw new Error(error.message);
      return count ?? 0;
    },

    async carregarDossie(tenant, licitacaoId) {
      const { data: lic, error: eLic } = await client
        .from("licitacoes_externas")
        .select("id,fonte,codigo_externo,numero_edital,link_sistema_origem,usuario_nome:raw->>usuario_nome")
        .eq("id", licitacaoId)
        .maybeSingle();
      if (eLic) throw new Error(eLic.message);
      if (!lic) return null;

      const { data: docs, error: eDocs } = await client
        .from("licitacao_documentos")
        .select("sha256")
        .eq("licitacao_id", licitacaoId)
        .not("sha256", "is", null);
      if (eDocs) throw new Error(eDocs.message);
      const documentos_sha256 = ((docs ?? []) as { sha256: string }[])
        .map((d) => d.sha256)
        .filter((s) => typeof s === "string" && s.length > 0)
        .sort();

      const { data: chunks, error: eChunks } = await client
        .from("licitacao_chunks")
        .select("id,documento_id,pagina,texto")
        .eq("licitacao_id", licitacaoId)
        .eq("secao", "processo")
        .order("documento_id")
        .order("ordem")
        .limit(2000);
      if (eChunks) throw new Error(eChunks.message);

      const { data: itensRaw, error: eItens } = await client
        .from("licitacao_itens")
        .select("id,numero_item,unidade_medida,valor_unitario_estimado,catalogo_codigo_item")
        .eq("licitacao_id", licitacaoId)
        .order("numero_item");
      if (eItens) throw new Error(eItens.message);

      const desde = new Date();
      desde.setUTCMonth(desde.getUTCMonth() - JANELA_MESES);
      const desdeIso = desde.toISOString().slice(0, 10);
      const hoje = new Date().toISOString().slice(0, 10);

      const itens: ItemPreco[] = [];
      for (const bruto of (itensRaw ?? []) as Array<Record<string, unknown>>) {
        const codigo = codigoCatalogo(bruto.catalogo_codigo_item);
        let amostras: ItemPreco["amostras"] = [];
        if (codigo !== null) {
          const { data: amostrasRaw, error: eAm } = await client
            .from("precos_praticados_itens")
            .select("id_compra_item,preco_unitario,sigla_unidade_fornecimento")
            .eq("codigo_item_catalogo", codigo)
            .gte("data_resultado", desdeIso)
            // As LIMITE_AMOSTRAS homologações mais recentes; id_compra_item desempata para a amostra ser estável.
            .order("data_resultado", { ascending: false })
            .order("id_compra_item", { ascending: true })
            .limit(LIMITE_AMOSTRAS);
          if (eAm) throw new Error(eAm.message);
          amostras = ((amostrasRaw ?? []) as Array<Record<string, unknown>>)
            .filter((a) => typeof a.id_compra_item === "string")
            .map((a) => ({
              id_compra_item: a.id_compra_item as string,
              preco_centavos: Math.round(Number(a.preco_unitario) * 100),
              unidade: (a.sigla_unidade_fornecimento as string | null) ?? null,
            }));
        }

        let piso_centavos: number | null = null;
        const { data: dePara, error: eDe } = await client
          .from("catalogo_de_para")
          .select("produto_id")
          .eq("tenant_id", tenant)
          .eq("licitacao_item_id", bruto.id)
          .eq("status", "confirmado")
          .order("id")
          .limit(1);
        if (eDe) throw new Error(eDe.message);
        const produtoId = (dePara ?? [])[0]?.produto_id as number | undefined;
        if (produtoId !== undefined) {
          const { data: precos, error: ePr } = await client
            .from("catalogo_precos")
            .select("preco_tabela,desconto_max_pct,vigencia_inicio,vigencia_fim")
            .eq("tenant_id", tenant)
            .eq("produto_id", produtoId)
            .lte("vigencia_inicio", hoje)
            .order("vigencia_inicio", { ascending: false })
            .limit(5);
          if (ePr) throw new Error(ePr.message);
          const vigente = ((precos ?? []) as Array<Record<string, unknown>>).find((p) =>
            p.vigencia_fim === null || String(p.vigencia_fim) >= hoje
          );
          if (vigente && typeof vigente.preco_tabela === "number") {
            const tabela = Math.round(vigente.preco_tabela * 100);
            const desconto = typeof vigente.desconto_max_pct === "number" ? vigente.desconto_max_pct : 0;
            piso_centavos = pisoTenantCentavos(tabela, desconto);
          }
        }

        itens.push({
          numero_item: Number(bruto.numero_item),
          unidade: (bruto.unidade_medida as string | null) ?? null,
          estimado_centavos: centavos(bruto.valor_unitario_estimado),
          amostras,
          piso_centavos,
        });
      }

      const { data: dispositivos, error: eDisp } = await client
        .from("norma_dispositivos")
        .select("norma,artigo,texto,conferido_oficial")
        .eq("norma", NORMA);
      if (eDisp) throw new Error(eDisp.message);

      const chunksEdital = (chunks ?? []) as ChunkEdital[];
      return {
        // licitacoes_externas ainda não registra uma data inequívoca de sessão pública.
        // Não usar início/fim de propostas para calcular prazo de impugnação.
        licitacao: { id: Number(lic.id), payload_hash: null, data_abertura: null },
        documentos_sha256,
        chunks: chunksEdital,
        // licitacoes_externas.raw não traz a categoria do processo: a natureza fica desconhecida.
        natureza: null,
        itens,
        dispositivos: ((dispositivos ?? []) as Dispositivo[]),
        // Rota do portal: link de origem, depois portal mapeado ou indicado no edital (com o trecho).
        portal_oficial: resolverPortalOficial(lic as Record<string, unknown>, chunksEdital),
      };
    },

    async buscarExecucao(tenant, licitacaoId, agente, contextoHash) {
      const { data, error } = await client
        .from("agente_execucoes")
        .select("*")
        .eq("tenant_id", tenant)
        .eq("licitacao_id", licitacaoId)
        .eq("agente", agente)
        .eq("contexto_hash", contextoHash)
        .maybeSingle();
      if (error) throw new Error(error.message);
      return data ? comoExecucao(data as Record<string, unknown>) : null;
    },

    async gravarExecucao(tenant, userId, licitacaoId, contextoHash, proposta, r) {
      const { data, error } = await client
        .from("agente_execucoes")
        .insert({
          tenant_id: tenant,
          licitacao_id: licitacaoId,
          agente: r.agente,
          situacao: r.situacao,
          contexto_hash: contextoHash,
          regra_versao: r.regra_versao,
          entrada: { proposta },
          achados: r.achados,
          solicitado_por: userId,
        })
        .select("*")
        .single();
      if (error) throw new Error(error.message);
      return comoExecucao(data as Record<string, unknown>);
    },

    async ultimasExecucoes(tenant, licitacaoId, somenteEnviadas = false) {
      let q = client
        .from("agente_execucoes")
        .select("*")
        .eq("tenant_id", tenant)
        .eq("licitacao_id", licitacaoId);
      // R-10: filtra antes de escolher a mais recente, para uma execução nova não enviada não esconder a enviada.
      if (somenteEnviadas) q = q.not("enviada_em", "is", null).order("enviada_em", { ascending: false });
      const { data, error } = await q.order("created_at", { ascending: false }).limit(200);
      if (error) throw new Error(error.message);
      const vistas = new Set<Agente>();
      const saida: Execucao[] = [];
      for (const row of (data ?? []) as Record<string, unknown>[]) {
        const exec = comoExecucao(row);
        if (vistas.has(exec.agente)) continue;
        vistas.add(exec.agente);
        saida.push(exec);
      }
      return AGENTES.flatMap((agente) => {
        const achou = saida.find((e) => e.agente === agente);
        return achou ? [achou] : [];
      });
    },

    async estaNoPipeline(tenant, licitacaoId) {
      const { data, error } = await client.from("pipeline_oportunidades").select("licitacao_id")
        .eq("tenant_id", tenant).eq("licitacao_id", licitacaoId).maybeSingle();
      if (error) throw new Error(error.message);
      return data !== null;
    },

    async buscarOportunidades(tenant, agente, busca, limite, deslocamento) {
      const { data, error } = await client.rpc("agente_oportunidades_buscar", {
        p_tenant: tenant, p_agente: agente, p_busca: busca, p_limite: limite, p_deslocamento: deslocamento,
      });
      if (error) throw new Error(error.message);
      const linhas = (data ?? []) as Array<Record<string, unknown>>;
      return {
        total: Number(linhas[0]?.total ?? 0),
        itens: linhas.map((l) => ({
          licitacao_id: Number(l.licitacao_id),
          numero_edital: (l.numero_edital as string | null) ?? null,
          numero_processo: (l.numero_processo as string | null) ?? null,
          orgao_nome: (l.orgao_nome as string | null) ?? null,
          municipio: (l.municipio as string | null) ?? null,
          uf: (l.uf as string | null) ?? null,
          objeto: (l.objeto as string | null) ?? null,
          modalidade: (l.modalidade as string | null) ?? null,
          data_fim: (l.data_fim as string | null) ?? null,
          etapa: { id: Number(l.etapa_id), nome: String(l.etapa_nome) },
        })),
      };
    },

    async listarDocumentos(tenant, licitacaoId) {
      const { data, error } = await client.rpc("agente_documentos_listar", { p_tenant: tenant, p_licitacao: licitacaoId });
      if (error?.code === "P0002") throw new ErroAgentes("Licitação não encontrada.", 404);
      if (error) throw new Error(error.message);
      // Lista fixa de chaves (R-3): nada além disto sai, mesmo que a função passe a devolver mais colunas.
      return ((data ?? []) as Array<Record<string, unknown>>).map((d): DocumentoAgente => {
        const status = String(d.status_processamento);
        if (!STATUS_DOCUMENTO.has(status)) throw new Error(`status_processamento desconhecido: ${status}`);
        return {
          id: Number(d.id),
          secao: String(d.secao),
          nome: String(d.nome),
          data_documento: (d.data_documento as string | null) ?? null,
          status_processamento: status as DocumentoAgente["status_processamento"],
          paginas: d.paginas == null ? null : Number(d.paginas),
          entra_na_analise: d.secao === "processo",
          erro: categoriaErro((d.erro as string | null) ?? null),
        };
      });
    },

    async enviar(tenant, id, userId) {
      const { data, error } = await client.rpc("agente_execucao_enviar", { p_tenant: tenant, p_execucao: id, p_user: userId });
      if (error?.code === "LG003") throw new ErroAgentes("Esta análise já foi enviada.", 409);
      if (error?.code === "P0002") throw new ErroAgentes("Execução não encontrada.", 404);
      if (error) throw new Error(error.message);
      const row = (Array.isArray(data) ? data[0] : data) as Record<string, unknown> | null;
      if (!row) throw new Error("agente_execucao_enviar não devolveu a execução");
      return comoExecucao(row);
    },

    async tarefaAgenteAberta(tenant, licitacaoId, agente) {
      const { data, error } = await client.rpc("agente_tarefa_aberta", { p_tenant: tenant, p_licitacao: licitacaoId, p_agente: agente });
      if (error) throw new Error(error.message);
      return data == null ? null : Number(data);
    },

    async obterExecucao(tenant, id) {
      const { data, error } = await client
        .from("agente_execucoes")
        .select("*")
        .eq("tenant_id", tenant)
        .eq("id", id)
        .maybeSingle();
      if (error) throw new Error(error.message);
      return data ? comoExecucao(data as Record<string, unknown>) : null;
    },

    async ultimaAprovada(tenant, licitacaoId, agente) {
      const { data, error } = await client
        .from("agente_execucoes")
        .select("*")
        .eq("tenant_id", tenant)
        .eq("licitacao_id", licitacaoId)
        .eq("agente", agente)
        .eq("revisao", "aprovada")
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw new Error(error.message);
      return data ? comoExecucao(data as Record<string, unknown>) : null;
    },

    async revisar(tenant, id, decisao, nota, userId) {
      const { data, error } = await client
        .from("agente_execucoes")
        .update({
          revisao: decisao,
          revisao_nota: nota,
          revisado_por: userId,
          revisado_em: new Date().toISOString(),
        })
        .eq("tenant_id", tenant)
        .eq("id", id)
        .eq("revisao", "aguardando")
        .select("*")
        .maybeSingle();
      if (error) throw new Error(error.message);
      return data ? comoExecucao(data as Record<string, unknown>) : null;
    },

    async reservarCota(tenant, dia, limite) {
      const { data, error } = await client.rpc("agente_cota_reservar", { p_tenant: tenant, p_dia: dia, p_limite: limite });
      if (error) throw new Error(error.message);
      return data == null ? null : Number(data);
    },

    async devolverCota(tenant, dia) {
      const { error } = await client.rpc("agente_cota_devolver", { p_tenant: tenant, p_dia: dia });
      if (error) throw new Error(error.message);
    },

    async cotaUsada(tenant, dia) {
      const { data, error } = await client.from("agente_cota_dia").select("usadas")
        .eq("tenant_id", tenant).eq("dia", dia).maybeSingle();
      if (error) throw new Error(error.message);
      return data ? Number((data as { usadas: unknown }).usadas) : 0;
    },

    async contarChunksIndexados(licitacaoId) {
      const { count, error } = await client
        .from("licitacao_chunks")
        .select("id", { count: "exact", head: true })
        .eq("licitacao_id", licitacaoId)
        .eq("secao", "processo")
        .not("embedding", "is", null)
        .not("nivel_confianca", "in", NIVEIS_FORA)
        .or(`embedding_model.is.null,embedding_model.eq.${MODELO_EMBEDDING}`);
      if (error) throw new Error(error.message);
      if (count === null) throw new Error("contagem de licitacao_chunks indisponível");
      return count;
    },

    async chunksDaLicitacao(licitacaoId, ids) {
      if (ids.length === 0) return [];
      const { data, error } = await client
        .from("licitacao_chunks")
        .select("id,documento_id,pagina,texto")
        .eq("licitacao_id", licitacaoId)
        .eq("secao", "processo")
        .not("nivel_confianca", "in", NIVEIS_FORA)
        .in("id", ids);
      if (error) throw new Error(error.message);
      return ((data ?? []) as Array<Record<string, unknown>>).map((c) => ({
        id: Number(c.id),
        documento_id: Number(c.documento_id),
        pagina: c.pagina == null ? null : Number(c.pagina),
        texto: String(c.texto ?? ""),
      }));
    },

    async gravarPergunta(tenant, userId, p) {
      const { data, error } = await client
        .from("agente_perguntas")
        .insert({ tenant_id: tenant, perguntado_por: userId, ...p })
        .select(COLUNAS_PERGUNTA)
        .single();
      if (error) throw new Error(error.message);
      return comoPergunta(data as unknown as Record<string, unknown>);
    },

    async listarPerguntas(tenant, filtro, limite, deslocamento) {
      let q = client.from("agente_perguntas").select(COLUNAS_PERGUNTA, { count: "exact" }).eq("tenant_id", tenant);
      if (filtro.agente) q = q.eq("agente", filtro.agente);
      if (filtro.licitacao_id !== null) q = q.eq("licitacao_id", filtro.licitacao_id);
      if (filtro.somente_enviadas) q = q.not("enviada_em", "is", null).order("enviada_em", { ascending: false });
      const { data, error, count } = await q
        .order("created_at", { ascending: false })
        .order("id", { ascending: false })
        .range(deslocamento, deslocamento + limite - 1);
      if (error) throw new Error(error.message);
      return {
        itens: ((data ?? []) as unknown as Array<Record<string, unknown>>).map(comoPergunta),
        total: count ?? 0,
      };
    },

    async obterPergunta(tenant, id) {
      const { data, error } = await client.from("agente_perguntas").select(COLUNAS_PERGUNTA)
        .eq("tenant_id", tenant).eq("id", id).maybeSingle();
      if (error) throw new Error(error.message);
      return data ? comoPergunta(data as unknown as Record<string, unknown>) : null;
    },

    async favoritarPergunta(tenant, id, favorita) {
      const { data, error } = await client.from("agente_perguntas").update({ favorita })
        .eq("tenant_id", tenant).eq("id", id).select(COLUNAS_PERGUNTA).maybeSingle();
      if (error) throw new Error(error.message);
      return data ? comoPergunta(data as unknown as Record<string, unknown>) : null;
    },

    async enviarPergunta(tenant, id, userId) {
      const { data, error } = await client.from("agente_perguntas")
        .update({ enviada_em: new Date().toISOString(), enviada_por: userId })
        .eq("tenant_id", tenant).eq("id", id).is("enviada_em", null)
        .select(COLUNAS_PERGUNTA).maybeSingle();
      if (error) throw new Error(error.message);
      return data ? comoPergunta(data as unknown as Record<string, unknown>) : null;
    },
  };
}
