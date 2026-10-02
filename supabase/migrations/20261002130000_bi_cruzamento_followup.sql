-- =============================================================================
-- Migration: 20261002130000_bi_cruzamento_followup.sql
-- Follow-up da migration 20261002100000_bi_cruzamento_apis.sql:
-- 1. Alinhamento de DDL nas tabelas:
--    - Adiciona colunas faltantes em precos_praticados_itens caso pré-existente
--    - Constraints de unicidade com NULLS NOT DISTINCT para colunas anuláveis
-- 2. Correção de Views:
--    - v_bi_atas_vencendo: não coalescer quantidade/saldo para zero (preservar NULL quando não verificado)
--    - v_bi_orgaos_match: agrega resultados de resultados_itens_14133 além de licitacao_resultados;
--      agrupamento estrito por CNPJ (sem repetir por nome/UF divergente);
--    - v_bi_fornecedor_historico:
--      * Separa valor_registrado_ata e valor_homologado_contratacao (flag eh_ata_rp e valor_origem)
--      * Preserva NULL quando valor total não é informado (sem coalesce(..., 0))
--      * Distingue pdm_palavra (catmat_pdm_palavras) de pdm_oficial (catmat_itens)
--      * Expõe cobertura refinada (catmat_oficial, pdm_oficial, pdm_palavra, sem_pdm)
--      * Fallback de chave canônica inclui codigo_pdm quando numero_item e codigo_item são nulos
--      * Normaliza orgao_identificador para contagem não inflada de órgãos atendidos
-- =============================================================================

begin;

set local lock_timeout = '10s';

-- -----------------------------------------------------------------------------
-- 1. Garantir colunas em precos_praticados_itens caso tenha sido criada previamente
-- -----------------------------------------------------------------------------
alter table public.precos_praticados_itens
  add column if not exists marca text,
  add column if not exists fabricante text,
  add column if not exists modelo text,
  add column if not exists raw jsonb,
  add column if not exists payload_hash text;

-- -----------------------------------------------------------------------------
-- 2. Ajuste de Unicidade com NULLS NOT DISTINCT (Postgres 15+)
-- -----------------------------------------------------------------------------
-- pca_pgc_itens
alter table public.pca_pgc_itens
  drop constraint if exists uq_pca_pgc_item;

alter table public.pca_pgc_itens
  add constraint uq_pca_pgc_item
  unique nulls not distinct (orgao_cnpj, codigo_uasg, ano_pca_projeto_compra, numero_item_pncp, codigo_item_catalogo);

-- atas_rp_itens
alter table public.atas_rp_itens
  drop constraint if exists uq_atas_rp_itens;

alter table public.atas_rp_itens
  add constraint uq_atas_rp_itens
  unique nulls not distinct (numero_ata_registro_preco, codigo_unidade_gerenciadora, numero_item);

-- resultados_itens_14133
alter table public.resultados_itens_14133
  drop constraint if exists uq_resultados_14133;

alter table public.resultados_itens_14133
  add constraint uq_resultados_14133
  unique nulls not distinct (id_compra_item, sequencial_resultado);

-- -----------------------------------------------------------------------------
-- 3. Atualização das Views de BI
-- -----------------------------------------------------------------------------
drop view if exists public.v_bi_fornecedor_historico cascade;
drop view if exists public.v_bi_orgaos_match cascade;
drop view if exists public.v_bi_atas_vencendo cascade;

-- 3.1 v_bi_atas_vencendo
-- Preservar NULL quando saldo ou quantidade não estiverem verificados
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
  coalesce(
    case when a.codigo_pdm ~ '^\d+$' then a.codigo_pdm::integer end,
    case when ci.codigo_pdm ~ '^\d+$' then ci.codigo_pdm::integer end
  ) as codigo_pdm,
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
  -- Não coalescer para 0 se quantidade for nula; se não houver empenho, saldo é a própria quantidade
  case
    when a.quantidade_homologada_item is null then null
    else (a.quantidade_homologada_item - coalesce(a.quantidade_empenhada, 0))
  end as saldo_remanescente_estimado
from public.atas_rp_itens a
left join public.catmat_itens ci on ci.codigo_item = a.codigo_item
where a.data_vigencia_final is not null
  and a.data_vigencia_final >= current_date
  and a.data_vigencia_final <= current_date + interval '180 days'
  and coalesce(
    case when a.codigo_pdm ~ '^\d+$' then a.codigo_pdm::integer end,
    case when ci.codigo_pdm ~ '^\d+$' then ci.codigo_pdm::integer end
  ) in (select codigo_pdm from pdms_escopo);

comment on view public.v_bi_atas_vencendo is 'Atas de registro de preço no escopo com vigência expirando nos próximos 180 dias (janela de oportunidade de relicitação e carona).';

-- 3.2 v_bi_orgaos_match
-- Inclui compras homologadas de licitacao_resultados e resultados_itens_14133
-- Agrupamento estrito por CNPJ (evita linhas duplicadas por variações de nome/UF)
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
    coalesce(sum(r.valor_total), 0)::numeric(18,2) as valor_planejado_pca,
    max(r.data_prevista) as ultima_data_prevista
  from public.v_bi_pca_radar r
  group by r.orgao_cnpj
),
compras_14133_homolog as (
  select
    regexp_replace(coalesce(res.orgao_entidade_cnpj, ''), '\D', '', 'g') as orgao_cnpj,
    coalesce(res.numero_controle_pncp_compra, 'ext:14133:' || res.id_compra) as compra_id,
    res.numero_item_pncp as numero_item,
    res.valor_total_homologado,
    coalesce(res.data_resultado_pncp::date, res.data_inclusao_pncp::date) as data_resultado
  from public.resultados_itens_14133 res
  left join public.catmat_itens ci on ci.codigo_item = res.codigo_item_catalogo
  where res.orgao_entidade_cnpj is not null
    and coalesce(res.situacao_compra_item_resultado_nome, '') <> 'Cancelado'
    and coalesce(res.material_ou_servico, res.tipo_item, 'M') ~* '^(m|material)'
    and coalesce(case when res.codigo_pdm ~ '^\d+$' then res.codigo_pdm::integer end, case when ci.codigo_pdm ~ '^\d+$' then ci.codigo_pdm::integer end) in (select codigo_pdm from pdms_escopo)
),
licitacoes_homolog as (
  select
    regexp_replace(coalesce(l.orgao_cnpj, ''), '\D', '', 'g') as orgao_cnpj,
    coalesce(case when l.fonte = 'pncp' then nullif(l.codigo_externo, '') end, 'ext:' || l.fonte || ':' || l.id::text) as compra_id,
    r.numero_item,
    r.valor_total_homologado,
    coalesce(r.data_resultado::date, l.data_homologacao::date) as data_resultado
  from public.licitacao_resultados r
  join public.licitacoes_externas_prioridade_efetiva l on l.id = r.licitacao_id
  left join public.licitacao_itens li on li.licitacao_id = r.licitacao_id and li.numero_item = r.numero_item
  left join public.catmat_itens ci on ci.codigo_item::text = li.catalogo_codigo_item
  left join lateral (
    select w.codigo_pdm from public.catmat_pdm_palavras w
    where ci.codigo_pdm is null and w.ativo and public.norm_txt(li.descricao) ~ w.padrao
    order by length(w.padrao) desc limit 1
  ) kw on true
  where r.vencedor is distinct from false
    and coalesce(r.situacao, '') <> 'Cancelado'
    and l.prioridade = 'historico'
    and (
      li.material_ou_servico = 'M'
      or (li.material_ou_servico is null and coalesce(case when ci.codigo_pdm ~ '^\d+$' then ci.codigo_pdm::integer end, kw.codigo_pdm) in (select codigo_pdm from pdms_escopo))
    )
    and coalesce(case when ci.codigo_pdm ~ '^\d+$' then ci.codigo_pdm::integer end, kw.codigo_pdm) in (select codigo_pdm from pdms_escopo)
),
todas_homolog as (
  select * from licitacoes_homolog
  union all
  select * from compras_14133_homolog
),
homolog_dedup as (
  select distinct on (orgao_cnpj, compra_id, coalesce(numero_item, 0))
    *
  from todas_homolog
  where orgao_cnpj is not null and orgao_cnpj <> ''
  order by orgao_cnpj, compra_id, coalesce(numero_item, 0), valor_total_homologado desc nulls last
),
homologado_por_orgao as (
  select
    orgao_cnpj,
    count(distinct compra_id)::integer as qtd_licitacoes_homologadas,
    count(*)::integer as qtd_itens_homologados,
    coalesce(sum(valor_total_homologado), 0)::numeric(18,2) as valor_homologado,
    max(data_resultado) as ultima_data_homologada
  from homolog_dedup
  group by orgao_cnpj
),
todos_cnpjs as (
  select orgao_cnpj from planejado_por_orgao where orgao_cnpj is not null and orgao_cnpj <> ''
  union
  select orgao_cnpj from homologado_por_orgao where orgao_cnpj is not null and orgao_cnpj <> ''
)
select
  c.orgao_cnpj,
  coalesce(o.nome_orgao, o.razao_social, c.orgao_cnpj) as orgao_nome,
  coalesce(o.esfera_canon, o.esfera) as esfera,
  o.uf,
  coalesce(pl.qtd_itens_planejados, 0) as qtd_itens_planejados,
  coalesce(pl.valor_planejado_pca, 0) as valor_planejado_pca,
  coalesce(h.qtd_itens_homologados, 0) as qtd_itens_homologados,
  coalesce(h.valor_homologado, 0) as valor_homologado,
  pl.ultima_data_prevista,
  h.ultima_data_homologada
from todos_cnpjs c
left join public.orgaos o on o.cnpj = c.orgao_cnpj
left join planejado_por_orgao pl on pl.orgao_cnpj = c.orgao_cnpj
left join homologado_por_orgao h on h.orgao_cnpj = c.orgao_cnpj
order by coalesce(h.valor_homologado, 0) desc, coalesce(pl.valor_planejado_pca, 0) desc;

comment on view public.v_bi_orgaos_match is 'Ranking consolidado de órgãos por volume de demanda planejada (PCA) e compras homologadas no catálogo fitness.';

-- 3.3 v_bi_fornecedor_historico
-- Separação entre valor registrado em ata RP e contratação direta/homologada
-- Cobertura com pdm_palavra distinto de pdm_oficial
-- Normalização canônica do órgão comprador
create or replace view public.v_bi_fornecedor_historico
with (security_invoker = true) as
with pdms_escopo as (
  select codigo_pdm
  from public.catalogo_catmat_pdms_efetivos()
),
compras_pncp_bridge as (
  -- Ponte de id_compra (Compras.gov) para numero_controle_pncp_compra (PNCP)
  select distinct on (id_compra)
    id_compra,
    numero_controle_pncp_compra
  from (
    select id_compra, numero_controle_pncp_compra, 1 as prio
    from public.resultados_itens_14133
    where id_compra is not null and numero_controle_pncp_compra is not null
    union all
    select id_compra, numero_controle_pncp_compra, 2 as prio
    from public.atas_rp_itens
    where id_compra is not null and numero_controle_pncp_compra is not null
    union all
    select substring(raw->>'link_sistema_origem' from '[?&]compra=(\d{17})') as id_compra,
           codigo_externo as numero_controle_pncp_compra,
           3 as prio
    from public.licitacoes_externas
    where fonte = 'pncp'
      and codigo_externo is not null
      and raw->>'link_sistema_origem' is not null
      and substring(raw->>'link_sistema_origem' from '[?&]compra=(\d{17})') is not null
  ) m
  where id_compra is not null and numero_controle_pncp_compra is not null
  order by id_compra, prio
),
-- Origem 1: licitacao_resultados homologados do banco (PNCP e Paradigma/SEST)
f_resultados as (
  select
    regexp_replace(r.fornecedor_cnpj, '\D', '', 'g') as cnpj,
    r.fornecedor_nome as nome_fornecedor,
    'licitacao_resultados'::text as fonte_origem,
    coalesce(case when l.fonte = 'pncp' then nullif(l.codigo_externo, '') end, 'ext:' || l.fonte || ':' || l.id::text) as compra_id_canonico,
    r.numero_item,
    coalesce(case when ci.codigo_pdm ~ '^\d+$' then ci.codigo_pdm::integer end, kw.codigo_pdm) as codigo_pdm,
    case when li.catalogo_codigo_item ~ '^\d+$' then li.catalogo_codigo_item::bigint else null end as codigo_item,
    coalesce(r.marca_normalizada, r.marca) as marca,
    null::text as fabricante,
    r.modelo,
    r.quantidade_homologada as quantidade,
    r.valor_unitario_homologado as preco_unitario,
    r.valor_total_homologado as valor_total,
    coalesce(r.data_resultado::date, l.data_homologacao::date) as data_venda,
    coalesce(nullif(regexp_replace(l.orgao_cnpj, '\D', '', 'g'), ''), 'org:' || l.fonte || ':' || l.id::text) as orgao_identificador,
    coalesce(l.orgao_nome, l.unidade_compradora) as orgao_nome,
    case
      when li.catalogo_codigo_item ~ '^\d+$' and ci.codigo_item is not null then 'catmat_oficial'
      when ci.codigo_pdm is not null then 'pdm_oficial'
      when kw.codigo_pdm is not null then 'pdm_palavra'
      else 'sem_pdm'
    end as cobertura,
    coalesce(
      case
        when lower(le.raw->>'srp') in ('true', 't', '1', 'sim') then true
        when lower(le.raw->>'srp') in ('false', 'f', '0', 'nao', 'não') then false
      end,
      l.modalidade ~* 'registro de pre[cç]o' or l.objeto ~* '\y(arp|registro de pre[cç]os?)\y',
      false
    ) as eh_ata_rp,
    case
      when coalesce(
        case
          when lower(le.raw->>'srp') in ('true', 't', '1', 'sim') then true
          when lower(le.raw->>'srp') in ('false', 'f', '0', 'nao', 'não') then false
        end,
        l.modalidade ~* 'registro de pre[cç]o' or l.objeto ~* '\y(arp|registro de pre[cç]os?)\y',
        false
      ) then 'ata_rp'
      else 'contratacao_direta'
    end as valor_origem
  from public.licitacao_resultados r
  join public.licitacoes_externas_prioridade_efetiva l on l.id = r.licitacao_id
  join public.licitacoes_externas le on le.id = r.licitacao_id
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
    and l.prioridade = 'historico'
    and (
      li.material_ou_servico = 'M'
      or (li.material_ou_servico is null and coalesce(case when ci.codigo_pdm ~ '^\d+$' then ci.codigo_pdm::integer end, kw.codigo_pdm) in (select codigo_pdm from pdms_escopo))
    )
    and coalesce(case when ci.codigo_pdm ~ '^\d+$' then ci.codigo_pdm::integer end, kw.codigo_pdm) in (select codigo_pdm from pdms_escopo)
),
-- Origem 2: precos_praticados_itens (módulo Pesquisa de Preço Compras.gov - já homologados de materiais)
f_precos as (
  select
    regexp_replace(p.ni_fornecedor, '\D', '', 'g') as cnpj,
    p.nome_fornecedor,
    'compras_pesquisa_preco'::text as fonte_origem,
    coalesce(b.numero_controle_pncp_compra, 'ext:compras_gov:' || p.id_compra) as compra_id_canonico,
    p.numero_item_compra as numero_item,
    coalesce(case when p.codigo_pdm ~ '^\d+$' then p.codigo_pdm::integer end, case when ci.codigo_pdm ~ '^\d+$' then ci.codigo_pdm::integer end) as codigo_pdm,
    p.codigo_item_catalogo::bigint as codigo_item,
    p.marca,
    p.fabricante,
    p.modelo,
    p.quantidade,
    p.preco_unitario,
    (p.quantidade * p.preco_unitario) as valor_total,
    p.data_resultado as data_venda,
    coalesce(nullif(regexp_replace(p.codigo_uasg, '\D', '', 'g'), ''), 'uasg:desconhecida') as orgao_identificador,
    p.nome_uasg as orgao_nome,
    case
      when p.codigo_item_catalogo is not null and ci.codigo_item is not null then 'catmat_oficial'
      when p.codigo_pdm is not null then 'pdm_oficial'
      else 'sem_pdm'
    end as cobertura,
    false as eh_ata_rp,
    'contratacao_direta'::text as valor_origem
  from public.precos_praticados_itens p
  left join compras_pncp_bridge b on b.id_compra = p.id_compra
  left join public.catmat_itens ci on ci.codigo_item = p.codigo_item_catalogo
  where p.ni_fornecedor is not null
    and p.preco_unitario is not null
    and p.preco_unitario > 0
    and coalesce(case when p.codigo_pdm ~ '^\d+$' then p.codigo_pdm::integer end, case when ci.codigo_pdm ~ '^\d+$' then ci.codigo_pdm::integer end) in (select codigo_pdm from pdms_escopo)
),
-- Origem 3: atas_rp_itens (módulo ARP Compras.gov - homologadas de materiais)
f_atas as (
  select
    regexp_replace(a.ni_fornecedor, '\D', '', 'g') as cnpj,
    a.nome_fornecedor,
    'compras_arp'::text as fonte_origem,
    coalesce(nullif(a.numero_controle_pncp_compra, ''), b.numero_controle_pncp_compra, 'ext:compras_gov:' || nullif(a.id_compra, ''), 'ext:arp:' || a.numero_ata_registro_preco) as compra_id_canonico,
    case when a.numero_item ~ '^\d+$' then a.numero_item::integer end as numero_item,
    coalesce(case when a.codigo_pdm ~ '^\d+$' then a.codigo_pdm::integer end, case when ci.codigo_pdm ~ '^\d+$' then ci.codigo_pdm::integer end) as codigo_pdm,
    a.codigo_item::bigint as codigo_item,
    a.marca,
    a.fabricante,
    a.modelo,
    a.quantidade_homologada_item as quantidade,
    a.valor_unitario,
    a.valor_total,
    coalesce(a.data_assinatura::date, a.data_vigencia_inicial) as data_venda,
    coalesce(nullif(regexp_replace(a.codigo_unidade_gerenciadora::text, '\D', '', 'g'), ''), 'uasg:desconhecida') as orgao_identificador,
    a.nome_unidade_gerenciadora as orgao_nome,
    case
      when a.codigo_item is not null and ci.codigo_item is not null then 'catmat_oficial'
      when a.codigo_pdm is not null then 'pdm_oficial'
      else 'sem_pdm'
    end as cobertura,
    true as eh_ata_rp,
    'ata_rp'::text as valor_origem
  from public.atas_rp_itens a
  left join compras_pncp_bridge b on b.id_compra = a.id_compra
  left join public.catmat_itens ci on ci.codigo_item = a.codigo_item
  where a.ni_fornecedor is not null
    and coalesce(a.tipo_item, 'Material') ~* 'material'
    and coalesce(case when a.codigo_pdm ~ '^\d+$' then a.codigo_pdm::integer end, case when ci.codigo_pdm ~ '^\d+$' then ci.codigo_pdm::integer end) in (select codigo_pdm from pdms_escopo)
),
-- Origem 4: resultados_itens_14133 (Apenas materiais/produtos)
f_14133 as (
  select
    regexp_replace(res.ni_fornecedor, '\D', '', 'g') as cnpj,
    res.nome_fornecedor,
    'compras_14133'::text as fonte_origem,
    coalesce(nullif(res.numero_controle_pncp_compra, ''), nullif(res.id_contratacao_pncp, ''), b.numero_controle_pncp_compra, 'ext:compras_14133:' || res.id_compra) as compra_id_canonico,
    res.numero_item_pncp as numero_item,
    coalesce(case when res.codigo_pdm ~ '^\d+$' then res.codigo_pdm::integer end, case when ci.codigo_pdm ~ '^\d+$' then ci.codigo_pdm::integer end) as codigo_pdm,
    res.codigo_item_catalogo::bigint as codigo_item,
    res.marca,
    res.fabricante,
    res.modelo,
    res.quantidade_homologada as quantidade,
    res.valor_unitario_homologado as preco_unitario,
    res.valor_total_homologado as valor_total,
    coalesce(res.data_resultado_pncp::date, res.data_inclusao_pncp::date) as data_venda,
    coalesce(nullif(regexp_replace(res.unidade_orgao_codigo_unidade::text, '\D', '', 'g'), ''), nullif(regexp_replace(res.orgao_entidade_cnpj, '\D', '', 'g'), ''), 'org:14133') as orgao_identificador,
    res.orgao_entidade_cnpj as orgao_nome,
    case
      when res.codigo_item_catalogo is not null and ci.codigo_item is not null then 'catmat_oficial'
      when res.codigo_pdm is not null then 'pdm_oficial'
      else 'sem_pdm'
    end as cobertura,
    false as eh_ata_rp,
    'contratacao_direta'::text as valor_origem
  from public.resultados_itens_14133 res
  left join compras_pncp_bridge b on b.id_compra = res.id_compra
  left join public.catmat_itens ci on ci.codigo_item = res.codigo_item_catalogo
  where res.ni_fornecedor is not null
    and coalesce(res.situacao_compra_item_resultado_nome, '') <> 'Cancelado'
    -- Filtro estrito: somente produtos/materiais, nunca servicos
    and coalesce(res.material_ou_servico, res.tipo_item, 'M') ~* '^(m|material)'
    and coalesce(case when res.codigo_pdm ~ '^\d+$' then res.codigo_pdm::integer end, case when ci.codigo_pdm ~ '^\d+$' then ci.codigo_pdm::integer end) in (select codigo_pdm from pdms_escopo)
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
  -- Deduplica vendas: chave canônica composta por:
  -- (cnpj, compra_id_canonico, coalesce(numero_item::text, 'cod:' || coalesce(codigo_item::text, 'pdm:' || coalesce(codigo_pdm::text, '0'))))
  -- Inclui codigo_pdm no fallback para que vendas sem numero_item nem codigo_item não colapsem em cod:0
  select distinct on (cnpj, compra_id_canonico, coalesce(numero_item::text, 'cod:' || coalesce(codigo_item::text, 'pdm:' || coalesce(codigo_pdm::text, '0'))))
    cnpj,
    nome_fornecedor,
    fonte_origem,
    compra_id_canonico,
    numero_item,
    codigo_pdm,
    codigo_item,
    marca,
    fabricante,
    modelo,
    quantidade,
    preco_unitario,
    valor_total,
    data_venda,
    orgao_identificador,
    orgao_nome,
    cobertura,
    eh_ata_rp,
    valor_origem
  from todas_vendas
  order by cnpj, compra_id_canonico, coalesce(numero_item::text, 'cod:' || coalesce(codigo_item::text, 'pdm:' || coalesce(codigo_pdm::text, '0'))),
           (codigo_item is not null) desc,
           (preco_unitario is not null) desc,
           (marca is not null) desc,
           (quantidade is not null) desc,
           data_venda desc nulls last
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
    ) order by o.frequencia desc, o.total_valor desc nulls last) as orgaos_clientes
  from (
    select
      cnpj,
      orgao_identificador,
      (array_agg(orgao_nome order by data_venda desc nulls last) filter (where orgao_nome is not null))[1] as nome_amostra,
      count(*)::integer as frequencia,
      sum(valor_total)::numeric(18,2) as total_valor,
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
    count(distinct v.compra_id_canonico)::integer as total_certames,
    count(distinct v.orgao_identificador) filter (where v.orgao_identificador is not null and v.orgao_identificador <> '')::integer as total_orgaos,
    -- Separação solicitada pelo dono: valor_registrado_ata e valor_homologado_contratacao
    -- Preservar NULL se nenhum valor oficial foi informado (não coalescer para 0)
    sum(v.valor_total) filter (where not v.eh_ata_rp)::numeric(18,2) as valor_homologado_contratacao,
    sum(v.valor_total) filter (where v.eh_ata_rp)::numeric(18,2) as valor_registrado_ata,
    sum(v.valor_total)::numeric(18,2) as valor_total_vendido,
    array_agg(distinct upper(trim(v.marca))) filter (where v.marca is not null and trim(v.marca) <> '') as marcas_entregues,
    array_agg(distinct upper(trim(v.fabricante))) filter (where v.fabricante is not null and trim(v.fabricante) <> '') as fabricantes_entregues,
    -- Contagem explícita de coberturas para transparência total
    count(*) filter (where v.cobertura = 'catmat_oficial')::integer as qtd_itens_catmat_oficial,
    count(*) filter (where v.cobertura = 'pdm_oficial')::integer as qtd_itens_pdm_oficial,
    count(*) filter (where v.cobertura = 'pdm_palavra')::integer as qtd_itens_pdm_palavra,
    count(*) filter (where v.cobertura = 'sem_pdm')::integer as qtd_itens_sem_pdm,
    array_agg(distinct v.cobertura) filter (where v.cobertura is not null) as coberturas,
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
  case
    when f.cnae_principal is not null and left(lpad(f.cnae_principal::text, 7, '0'), 2)::integer between 10 and 33 then 'fabricante'
    when f.cnae_principal is not null and left(lpad(f.cnae_principal::text, 7, '0'), 2)::integer between 45 and 47 then 'revenda'
    when exists (
      select 1 from unnest(t.marcas_entregues) m
      where m is not null and length(m) >= 4 and upper(coalesce(f.razao_social, t.nome_fornecedor)) like '%' || m || '%'
    ) then 'fabricante'
    else 'nao_classificado'
  end as tipo_fornecedor,
  case
    when f.cnae_principal is not null and left(lpad(f.cnae_principal::text, 7, '0'), 2)::integer between 10 and 33 then 'cnae_industria'
    when f.cnae_principal is not null and left(lpad(f.cnae_principal::text, 7, '0'), 2)::integer between 45 and 47 then 'cnae_comercio'
    when exists (
      select 1 from unnest(t.marcas_entregues) m
      where m is not null and length(m) >= 4 and upper(coalesce(f.razao_social, t.nome_fornecedor)) like '%' || m || '%'
    ) then 'marca_propria'
    else 'sem_fonte'
  end as tipo_fornecedor_motivo,
  case
    when f.cnae_principal is not null and left(lpad(f.cnae_principal::text, 7, '0'), 2)::integer between 10 and 33 then 'alta_cnae_industria'
    when f.cnae_principal is not null and left(lpad(f.cnae_principal::text, 7, '0'), 2)::integer between 45 and 47 then 'alta_cnae_comercio'
    when exists (
      select 1 from unnest(t.marcas_entregues) m
      where m is not null and length(m) >= 4 and upper(coalesce(f.razao_social, t.nome_fornecedor)) like '%' || m || '%'
    ) then 'media_coincidencia_marca'
    else 'sem_dados'
  end as tipo_fornecedor_confianca,
  -- Cobertura hierárquica baseada na evidência mais fraca se houver mistura, com contagens individuais
  case
    when 'pdm_palavra' = any(t.coberturas) then 'pdm_palavra'
    when 'pdm_oficial' = any(t.coberturas) then 'pdm_oficial'
    when 'catmat_oficial' = any(t.coberturas) then 'catmat_oficial'
    else 'sem_pdm'
  end as cobertura_predominante,
  t.qtd_itens_catmat_oficial,
  t.qtd_itens_pdm_oficial,
  t.qtd_itens_pdm_palavra,
  t.qtd_itens_sem_pdm,
  f.uf as uf_sede,
  f.municipio as municipio_sede,
  f.porte,
  t.total_vendas_homologadas,
  t.total_certames,
  t.total_orgaos,
  t.valor_homologado_contratacao,
  t.valor_registrado_ata,
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

comment on view public.v_bi_fornecedor_historico is 'Inteligência de fornecedor histórico (somente compras homologadas/encerradas): tipo fabricante x revenda, marcas entregues, preços por item CATMAT/PDM, separação entre contratação e ata RP e contagem de cobertura.';

-- -----------------------------------------------------------------------------
-- 4. ACL das Views de BI
-- Mantém permissões fechadas: security_invoker = true, apenas service_role
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
