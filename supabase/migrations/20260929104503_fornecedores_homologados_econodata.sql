-- Recuperado de supabase_migrations.schema_migrations em 2026-09-29 (aplicado no remoto sem arquivo no repo).
-- Nao reaplicar: versao ja registrada como aplicada.
-- Procedência: aplicada direto no projeto ifaiagegyicjzlpskafh via MCP (apply_migration) em 29/09/2026
-- 07:45:03 BRT (versão 20260929104503 = horário UTC), 1 statement. O corpo abaixo é byte a byte igual a
-- statements[1] de schema_migrations (md5 006aa8d1784abbd0a068bdacf77bea30, conferido no banco no L0 de 29/09/2026).
-- supabase db push e a integração GitHub pulam este arquivo: a versão já consta em schema_migrations.
-- Ajustes de permissão/índice deste objeto: 20260929145232_l3_permissoes_fornecedores_pdm.sql (migration nova).

-- Enriquecimento Econodata no cadastro de fornecedores
alter table public.fornecedores
  add column if not exists econodata jsonb,
  add column if not exists econodata_consultado_em timestamptz,
  add column if not exists econodata_tokens integer,
  add column if not exists recebimentos_governo numeric,
  add column if not exists porte_econodata text,
  add column if not exists socios jsonb,
  add column if not exists emails_publicos jsonb,
  add column if not exists filiais_qtd integer,
  add column if not exists ufs_atuacao text[];

comment on column public.fornecedores.econodata is 'Resposta bruta Econodata API v4 (buckets cadastro, perfilNegocio, contatosBasicos). Escrita só service_role (Edge Function api-fornecedores-homologados).';

-- Log de chamadas pagas à Econodata (auditoria de tokens)
create table if not exists public.econodata_consultas (
  id bigint generated always as identity primary key,
  cnpjs text[] not null,
  incluir text[] not null,
  estimativa boolean not null default false,
  status_http integer,
  tokens_cobrados integer,
  tokens_estimados integer,
  erro text,
  usuario_id uuid,
  created_at timestamptz not null default now()
);
alter table public.econodata_consultas enable row level security;
revoke all on public.econodata_consultas from anon, authenticated;
comment on table public.econodata_consultas is 'Auditoria de chamadas à API Econodata. Acesso só service_role.';

-- Base agregada de fornecedores homologados (vencedores por item em licitacao_resultados)
create or replace view public.fornecedores_homologados
with (security_invoker = true) as
with r as (
  select regexp_replace(r.fornecedor_cnpj, '\D', '', 'g') as cnpj,
         r.fornecedor_nome, r.porte_fornecedor, r.licitacao_id, r.numero_item,
         r.valor_total_homologado, r.data_resultado, r.marca_normalizada, r.marca,
         l.modalidade, l.objeto, l.uf, l.orgao_cnpj, l.orgao_nome, l.categoria_escopo
  from public.licitacao_resultados r
  join public.licitacoes_externas l on l.id = r.licitacao_id
  where r.fornecedor_cnpj is not null
),
por_mod as (
  select cnpj, jsonb_object_agg(modalidade, n) as modalidades
  from (select cnpj, coalesce(modalidade,'Não informada') modalidade, count(distinct licitacao_id) n from r group by 1,2) x
  group by cnpj
),
agg as (
  select cnpj,
    (array_agg(fornecedor_nome order by data_resultado desc nulls last))[1] as nome_pncp,
    (array_agg(porte_fornecedor order by data_resultado desc nulls last))[1] as porte_pncp,
    count(distinct licitacao_id) as qtd_editais,
    count(*) as qtd_itens,
    coalesce(sum(valor_total_homologado),0) as valor_total_homologado,
    count(distinct orgao_cnpj) as qtd_orgaos,
    array_agg(distinct uf) filter (where uf is not null) as ufs_vitoria,
    array_agg(distinct modalidade) filter (where modalidade is not null) as tipos_licitacao,
    array_agg(distinct categoria_escopo) filter (where categoria_escopo is not null) as categorias,
    array_agg(distinct coalesce(marca_normalizada, marca)) filter (where coalesce(marca_normalizada, marca) is not null) as marcas,
    (array_agg(distinct objeto) filter (where objeto is not null))[1:5] as objetos,
    min(data_resultado) as primeira_homologacao,
    max(data_resultado) as ultima_homologacao
  from r group by cnpj
)
select a.*, round(a.valor_total_homologado / nullif(a.qtd_editais,0), 2) as ticket_medio_edital,
  m.modalidades,
  f.razao_social, f.nome_fantasia, f.porte_econodata, f.porte, f.cnae_principal, f.cnae_principal_descricao,
  f.uf as uf_sede, f.municipio as municipio_sede, f.data_inicio_atividade, f.capital_social,
  f.recebimentos_governo, f.filiais_qtd, f.situacao_cadastral,
  f.econodata_consultado_em, (f.econodata is not null) as enriquecido
from agg a
left join por_mod m using (cnpj)
left join public.fornecedores f on f.cnpj = a.cnpj;

revoke all on public.fornecedores_homologados from anon, authenticated;
comment on view public.fornecedores_homologados is 'Fornecedores homologados/vencedores agregados por CNPJ (licitacao_resultados × licitacoes_externas) + enriquecimento Econodata. Leitura via Edge Function api-fornecedores-homologados (service_role).';

create index if not exists licitacao_resultados_fornecedor_cnpj_idx on public.licitacao_resultados (fornecedor_cnpj);
