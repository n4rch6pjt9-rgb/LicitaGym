-- =============================================================================
-- Migration: 20261002100000_bi_cruzamento_apis.sql
-- Cruzamento de APIs oficiais para o BI do LicitaGym:
-- 1. pca_pgc_itens (PCA do módulo PGC Compras.gov)
-- 2. precos_praticados_itens (módulo Pesquisa de Preço Compras.gov)
-- 3. atas_rp_itens (módulo ARP Compras.gov)
-- 4. resultados_itens_14133 (módulo Contratações 14.133 Compras.gov)
-- 5. Colunas adicionais em contratacoes_atas (ni_fornecedor, etc.)
-- 6. Views de BI:
--    - v_bi_pca_radar
--    - v_bi_precos_praticados
--    - v_bi_atas_vencendo
--    - v_bi_orgaos_match
--    - v_bi_fornecedor_historico
--
-- Segurança & ACL:
-- - RLS ligado em todas as tabelas novas.
-- - Sem grant para anon em nenhuma tabela ou view.
-- - Tabelas novas: authenticated com SELECT, escrita apenas service_role.
-- - Views de BI: security_invoker = true, sem grant para anon nem authenticated;
--   acesso apenas service_role (via Edge Functions dedicadas).
-- =============================================================================

begin;

set local lock_timeout = '10s';

-- -----------------------------------------------------------------------------
-- 1. pca_pgc_itens (Compras.gov - PGC Detalhe Catálogo)
-- -----------------------------------------------------------------------------
create table if not exists public.pca_pgc_itens (
  id bigint generated always as identity primary key,
  codigo_uasg text not null,
  nome_uasg text,
  orgao_cnpj text not null,
  numero_artefato integer,
  ano_artefato integer,
  codigo_estado_artefato integer,
  codigo_categoria_artefato integer,
  descricao_artefato text,
  codigo_tipo_artefato integer,
  ordem_dfd integer,
  descricao_objeto_dfd text,
  nivel_prioridade_dfd text,
  data_prevista_formalizacao_demanda date,
  codigo_area_dfd integer,
  tipo_item text,
  item_sustentavel boolean,
  codigo_grupo_material integer,
  nome_grupo_material text,
  codigo_classe_material integer,
  nome_classe_material text,
  codigo_pdm_material text,
  nome_pdm_material text,
  codigo_item_catalogo integer,
  descricao_item_catalogo text,
  sigla_unidade_fornecimento text,
  nome_unidade_fornecimento text,
  quantidade_item numeric,
  valor_unitario_item numeric(18,4),
  valor_total_item numeric(18,4),
  titulo_projeto_compra text,
  descricao_projeto_compra text,
  ano_pca_projeto_compra integer not null,
  data_inicio_processo_compra date,
  data_fim_processo_compra date,
  duracao_processo_compra integer,
  numero_item_pncp integer,
  status_contratacao_execucao text,
  data_hora_publicacao_pncp timestamptz,
  data_hora_atualizacao_item timestamptz,
  raw jsonb,
  payload_hash text,
  last_synced_at timestamptz default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint uq_pca_pgc_item unique (orgao_cnpj, codigo_uasg, ano_pca_projeto_compra, numero_item_pncp, codigo_item_catalogo)
);

create index if not exists idx_pca_pgc_classe on public.pca_pgc_itens (codigo_classe_material);
create index if not exists idx_pca_pgc_pdm on public.pca_pgc_itens (codigo_pdm_material);
create index if not exists idx_pca_pgc_item on public.pca_pgc_itens (codigo_item_catalogo);
create index if not exists idx_pca_pgc_orgao on public.pca_pgc_itens (orgao_cnpj);
create index if not exists idx_pca_pgc_ano on public.pca_pgc_itens (ano_pca_projeto_compra);

alter table public.pca_pgc_itens enable row level security;
drop policy if exists pca_pgc_itens_select on public.pca_pgc_itens;
create policy pca_pgc_itens_select on public.pca_pgc_itens for select to authenticated using (true);

revoke all on table public.pca_pgc_itens from anon, authenticated, PUBLIC;
grant select on table public.pca_pgc_itens to authenticated;
grant all on table public.pca_pgc_itens to service_role;

revoke all on sequence public.pca_pgc_itens_id_seq from anon, authenticated, PUBLIC;
grant all on sequence public.pca_pgc_itens_id_seq to service_role;

comment on table public.pca_pgc_itens is 'Itens do Plano de Contratações Anual do Compras.gov (módulo PGC Detalhe Catálogo). Escrita só service_role; leitura authenticated.';

-- -----------------------------------------------------------------------------
-- 2. precos_praticados_itens (Compras.gov - Pesquisa de Preço)
-- -----------------------------------------------------------------------------
create table if not exists public.precos_praticados_itens (
  id_compra text not null,
  id_item_compra bigint not null,
  numero_item_compra integer,
  codigo_item_catalogo integer,
  data_compra date,
  forma text,
  modalidade integer,
  criterio_julgamento text,
  objeto_compra text,
  data_hora_atualizacao_compra timestamptz,
  quantidade numeric,
  preco_unitario numeric(18,4),
  percentual_maior_desconto numeric,
  descricao_item text,
  descricao_detalhada_item text,
  marca text,
  fabricante text,
  modelo text,
  data_resultado date,
  data_hora_atualizacao_item timestamptz,
  sigla_unidade_fornecimento text,
  nome_unidade_fornecimento text,
  capacidade_unidade_fornecimento numeric,
  sigla_unidade_medida text,
  nome_unidade_medida text,
  ni_fornecedor text,
  nome_fornecedor text,
  codigo_uasg text,
  nome_uasg text,
  codigo_orgao integer,
  nome_orgao text,
  estado text,
  codigo_municipio integer,
  municipio text,
  poder text,
  esfera text,
  data_hora_atualizacao_uasg timestamptz,
  codigo_classe integer,
  nome_classe text,
  codigo_pdm text,
  nome_pdm text,
  id_compra_item text,
  data_atualizacao_fato timestamptz,
  detalhe_sincronizado_em timestamptz,
  raw jsonb,
  payload_hash text,
  last_synced_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (id_compra, id_item_compra)
);

create index if not exists precos_praticados_catalogo_idx on public.precos_praticados_itens (codigo_item_catalogo);
create index if not exists precos_praticados_pdm_idx on public.precos_praticados_itens (codigo_pdm);
create index if not exists precos_praticados_classe_idx on public.precos_praticados_itens (codigo_classe);
create index if not exists precos_praticados_data_idx on public.precos_praticados_itens (data_resultado desc);
create index if not exists precos_praticados_fornecedor_idx on public.precos_praticados_itens (ni_fornecedor);

alter table public.precos_praticados_itens enable row level security;
drop policy if exists precos_praticados_itens_select on public.precos_praticados_itens;
create policy precos_praticados_itens_select on public.precos_praticados_itens for select to authenticated using (true);

revoke all on table public.precos_praticados_itens from anon, authenticated, PUBLIC;
grant select on table public.precos_praticados_itens to authenticated;
grant all on table public.precos_praticados_itens to service_role;

comment on table public.precos_praticados_itens is 'Preços efetivamente praticados (homologados) do módulo 03 Pesquisa de Preço do Compras.gov. Escrita só service_role; leitura authenticated.';

-- -----------------------------------------------------------------------------
-- 3. atas_rp_itens (Compras.gov - Módulo ARP)
-- -----------------------------------------------------------------------------
create table if not exists public.atas_rp_itens (
  id bigint generated always as identity primary key,
  numero_ata_registro_preco text not null,
  codigo_unidade_gerenciadora integer,
  nome_unidade_gerenciadora text,
  numero_compra text,
  ano_compra integer,
  codigo_modalidade_compra text,
  nome_modalidade_compra text,
  data_assinatura timestamptz,
  data_vigencia_inicial date,
  data_vigencia_final date,
  numero_item text not null,
  codigo_item integer,
  codigo_pdm text,
  nome_pdm text,
  descricao_item text,
  tipo_item text,
  quantidade_homologada_item numeric,
  classificacao_fornecedor text,
  ni_fornecedor text,
  nome_fornecedor text,
  marca text,
  fabricante text,
  modelo text,
  quantidade_homologada_vencedor numeric,
  valor_unitario numeric(18,4),
  valor_total numeric(18,4),
  maximo_adesao numeric,
  quantidade_empenhada numeric,
  percentual_maior_desconto numeric,
  id_compra text,
  numero_controle_pncp_compra text,
  numero_controle_pncp_ata text,
  raw jsonb,
  payload_hash text,
  last_synced_at timestamptz default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint uq_atas_rp_itens unique (numero_ata_registro_preco, codigo_unidade_gerenciadora, numero_item)
);

create index if not exists idx_atas_rp_pdm on public.atas_rp_itens (codigo_pdm);
create index if not exists idx_atas_rp_item on public.atas_rp_itens (codigo_item);
create index if not exists idx_atas_rp_fornecedor on public.atas_rp_itens (ni_fornecedor);
create index if not exists idx_atas_rp_vigencia on public.atas_rp_itens (data_vigencia_final);

alter table public.atas_rp_itens enable row level security;
drop policy if exists atas_rp_itens_select on public.atas_rp_itens;
create policy atas_rp_itens_select on public.atas_rp_itens for select to authenticated using (true);

revoke all on table public.atas_rp_itens from anon, authenticated, PUBLIC;
grant select on table public.atas_rp_itens to authenticated;
grant all on table public.atas_rp_itens to service_role;

revoke all on sequence public.atas_rp_itens_id_seq from anon, authenticated, PUBLIC;
grant all on sequence public.atas_rp_itens_id_seq to service_role;

comment on table public.atas_rp_itens is 'Itens de atas de registro de preço do Compras.gov (módulo ARP). Escrita só service_role; leitura authenticated.';

-- -----------------------------------------------------------------------------
-- 4. resultados_itens_14133 (Compras.gov - Contratações 14.133)
-- -----------------------------------------------------------------------------
create table if not exists public.resultados_itens_14133 (
  id bigint generated always as identity primary key,
  id_compra_item text,
  id_compra text,
  id_contratacao_pncp text,
  numero_controle_pncp_compra text,
  orgao_entidade_cnpj text,
  unidade_orgao_codigo_unidade integer,
  unidade_orgao_uf_sigla text,
  numero_item_pncp integer,
  sequencial_resultado integer,
  ni_fornecedor text,
  tipo_pessoa text,
  nome_fornecedor text,
  porte_fornecedor text,
  natureza_juridica_nome text,
  quantidade_homologada numeric,
  valor_unitario_homologado numeric(18,4),
  valor_total_homologado numeric(18,4),
  percentual_desconto numeric,
  situacao_compra_item_resultado_nome text,
  data_resultado_pncp timestamptz,
  data_inclusao_pncp timestamptz,
  codigo_item_catalogo integer,
  codigo_pdm text,
  marca text,
  fabricante text,
  modelo text,
  raw jsonb,
  payload_hash text,
  last_synced_at timestamptz default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint uq_resultados_14133 unique (id_compra_item, sequencial_resultado)
);

create index if not exists idx_res_14133_fornecedor on public.resultados_itens_14133 (ni_fornecedor);
create index if not exists idx_res_14133_pdm on public.resultados_itens_14133 (codigo_pdm);
create index if not exists idx_res_14133_item on public.resultados_itens_14133 (codigo_item_catalogo);
create index if not exists idx_res_14133_data on public.resultados_itens_14133 (data_resultado_pncp desc);

alter table public.resultados_itens_14133 enable row level security;
drop policy if exists resultados_itens_14133_select on public.resultados_itens_14133;
create policy resultados_itens_14133_select on public.resultados_itens_14133 for select to authenticated using (true);

revoke all on table public.resultados_itens_14133 from anon, authenticated, PUBLIC;
grant select on table public.resultados_itens_14133 to authenticated;
grant all on table public.resultados_itens_14133 to service_role;

revoke all on sequence public.resultados_itens_14133_id_seq from anon, authenticated, PUBLIC;
grant all on sequence public.resultados_itens_14133_id_seq to service_role;

comment on table public.resultados_itens_14133 is 'Resultados homologados por item da Lei 14.133 (Compras.gov / PNCP). Escrita só service_role; leitura authenticated.';

-- -----------------------------------------------------------------------------
-- 5. Extensão de contratacoes_atas (adiciona ni_fornecedor e colunas úteis)
-- -----------------------------------------------------------------------------
alter table public.contratacoes_atas
  add column if not exists ni_fornecedor text,
  add column if not exists nome_fornecedor text;

-- -----------------------------------------------------------------------------
-- 6. VIEWS DE BI
-- -----------------------------------------------------------------------------

-- 6.1 v_bi_pca_radar
-- Demanda planejada por órgão, PDM e mês previsto, unificando PNCP pca_itens e Compras.gov pca_pgc_itens.
-- Regra de deduplicação documentada:
--   - Quando o órgão/item do PGC possui correspondência exata no PNCP por (orgao_cnpj, ano, numero_item_pncp),
--     prioriza-se o registro do PGC (fonte rica com CATMAT completo).
--   - Se o PNCP tem item com numero_item correspondente ao PGC, o PNCP é deduplicado (descartado).
--   - Casamento marcado com casamento_confirmado = true para PGC (dado oficial estruturado) e para PNCP com PDM confirmado;
--     casamento por numero_item_pncp é auditável na coluna casamento_pncp_num_item.
create or replace view public.v_bi_pca_radar
with (security_invoker = true) as
with pdms_escopo as (
  select codigo_pdm, codigo_classe
  from public.catalogo_catmat_pdms_efetivos()
),
pgc_normalizado as (
  select
    'pgc'::text as fonte,
    p.orgao_cnpj,
    p.codigo_uasg,
    coalesce(nullif(p.nome_uasg, ''), o.nome_orgao, o.razao_social, p.orgao_cnpj) as orgao_nome,
    p.ano_pca_projeto_compra as ano_pca,
    coalesce(nullif(p.codigo_pdm_material, '')::integer, nullif(ci.codigo_pdm, '')::integer) as codigo_pdm,
    p.codigo_item_catalogo as codigo_item,
    p.descricao_item_catalogo as descricao_item,
    p.quantidade_item as quantidade,
    p.valor_unitario_item as valor_unitario,
    p.valor_total_item as valor_total,
    coalesce(p.data_prevista_formalizacao_demanda, p.data_inicio_processo_compra) as data_prevista,
    to_char(coalesce(p.data_prevista_formalizacao_demanda, p.data_inicio_processo_compra), 'YYYY-MM') as mes_previsto,
    p.nivel_prioridade_dfd as prioridade,
    p.status_contratacao_execucao as status,
    p.numero_item_pncp,
    true as casamento_confirmado,
    'pgc_catmat'::text as metodo_identificacao
  from public.pca_pgc_itens p
  left join public.orgaos o on o.cnpj = p.orgao_cnpj
  left join public.catmat_itens ci on ci.codigo_item = p.codigo_item_catalogo
  where coalesce(nullif(p.codigo_pdm_material, '')::integer, nullif(ci.codigo_pdm, '')::integer) in (select codigo_pdm from pdms_escopo)
),
pncp_itens_norm as (
  select
    'pncp'::text as fonte,
    pl.orgao_cnpj,
    pl.unidade_codigo as codigo_uasg,
    coalesce(pl.titulo, o.nome_orgao, o.razao_social, pl.orgao_cnpj) as orgao_nome,
    pl.ano_exercicio as ano_pca,
    coalesce(
      pip.codigo_pdm,
      nullif(i.pdm_codigo_origem, '')::integer,
      nullif(ci.codigo_pdm, '')::integer
    ) as codigo_pdm,
    case when i.codigo_item_origem ~ '^\d+$' then i.codigo_item_origem::bigint else null end as codigo_item,
    i.descricao as descricao_item,
    i.quantidade,
    i.valor_unitario_estimado as valor_unitario,
    i.valor_total_estimado as valor_total,
    i.data_prevista_contratacao as data_prevista,
    to_char(i.data_prevista_contratacao, 'YYYY-MM') as mes_previsto,
    i.prioridade,
    i.status,
    i.numero_item as numero_item_pncp,
    coalesce(pip.confirmado, false) as casamento_confirmado,
    case
      when pip.confirmado then 'pncp_pdm_confirmado'
      when i.pdm_codigo_origem is not null then 'pncp_pdm_origem'
      when ci.codigo_pdm is not null then 'pncp_catmat_item'
      else 'pncp_classe_apenas'
    end as metodo_identificacao
  from public.pca_itens i
  join public.pca_planos pl on pl.id = i.pca_plano_id
  left join public.orgaos o on o.cnpj = pl.orgao_cnpj
  left join public.pca_item_pdm pip on pip.pca_item_id = i.id and pip.confirmado = true
  left join public.catmat_itens ci on ci.codigo_item::text = i.codigo_item_origem
  where i.ativo = true and pl.ativo = true
    and coalesce(
      pip.codigo_pdm,
      nullif(i.pdm_codigo_origem, '')::integer,
      nullif(ci.codigo_pdm, '')::integer
    ) in (select codigo_pdm from pdms_escopo)
    -- Deduplicação: descarta item do PNCP que já consta no PGC para o mesmo orgao, ano e numero_item_pncp
    and not exists (
      select 1 from public.pca_pgc_itens pgc
      where pgc.orgao_cnpj = pl.orgao_cnpj
        and pgc.ano_pca_projeto_compra = pl.ano_exercicio
        and pgc.numero_item_pncp = i.numero_item
    )
)
select * from pgc_normalizado
union all
select * from pncp_itens_norm;

comment on view public.v_bi_pca_radar is 'Radar consolidado de demanda planejada (PCA PNCP + PGC Compras.gov) no escopo de produtos fitness, deduplicado por orgao+ano+numero_item_pncp.';

-- 6.2 v_bi_precos_praticados
-- Estatísticas de preços efetivamente praticados por PDM e item CATMAT: mediana, p25, p75, min, max, n e detecção de outliers.
create or replace view public.v_bi_precos_praticados
with (security_invoker = true) as
with pdms_escopo as (
  select codigo_pdm
  from public.catalogo_catmat_pdms_efetivos()
),
base_precos as (
  select
    coalesce(nullif(p.codigo_pdm, '')::integer, ci.codigo_pdm::integer) as codigo_pdm,
    p.codigo_item_catalogo as codigo_item,
    max(coalesce(p.nome_pdm, ci.nome_pdm)) as nome_pdm,
    max(p.descricao_item) as descricao_item,
    count(*)::integer as n_cotacoes,
    count(distinct p.id_compra)::integer as n_compras,
    count(distinct p.ni_fornecedor)::integer as n_fornecedores,
    count(distinct p.codigo_uasg)::integer as n_uasgs,
    min(p.preco_unitario)::numeric(18,4) as preco_min,
    percentile_cont(0.25) within group (order by p.preco_unitario)::numeric(18,4) as preco_p25,
    percentile_cont(0.50) within group (order by p.preco_unitario)::numeric(18,4) as preco_mediana,
    percentile_cont(0.75) within group (order by p.preco_unitario)::numeric(18,4) as preco_p75,
    max(p.preco_unitario)::numeric(18,4) as preco_max,
    min(p.data_resultado) as primeira_data,
    max(p.data_resultado) as ultima_data,
    -- Marcação de outlier: se min < p25 - 1.5*(p75-p25) ou max > p75 + 1.5*(p75-p25)
    case
      when count(*) >= 4 and min(p.preco_unitario) < (percentile_cont(0.25) within group (order by p.preco_unitario) - 1.5 * (percentile_cont(0.75) within group (order by p.preco_unitario) - percentile_cont(0.25) within group (order by p.preco_unitario)))
        then true
      when count(*) >= 4 and max(p.preco_unitario) > (percentile_cont(0.75) within group (order by p.preco_unitario) + 1.5 * (percentile_cont(0.75) within group (order by p.preco_unitario) - percentile_cont(0.25) within group (order by p.preco_unitario)))
        then true
      else false
    end as outlier_detectado,
    case
      when count(*) >= 4 and min(p.preco_unitario) < (percentile_cont(0.25) within group (order by p.preco_unitario) - 1.5 * (percentile_cont(0.75) within group (order by p.preco_unitario) - percentile_cont(0.25) within group (order by p.preco_unitario)))
        then 'minimo_abaixo_iqr'
      when count(*) >= 4 and max(p.preco_unitario) > (percentile_cont(0.75) within group (order by p.preco_unitario) + 1.5 * (percentile_cont(0.75) within group (order by p.preco_unitario) - percentile_cont(0.25) within group (order by p.preco_unitario)))
        then 'maximo_acima_iqr'
      else 'normal'
    end as outlier_tipo
  from public.precos_praticados_itens p
  left join public.catmat_itens ci on ci.codigo_item = p.codigo_item_catalogo
  where p.preco_unitario is not null
    and p.preco_unitario > 0
    and coalesce(nullif(p.codigo_pdm, '')::integer, ci.codigo_pdm::integer) in (select codigo_pdm from pdms_escopo)
  group by coalesce(nullif(p.codigo_pdm, '')::integer, ci.codigo_pdm::integer), p.codigo_item_catalogo
)
select * from base_precos;

comment on view public.v_bi_precos_praticados is 'Estatísticas de preços praticados por PDM e item CATMAT com mediana, quartis, amplitude e detecção de outliers.';

-- 6.3 v_bi_atas_vencendo
-- Atas de Registro de Preço com vigência expirando nos próximos 180 dias no escopo do catálogo.
create or replace view public.v_bi_atas_vencendo
with (security_invoker = true) as
with pdms_escopo as (
  select codigo_pdm
  from public.catalogo_catmat_pdms_efetivos()
)
select
  a.id as ata_item_id,
  a.numero_ata_registro_preco,
  a.codigo_unidade_gerenciadora,
  a.nome_unidade_gerenciadora,
  coalesce(nullif(a.codigo_pdm, '')::integer, ci.codigo_pdm::integer) as codigo_pdm,
  coalesce(a.nome_pdm, ci.nome_pdm) as nome_pdm,
  a.codigo_item,
  a.descricao_item,
  a.ni_fornecedor,
  a.nome_fornecedor,
  a.marca,
  a.quantidade_homologada_item as quantidade,
  a.valor_unitario,
  a.valor_total,
  a.data_vigencia_inicial,
  a.data_vigencia_final,
  (a.data_vigencia_final - current_date) as dias_para_vencer,
  a.maximo_adesao,
  a.quantidade_empenhada,
  (coalesce(a.quantidade_homologada_item, 0) - coalesce(a.quantidade_empenhada, 0)) as saldo_remanescente_estimado
from public.atas_rp_itens a
left join public.catmat_itens ci on ci.codigo_item = a.codigo_item
where a.data_vigencia_final is not null
  and a.data_vigencia_final >= current_date
  and a.data_vigencia_final <= current_date + interval '180 days'
  and coalesce(nullif(a.codigo_pdm, '')::integer, ci.codigo_pdm::integer) in (select codigo_pdm from pdms_escopo);

comment on view public.v_bi_atas_vencendo is 'Atas de registro de preço no escopo com vigência expirando nos próximos 180 dias (janela de oportunidade de relicitação e carona).';

-- 6.4 v_bi_orgaos_match
-- Ranking de órgãos por valor planejado (PCA) + valor homologado/pago em compras no escopo fitness.
create or replace view public.v_bi_orgaos_match
with (security_invoker = true) as
with pdms_escopo as (
  select codigo_pdm
  from public.catalogo_catmat_pdms_efetivos()
),
planejado_por_orgao as (
  select
    r.orgao_cnpj,
    count(*)::integer as qtd_itens_planejados,
    coalesce(sum(r.valor_total), 0)::numeric(18,2) as valor_total_planejado,
    max(r.data_prevista) as ultima_data_prevista
  from public.v_bi_pca_radar r
  group by r.orgao_cnpj
),
pago_por_orgao as (
  -- Compras.gov preços praticados no escopo
  select
    regexp_replace(coalesce(p.codigo_uasg, ''), '\D', '', 'g') as codigo_uasg,
    p.nome_orgao,
    p.estado as uf,
    count(*)::integer as qtd_itens_pagos,
    coalesce(sum(p.quantidade * p.preco_unitario), 0)::numeric(18,2) as valor_total_pago,
    max(p.data_resultado) as ultima_data_paga
  from public.precos_praticados_itens p
  left join public.catmat_itens ci on ci.codigo_item = p.codigo_item_catalogo
  where coalesce(nullif(p.codigo_pdm, '')::integer, ci.codigo_pdm::integer) in (select codigo_pdm from pdms_escopo)
  group by regexp_replace(coalesce(p.codigo_uasg, ''), '\D', '', 'g'), p.nome_orgao, p.estado
),
homologado_por_orgao as (
  -- Resultados homologados do LicitaGym (licitacoes_externas x licitacao_resultados)
  select
    regexp_replace(coalesce(l.orgao_cnpj, ''), '\D', '', 'g') as orgao_cnpj,
    coalesce(l.orgao_nome, l.unidade_compradora) as orgao_nome,
    l.uf,
    count(distinct r.licitacao_id)::integer as qtd_licitacoes_homologadas,
    count(distinct r.id)::integer as qtd_itens_homologados,
    coalesce(sum(r.valor_total_homologado), 0)::numeric(18,2) as valor_total_homologado,
    max(r.data_resultado::date) as ultima_data_homologada
  from public.licitacao_resultados r
  join public.licitacoes_externas l on l.id = r.licitacao_id
  left join public.licitacao_itens li on li.licitacao_id = r.licitacao_id and li.numero_item = r.numero_item
  left join public.catmat_itens ci on ci.codigo_item::text = li.catalogo_codigo_item
  left join public.catmat_pdm_palavras w on ci.codigo_pdm is null and w.ativo and public.norm_txt(li.descricao) ~ w.padrao
  where r.vencedor is distinct from false
    and coalesce(r.situacao, '') <> 'Cancelado'
    and (l.data_homologacao is not null or l.situacao ~* '(homologad|adjudicad|encerrad|conclu[ií]d|finalizad)')
    and coalesce(ci.codigo_pdm::integer, w.codigo_pdm) in (select codigo_pdm from pdms_escopo)
  group by regexp_replace(coalesce(l.orgao_cnpj, ''), '\D', '', 'g'), coalesce(l.orgao_nome, l.unidade_compradora), l.uf
),
todos_cnpjs as (
  select orgao_cnpj from planejado_por_orgao where orgao_cnpj is not null and orgao_cnpj <> ''
  union
  select orgao_cnpj from homologado_por_orgao where orgao_cnpj is not null and orgao_cnpj <> ''
)
select
  c.orgao_cnpj,
  coalesce(o.nome_orgao, o.razao_social, h.orgao_nome, c.orgao_cnpj) as orgao_nome,
  coalesce(o.esfera_canon, o.esfera, 'Federal') as esfera,
  coalesce(o.uf, h.uf) as uf,
  coalesce(pl.qtd_itens_planejados, 0) as qtd_itens_planejados,
  coalesce(pl.valor_total_planejado, 0) as valor_total_planejado,
  coalesce(h.qtd_itens_homologados, 0) as qtd_itens_homologados,
  coalesce(h.valor_total_homologado, 0) as valor_total_homologado,
  (coalesce(pl.valor_total_planejado, 0) + coalesce(h.valor_total_homologado, 0)) as score_demanda_total,
  pl.ultima_data_prevista,
  h.ultima_data_homologada
from todos_cnpjs c
left join public.orgaos o on o.cnpj = c.orgao_cnpj
left join planejado_por_orgao pl on pl.orgao_cnpj = c.orgao_cnpj
left join homologado_por_orgao h on h.orgao_cnpj = c.orgao_cnpj
order by score_demanda_total desc;

comment on view public.v_bi_orgaos_match is 'Ranking consolidado de órgãos por volume de demanda planejada (PCA) e compras homologadas no catálogo fitness.';

-- 6.5 v_bi_fornecedor_historico
-- Visão central de inteligência de concorrentes e fornecedores históricos no escopo fitness.
-- Apenas resultados de certames ENCERRADOS/HOMOLOGADOS (prioridade = historico).
create or replace view public.v_bi_fornecedor_historico
with (security_invoker = true) as
with pdms_escopo as (
  select codigo_pdm
  from public.catalogo_catmat_pdms_efetivos()
),
-- Origem 1: licitacao_resultados homologados do banco (PNCP e Paradigma/SEST)
f_resultados as (
  select
    regexp_replace(r.fornecedor_cnpj, '\D', '', 'g') as cnpj,
    r.fornecedor_nome as nome_fornecedor,
    'licitacao_resultados'::text as fonte_origem,
    r.licitacao_id::text as id_certame_origem,
    coalesce(ci.codigo_pdm::integer, kw.codigo_pdm) as codigo_pdm,
    case when li.catalogo_codigo_item ~ '^\d+$' then li.catalogo_codigo_item::bigint else null end as codigo_item,
    coalesce(r.marca_normalizada, r.marca) as marca,
    null::text as fabricante,
    r.modelo,
    r.quantidade_homologada as quantidade,
    r.valor_unitario_homologado as preco_unitario,
    r.valor_total_homologado as valor_total,
    coalesce(r.data_resultado::date, l.data_homologacao::date) as data_venda,
    coalesce(l.orgao_cnpj, '') as orgao_identificador,
    coalesce(l.orgao_nome, l.unidade_compradora) as orgao_nome,
    case
      when ci.codigo_pdm is not null then 'catmat_oficial'
      when kw.codigo_pdm is not null then 'pdm_palavra_chave'
      else 'sem_pdm'
    end as cobertura
  from public.licitacao_resultados r
  join public.licitacoes_externas l on l.id = r.licitacao_id
  left join public.licitacao_itens li on li.licitacao_id = r.licitacao_id and li.numero_item = r.numero_item
  left join public.catmat_itens ci on ci.codigo_item::text = li.catalogo_codigo_item
  left join lateral (
    select w.codigo_pdm from public.catmat_pdm_palavras w
    where ci.codigo_pdm is null and w.ativo and public.norm_txt(li.descricao) ~ w.padrao
    order by length(w.padrao) desc limit 1
  ) kw on true
  where r.fornecedor_cnpj is not null
    and r.vencedor is distinct from false
    and coalesce(r.situacao, '') <> 'Cancelado'
    and (l.data_homologacao is not null or l.situacao ~* '(homologad|adjudicad|encerrad|conclu[ií]d|finalizad)')
    and coalesce(ci.codigo_pdm::integer, kw.codigo_pdm) in (select codigo_pdm from pdms_escopo)
),
-- Origem 2: precos_praticados_itens (módulo Pesquisa de Preço Compras.gov - já homologados)
f_precos as (
  select
    regexp_replace(p.ni_fornecedor, '\D', '', 'g') as cnpj,
    p.nome_fornecedor,
    'compras_pesquisa_preco'::text as fonte_origem,
    p.id_compra as id_certame_origem,
    coalesce(nullif(p.codigo_pdm, '')::integer, ci.codigo_pdm::integer) as codigo_pdm,
    p.codigo_item_catalogo::bigint as codigo_item,
    p.marca,
    p.fabricante,
    p.modelo,
    p.quantidade,
    p.preco_unitario,
    (p.quantidade * p.preco_unitario) as valor_total,
    p.data_resultado as data_venda,
    coalesce(p.codigo_uasg, '') as orgao_identificador,
    p.nome_uasg as orgao_nome,
    case
      when p.codigo_item_catalogo is not null then 'catmat_oficial'
      when p.codigo_pdm is not null then 'pdm_oficial'
      else 'sem_pdm'
    end as cobertura
  from public.precos_praticados_itens p
  left join public.catmat_itens ci on ci.codigo_item = p.codigo_item_catalogo
  where p.ni_fornecedor is not null
    and p.preco_unitario is not null
    and p.preco_unitario > 0
    and coalesce(nullif(p.codigo_pdm, '')::integer, ci.codigo_pdm::integer) in (select codigo_pdm from pdms_escopo)
),
-- Origem 3: atas_rp_itens (módulo ARP Compras.gov - homologadas)
f_atas as (
  select
    regexp_replace(a.ni_fornecedor, '\D', '', 'g') as cnpj,
    a.nome_fornecedor,
    'compras_arp'::text as fonte_origem,
    a.numero_ata_registro_preco as id_certame_origem,
    coalesce(nullif(a.codigo_pdm, '')::integer, ci.codigo_pdm::integer) as codigo_pdm,
    a.codigo_item::bigint as codigo_item,
    a.marca,
    a.fabricante,
    a.modelo,
    a.quantidade_homologada_item as quantidade,
    a.valor_unitario,
    a.valor_total,
    coalesce(a.data_assinatura::date, a.data_vigencia_inicial) as data_venda,
    coalesce(a.codigo_unidade_gerenciadora::text, '') as orgao_identificador,
    a.nome_unidade_gerenciadora as orgao_nome,
    case
      when a.codigo_item is not null then 'catmat_oficial'
      when a.codigo_pdm is not null then 'pdm_oficial'
      else 'sem_pdm'
    end as cobertura
  from public.atas_rp_itens a
  left join public.catmat_itens ci on ci.codigo_item = a.codigo_item
  where a.ni_fornecedor is not null
    and coalesce(nullif(a.codigo_pdm, '')::integer, ci.codigo_pdm::integer) in (select codigo_pdm from pdms_escopo)
),
-- Origem 4: resultados_itens_14133
f_14133 as (
  select
    regexp_replace(res.ni_fornecedor, '\D', '', 'g') as cnpj,
    res.nome_fornecedor,
    'compras_14133'::text as fonte_origem,
    coalesce(res.numero_controle_pncp_compra, res.id_compra, res.id_contratacao_pncp) as id_certame_origem,
    coalesce(nullif(res.codigo_pdm, '')::integer, ci.codigo_pdm::integer) as codigo_pdm,
    res.codigo_item_catalogo::bigint as codigo_item,
    res.marca,
    res.fabricante,
    res.modelo,
    res.quantidade_homologada as quantidade,
    res.valor_unitario_homologado as preco_unitario,
    res.valor_total_homologado as valor_total,
    coalesce(res.data_resultado_pncp::date, res.data_inclusao_pncp::date) as data_venda,
    coalesce(res.unidade_orgao_codigo_unidade::text, res.orgao_entidade_cnpj) as orgao_identificador,
    res.orgao_entidade_cnpj as orgao_nome,
    case
      when res.codigo_item_catalogo is not null then 'catmat_oficial'
      when res.codigo_pdm is not null then 'pdm_oficial'
      else 'sem_pdm'
    end as cobertura
  from public.resultados_itens_14133 res
  left join public.catmat_itens ci on ci.codigo_item = res.codigo_item_catalogo
  where res.ni_fornecedor is not null
    and coalesce(res.situacao_compra_item_resultado_nome, '') <> 'Cancelado'
    and coalesce(nullif(res.codigo_pdm, '')::integer, ci.codigo_pdm::integer) in (select codigo_pdm from pdms_escopo)
),
todas_vendas as (
  select * from f_resultados
  union all
  select * from f_precos
  union all
  select * from f_atas
  union all
  select * from f_14133
),
vendas_dedup as (
  -- Deduplica quando a mesma compra/resultado é ingerido por mais de uma fonte (PNCP e Compras.gov)
  select distinct on (cnpj, id_certame_origem, coalesce(codigo_item, 0), coalesce(codigo_pdm, 0))
    *
  from todas_vendas
  order by cnpj, id_certame_origem, coalesce(codigo_item, 0), coalesce(codigo_pdm, 0),
           (preco_unitario is not null) desc, (marca is not null) desc
),
fornecedor_itens as (
  select
    v.cnpj,
    v.codigo_pdm,
    v.codigo_item,
    v.cobertura,
    count(*)::integer as n_vendas_item,
    min(v.preco_unitario)::numeric(18,4) as preco_min_item,
    percentile_cont(0.50) within group (order by v.preco_unitario)::numeric(18,4) as preco_mediana_item,
    max(v.preco_unitario)::numeric(18,4) as preco_max_item,
    sum(v.quantidade)::numeric as quantidade_total_item,
    sum(v.valor_total)::numeric(18,2) as valor_total_item,
    max(v.data_venda) as ultima_venda_item
  from vendas_dedup v
  group by v.cnpj, v.codigo_pdm, v.codigo_item, v.cobertura
),
fornecedor_itens_agg as (
  select
    fi.cnpj,
    jsonb_agg(jsonb_build_object(
      'codigo_pdm', fi.codigo_pdm,
      'codigo_item', fi.codigo_item,
      'cobertura', fi.cobertura,
      'n_vendas', fi.n_vendas_item,
      'preco_min', fi.preco_min_item,
      'preco_mediana', fi.preco_mediana_item,
      'preco_max', fi.preco_max_item,
      'quantidade_total', fi.quantidade_total_item,
      'valor_total', fi.valor_total_item,
      'ultima_venda', fi.ultima_venda_item
    ) order by fi.valor_total_item desc nulls last) as itens_praticados
  from fornecedor_itens fi
  group by fi.cnpj
),
orgaos_frequencia as (
  select
    v.cnpj,
    jsonb_agg(jsonb_build_object(
      'orgao_identificador', o.orgao_identificador,
      'orgao_nome', o.nome_amostra,
      'frequencia_vendas', o.frequencia,
      'valor_total', o.total_valor,
      'ultima_venda', o.ultima_data
    ) order by o.frequencia desc, o.total_valor desc) as orgaos_clientes
  from (
    select
      cnpj,
      orgao_identificador,
      (array_agg(orgao_nome order by data_venda desc nulls last) filter (where orgao_nome is not null))[1] as nome_amostra,
      count(*)::integer as frequencia,
      coalesce(sum(valor_total), 0)::numeric(18,2) as total_valor,
      max(data_venda) as ultima_data
    from vendas_dedup
    where orgao_identificador is not null and orgao_identificador <> ''
    group by cnpj, orgao_identificador
  ) o
  join (select distinct cnpj from vendas_dedup) v on v.cnpj = o.cnpj
  group by v.cnpj
),
fornecedor_totais as (
  select
    v.cnpj,
    (array_agg(v.nome_fornecedor order by v.data_venda desc nulls last) filter (where v.nome_fornecedor is not null))[1] as nome_fornecedor,
    count(*)::integer as total_vendas_homologadas,
    count(distinct v.id_certame_origem)::integer as total_certames,
    count(distinct v.orgao_identificador)::integer as total_orgaos,
    coalesce(sum(v.valor_total), 0)::numeric(18,2) as valor_total_vendido,
    array_agg(distinct upper(trim(v.marca))) filter (where v.marca is not null and trim(v.marca) <> '') as marcas_entregues,
    array_agg(distinct upper(trim(v.fabricante))) filter (where v.fabricante is not null and trim(v.fabricante) <> '') as fabricantes_entregues,
    min(v.data_venda) as primeira_venda,
    max(v.data_venda) as ultima_venda
  from vendas_dedup v
  group by v.cnpj
)
select
  t.cnpj,
  coalesce(f.razao_social, t.nome_fornecedor) as razao_social,
  f.nome_fantasia,
  f.cnae_principal,
  f.cnae_principal_descricao,
  case
    when f.cnae_principal is not null then left(lpad(f.cnae_principal::text, 7, '0'), 2)::integer
    else null
  end as cnae_divisao,
  -- Regra oficial: divisões 10-33 = fabricante, 45-47 = revenda/comércio.
  -- Sinal adicional: se a marca entregue coincide com o próprio nome/razão social.
  case
    when f.cnae_principal is not null and left(lpad(f.cnae_principal::text, 7, '0'), 2)::integer between 10 and 33 then 'fabricante'
    when f.cnae_principal is not null and left(lpad(f.cnae_principal::text, 7, '0'), 2)::integer between 45 and 47 then 'revenda'
    when exists (
      select 1 from unnest(t.marcas_entregues) m
      where m is not null and length(m) >= 4 and upper(coalesce(f.razao_social, t.nome_fornecedor)) like '%' || m || '%'
    ) then 'fabricante'
    when f.cnpj is not null then 'revenda'
    else 'nao_classificado'
  end as tipo_fornecedor,
  case
    when f.cnae_principal is not null and left(lpad(f.cnae_principal::text, 7, '0'), 2)::integer between 10 and 33 then 'alta_cnae_industria'
    when f.cnae_principal is not null and left(lpad(f.cnae_principal::text, 7, '0'), 2)::integer between 45 and 47 then 'alta_cnae_comercio'
    when exists (
      select 1 from unnest(t.marcas_entregues) m
      where m is not null and length(m) >= 4 and upper(coalesce(f.razao_social, t.nome_fornecedor)) like '%' || m || '%'
    ) then 'media_coincidencia_marca'
    when f.cnpj is not null then 'baixa_sem_cnae_especifico'
    else 'sem_dados'
  end as tipo_fornecedor_confianca,
  f.uf as uf_sede,
  f.municipio as municipio_sede,
  f.porte,
  t.total_vendas_homologadas,
  t.total_certames,
  t.total_orgaos,
  t.valor_total_vendido,
  coalesce(t.marcas_entregues, array[]::text[]) as marcas_entregues,
  coalesce(t.fabricantes_entregues, array[]::text[]) as fabricantes_entregues,
  coalesce(fia.itens_praticados, '[]'::jsonb) as itens_praticados,
  coalesce(orf.orgaos_clientes, '[]'::jsonb) as orgaos_clientes,
  t.primeira_venda,
  t.ultima_venda
from fornecedor_totais t
left join public.fornecedores f on f.cnpj = t.cnpj
left join fornecedor_itens_agg fia on fia.cnpj = t.cnpj
left join orgaos_frequencia orf on orf.cnpj = t.cnpj;

comment on view public.v_bi_fornecedor_historico is 'Inteligência de fornecedor histórico (somente compras homologadas/encerradas): tipo fabricante x revenda, marcas entregues, preços por item CATMAT/PDM e órgãos clientes.';

-- -----------------------------------------------------------------------------
-- 7. ACL das Views de BI
-- Conforme especificação: views security_invoker = true, SEM grant para
-- anon nem authenticated. Acesso exclusivo service_role (via Edge Functions).
-- -----------------------------------------------------------------------------
revoke all on public.v_bi_pca_radar from anon, authenticated, PUBLIC;
revoke all on public.v_bi_precos_praticados from anon, authenticated, PUBLIC;
revoke all on public.v_bi_atas_vencendo from anon, authenticated, PUBLIC;
revoke all on public.v_bi_orgaos_match from anon, authenticated, PUBLIC;
revoke all on public.v_bi_fornecedor_historico from anon, authenticated, PUBLIC;

grant select on public.v_bi_pca_radar to service_role;
grant select on public.v_bi_precos_praticados to service_role;
grant select on public.v_bi_atas_vencendo to service_role;
grant select on public.v_bi_orgaos_match to service_role;
grant select on public.v_bi_fornecedor_historico to service_role;

commit;
