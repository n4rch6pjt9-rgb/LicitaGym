-- Etapas do pipeline editáveis (spec 0034, K-5 a K-7): reordenar a lista inteira numa transação, com controle de
-- versão, e criar etapa dentro do mesmo lock por tenant de pipeline_mover e pipeline_etapa_excluir.
--
-- O que cria (só funções; nenhuma tabela, coluna ou dado muda):
--   1) pipeline_etapas_versao(tenant)   md5 de id, ordem e updated_at de todas as etapas do tenant. Muda quando
--                                       uma etapa é reordenada, editada, criada ou excluída.
--   2) pipeline_etapas_listar(tenant)   as etapas (com total de oportunidades) e a versão no mesmo comando.
--   3) pipeline_etapas_reordenar(...)   lista completa na ordem nova; ordem = posição × 10. Erros:
--                                       LG002 versao_desatualizada (a lista mudou desde a leitura) e, só com a versão
--                                       certa, LG001 lista_invalida (id repetido, faltando, de outro tenant).
--   4) pipeline_etapa_criar(...)        põe a etapa no fim (maior ordem + 10), dentro do lock.
-- Quem executa: só service_role (Edge Function api-pipeline; o JWT do usuário identifica e autoriza).
-- Verificação: supabase/tests/pipeline_etapas_reordenar_check.sql. Volta: drop das 4 funções.

begin;

set local lock_timeout = '10s';

-- 1) Versão da lista. updated_at em UTC, para o texto não depender do TimeZone da sessão.
create or replace function public.pipeline_etapas_versao(p_tenant bigint)
returns text
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  select md5(coalesce(
    string_agg(e.id::text || ':' || e.ordem::text || ':' || (e.updated_at at time zone 'UTC')::text, ',' order by e.id),
    ''))
    from public.pipeline_etapas e
   where e.tenant_id = p_tenant
$$;

-- 2) Etapas e versão num só comando (mesmo snapshot): a versão descreve exatamente as linhas devolvidas.
create or replace function public.pipeline_etapas_listar(p_tenant bigint)
returns table (
  id bigint, nome text, fase text, ordem integer, desfecho text, exige_motivo boolean, padrao boolean,
  total bigint, versao text
)
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  with v as (select public.pipeline_etapas_versao(p_tenant) as versao),
       c as (select po.etapa_id, count(*) as total
               from public.pipeline_oportunidades po
              where po.tenant_id = p_tenant
              group by po.etapa_id)
  select e.id, e.nome, e.fase, e.ordem, e.desfecho, e.exige_motivo, e.padrao, coalesce(c.total, 0), v.versao
    from public.pipeline_etapas e
    cross join v
    left join c on c.etapa_id = e.id
   where e.tenant_id = p_tenant
   order by e.ordem, e.id
$$;

-- 3) Reordenar. Primeiro a versão (409), depois a lista (400): uma etapa criada ou excluída por outra pessoa dá
-- versão velha, não lista inválida. Só grava as linhas cuja ordem muda.
create or replace function public.pipeline_etapas_reordenar(
  p_tenant bigint,
  p_ids    bigint[],
  p_versao text,
  p_user   uuid
)
returns table (
  id bigint, nome text, fase text, ordem integer, desfecho text, exige_motivo boolean, padrao boolean,
  total bigint, versao text
)
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
#variable_conflict use_column
begin
  if p_user is null then
    raise exception 'pipeline_etapas_reordenar: usuário obrigatório' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('pipeline:' || p_tenant::text, 0));

  if p_versao is distinct from public.pipeline_etapas_versao(p_tenant) then
    raise exception 'pipeline_etapas_reordenar: A ordem das etapas mudou desde a leitura. Recarregue a lista.'
      using errcode = 'LG002';
  end if;

  if p_ids is null
     or cardinality(p_ids) = 0
     or cardinality(p_ids) <> (select count(distinct x) from unnest(p_ids) as u (x))
     or exists (select 1 from unnest(p_ids) as u (x)
                 where not exists (select 1 from public.pipeline_etapas e where e.id = u.x and e.tenant_id = p_tenant))
     or cardinality(p_ids) <> (select count(*) from public.pipeline_etapas e where e.tenant_id = p_tenant) then
    raise exception 'pipeline_etapas_reordenar: A lista deve trazer todas as etapas da empresa, uma vez cada.'
      using errcode = 'LG001';
  end if;

  update public.pipeline_etapas e
     set ordem = (n.pos * 10)::integer, updated_at = now(), updated_by = p_user
    from unnest(p_ids) with ordinality as n (etapa_id, pos)
   where e.tenant_id = p_tenant
     and e.id = n.etapa_id
     and e.ordem <> (n.pos * 10)::integer;

  return query select * from public.pipeline_etapas_listar(p_tenant);
end
$$;

-- 4) Criar no fim. O nome chega normalizado da api-pipeline; repetido continua 23505 (pipeline_etapas_tenant_nome_key).
create or replace function public.pipeline_etapa_criar(
  p_tenant       bigint,
  p_nome         text,
  p_fase         text,
  p_desfecho     text,
  p_exige_motivo boolean,
  p_user         uuid
)
returns table (id bigint, nome text, fase text, ordem integer, desfecho text, exige_motivo boolean, padrao boolean)
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
#variable_conflict use_column
begin
  if p_user is null then
    raise exception 'pipeline_etapa_criar: usuário obrigatório' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('pipeline:' || p_tenant::text, 0));

  return query
  insert into public.pipeline_etapas (tenant_id, nome, fase, ordem, desfecho, exige_motivo, updated_by)
  values (
    p_tenant, p_nome, p_fase,
    coalesce((select max(e.ordem) from public.pipeline_etapas e where e.tenant_id = p_tenant), 0) + 10,
    p_desfecho, coalesce(p_exige_motivo, false), p_user
  )
  returning id, nome, fase, ordem, desfecho, exige_motivo, padrao;
end
$$;

-- 5) ACL (padrão de pipeline_mover: só service_role) --------------------------------------------------------------
revoke execute on function public.pipeline_etapas_versao(bigint) from PUBLIC, anon, authenticated;
revoke execute on function public.pipeline_etapas_listar(bigint) from PUBLIC, anon, authenticated;
revoke execute on function public.pipeline_etapas_reordenar(bigint, bigint[], text, uuid) from PUBLIC, anon, authenticated;
revoke execute on function public.pipeline_etapa_criar(bigint, text, text, text, boolean, uuid) from PUBLIC, anon, authenticated;
grant execute on function public.pipeline_etapas_versao(bigint) to service_role;
grant execute on function public.pipeline_etapas_listar(bigint) to service_role;
grant execute on function public.pipeline_etapas_reordenar(bigint, bigint[], text, uuid) to service_role;
grant execute on function public.pipeline_etapa_criar(bigint, text, text, text, boolean, uuid) to service_role;

commit;
