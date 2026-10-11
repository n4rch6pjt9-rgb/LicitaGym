import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { lerTenantDoUsuario, type TenantResolvido } from "../_shared/tenant.ts";
import type { Bloqueio, Status, Tarefa, TarefaPrevia } from "./types.ts";

const TAREFA_COLUMNS = [
  "id", "tenant_id", "licitacao_id", "origem", "tarefa_codigo", "titulo", "descricao", "liberada_por_fase",
  "liberada_por_evento", "condicao_verificada", "contexto", "prazo_situacao", "prazo_em", "prazo_informado_por", "prazo_informado_em", "status", "responsavel_papel",
  "responsavel_user_id", "criada_em", "atualizada_em", "concluida_em",
].join(",") +
  ",catalogo:tarefas_catalogo(titulo,descricao,fase_codigo,natureza,prazo_quantidade,prazo_unidade,prazo_sentido,prazo_evento)";

export const LIMITE_LISTA = 500;

export interface FiltroTarefas {
  licitacao_id: number | null;
  status: Status | null;
  /** user_id do responsável; null = qualquer (inclusive a fila dos admins). */
  responsavel: string | null;
}

export interface TarefasRepo {
  tenantDoUsuario(userId: string, desenvolvedor: boolean): Promise<TenantResolvido>;
  estaNoPipeline(tenant: number, licitacaoId: number): Promise<boolean>;
  /** licitacoes_externas.regulamento (null = não informado). */
  regulamento(licitacaoId: number): Promise<string | null>;
  /** Tarefas que a fase ou o evento liberam, com a condição avaliada no contexto oficial do certame. Não grava. */
  previa(licitacaoId: number, fase: string | null, evento: string | null): Promise<TarefaPrevia[]>;
  liberar(tenant: number, licitacaoId: number, fase: string | null, evento: string | null, userId: string): Promise<{
    criadas: number;
    existentes: number;
    bloqueio: Bloqueio | null;
  }>;
  /** Até LIMITE_LISTA, mais recentes primeiro; `truncado` avisa quando havia mais. */
  listar(tenant: number, filtro: FiltroTarefas): Promise<{ tarefas: Tarefa[]; truncado: boolean }>;
  obter(tenant: number, id: number): Promise<Tarefa | null>;
  /** soDoResponsavel: só grava se a tarefa ainda está com esse usuário (sem corrida com a reatribuição); null se não. */
  atualizar(tenant: number, id: number, campos: Partial<Tarefa>, userId: string, soDoResponsavel?: string): Promise<Tarefa | null>;
  /** Papel do membro ativo (tenant_membros.ativo) na empresa; null se não for membro ativo. */
  papelDoMembro(tenant: number, userId: string): Promise<"admin" | "operacao" | null>;
}

export function createSupabaseRepo(client: SupabaseClient): TarefasRepo {
  return {
    tenantDoUsuario(userId, desenvolvedor) {
      return lerTenantDoUsuario(client, userId, desenvolvedor);
    },

    async estaNoPipeline(tenant, licitacaoId) {
      const { data, error } = await client.from("pipeline_oportunidades").select("licitacao_id")
        .eq("tenant_id", tenant).eq("licitacao_id", licitacaoId).maybeSingle();
      if (error) throw new Error(error.message);
      return data !== null;
    },

    async regulamento(licitacaoId) {
      const { data, error } = await client.from("licitacoes_externas").select("regulamento").eq("id", licitacaoId).maybeSingle();
      if (error) throw new Error(error.message);
      return (data?.regulamento as string | null | undefined) ?? null;
    },

    async previa(licitacaoId, fase, evento) {
      const { data: contexto, error: e1 } = await client.rpc("tarefas_contexto_certame", { p_licitacao_id: licitacaoId });
      if (e1) throw new Error(e1.message);
      const { data, error } = fase
        ? await client.rpc("catalogo_tarefas_da_fase", { p_fase: fase, p_contexto: contexto ?? {} })
        : await client.rpc("catalogo_tarefas_do_evento", { p_evento: evento, p_contexto: contexto ?? {} });
      if (error) throw new Error(error.message);
      const linhas = (data ?? []) as Array<Record<string, unknown>>;
      const codigos = linhas.map((l) => String(l.codigo));
      if (codigos.length === 0) return [];
      // As duas funções do catálogo devolvem colunas diferentes: completa pelo catálogo para um formato só.
      const { data: cat, error: e2 } = await client.from("tarefas_catalogo")
        .select("codigo,fase_codigo,parent_codigo,titulo,natureza,prazo_quantidade,prazo_unidade,prazo_sentido,prazo_evento")
        .in("codigo", codigos);
      if (e2) throw new Error(e2.message);
      const { data: bases, error: e3 } = await client.from("tarefas_catalogo_base_legal")
        .select("tarefa_codigo,artigo,dispositivo").in("tarefa_codigo", codigos).order("artigo").order("dispositivo");
      if (e3) throw new Error(e3.message);
      const porCodigo = new Map((cat ?? []).map((c) => [String(c.codigo), c as Record<string, unknown>]));
      const base = new Map<string, string[]>();
      for (const b of bases ?? []) {
        const k = String(b.tarefa_codigo);
        base.set(k, [...(base.get(k) ?? []), "art. " + b.artigo + " (" + b.dispositivo + ")"]);
      }
      return linhas.map((l): TarefaPrevia => {
        const c = porCodigo.get(String(l.codigo)) ?? {};
        return {
          codigo: String(l.codigo),
          fase_codigo: String(c.fase_codigo ?? l.fase_codigo ?? ""),
          parent_codigo: (c.parent_codigo as string | null) ?? null,
          titulo: String(c.titulo ?? l.titulo ?? ""),
          natureza: String(c.natureza ?? ""),
          prazo_quantidade: (c.prazo_quantidade as number | null) ?? null,
          prazo_unidade: String(c.prazo_unidade ?? l.prazo_unidade ?? ""),
          prazo_sentido: (c.prazo_sentido as string | null) ?? null,
          prazo_evento: (c.prazo_evento as string | null) ?? null,
          aplicavel: (l.aplicavel as boolean | null) ?? null,
          base_legal: base.get(String(l.codigo))?.join("; ") ?? null,
        };
      });
    },

    async liberar(tenant, licitacaoId, fase, evento, userId) {
      const { data, error } = await client.rpc("tarefas_equipe_liberar", {
        p_tenant_id: tenant, p_licitacao_id: licitacaoId, p_fase: fase, p_evento: evento, p_user_id: userId,
      });
      if (error) throw new Error(error.message);
      const linha = (Array.isArray(data) ? data[0] : data) as { criadas: number; existentes: number; bloqueio: Bloqueio | null };
      return { criadas: Number(linha?.criadas ?? 0), existentes: Number(linha?.existentes ?? 0), bloqueio: linha?.bloqueio ?? null };
    },

    async listar(tenant, f) {
      let q = client.from("tarefas_equipe").select(TAREFA_COLUMNS).eq("tenant_id", tenant)
        .order("criada_em", { ascending: false }).limit(LIMITE_LISTA + 1);
      if (f.licitacao_id !== null) q = q.eq("licitacao_id", f.licitacao_id);
      if (f.status !== null) q = q.eq("status", f.status);
      if (f.responsavel !== null) q = q.eq("responsavel_user_id", f.responsavel);
      const { data, error } = await q;
      if (error) throw new Error(error.message);
      const linhas = (data ?? []) as unknown as Tarefa[];
      return { tarefas: linhas.slice(0, LIMITE_LISTA), truncado: linhas.length > LIMITE_LISTA };
    },

    async obter(tenant, id) {
      const { data, error } = await client.from("tarefas_equipe").select(TAREFA_COLUMNS)
        .eq("tenant_id", tenant).eq("id", id).maybeSingle();
      if (error) throw new Error(error.message);
      return (data as unknown as Tarefa) ?? null;
    },

    async atualizar(tenant, id, campos, userId, soDoResponsavel) {
      let q = client.from("tarefas_equipe")
        .update({ ...campos, atualizada_por: userId, atualizada_em: new Date().toISOString() })
        .eq("tenant_id", tenant).eq("id", id);
      if (soDoResponsavel) q = q.eq("responsavel_user_id", soDoResponsavel);
      const { data, error } = await q.select(TAREFA_COLUMNS).maybeSingle();
      if (error) throw new Error(error.message);
      return (data as unknown as Tarefa) ?? null;
    },

    async papelDoMembro(tenant, userId) {
      const { data, error } = await client.from("tenant_membros").select("papel")
        .eq("tenant_id", tenant).eq("user_id", userId).eq("ativo", true).maybeSingle();
      if (error) throw new Error(error.message);
      return (data?.papel as "admin" | "operacao" | undefined) ?? null;
    },
  };
}
