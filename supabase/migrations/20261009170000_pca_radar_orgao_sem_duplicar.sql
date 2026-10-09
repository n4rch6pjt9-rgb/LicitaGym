-- Corrige item repetido em public.v_bi_pca_radar (radar /pca, spec 0006).
--
-- Bug: a view fazia `left join public.orgaos o on o.cnpj = <orgao_cnpj>` só para pegar o nome do órgão. orgaos tem uma
-- linha por unidade/UASG (em 09/10/2026: 250 CNPJs repetidos, até 9x), então cada item do PCA saía N vezes. Medido em
-- produção (só leitura): itens ativos de 2026 a partir de outubro = 1.524 reais x 2.120 linhas na view (+39%); valor
-- R$ 89,3 mi real x R$ 118,9 mi somado (+33%). O Dashboard (/pca) passou a exibir a view em 09/10 e mostrava o mesmo
-- item várias vezes (ex.: Academia Nacional de Polícia, item 435 do plano 00394494000136-0-000032/2026, 6x).
--
-- Correção: o nome vem de UM registro de orgaos por CNPJ (left join lateral ... limit 1): primeiro quem tem nome, depois
-- razão social, ativo e id (ordem estável). Mesmas colunas e mesma ordem; só muda a cardinalidade. Nada é apagado.
-- ACL igual (revoke de anon/authenticated/PUBLIC; select só service_role), reaplicada aqui por clareza.
-- Outras views com o mesmo join (v_bi_orgaos_match, v_bi_fornecedor_historico) ficam para issue própria.
-- Idempotente (create or replace view com as mesmas colunas). Verificação: supabase/tests/pca_radar_orgaos_duplicado_check.sql.

begin;

set local lock_timeout = '5s';

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
    coalesce(
      case when p.codigo_pdm_material ~ '^\d+$' then p.codigo_pdm_material::integer end,
      case when ci.codigo_pdm ~ '^\d+$' then ci.codigo_pdm::integer end
    ) as codigo_pdm,
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
  -- orgaos tem uma linha por unidade: pega UM nome por CNPJ (com nome primeiro, ativo primeiro, ordem estável)
  left join lateral (
    select oo.nome_orgao, oo.razao_social
      from public.orgaos oo
     where oo.cnpj = p.orgao_cnpj
     order by (nullif(btrim(oo.nome_orgao), '') is null), (nullif(btrim(oo.razao_social), '') is null), oo.ativo desc, oo.id
     limit 1
  ) o on true
  left join public.catmat_itens ci on ci.codigo_item = p.codigo_item_catalogo
  where coalesce(
    case when p.codigo_pdm_material ~ '^\d+$' then p.codigo_pdm_material::integer end,
    case when ci.codigo_pdm ~ '^\d+$' then ci.codigo_pdm::integer end
  ) in (select codigo_pdm from pdms_escopo)
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
      case when i.pdm_codigo_origem ~ '^\d+$' then i.pdm_codigo_origem::integer end,
      case when ci.codigo_pdm ~ '^\d+$' then ci.codigo_pdm::integer end
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
  -- orgaos tem uma linha por unidade: pega UM nome por CNPJ (com nome primeiro, ativo primeiro, ordem estável)
  left join lateral (
    select oo.nome_orgao, oo.razao_social
      from public.orgaos oo
     where oo.cnpj = pl.orgao_cnpj
     order by (nullif(btrim(oo.nome_orgao), '') is null), (nullif(btrim(oo.razao_social), '') is null), oo.ativo desc, oo.id
     limit 1
  ) o on true
  left join public.pca_item_pdm pip on pip.pca_item_id = i.id and pip.confirmado = true
  left join public.catmat_itens ci on ci.codigo_item::text = i.codigo_item_origem
  where i.ativo = true and pl.ativo = true
    and coalesce(
      pip.codigo_pdm,
      case when i.pdm_codigo_origem ~ '^\d+$' then i.pdm_codigo_origem::integer end,
      case when ci.codigo_pdm ~ '^\d+$' then ci.codigo_pdm::integer end
    ) in (select codigo_pdm from pdms_escopo)
    -- Deduplicação: descarta item do PNCP que já consta no PGC para o mesmo orgao, uasg, ano e numero_item_pncp
    and not exists (
      select 1 from public.pca_pgc_itens pgc
      where pgc.orgao_cnpj = pl.orgao_cnpj
        and pgc.codigo_uasg = pl.unidade_codigo
        and pgc.ano_pca_projeto_compra = pl.ano_exercicio
        and pgc.numero_item_pncp = i.numero_item
    )
)
select * from pgc_normalizado
union all
select * from pncp_itens_norm;

revoke all on public.v_bi_pca_radar from anon, authenticated, PUBLIC;
grant select on public.v_bi_pca_radar to service_role;

commit;
