-- LicitaGym: contagem de tarefas abertas por card do pipeline (spec 0018, PR 5a; seção 5: "Cartão do Kanban mostra
-- N tarefas abertas"; a lista fica na Dashboard #72 / api-tarefas).
--
-- O que muda:
--   public.pipeline_tarefas_abertas(tenant, licitações)  conta, por licitação, as tarefas da empresa em 'aberta' ou
--                                                         'em_andamento' (tarefas_equipe). Contar no banco evita trazer
--                                                         as linhas e esbarrar no max_rows do PostgREST.
-- Quem lê: api-pipeline (pipeline_listar), com o tenant de quem chama. Só service_role executa.
-- Sem limite próprio de p_licitacoes: quem chama limita (api-pipeline manda até 1000, LIMITE_LISTA).
-- Verificar: supabase/tests/pipeline_tarefas_abertas_check.sql. Idempotente.

begin;

create or replace function public.pipeline_tarefas_abertas(p_tenant bigint, p_licitacoes bigint[])
returns table (licitacao_id bigint, abertas integer)
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  select t.licitacao_id, count(*)::integer
    from public.tarefas_equipe t
   where t.tenant_id = p_tenant
     and t.licitacao_id = any (p_licitacoes)
     and t.status in ('aberta', 'em_andamento')
   group by t.licitacao_id
$$;

revoke all on function public.pipeline_tarefas_abertas(bigint, bigint[]) from PUBLIC, anon, authenticated;
grant execute on function public.pipeline_tarefas_abertas(bigint, bigint[]) to service_role;

commit;
