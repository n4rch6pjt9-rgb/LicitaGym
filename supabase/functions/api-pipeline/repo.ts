import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { lerTenantDoUsuario, type TenantResolvido } from "../_shared/tenant.ts";
import type {
  AgenteDisponivel, Desfecho, Etapa, EtapaComTotal, EventoHistorico, Fase, ItemAgente, ItemModelo, ItemPipeline, ListaEtapas, ModeloAgente,
  ModeloTarefa, ResultadoPreparacao, StatusPreparacao, TarefaCatalogo,
} from "./types.ts";

/** Campos da licitação que o Kanban e os selos mostram (subconjunto das colunas públicas da api-dashboard-oportunidades). */
export const LICITACAO_CARD_COLUMNS = [
  "id", "fonte", "codigo_externo", "numero_processo", "processo_norm", "numero_edital", "objeto", "modalidade",
  "data_inicio", "data_fim", "valor_total", "orgao_cnpj", "orgao_nome", "municipio", "uf", "prioridade", "regulamento",
].join(",");

const ETAPA_COLUMNS = "id,nome,fase,ordem,desfecho,exige_motivo,padrao";
export const LIMITE_LISTA = 1000;
/** Norma do catálogo de tarefas (tarefas_catalogo.norma; seed 20260927100100). Outro regulamento terá o seu. */
export const NORMA_CATALOGO = "LEI_14133_2021";

/** Erro de regra vindo do banco (pipeline_mover / pipeline_etapa_excluir), já com status HTTP. `codigo` vai na
 * resposta quando o cliente precisa distinguir o caso (lista_invalida, versao_desatualizada). */
export class ErroPipeline extends Error {
  constructor(message: string, readonly status: number, readonly codigo?: string) {
    super(message);
  }
}

export interface PipelineRepo {
  /** Empresa e papel do usuário (_shared/tenant.ts: vínculo com empresa ativa; sem vínculo, só o desenvolvedor, na única empresa ativa). */
  tenantDoUsuario(userId: string, desenvolvedor: boolean): Promise<TenantResolvido>;
  /** Etapas e versão num só comando (pipeline_etapas_listar). */
  listarEtapas(tenant: number): Promise<ListaEtapas>;
  /** Lista completa na ordem nova, com a versão lida (pipeline_etapas_reordenar, no lock do tenant). */
  reordenarEtapas(tenant: number, ids: number[], versao: string, userId: string): Promise<ListaEtapas>;
  /** Até LIMITE_LISTA itens, mais recentes primeiro; `truncado` avisa quando havia mais. `avisos` lista o complemento
   * que não pôde ser lido (o card vem sem ele, nunca com valor inventado). */
  listarPipeline(tenant: number, etapaId: number | null): Promise<{ itens: ItemPipeline[]; truncado: boolean; avisos: string[] }>;
  estado(tenant: number, licitacaoIds: number[]): Promise<Array<{ licitacao_id: number; etapa_id: number }>>;
  /** soNovos: só adiciona quem ainda não está no pipeline (atômico no banco; não move quem já está). */
  mover(tenant: number, licitacaoIds: number[], etapaId: number | null, motivo: string | null, userId: string, soNovos?: boolean): Promise<number>;
  historico(tenant: number, licitacaoId: number): Promise<EventoHistorico[]>;
  /** No fim da lista, dentro do lock do tenant (pipeline_etapa_criar). */
  criarEtapa(tenant: number, e: { nome: string; fase: Fase; desfecho: Desfecho | null; exige_motivo: boolean }, userId: string): Promise<Etapa>;
  atualizarEtapa(tenant: number, id: number, campos: Partial<Omit<Etapa, "id" | "padrao">>, userId: string): Promise<Etapa | null>;
  excluirEtapa(tenant: number, id: number, moverPara: number | null, userId: string): Promise<number>;
  /** Tarefas ativas do catálogo 14.133 (para o modelo da etapa), com fase e base legal. */
  listarCatalogo(): Promise<TarefaCatalogo[]>;
  /** Modelo de tarefas da etapa (ativas e desligadas), com o resumo do catálogo. null se a etapa não é da empresa.
   * Sem as tarefas de agente (spec 0035): o front anterior as trataria como da empresa e as gravaria de volta. */
  listarModelo(tenant: number, etapaId: number): Promise<ModeloTarefa[] | null>;
  /** Tarefas de agente da etapa (ativas e desligadas) e os agentes ativos do catálogo (spec 0035, K-16). Chamar só
   * depois de listarModelo confirmar a etapa da empresa. */
  listarAgentes(tenant: number, etapaId: number): Promise<{ tarefas_agente: ModeloAgente[]; agentes_disponiveis: AgenteDisponivel[] }>;
  /** Lista completa de agentes da etapa (pipeline_etapa_tarefas_agentes_salvar): o que sai é desligado, nunca apagado. */
  salvarAgentes(tenant: number, etapaId: number, itens: ItemAgente[], userId: string): Promise<number>;
  /** Lista completa da etapa, numa transação (pipeline_etapa_tarefas_salvar). */
  salvarModelo(tenant: number, etapaId: number, itens: ItemModelo[], userId: string): Promise<number>;
  /** Cria as tarefas que faltam da etapa atual e das visitadas (pipeline_tarefas_reaplicar). */
  reaplicarTarefas(tenant: number, licitacaoId: number, userId: string): Promise<{ criadas: number; existentes: number; bloqueio: string | null }>;
}

/** Traduz o erro do Postgres das funções do pipeline para HTTP (22023 = regra, P0002 = não existe, 23505 = nome repetido,
 * LG001 = lista de etapas inválida, LG002 = versão da lista desatualizada). */
function traduzir(error: { code?: string; message?: string } | null): never {
  const msg = (error?.message ?? "Erro no pipeline").replace(/^pipeline_(mover|etapa_excluir|etapas_reordenar|etapa_criar): /, "");
  if (error?.code === "LG001") throw new ErroPipeline(msg, 400, "lista_invalida");
  if (error?.code === "LG002") throw new ErroPipeline(msg, 409, "versao_desatualizada");
  if (error?.code === "22023") throw new ErroPipeline(msg, 400);
  if (error?.code === "P0002") throw new ErroPipeline(msg, 404);
  if (error?.code === "23514") throw new ErroPipeline(msg || "Tarefa não aceita no modelo.", 400);
  if (error?.code === "23505") throw new ErroPipeline("Já existe uma etapa com esse nome.", 409);
  if (error?.code === "23503") throw new ErroPipeline("A etapa tem oportunidades; mova-as antes de excluir.", 409);
  throw new Error(error?.message ?? "Erro no pipeline");
}

const etapa = (l: Etapa): Etapa => ({
  id: Number(l.id), nome: l.nome, fase: l.fase, ordem: Number(l.ordem), desfecho: l.desfecho, exige_motivo: l.exige_motivo, padrao: l.padrao,
});

/** Linhas de pipeline_etapas_listar / _reordenar (cada uma com a mesma `versao`) no formato da resposta. */
function listaEtapas(data: unknown): ListaEtapas {
  const linhas = (data ?? []) as Array<EtapaComTotal & { versao: string }>;
  return { etapas: linhas.map((l) => ({ ...etapa(l), total: Number(l.total) })), versao: linhas[0]?.versao ?? null };
}

export function createSupabaseRepo(client: SupabaseClient): PipelineRepo {
  return {
    tenantDoUsuario(userId, desenvolvedor) {
      return lerTenantDoUsuario(client, userId, desenvolvedor);
    },

    async listarEtapas(tenant) {
      // etapas, total e versão no mesmo comando: a versão descreve exatamente estas linhas (spec 0034, K-6)
      const { data, error } = await client.rpc("pipeline_etapas_listar", { p_tenant: tenant });
      if (error) throw new Error(error.message);
      return listaEtapas(data);
    },

    async reordenarEtapas(tenant, ids, versao, userId) {
      const { data, error } = await client.rpc("pipeline_etapas_reordenar", { p_tenant: tenant, p_ids: ids, p_versao: versao, p_user: userId });
      if (error) traduzir(error);
      return listaEtapas(data);
    },

    async listarPipeline(tenant, etapaId) {
      let q = client
        .from("pipeline_oportunidades")
        .select(`licitacao_id,etapa_id,motivo,atualizada_em,atualizada_por,licitacao:licitacoes_externas(${LICITACAO_CARD_COLUMNS})`)
        .eq("tenant_id", tenant)
        .order("atualizada_em", { ascending: false })
        .limit(LIMITE_LISTA + 1);
      if (etapaId) q = q.eq("etapa_id", etapaId);
      const { data, error } = await q;
      if (error) throw new Error(error.message);
      const linhas = (data ?? []) as unknown as ItemPipeline[];
      // Pendência de tarefas da lei (falha ao reaplicar quando o regulamento chegou): nunca some em silêncio.
      const { data: pend, error: e2 } = await client.schema("private").from("pipeline_tarefas_pendencias")
        .select("licitacao_id,motivo,erro,em").eq("tenant_id", tenant);
      if (e2) throw new Error(e2.message);
      const porLicitacao = new Map((pend ?? []).map((p) => [Number(p.licitacao_id), { motivo: String(p.motivo), erro: (p.erro as string | null) ?? null, em: String(p.em) }]));
      // Preparação da Triagem (fila de download/indexação): "análise em preparação" enquanto pendente.
      const ids = linhas.slice(0, LIMITE_LISTA).map((i) => Number(i.licitacao_id));
      const prep = new Map<number, ItemPipeline["preparacao"]>();
      const avisos: string[] = [];
      let prepOk = true;
      if (ids.length) {
        const { data: est, error: e3 } = await client.rpc("pipeline_preparacao_estado", { p_tenant: tenant, p_licitacoes: ids });
        // Complemento do card: a falha (ex.: função publicada antes da migration) não derruba o Kanban, mas também não
        // vira "sem pedido" (null): o campo some do item e `avisos` diz por quê.
        if (e3) {
          console.error("[api-pipeline] pipeline_preparacao_estado falhou", { code: e3.code, message: e3.message });
          prepOk = false;
          avisos.push("preparacao_indisponivel");
        }
        for (const e of (prepOk ? est ?? [] : []) as Array<Record<string, unknown>>) {
          prep.set(Number(e.licitacao_id), {
            status: e.status as StatusPreparacao, resultado: (e.resultado as ResultadoPreparacao | null) ?? null,
            erro: (e.erro as string | null) ?? null, atualizado_em: String(e.atualizado_em),
          });
        }
      }
      // Tarefas abertas por card (contadas no banco: pipeline_tarefas_abertas).
      const abertas = new Map<number, number>();
      let abertasOk = true;
      if (ids.length) {
        const { data: ab, error: e4 } = await client.rpc("pipeline_tarefas_abertas", { p_tenant: tenant, p_licitacoes: ids });
        // mesmo contrato da preparação: falha não vira 0, o campo some e avisos explica
        if (e4) {
          console.error("[api-pipeline] pipeline_tarefas_abertas falhou", { code: e4.code, message: e4.message });
          abertasOk = false;
          avisos.push("tarefas_abertas_indisponivel");
        }
        for (const a of (abertasOk ? ab ?? [] : []) as Array<{ licitacao_id: number; abertas: number }>) abertas.set(Number(a.licitacao_id), Number(a.abertas));
      }
      const itens = linhas.slice(0, LIMITE_LISTA).map((i) => ({
        ...i,
        ...(abertasOk ? { tarefas_abertas: abertas.get(Number(i.licitacao_id)) ?? 0 } : {}),
        tarefas_pendencia: porLicitacao.get(Number(i.licitacao_id)) ?? null,
        ...(prepOk ? { preparacao: prep.get(Number(i.licitacao_id)) ?? null } : {}),
      }));
      return { itens, truncado: linhas.length > LIMITE_LISTA, avisos };
    },

    async estado(tenant, ids) {
      const { data, error } = await client.from("pipeline_oportunidades").select("licitacao_id,etapa_id").eq("tenant_id", tenant).in("licitacao_id", ids);
      if (error) throw new Error(error.message);
      return (data ?? []) as Array<{ licitacao_id: number; etapa_id: number }>;
    },

    async mover(tenant, ids, etapaId, motivo, userId, soNovos = false) {
      const { data, error } = await client.rpc("pipeline_mover", {
        p_tenant: tenant, p_licitacoes: ids, p_etapa: etapaId, p_motivo: motivo, p_user: userId, p_so_novos: soNovos,
      });
      if (error) traduzir(error);
      return (data as number) ?? 0;
    },

    async historico(tenant, licitacaoId) {
      const { data, error } = await client
        .from("pipeline_historico")
        .select("id,licitacao_id,etapa_de,etapa_para,nome_de,nome_para,motivo,user_id,em")
        .eq("tenant_id", tenant).eq("licitacao_id", licitacaoId)
        .order("em", { ascending: false }).limit(200);
      if (error) throw new Error(error.message);
      return (data ?? []) as EventoHistorico[];
    },

    async criarEtapa(tenant, e, userId) {
      const { data, error } = await client.rpc("pipeline_etapa_criar", {
        p_tenant: tenant, p_nome: e.nome, p_fase: e.fase, p_desfecho: e.desfecho, p_exige_motivo: e.exige_motivo, p_user: userId,
      });
      if (error) traduzir(error);
      const linha = (data as Etapa[] | null)?.[0];
      if (!linha) throw new Error("pipeline_etapa_criar não devolveu a etapa");
      return etapa(linha);
    },

    async atualizarEtapa(tenant, id, campos, userId) {
      const { data, error } = await client
        .from("pipeline_etapas")
        .update({ ...campos, updated_by: userId, updated_at: new Date().toISOString() })
        .eq("tenant_id", tenant).eq("id", id)
        .select(ETAPA_COLUMNS).maybeSingle();
      if (error) traduzir(error);
      return (data as unknown as Etapa) ?? null;
    },

    async listarCatalogo() {
      // Base legal embutida (FK tarefa_codigo): uma consulta só, sem o corte silencioso do max_rows numa segunda.
      const { data, error } = await client.from("tarefas_catalogo")
        .select("codigo,fase_codigo,parent_codigo,ordem,titulo,natureza,ator,prazo_unidade,fase:processo_fases(nome,ordem),base:tarefas_catalogo_base_legal(artigo,dispositivo)")
        .eq("ativo", true).eq("norma", NORMA_CATALOGO).order("fase_codigo").order("ordem");
      if (error) throw new Error(error.message);
      const linhas = (data ?? []) as Array<Record<string, unknown>>;
      // max_rows do PostgREST é 1000: lista cheia pode estar cortada; erro em vez de catálogo incompleto.
      if (linhas.length >= LIMITE_LISTA) throw new Error("Catálogo maior que o limite de leitura; paginar antes de usar.");
      return linhas.map((c): TarefaCatalogo => {
        const fase = (c.fase ?? null) as { nome?: string; ordem?: number | null } | null;
        // mesma ordem e formato do string_agg de catalogo_tarefas_da_fase: "art. N (dispositivo)" unidos por "; "
        const bases = ((c.base ?? []) as Array<{ artigo: number; dispositivo: string }>)
          .slice().sort((a, b) => a.artigo - b.artigo || a.dispositivo.localeCompare(b.dispositivo, "pt-BR"));
        return {
          codigo: String(c.codigo), fase_codigo: String(c.fase_codigo), fase_nome: fase?.nome ?? null,
          fase_ordem: fase?.ordem ?? null, parent_codigo: c.parent_codigo == null ? null : String(c.parent_codigo),
          ordem: Number(c.ordem), titulo: String(c.titulo), natureza: String(c.natureza), ator: String(c.ator),
          prazo_unidade: String(c.prazo_unidade),
          base_legal: bases.length ? bases.map((b) => `art. ${b.artigo} (${b.dispositivo})`).join("; ") : null,
        };
      });
    },

    async listarModelo(tenant, etapaId) {
      const { data: etapa, error: e1 } = await client.from("pipeline_etapas").select("id").eq("tenant_id", tenant).eq("id", etapaId).maybeSingle();
      if (e1) throw new Error(e1.message);
      if (!etapa) return null;
      const { data, error } = await client
        .from("pipeline_etapa_tarefas")
        .select(
          "id,etapa_id,origem,tarefa_codigo,chave,titulo,descricao,prazo_horas,ordem,ativo,responsavel_tipo,responsavel_papel,responsavel_user_id," +
            "catalogo:tarefas_catalogo(titulo,fase_codigo,natureza,prazo_unidade,ativo)",
        )
        .eq("tenant_id", tenant).eq("etapa_id", etapaId).in("origem", ["catalogo", "empresa"])
        .order("ativo", { ascending: false }).order("ordem").order("id");
      if (error) throw new Error(error.message);
      return (data ?? []) as unknown as ModeloTarefa[];
    },

    async listarAgentes(tenant, etapaId) {
      const [mod, cat] = await Promise.all([
        client.from("pipeline_etapa_tarefas")
          .select("id,etapa_id,chave,titulo,descricao,prazo_horas,ordem,ativo,responsavel_agente")
          .eq("tenant_id", tenant).eq("etapa_id", etapaId).eq("origem", "agente")
          .order("ativo", { ascending: false }).order("ordem").order("id"),
        client.from("agentes_catalogo").select("codigo,nome,api,acao_api,agente_api,descricao").eq("ativo", true).order("ordem").order("codigo"),
      ]);
      if (mod.error) throw new Error(mod.error.message);
      if (cat.error) throw new Error(cat.error.message);
      const tarefas_agente = ((mod.data ?? []) as Array<Record<string, unknown>>).map((m): ModeloAgente => ({
        id: Number(m.id), etapa_id: Number(m.etapa_id), chave: String(m.chave), titulo: String(m.titulo),
        descricao: (m.descricao as string | null) ?? null, prazo_horas: m.prazo_horas == null ? null : Number(m.prazo_horas),
        ordem: Number(m.ordem), ativo: Boolean(m.ativo), agente: String(m.responsavel_agente),
      }));
      return { tarefas_agente, agentes_disponiveis: (cat.data ?? []) as AgenteDisponivel[] };
    },

    async salvarAgentes(tenant, etapaId, itens, userId) {
      const { data, error } = await client.rpc("pipeline_etapa_tarefas_agentes_salvar", { p_tenant: tenant, p_etapa: etapaId, p_itens: itens, p_user: userId });
      if (error) traduzir(error);
      return (data as number) ?? 0;
    },

    async salvarModelo(tenant, etapaId, itens, userId) {
      const { data, error } = await client.rpc("pipeline_etapa_tarefas_salvar", { p_tenant: tenant, p_etapa: etapaId, p_itens: itens, p_user: userId });
      if (error) traduzir(error);
      return (data as number) ?? 0;
    },

    async reaplicarTarefas(tenant, licitacaoId, userId) {
      const { data, error } = await client.rpc("pipeline_tarefas_reaplicar", { p_tenant: tenant, p_licitacao: licitacaoId, p_user: userId });
      if (error) traduzir(error);
      const linha = (Array.isArray(data) ? data[0] : data) as { criadas: number; existentes: number; bloqueio: string | null } | null;
      return { criadas: Number(linha?.criadas ?? 0), existentes: Number(linha?.existentes ?? 0), bloqueio: linha?.bloqueio ?? null };
    },

    async excluirEtapa(tenant, id, moverPara, userId) {
      const { data, error } = await client.rpc("pipeline_etapa_excluir", { p_tenant: tenant, p_etapa: id, p_mover_para: moverPara, p_user: userId });
      if (error) traduzir(error);
      return (data as number) ?? 0;
    },
  };
}
