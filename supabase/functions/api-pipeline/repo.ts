import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { lerTenantDoUsuario, type TenantResolvido } from "../_shared/tenant.ts";
import type { Desfecho, Etapa, EtapaComTotal, EventoHistorico, Fase, ItemModelo, ItemPipeline, ModeloTarefa, ResultadoPreparacao, StatusPreparacao, TarefaCatalogo } from "./types.ts";

/** Campos da licitação que o Kanban e os selos mostram (subconjunto das colunas públicas da api-dashboard-oportunidades). */
export const LICITACAO_CARD_COLUMNS = [
  "id", "fonte", "codigo_externo", "numero_processo", "processo_norm", "numero_edital", "objeto", "modalidade",
  "data_inicio", "data_fim", "valor_total", "orgao_cnpj", "orgao_nome", "municipio", "uf", "prioridade", "regulamento",
].join(",");

const ETAPA_COLUMNS = "id,nome,fase,ordem,desfecho,exige_motivo,padrao";
export const LIMITE_LISTA = 1000;
/** Norma do catálogo de tarefas (tarefas_catalogo.norma; seed 20260927100100). Outro regulamento terá o seu. */
export const NORMA_CATALOGO = "LEI_14133_2021";

/** Erro de regra vindo do banco (pipeline_mover / pipeline_etapa_excluir), já com status HTTP. */
export class ErroPipeline extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

export interface PipelineRepo {
  /** Empresa e papel do usuário (_shared/tenant.ts: vínculo com empresa ativa; sem vínculo, só o desenvolvedor, na única empresa ativa). */
  tenantDoUsuario(userId: string, desenvolvedor: boolean): Promise<TenantResolvido>;
  listarEtapas(tenant: number): Promise<EtapaComTotal[]>;
  /** Até LIMITE_LISTA itens, mais recentes primeiro; `truncado` avisa quando havia mais. `avisos` lista o complemento
   * que não pôde ser lido (o card vem sem ele, nunca com valor inventado). */
  listarPipeline(tenant: number, etapaId: number | null): Promise<{ itens: ItemPipeline[]; truncado: boolean; avisos: string[] }>;
  estado(tenant: number, licitacaoIds: number[]): Promise<Array<{ licitacao_id: number; etapa_id: number }>>;
  /** soNovos: só adiciona quem ainda não está no pipeline (atômico no banco; não move quem já está). */
  mover(tenant: number, licitacaoIds: number[], etapaId: number | null, motivo: string | null, userId: string, soNovos?: boolean): Promise<number>;
  historico(tenant: number, licitacaoId: number): Promise<EventoHistorico[]>;
  criarEtapa(tenant: number, e: { nome: string; fase: Fase; ordem: number | null; desfecho: Desfecho | null; exige_motivo: boolean }, userId: string): Promise<Etapa>;
  atualizarEtapa(tenant: number, id: number, campos: Partial<Omit<Etapa, "id" | "padrao">>, userId: string): Promise<Etapa | null>;
  excluirEtapa(tenant: number, id: number, moverPara: number | null, userId: string): Promise<number>;
  /** Tarefas ativas do catálogo 14.133 (para o modelo da etapa), com fase e base legal. */
  listarCatalogo(): Promise<TarefaCatalogo[]>;
  /** Modelo de tarefas da etapa (ativas e desligadas), com o resumo do catálogo. null se a etapa não é da empresa. */
  listarModelo(tenant: number, etapaId: number): Promise<ModeloTarefa[] | null>;
  /** Lista completa da etapa, numa transação (pipeline_etapa_tarefas_salvar). */
  salvarModelo(tenant: number, etapaId: number, itens: ItemModelo[], userId: string): Promise<number>;
  /** Cria as tarefas que faltam da etapa atual e das visitadas (pipeline_tarefas_reaplicar). */
  reaplicarTarefas(tenant: number, licitacaoId: number, userId: string): Promise<{ criadas: number; existentes: number; bloqueio: string | null }>;
}

/** Traduz o erro do Postgres das funções do pipeline para HTTP (22023 = regra, P0002 = não existe, 23505 = nome repetido). */
function traduzir(error: { code?: string; message?: string } | null): never {
  const msg = (error?.message ?? "Erro no pipeline").replace(/^pipeline_(mover|etapa_excluir): /, "");
  if (error?.code === "22023") throw new ErroPipeline(msg, 400);
  if (error?.code === "P0002") throw new ErroPipeline(msg, 404);
  if (error?.code === "23514") throw new ErroPipeline(msg || "Tarefa não aceita no modelo.", 400);
  if (error?.code === "23505") throw new ErroPipeline("Já existe uma etapa com esse nome.", 409);
  if (error?.code === "23503") throw new ErroPipeline("A etapa tem oportunidades; mova-as antes de excluir.", 409);
  throw new Error(error?.message ?? "Erro no pipeline");
}

export function createSupabaseRepo(client: SupabaseClient): PipelineRepo {
  return {
    tenantDoUsuario(userId, desenvolvedor) {
      return lerTenantDoUsuario(client, userId, desenvolvedor);
    },

    async listarEtapas(tenant) {
      const { data, error } = await client.from("pipeline_etapas").select(ETAPA_COLUMNS).eq("tenant_id", tenant).order("ordem").order("id");
      if (error) throw new Error(error.message);
      // contagem no banco (pipeline_contagem): não traz as linhas nem esbarra no max_rows do PostgREST
      const { data: cont, error: e2 } = await client.rpc("pipeline_contagem", { p_tenant: tenant });
      if (e2) throw new Error(e2.message);
      const total = new Map<number, number>((cont ?? []).map((c: { etapa_id: number; total: number }) => [Number(c.etapa_id), Number(c.total)]));
      return (data ?? []).map((e) => ({ ...(e as unknown as Etapa), total: total.get((e as { id: number }).id) ?? 0 }));
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
      let ordem = e.ordem;
      if (ordem === null) {
        const { data, error } = await client.from("pipeline_etapas").select("ordem").eq("tenant_id", tenant).order("ordem", { ascending: false }).limit(1);
        if (error) throw new Error(error.message);
        ordem = ((data?.[0]?.ordem as number | undefined) ?? 0) + 10;
      }
      const { data, error } = await client
        .from("pipeline_etapas")
        .insert({ tenant_id: tenant, nome: e.nome, fase: e.fase, ordem, desfecho: e.desfecho, exige_motivo: e.exige_motivo, updated_by: userId })
        .select(ETAPA_COLUMNS).single();
      if (error) traduzir(error);
      return data as unknown as Etapa;
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
        .select("id,etapa_id,origem,tarefa_codigo,chave,titulo,descricao,prazo_horas,ordem,ativo,catalogo:tarefas_catalogo(titulo,fase_codigo,natureza,prazo_unidade,ativo)")
        .eq("tenant_id", tenant).eq("etapa_id", etapaId)
        .order("ativo", { ascending: false }).order("ordem").order("id");
      if (error) throw new Error(error.message);
      return (data ?? []) as unknown as ModeloTarefa[];
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
