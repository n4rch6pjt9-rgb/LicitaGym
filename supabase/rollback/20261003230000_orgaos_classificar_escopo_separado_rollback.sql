-- Volta ao estado anterior a 20261003230000_orgaos_classificar_escopo_separado.
-- Restaura o job único licitagym-orgaos-classificar-escopo (05:03 BRT, classificação e match
-- na mesma transação, statement_timeout 10 min), a MV que chama fn_escopo_item em cada linha,
-- e fn_escopo_match_atualizar() só com REFRESH + match_nivel.
-- A MV é recriada WITH NO DATA: o próximo run do job antigo é que a popula de novo
-- (o refresh completo voltou a custar cerca de 14 min em produção; não rode este script
-- esperando que ele recalcule a demanda).
-- Rode como postgres, numa janela em que o job novo não esteja no meio. Idempotente no cron
-- (unschedule pelo nome + schedule). Sem pg_cron, o bloco de agenda só avisa.

begin;

set local lock_timeout = '10s';
set local statement_timeout = '15min';

do $cron$
declare
  r record;
begin
  if to_regnamespace('cron') is null
     or to_regprocedure('cron.schedule(text,text,text)') is null then
    raise notice 'pg_cron ausente: agenda não restaurada.';
    return;
  end if;
  for r in
    select c.jobid
      from cron.job c
     where c.jobname in (
       'licitagym-orgaos-classificar-escopo',
       'licitagym-orgaos-classificar',
       'licitagym-escopo-match')
  loop
    perform cron.unschedule(r.jobid);
  end loop;
  perform cron.schedule(
    'licitagym-orgaos-classificar-escopo',
    '3 8 * * *',
    $cmd$set local statement_timeout = '10min'; select public.fn_orgaos_uasgs_classificar(); select public.fn_escopo_match_atualizar()$cmd$);
end
$cron$;

create or replace function public.fn_escopo_match_atualizar(out orgaos_com_match integer, out uasgs_com_match integer)
language plpgsql
volatile
set search_path = pg_catalog, public
as $fn$
begin
  refresh materialized view public.mv_escopo_demanda;
  with m as (
    select orgao_cnpj,
           case when bool_or(fonte in ('licitacao','edital') and processos_nucleo > 0) then 'comprou'
                when bool_or(fonte = 'pca') then 'planeja'
                when bool_or(fonte = 'licitacao' and itens_adjacentes > 0) then 'adjacente' end as nivel
      from public.mv_escopo_demanda group by orgao_cnpj)
  update public.orgaos o set match_nivel = m.nivel, match_atualizado_em = now()
    from (select o2.id, m.nivel from public.orgaos o2
            left join m on m.orgao_cnpj = regexp_replace(o2.cnpj, '[^0-9]', '', 'g')) m
   where o.id = m.id and o.match_nivel is distinct from m.nivel;
  select count(*) into orgaos_com_match from public.orgaos where match_nivel is not null;

  with m as (
    select orgao_cnpj, unidade_codigo,
           case when bool_or(fonte = 'licitacao' and processos_nucleo > 0) then 'comprou'
                when bool_or(fonte = 'pca') then 'planeja'
                when bool_or(fonte = 'licitacao' and itens_adjacentes > 0) then 'adjacente' end as nivel
      from public.mv_escopo_demanda where unidade_codigo is not null group by orgao_cnpj, unidade_codigo)
  update public.uasgs u set match_nivel = m.nivel, match_atualizado_em = now()
    from (select u2.id,
                 (array_agg(m.nivel order by array_position(array['comprou','planeja','adjacente'], m.nivel))
                    filter (where m.nivel is not null))[1] as nivel
            from public.uasgs u2
            left join m on m.unidade_codigo = u2.codigo_uasg
                       and m.orgao_cnpj in (u2.cnpj_cpf_orgao_norm, u2.cnpj_cpf_orgao_vinculado_norm)
           group by u2.id) m
   where u.id = m.id and u.match_nivel is distinct from m.nivel;
  select count(*) into uasgs_com_match from public.uasgs where match_nivel is not null;
end
$fn$;

revoke all on function public.fn_escopo_match_atualizar() from PUBLIC, anon, authenticated, service_role;

drop function if exists public.fn_escopo_calc_sincronizar();

drop view if exists public.v_orgao_match_projeto;
drop materialized view if exists public.mv_escopo_demanda;

create materialized view public.mv_escopo_demanda as
with it as (
  select l.id as licitacao_id, l.orgao_cnpj,
         case when l.raw->>'unidade_codigo' ~ '^\d{6}$' then l.raw->>'unidade_codigo' end as unidade_codigo,
         coalesce(l.data_publicacao, l.data_inicio) as data_pub,
         i.valor_total_estimado, e.nivel,
         r.homologado, r.data_res
    from public.licitacoes_externas l
    join public.licitacao_itens i on i.licitacao_id = l.id
    cross join lateral public.fn_escopo_item(i.descricao) e
    left join lateral (select sum(x.valor_total_homologado) as homologado, max(x.data_resultado) as data_res
                         from public.licitacao_resultados x
                        where x.licitacao_id = i.licitacao_id and x.numero_item = i.numero_item) r on true
   where e.nivel is not null and l.orgao_cnpj ~ '^\d{14}$'
), ed as (
  select c.orgao_cnpj, null::text as unidade_codigo, c.valor_estimado, c.data_publicacao, e.nivel
    from public.contratacoes_editais c
    cross join lateral public.fn_escopo_item(coalesce(c.objeto, '') || ' ' || coalesce(c.descricao, '')) e
   where e.nivel is not null and c.orgao_cnpj ~ '^\d{14}$'
), pca as (
  select p.orgao_cnpj, p.unidade_codigo, i.valor_total_estimado, p.data_publicacao, public.fn_escopo_pca(i.descricao) as k
    from public.pca_itens i join public.pca_planos p on p.id = i.pca_plano_id
   where i.codigo_classe_catmat = 7830 and coalesce(i.ativo, true) and coalesce(p.ativo, true)
)
select orgao_cnpj, unidade_codigo, 'licitacao'::text as fonte,
       count(distinct licitacao_id) filter (where nivel = 'nucleo') as processos_nucleo,
       count(distinct licitacao_id) as processos,
       count(*) filter (where nivel = 'nucleo') as itens_nucleo,
       count(*) filter (where nivel = 'adjacente') as itens_adjacentes,
       sum(valor_total_estimado) as valor_estimado,
       sum(homologado) as valor_homologado,
       max(data_pub) as ultima_publicacao,
       max(data_res) as ultimo_resultado
  from it group by orgao_cnpj, unidade_codigo
union all
select orgao_cnpj, unidade_codigo, 'edital', count(*) filter (where nivel = 'nucleo'), count(*),
       null::bigint, null::bigint, sum(valor_estimado), null::numeric, max(data_publicacao), null::timestamptz
  from ed group by orgao_cnpj, unidade_codigo
union all
select orgao_cnpj, unidade_codigo, 'pca', null::bigint, null::bigint,
       count(*) filter (where k in ('escopo','vazio')), null::bigint,
       sum(valor_total_estimado) filter (where k in ('escopo','vazio')), null::numeric,
       max(data_publicacao)::timestamptz, null::timestamptz
  from pca group by orgao_cnpj, unidade_codigo
having count(*) filter (where k in ('escopo','vazio')) > 0
with no data;

create unique index mv_escopo_demanda_key
  on public.mv_escopo_demanda (orgao_cnpj, coalesce(unidade_codigo, ''), fonte);

create or replace view public.v_orgao_match_projeto with (security_invoker = true) as
select d.orgao_cnpj,
       t.id as orgao_id, coalesce(t.nome_orgao, t.razao_social) as orgao_nome, t.tipo_orgao, t.grupo_tipo, t.esfera_canon, t.poder_canon, t.uf,
       sum(d.processos_nucleo) filter (where d.fonte = 'licitacao') as licitacoes_nucleo,
       sum(d.itens_nucleo)     filter (where d.fonte = 'licitacao') as itens_nucleo,
       sum(d.itens_adjacentes) filter (where d.fonte = 'licitacao') as itens_adjacentes,
       sum(d.valor_estimado)   filter (where d.fonte = 'licitacao') as valor_estimado_itens,
       sum(d.valor_homologado) filter (where d.fonte = 'licitacao') as valor_homologado_itens,
       sum(d.processos_nucleo) filter (where d.fonte = 'edital')    as editais_nucleo,
       sum(d.valor_estimado)   filter (where d.fonte = 'edital')    as valor_editais,
       sum(d.itens_nucleo)     filter (where d.fonte = 'pca')       as itens_pca_7830,
       sum(d.valor_estimado)   filter (where d.fonte = 'pca')       as valor_pca_7830,
       max(d.ultima_publicacao) filter (where d.fonte in ('licitacao','edital')) as ultima_compra_publicada,
       max(d.ultimo_resultado) as ultimo_resultado
  from public.mv_escopo_demanda d
  left join public.v_orgao_titular_cnpj t on t.cnpj14 = d.orgao_cnpj
 group by d.orgao_cnpj, t.id, t.nome_orgao, t.razao_social, t.tipo_orgao, t.grupo_tipo, t.esfera_canon, t.poder_canon, t.uf;

revoke all on table public.mv_escopo_demanda, public.v_orgao_match_projeto
  from PUBLIC, anon, authenticated, service_role;
grant select on table public.mv_escopo_demanda, public.v_orgao_match_projeto to service_role;

drop index if exists public.licitacao_itens_escopo_norm_trgm_idx;
drop table if exists public.escopo_item_calc;

commit;
