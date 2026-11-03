-- Recuperado de supabase_migrations.schema_migrations em 2026-09-29 (aplicado no remoto sem arquivo no repo).
-- Nao reaplicar: versao ja registrada como aplicada.
-- Procedência: aplicada direto no projeto ifaiagegyicjzlpskafh via MCP (apply_migration) em 29/09/2026
-- 07:49:36 BRT (versão 20260929104936 = horário UTC), 1 statement. O corpo abaixo é byte a byte igual a
-- statements[1] de schema_migrations (md5 f235014dbf5ce5012551670408717826, conferido no banco no L0 de 29/09/2026 e
-- de novo depois do ab2af12, que não mexeu neste arquivo).
-- supabase db push e a integração GitHub pulam este arquivo: a versão já consta em schema_migrations.
-- Ajustes de permissão/índice deste objeto: 20260929145232_l3_permissoes_fornecedores_pdm.sql (migration nova).

create or replace view public.orgaos_compradores
with (security_invoker = true) as
with l as (
  select regexp_replace(coalesce(orgao_cnpj,''), '\D', '', 'g') as cnpj, *
  from public.licitacoes_externas
  where orgao_cnpj is not null or orgao_nome is not null
),
res as (
  select regexp_replace(coalesce(le.orgao_cnpj,''), '\D', '', 'g') as cnpj,
         count(distinct r.licitacao_id) as qtd_homologadas,
         count(distinct r.fornecedor_cnpj) as qtd_fornecedores_vencedores,
         coalesce(sum(r.valor_total_homologado),0) as valor_homologado
  from public.licitacao_resultados r
  join public.licitacoes_externas le on le.id = r.licitacao_id
  group by 1
),
por_mod as (
  select cnpj, jsonb_object_agg(modalidade, n) as modalidades
  from (select cnpj, coalesce(modalidade,'Não informada') modalidade, count(*) n from l group by 1,2) x
  group by cnpj
)
select
  coalesce(nullif(l.cnpj,''), 'sem-cnpj:' || md5(min(l.orgao_nome))) as id,
  nullif(l.cnpj,'') as cnpj,
  (array_agg(l.orgao_nome order by l.data_publicacao desc nulls last))[1] as nome,
  (array_agg(l.uf order by l.data_publicacao desc nulls last) filter (where l.uf is not null))[1] as uf,
  (array_agg(l.municipio order by l.data_publicacao desc nulls last) filter (where l.municipio is not null))[1] as municipio,
  array_agg(distinct l.unidade_compradora) filter (where l.unidade_compradora is not null) as unidades_compradoras,
  count(*) as qtd_licitacoes,
  coalesce(sum(l.valor_total),0) as valor_estimado_total,
  array_agg(distinct l.modalidade) filter (where l.modalidade is not null) as tipos_licitacao,
  array_agg(distinct l.fonte) as fontes,
  (array_agg(distinct l.objeto) filter (where l.objeto is not null))[1:5] as objetos,
  max(l.data_publicacao) as ultima_publicacao,
  min(l.data_publicacao) as primeira_publicacao,
  m.modalidades,
  coalesce(res.qtd_homologadas,0) as qtd_homologadas,
  coalesce(res.qtd_fornecedores_vencedores,0) as qtd_fornecedores_vencedores,
  coalesce(res.valor_homologado,0) as valor_homologado
from l
left join por_mod m on m.cnpj = l.cnpj
left join res on res.cnpj = l.cnpj and l.cnpj <> ''
group by l.cnpj, m.modalidades, res.qtd_homologadas, res.qtd_fornecedores_vencedores, res.valor_homologado;

revoke all on public.orgaos_compradores from anon, authenticated;
comment on view public.orgaos_compradores is 'Órgãos compradores agregados de licitacoes_externas + homologações. Leitura via Edge Function api-fornecedores-homologados (service_role).';