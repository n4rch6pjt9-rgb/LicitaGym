import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import type { Desfecho, Etapa, EtapaComTotal, EventoHistorico, Fase, ItemPipeline } from "./types.ts";

/** Campos da licitação que o Kanban e os selos mostram (subconjunto das colunas públicas da api-dashboard-oportunidades). */
export const LICITACAO_CARD_COLUMNS = [
  "id", "fonte", "codigo_externo", "numero_processo", "processo_norm", "numero_edital", "objeto", "modalidade",
  "data_inicio", "data_fim", "valor_total", "orgao_cnpj", "orgao_nome", "municipio", "uf", "prioridade",
].join(",");

const ETAPA_COLUMNS = "id,nome,fase,ordem,desfecho,exige_motivo,padrao";
export const LIMITE_LISTA = 1000;

/** Erro de regra vindo do banco (pipeline_mover / pipeline_etapa_excluir), já com status HTTP. */
export class ErroPipeline extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

/**
 * Um vínculo ativo manda. Sem vínculo, só resta o único tenant ativo (a Konnen, até ligarem os usuários).
 * Dois vínculos, ou duas empresas ativas sem vínculo, recusam.
 */
export function resolverTenant(ligados: number[], ativos: number[]): number {
  const unicos = [...new Set(ligados)];
  if (unicos.length > 1) throw new ErroPipeline("Usuário ligado a mais de uma empresa.", 409);
  if (unicos.length === 1) return unicos[0];
  if (ativos.length === 1) return ativos[0];
  if (ativos.length === 0) throw new ErroPipeline("Nenhuma empresa ativa cadastrada.", 409);
  throw new ErroPipeline("Há mais de uma empresa cadastrada e o usuário ainda não está ligado a uma.", 409);
}

export interface PipelineRepo {
  /** Tenant do usuário. Vínculo em tenant_membros; sem vínculo, só se houver uma empresa ativa. */
  tenantDoUsuario(userId: string): Promise<number>;
  listarEtapas(tenant: number): Promise<EtapaComTotal[]>;
  /** Até LIMITE_LISTA itens, mais recentes primeiro; `truncado` avisa quando havia mais. */
  listarPipeline(tenant: number, etapaId: number | null): Promise<{ itens: ItemPipeline[]; truncado: boolean }>;
  estado(tenant: number, licitacaoIds: number[]): Promise<Array<{ licitacao_id: number; etapa_id: number }>>;
  /** soNovos: só adiciona quem ainda não está no pipeline (atômico no banco; não move quem já está). */
  mover(tenant: number, licitacaoIds: number[], etapaId: number | null, motivo: string | null, userId: string, soNovos?: boolean): Promise<number>;
  historico(tenant: number, licitacaoId: number): Promise<EventoHistorico[]>;
  criarEtapa(tenant: number, e: { nome: string; fase: Fase; ordem: number | null; desfecho: Desfecho | null; exige_motivo: boolean }, userId: string): Promise<Etapa>;
  atualizarEtapa(tenant: number, id: number, campos: Partial<Omit<Etapa, "id" | "padrao">>, userId: string): Promise<Etapa | null>;
  excluirEtapa(tenant: number, id: number, moverPara: number | null, userId: string): Promise<number>;
}

/** Traduz o erro do Postgres das funções do pipeline para HTTP (22023 = regra, P0002 = não existe, 23505 = nome repetido). */
function traduzir(error: { code?: string; message?: string } | null): never {
  const msg = (error?.message ?? "Erro no pipeline").replace(/^pipeline_(mover|etapa_excluir): /, "");
  if (error?.code === "22023") throw new ErroPipeline(msg, 400);
  if (error?.code === "P0002") throw new ErroPipeline(msg, 404);
  if (error?.code === "23505") throw new ErroPipeline("Já existe uma etapa com esse nome.", 409);
  if (error?.code === "23503") throw new ErroPipeline("A etapa tem oportunidades; mova-as antes de excluir.", 409);
  throw new Error(error?.message ?? "Erro no pipeline");
}

export function createSupabaseRepo(client: SupabaseClient): PipelineRepo {
  return {
    async tenantDoUsuario(userId) {
      const { data: membros, error } = await client
        .from("tenant_membros")
        .select("tenant_id")
        .eq("user_id", userId)
        .eq("ativo", true);
      if (error) throw new Error(error.message);
      const ligados = (membros ?? []).map((r) => Number(r.tenant_id));
      const { data: ativos, error: erroAtivos } = await client
        .from("tenants")
        .select("id")
        .eq("ativo", true)
        .order("id")
        .limit(2);
      if (erroAtivos) throw new Error(erroAtivos.message);
      return resolverTenant(ligados, (ativos ?? []).map((r) => Number(r.id)));
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
      return { itens: linhas.slice(0, LIMITE_LISTA), truncado: linhas.length > LIMITE_LISTA };
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

    async excluirEtapa(tenant, id, moverPara, userId) {
      const { data, error } = await client.rpc("pipeline_etapa_excluir", { p_tenant: tenant, p_etapa: id, p_mover_para: moverPara, p_user: userId });
      if (error) traduzir(error);
      return (data as number) ?? 0;
    },
  };
}
