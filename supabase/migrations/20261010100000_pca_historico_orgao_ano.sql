-- LicitaGym: a rota /pca precisa responder, por órgão, o plano da classe 7830
-- e o que disso apareceu como compra. A lista crua de planos não separa
-- planejado, compra observada e execução confirmada.
--
-- O que muda: view public.pca_historico_orgao_ano, uma linha por CNPJ e ano
-- da classe 7830. Planejado é a soma dos itens (não do plano). Compra
-- observada é licitação já coletada do mesmo CNPJ, no ano da publicação, nas
-- categorias de produto do escopo. Execução confirmada só existe quando o
-- plano já tem pca_plano_id e pca_link_evidencia. Nada aqui grava vínculo.
--
-- Quem lê: service_role, via api-pncp-pca depois do login. authenticated não
-- recebe grant: a view lê licitacoes_externas, e essa tabela não é mais
-- legível direto pelo usuário. security_invoker para o service_role ver só
-- o que ele já pode ler nas tabelas.
-- Verificar: supabase/tests/pca_historico_orgao_ano_check.sql

begin;

set local lock_timeout = '10s';

create or replace view public.pca_historico_orgao_ano
with (security_invoker = true) as
with orgao as (
  select distinct on (regexp_replace(o.cnpj, '\D', '', 'g'))
         regexp_replace(o.cnpj, '\D', '', 'g') as cnpj,
         coalesce(nullif(btrim(o.uf), ''), 'sem_uf') as uf,
         coalesce(o.nome_orgao, o.razao_social) as nome
    from public.orgaos o
   where o.ativo
     and nullif(regexp_replace(o.cnpj, '\D', '', 'g'), '') is not null
   order by regexp_replace(o.cnpj, '\D', '', 'g'), (o.uf is null), o.uf
),
planejado as (
  select regexp_replace(p.orgao_cnpj, '\D', '', 'g') as cnpj,
         p.ano_exercicio,
         count(distinct p.id)::int as planos,
         count(i.id)::int as itens,
         (count(i.id) filter (where i.valor_total_estimado is not null))::int as itens_com_valor,
         sum(i.valor_total_estimado) filter (where i.valor_total_estimado is not null) as valor_planejado,
         coalesce(
           array_agg(distinct p.unidade_codigo)
             filter (where nullif(btrim(p.unidade_codigo), '') is not null),
           '{}'::text[]
         ) as unidades
    from public.pca_itens i
    join public.pca_planos p on p.id = i.pca_plano_id
   where i.ativo
     and p.ativo
     and i.classe_material_servico = '7830'
     and nullif(regexp_replace(p.orgao_cnpj, '\D', '', 'g'), '') is not null
   group by 1, 2
),
evidencia as (
  select e.pca_plano_id, e.data_publicacao
    from public.contratacoes_editais e
   where e.ativo
     and e.pca_plano_id is not null
     and e.pca_link_evidencia is not null
  union all
  select l.pca_plano_id, l.data_publicacao
    from public.licitacoes_externas l
   where l.pca_plano_id is not null
     and l.pca_link_evidencia is not null
),
uma as (
  select distinct on (pca_plano_id)
         pca_plano_id,
         data_publicacao
    from evidencia
   order by pca_plano_id, data_publicacao nulls last
),
confirmado as (
  select regexp_replace(p.orgao_cnpj, '\D', '', 'g') as cnpj,
         p.ano_exercicio,
         count(distinct p.id)::int as execucoes_confirmadas,
         avg(((u.data_publicacao at time zone 'utc')::date - i.data_prevista_contratacao))
           filter (
             where u.data_publicacao is not null
               and i.data_prevista_contratacao is not null
           ) as lag_medio_dias
    from public.pca_itens i
    join public.pca_planos p on p.id = i.pca_plano_id
    join uma u on u.pca_plano_id = p.id
   where i.ativo
     and p.ativo
     and i.classe_material_servico = '7830'
   group by 1, 2
),
compras as (
  select regexp_replace(l.orgao_cnpj, '\D', '', 'g') as cnpj,
         extract(year from (l.data_publicacao at time zone 'utc'))::int as ano,
         count(*)::int as compras_observadas,
         sum(l.valor_total) filter (where l.valor_total is not null) as valor_observado
    from public.licitacoes_externas l
   where l.data_publicacao is not null
     and nullif(regexp_replace(l.orgao_cnpj, '\D', '', 'g'), '') is not null
     and l.objeto_categoria in (
       'academia_ar_livre',
       'equipamento_musculacao',
       'equipamento_fisioterapia',
       'piso_esportivo',
       'playground',
       'material_esportivo'
     )
   group by 1, 2
)
select pl.cnpj as orgao_cnpj,
       og.nome as orgao_nome,
       coalesce(og.uf, 'sem_uf') as uf,
       pl.ano_exercicio,
       '7830'::text as classe_material_servico,
       pl.planos,
       pl.itens,
       pl.itens_com_valor,
       (pl.itens - pl.itens_com_valor) as itens_sem_valor,
       pl.valor_planejado,
       pl.unidades,
       coalesce(c.compras_observadas, 0) as compras_observadas,
       c.valor_observado,
       coalesce(cf.execucoes_confirmadas, 0) as execucoes_confirmadas,
       cf.lag_medio_dias
  from planejado pl
  left join orgao og on og.cnpj = pl.cnpj
  left join compras c on c.cnpj = pl.cnpj and c.ano = pl.ano_exercicio
  left join confirmado cf on cf.cnpj = pl.cnpj and cf.ano_exercicio = pl.ano_exercicio;

comment on view public.pca_historico_orgao_ano is
  'Classe 7830 por CNPJ e ano. valor_planejado soma itens, não o plano. compras_observadas é licitação do escopo no mesmo CNPJ e ano, não execução. execucoes_confirmadas exige pca_link_evidencia. Prazo só quando a data prevista e a publicação existem.';

alter view public.pca_historico_orgao_ano set (security_invoker = true);

revoke all on table public.pca_historico_orgao_ano from PUBLIC, anon, authenticated, service_role;
grant select on table public.pca_historico_orgao_ano to service_role;

commit;
