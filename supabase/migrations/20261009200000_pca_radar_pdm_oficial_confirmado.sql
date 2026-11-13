-- Radar do PCA (/pca): PDM informado pelo órgão no PNCP passa a contar como aderência confirmada.
--
-- Problema: em public.v_bi_pca_radar, `casamento_confirmado` só era true quando existia linha confirmada em
-- public.pca_item_pdm. Essa linha é gravada pelo sync-pncp-pca (linkPcaItemOrigemCodes, evidência "pncp:pdmCodigo")
-- quando a página do item é processada. O sync do PCA não completa desde 26/09/2026 (runs com lock expirado; a de
-- 09/10 10:34 parou na página 2), então itens com PDM oficial ficaram "Não confirmada". Medido em produção (só leitura,
-- 09/10): 922 de 2.608 itens ativos de 2026 com pdmCodigo oficial válido estavam sem vínculo. Exemplo: Academia
-- Nacional de Polícia, item 435 do plano 00394494000136-0-000032/2026, pdmCodigo 18452 no payload do PNCP.
--
-- Regra nova (decisão do Marcelo, 09/10): o PDM vindo do campo oficial pdmCodigo do PNCP, se existe em catmat_pdms,
-- é confirmado. O vínculo de pca_item_pdm continua valendo (inclusive o confirmado por catálogo/jaccard).
-- metodo_identificacao não muda: 'pncp_pdm_confirmado' quando há vínculo, 'pncp_pdm_origem' quando há pdm_codigo_origem.
-- 'pncp_pdm_origem' agora pode vir com casamento_confirmado true (PDM oficial numérico) ou false (valor não numérico);
-- api-pncp-pca só lê o booleano. O exists em catmat_pdms é redundante com o filtro de escopo (pdms_escopo só tem PDM
-- de catmat_pdms), mas deixa a regra explícita; custa uma busca pela PK.
-- Item identificado só por codigoItem (catmat_itens) ou só pela classe continua não confirmado.
-- Mesmas colunas, mesma ordem e mesma cardinalidade da 20261009170000; nada é apagado.
-- ACL igual: revoke de anon/authenticated/PUBLIC; select só service_role.
-- Idempotente (create or replace view). Verificação: supabase/tests/pca_radar_pdm_oficial_check.sql.

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
    -- PDM vindo do campo oficial pdmCodigo do PNCP e existente no CATMAT é confirmado (decisão do Marcelo, 09/10),
    -- sem depender do vínculo pca_item_pdm gravado pelo sync.
    (
      coalesce(pip.confirmado, false)
      or exists (
        select 1 from public.catmat_pdms cp
         where i.pdm_codigo_origem ~ '^\d+$'
           and cp.codigo_pdm = case when i.pdm_codigo_origem ~ '^\d+$' then i.pdm_codigo_origem::integer end
      )
    ) as casamento_confirmado,
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
