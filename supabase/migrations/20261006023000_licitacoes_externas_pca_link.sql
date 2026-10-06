-- LicitaGym: o coletor grava a compra em licitacoes_externas. O linker de PCA só lia
-- contratacoes_editais, tabela que o sync nacional não enche. Sem estas colunas o
-- vínculo auditável da compra coletada não tem onde ficar.
--
-- O que muda: pca_plano_id + pca_link_evidencia em licitacoes_externas; a view
-- pca_conversao_edital_item passa a contar também essa evidência. Ano aberto
-- continua na view; a API é que o tira da taxa. Job do linker em dry_run.
--
-- Quem lê: authenticated e service_role, como o resto de licitacoes_externas.
-- Quem escreve: service_role (link-pca-edital).
-- Verificar: supabase/tests/licitacoes_externas_pca_link_check.sql

begin;

set local lock_timeout = '10s';

alter table public.licitacoes_externas
  add column if not exists pca_plano_id uuid references public.pca_planos (id) on delete set null,
  add column if not exists pca_link_evidencia text;

comment on column public.licitacoes_externas.pca_plano_id is
  'Plano PCA do PNCP ligado por evidência determinística. NULL = sem vínculo. Não é o PAAC do Sistema S.';
comment on column public.licitacoes_externas.pca_link_evidencia is
  'Como pca_plano_id foi preenchido (codigo_item ou pdm_janela). NULL = sem vínculo auditável.';

create index if not exists licitacoes_externas_pca_plano_idx
  on public.licitacoes_externas (pca_plano_id)
  where pca_plano_id is not null;

create or replace view public.pca_conversao_edital_item
with (security_invoker = true) as
with cohort as (
  select i.id as pca_item_id,
         i.pca_plano_id,
         i.numero_item,
         i.codigo_item_origem,
         i.data_prevista_contratacao,
         i.classe_material_servico,
         p.orgao_cnpj,
         p.ano_exercicio,
         p.id_pca_pncp
    from public.pca_itens i
    join public.pca_planos p on p.id = i.pca_plano_id
   where i.ativo = true
     and p.ativo = true
     and i.classe_material_servico in ('7830', '7220')
),
evidencia as (
  select e.pca_plano_id,
         e.id as edital_id,
         e.numero_controle_pncp,
         e.data_publicacao,
         e.pca_link_evidencia,
         'contratacao_edital'::text as fonte_evidencia
    from public.contratacoes_editais e
   where e.ativo = true
     and e.pca_plano_id is not null
     and e.pca_link_evidencia is not null
  union all
  select l.pca_plano_id,
         null::uuid as edital_id,
         l.codigo_externo as numero_controle_pncp,
         l.data_publicacao,
         l.pca_link_evidencia,
         'licitacao_externa'::text as fonte_evidencia
    from public.licitacoes_externas l
   where l.pca_plano_id is not null
     and l.pca_link_evidencia is not null
),
uma as (
  select distinct on (pca_plano_id)
         pca_plano_id, edital_id, numero_controle_pncp, data_publicacao,
         pca_link_evidencia, fonte_evidencia
    from evidencia
   order by pca_plano_id, data_publicacao nulls last
)
select c.pca_item_id,
       c.pca_plano_id,
       c.id_pca_pncp,
       c.orgao_cnpj,
       c.ano_exercicio,
       c.classe_material_servico,
       c.codigo_item_origem,
       c.data_prevista_contratacao,
       u.edital_id,
       u.numero_controle_pncp,
       u.data_publicacao as edital_data_publicacao,
       u.pca_link_evidencia,
       (u.pca_plano_id is not null) as convertido_com_evidencia,
       case
         when u.data_publicacao is not null and c.data_prevista_contratacao is not null
           then (u.data_publicacao::date - c.data_prevista_contratacao)
       end as lag_prevista_vs_pub_dias,
       (select count(*)::int
          from public.pca_alteracoes a
         where a.pca_item_id = c.pca_item_id
           and a.tipo_operacao = 'update'
           and (u.data_publicacao is null or a.created_at <= u.data_publicacao)
       ) as n_updates_antes_pub,
       u.fonte_evidencia
  from cohort c
  left join uma u on u.pca_plano_id = c.pca_plano_id;

comment on view public.pca_conversao_edital_item is
  'Coorte PCA 7830/7220 com evidência em contratacoes_editais ou licitacoes_externas. Frequência histórica, não ML. Ano aberto não é “não converteu”: a API o exclui da taxa.';

alter view public.pca_conversao_edital_item set (security_invoker = true);
revoke all on table public.pca_conversao_edital_item from PUBLIC, anon, authenticated, service_role;
grant select on table public.pca_conversao_edital_item to authenticated, service_role;

-- Job depois do link-catmat-pca (04:23 BRT) e antes dos órgãos (04:43 BRT).
-- dry_run: a primeira agenda só reporta. Gravar é trocar o corpo do job.
do $cron$
begin
  if to_regnamespace('cron') is null
     or to_regprocedure('cron.schedule(text,text,text)') is null then
    raise notice 'pg_cron ausente: job licitagym-link-pca-edital não agendado.';
    return;
  end if;
  perform cron.unschedule(c.jobid)
    from cron.job c
   where c.jobname = 'licitagym-link-pca-edital';
  perform cron.schedule(
    'licitagym-link-pca-edital',
    '33 7 * * *',
    $cmd$select private.cron_chamar_edge('licitagym-link-pca-edital', 'link-pca-edital', '{"dry_run": true, "limite": 500}'::jsonb, 150000)$cmd$);
end
$cron$;

commit;
