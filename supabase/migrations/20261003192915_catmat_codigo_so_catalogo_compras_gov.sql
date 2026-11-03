-- LicitaGym: código CATMAT só do Catálogo do Compras.gov.br (licitacao_itens.catalogo_id)
--
-- Contexto (03/10/2026): licitacao_itens.catalogo_codigo_item guarda o catalogoCodigoItem do PNCP de QUALQUER
-- catálogo. Em produção, 239 itens (10 licitações) têm código: só 6 são do "Catálogo do Compras.gov.br"
-- (raw.catalogo.id = 1; todos serviço, CATSER) e 233 do catálogo "Outros" (raw.catalogo.id = 2: código próprio do
-- órgão). Casar esse código com catmat_itens dá falso positivo: licitação 92 item 7 "BOLAS DE BASQUETE" tem o
-- código 230525, que no CATMAT é CESTO (PDM 121); licitação 397 item 36 "TOMADA" tem 93882 = CESTO ROUPA (PDM 762).
-- CATSER e CATMAT também dividem o espaço numérico, então serviço ('S') nunca casa com CATMAT.
--
-- Esta migration:
--   1) licitacao_itens.catalogo_id smallint: catalogo.id do item no PNCP (1 = Catálogo do Compras.gov.br,
--      2 = Outros). O coletor (coletor/pncp.py) passa a gravar; backfill aqui só nas linhas com código
--      (catalogo_codigo_item não nulo, 239 em produção), lendo raw->'catalogo'->>'id'. Itens do Paradigma e de
--      outras fontes ficam com NULL (código deles não é CATMAT);
--   2) índice da nova expressão de por_codigo (licitacao_itens_catmat_codigo_item_idx) no lugar do
--      licitacao_itens_catalogo_codigo_item_num_idx (20261002140000), que só a expressão antiga usava;
--   3) licitacoes_ids_por_catmat: o ramo por_codigo só aceita catalogo_id = 1 e material_ou_servico = 'M'. Resto
--      igual à 20261002170000 (assinatura, STABLE, SECURITY INVOKER, search_path, grants);
--      licitacoes_ids_por_catmat_unica só chama esta e não muda;
--   4) homologacoes_itens (20261002205000), v_bi_orgaos_match e v_bi_fornecedor_historico (20261003170000, #144: já
--      com licitacoes_pncp_canonica / eh_canonica, aplicada em produção em 03/10/2026): o join
--      com catmat_itens, o codigo_item e a cobertura 'catmat_oficial' exigem o mesmo predicado. Sem ele o item cai
--      na palavra-chave do PDM (catmat_pdm_palavras), como qualquer item sem código. create or replace com as mesmas
--      colunas, nomes, tipos e ordem: mantém dono, grants e dependentes; security_invoker = true continua.
--      homologacoes_itens ganha UMA coluna no fim, codigo_catmat (bigint): o código validado pelo mesmo predicado,
--      NULL fora dele. api-fornecedores-homologados filtra a busca por código CATMAT por ela (antes: código cru,
--      que casava código do órgão do catálogo 'Outros'). catalogo_codigo_item continua exposto cru em
--      homologacoes_itens e v_bi_resultados_itens (codigo_produto), para rastreabilidade.
--
-- Efeito medido em produção (SELECT, 03/10/2026; ver DRY-RUN-BE-CATMAT-CATALOGO.sql): por_codigo deixa de devolver 2
-- linhas (92/PDM 121 e 397/PDM 762), ambas falsos positivos; nenhum item de material tem código do catálogo 1,
-- então nenhuma licitação ganha casamento. Oportunidades (prioridade/categoria_escopo) não mudam: vêm do coletor.
--
-- Depende da 20261003170000 (#144): os corpos das views de BI são os dela; aplicar depois dela.
-- Leve: DDL + update de 239 linhas + índice de expressão em ~92 mil linhas. Idempotente.

begin;

set local lock_timeout = '10s';
set local statement_timeout = '2min';

-- 1) catalogo_id ----------------------------------------------------------------------------------------------------
alter table public.licitacao_itens add column if not exists catalogo_id smallint;

comment on column public.licitacao_itens.catalogo_id is
  'catalogo.id do item no PNCP: 1 = Catálogo do Compras.gov.br (catalogo_codigo_item é CATMAT em material, CATSER em '
  'serviço), 2 = Outros (código próprio do órgão, não é CATMAT). NULL fora do PNCP ou sem catálogo. Só catalogo_id = 1 '
  'e material_ou_servico = ''M'' casam com catmat_itens (licitacoes_ids_por_catmat, views de BI).';

update public.licitacao_itens
   set catalogo_id = (raw->'catalogo'->>'id')::smallint
 where catalogo_codigo_item is not null
   and catalogo_id is null
   and raw->'catalogo'->>'id' ~ '^\d{1,4}$';

-- 2) Índice da expressão de por_codigo ------------------------------------------------------------------------------
create index if not exists licitacao_itens_catmat_codigo_item_idx
  on public.licitacao_itens ((case when catalogo_id = 1 and material_ou_servico = 'M' and catalogo_codigo_item ~ '^\d{1,15}$'
                                   then catalogo_codigo_item::bigint end));

drop index if exists public.licitacao_itens_catalogo_codigo_item_num_idx;

-- 3) licitacoes_ids_por_catmat (igual à 20261002170000, menos o predicado de por_codigo) -----------------------------
create or replace function public.licitacoes_ids_por_catmat(
  p_grupos int[] default null,
  p_classes int[] default null,
  p_pdms int[] default null,
  p_itens int[] default null,
  p_somente_catalogo boolean default false
)
returns table (licitacao_id bigint, codigo_pdm int, codigo_item bigint, motivo text)
language sql
stable
set search_path = public, pg_temp
as $$
  with
  mapa as (select * from public.catmat_itens_mapa()),
  pdms_recorte as (
    select p.codigo_pdm
      from public.catmat_pdms p
     where (p_grupos  is null or p.codigo_grupo  = any (p_grupos))
       and (p_classes is null or p.codigo_classe = any (p_classes))
       and (p_pdms    is null or p.codigo_pdm    = any (p_pdms))
       and (p_itens   is null or p.codigo_pdm in (select m.codigo_pdm from mapa m where m.codigo_item = any (p_itens::bigint[])))
  ),
  pdms_alvo as (
    select r.codigo_pdm from pdms_recorte r
     where not coalesce(p_somente_catalogo, false)
        or r.codigo_pdm in (select e.codigo_pdm from public.catalogo_catmat_pdms_efetivos() e)
  ),
  itens_excluidos as (
    select c.codigo_item::bigint as codigo_item from public.catalogo_empresa_catmat c
     where c.nivel = 'item' and not c.incluido
  ),
  itens_avulsos as (
    select c.codigo_item::bigint as codigo_item, c.codigo_pdm from public.catalogo_empresa_catmat c
     where c.nivel = 'item' and c.incluido
       and (p_grupos  is null or c.codigo_grupo  = any (p_grupos))
       and (p_classes is null or c.codigo_classe = any (p_classes))
       and (p_pdms    is null or c.codigo_pdm    = any (p_pdms))
  ),
  itens_alvo as (
    -- itens pedidos explicitamente: dentro do recorte grupo/classe/PDM (quando informado) e, no catálogo,
    -- PDM efetivo sem exclusão do item, ou item avulso incluído
    select m.codigo_item, m.codigo_pdm from mapa m
     where p_itens is not null and m.codigo_item = any (p_itens::bigint[])
       and ((p_grupos is null and p_classes is null and p_pdms is null)
            or m.codigo_pdm in (select codigo_pdm from pdms_recorte))
       and (not coalesce(p_somente_catalogo, false)
            or (m.codigo_pdm in (select codigo_pdm from pdms_alvo)
                and m.codigo_item not in (select codigo_item from itens_excluidos))
            or m.codigo_item in (select codigo_item from itens_avulsos))
    union
    -- itens dos PDMs alvo (menos exclusões, quando for o catálogo)
    select m.codigo_item, m.codigo_pdm from mapa m
     where p_itens is null and m.codigo_pdm in (select codigo_pdm from pdms_alvo)
       and (not coalesce(p_somente_catalogo, false) or m.codigo_item not in (select codigo_item from itens_excluidos))
    union
    -- itens avulsos do catálogo (PDM não incluído como um todo): só por código
    select a.codigo_item, a.codigo_pdm from itens_avulsos a
     where coalesce(p_somente_catalogo, false) and p_itens is null
  ),
  pdms_texto as (
    -- sem p_itens: PDMs alvo (item avulso não expande para o PDM inteiro)
    select codigo_pdm from pdms_alvo where p_itens is null
    union
    -- com p_itens: PDMs dos itens pedidos que passaram no recorte (inclui avulsos; exclui itens excluídos)
    select codigo_pdm from itens_alvo where p_itens is not null
  ),
  padroes as (
    select w.codigo_pdm, w.padrao from public.catmat_pdm_palavras w
     where w.ativo and w.codigo_pdm in (select codigo_pdm from pdms_texto)
  ),
  -- padrões de exclusão (catmat_pdm_exclusoes): o mesmo texto que casar um deles não conta para o PDM
  exclusoes as (
    select x.codigo_pdm, x.padrao from public.catmat_pdm_exclusoes x
     where x.ativo and x.codigo_pdm in (select codigo_pdm from pdms_texto)
  ),
  por_codigo as (
    select li.licitacao_id, ia.codigo_pdm, ia.codigo_item, 'codigo'::text as motivo
      from public.licitacao_itens li
      -- só código do Catálogo Compras.gov.br (catalogo_id = 1) em item de material: catálogo 'Outros' (código do
      -- órgão; ex.: 230525 de 'BOLAS DE BASQUETE' é o CATMAT de CESTO) e CATSER (serviço; mesmo espaço numérico)
      -- não casam. Cast protegido: códigos não numéricos (ex.: Paradigma 'AI0300075') viram null e não casam.
      -- Mesma expressão do índice licitacao_itens_catmat_codigo_item_idx.
      join itens_alvo ia on ia.codigo_item =
           case when li.catalogo_id = 1 and li.material_ou_servico = 'M' and li.catalogo_codigo_item ~ '^\d{1,15}$'
                then li.catalogo_codigo_item::bigint end
  ),
  -- Texto, com licitacao_match carregada (licitacao_match_estado.carregado_em): lido do materializado (mesmas
  -- regras: padrão ativo do PDM casa lg_normalizar(texto) e nenhuma exclusão ativa do PDM casa). Texto ainda não
  -- recalculado (licitacao_match_pendente) fica fora do materializado e é casado ao vivo, padrão no laço externo
  -- (mantém a regex compilada no cache de regex do backend).
  -- Sem carga (fallback): o caminho ao vivo da 20261002140000, GIN trgm por ramo de topo do padrão. O estado é
  -- um InitPlan: o ramo que não vale não executa.
  carregado as materialized (
    select exists (select 1 from public.licitacao_match_estado e where e.carregado_em is not null) as ok
  ),
  ramos as (
    select pa.codigo_pdm, r.ramo
      from padroes pa
      cross join lateral unnest(public.lg_regex_ramos(pa.padrao)) as r(ramo)
     where not (select c.ok from carregado c)
  ),
  por_texto_item as (
    select m.licitacao_id, m.codigo_pdm, null::bigint as codigo_item,
           case when p_itens is null then 'texto_item' else 'texto_item_aprox' end as motivo
      from public.licitacao_match m
     where m.origem = 'texto_item'
       and (select c.ok from carregado c)
       and m.codigo_pdm in (select codigo_pdm from pdms_texto)
       and not exists (select 1 from public.licitacao_match_pendente p
                        where p.origem = 'texto_item' and p.ref_id = m.item_id)
    union all
    select li.licitacao_id, pa.codigo_pdm, null::bigint as codigo_item,
           case when p_itens is null then 'texto_item' else 'texto_item_aprox' end as motivo
      from padroes pa
      cross join lateral (
        select i.licitacao_id, i.descricao
          from public.licitacao_match_pendente p
          join public.licitacao_itens i on i.id = p.ref_id
         where p.origem = 'texto_item' and public.lg_normalizar(i.descricao) ~ pa.padrao
      ) li
     where (select c.ok from carregado c)
       and not exists (select 1 from exclusoes x
                        where x.codigo_pdm = pa.codigo_pdm and public.lg_normalizar(li.descricao) ~ x.padrao)
    union all
    select li.licitacao_id, ra.codigo_pdm, null::bigint as codigo_item,
           case when p_itens is null then 'texto_item' else 'texto_item_aprox' end as motivo
      from ramos ra
      cross join lateral (
        select i.licitacao_id, i.descricao from public.licitacao_itens i
         where public.lg_normalizar(i.descricao) ~ ra.ramo
      ) li
     where not exists (select 1 from exclusoes x
                        where x.codigo_pdm = ra.codigo_pdm and public.lg_normalizar(li.descricao) ~ x.padrao)
  ),
  por_texto_objeto as (
    select m.licitacao_id, m.codigo_pdm, null::bigint as codigo_item,
           case when p_itens is null then 'texto_objeto' else 'texto_item_aprox' end as motivo
      from public.licitacao_match m
     where m.origem = 'texto_objeto'
       and (select c.ok from carregado c)
       and m.codigo_pdm in (select codigo_pdm from pdms_texto)
       and not exists (select 1 from public.licitacao_match_pendente p
                        where p.origem = 'texto_objeto' and p.ref_id = m.licitacao_id)
    union all
    select le.id as licitacao_id, pa.codigo_pdm, null::bigint as codigo_item,
           case when p_itens is null then 'texto_objeto' else 'texto_item_aprox' end as motivo
      from padroes pa
      cross join lateral (
        select e.id, e.objeto
          from public.licitacao_match_pendente p
          join public.licitacoes_externas e on e.id = p.ref_id
         where p.origem = 'texto_objeto' and public.lg_normalizar(e.objeto) ~ pa.padrao
      ) le
     where (select c.ok from carregado c)
       and not exists (select 1 from exclusoes x
                        where x.codigo_pdm = pa.codigo_pdm and public.lg_normalizar(le.objeto) ~ x.padrao)
    union all
    select le.id as licitacao_id, ra.codigo_pdm, null::bigint as codigo_item,
           case when p_itens is null then 'texto_objeto' else 'texto_item_aprox' end as motivo
      from ramos ra
      cross join lateral (
        select e.id, e.objeto from public.licitacoes_externas e
         where public.lg_normalizar(e.objeto) ~ ra.ramo
      ) le
     where not exists (select 1 from exclusoes x
                        where x.codigo_pdm = ra.codigo_pdm and public.lg_normalizar(le.objeto) ~ x.padrao)
  ),
  nos_alvo as (
    select t.no_taxonomia, t.codigo_pdm from public.taxonomia_no_pdm t
     where t.codigo_pdm in (select codigo_pdm from pdms_texto)
  ),
  por_taxonomia as (
    select li.licitacao_id, n.codigo_pdm, null::bigint as codigo_item,
           case when p_itens is null then 'taxonomia' else 'taxonomia_aprox' end as motivo
      from public.licitacao_itens li
      join nos_alvo n on n.no_taxonomia = coalesce(li.no_taxonomia, li.taxonomia->>'no_taxonomia')
  ),
  por_taxonomia_objeto as (
    select le.id as licitacao_id, n.codigo_pdm, null::bigint as codigo_item,
           case when p_itens is null then 'taxonomia_objeto' else 'taxonomia_aprox' end as motivo
      from public.licitacoes_externas le
      join nos_alvo n on n.no_taxonomia = le.no_taxonomia
  )
  select distinct * from (
    select * from por_codigo
    union all select * from por_texto_item
    union all select * from por_texto_objeto
    union all select * from por_taxonomia
    union all select * from por_taxonomia_objeto
  ) t
$$;

-- 4) Views com o mesmo predicado ------------------------------------------------------------------------------------
-- homologacoes_itens (igual à 20261002205000, menos o join com catmat_itens; + codigo_catmat no fim)
create or replace view public.homologacoes_itens
with (security_invoker = true) as
select
  r.id as resultado_id,
  r.fornecedor_cnpj,
  r.licitacao_id,
  r.numero_item,
  l.uf,
  l.orgao_cnpj,
  l.modalidade,
  i.descricao as item_descricao,
  i.catalogo_codigo_item,
  r.valor_total_homologado,
  coalesce(ci.codigo_pdm::integer, kw.codigo_pdm) as codigo_pdm,
  p.nome_pdm,
  case when ci.codigo_pdm is not null then 'catalogo' when kw.codigo_pdm is not null then 'palavra_chave' end as pdm_metodo,
  -- código CATMAT validado (20261003180000): só Catálogo Compras.gov.br (catalogo_id = 1) em material; NULL para
  -- 'Outros' (código do órgão), CATSER e código não numérico. catalogo_codigo_item segue cru (rastreabilidade).
  case when i.catalogo_id = 1 and i.material_ou_servico = 'M' and i.catalogo_codigo_item ~ '^\d{1,15}$'
       then i.catalogo_codigo_item::bigint end as codigo_catmat
from public.licitacao_resultados r
join public.licitacoes_externas l on l.id = r.licitacao_id
left join public.licitacao_itens i on i.licitacao_id = r.licitacao_id and i.numero_item = r.numero_item
-- CATMAT só do Catálogo Compras.gov.br (catalogo_id = 1) em material; 'Outros' e CATSER caem na palavra-chave
left join public.catmat_itens ci on i.catalogo_id = 1 and i.material_ou_servico = 'M'
                               and ci.codigo_item::text = i.catalogo_codigo_item
left join lateral (
  select w.codigo_pdm from public.catmat_pdm_palavras w
  where ci.codigo_pdm is null and w.ativo and public.norm_txt(i.descricao) ~ w.padrao
  order by length(w.padrao) desc limit 1
) kw on true
left join public.catmat_pdms p on p.codigo_pdm = coalesce(ci.codigo_pdm::integer, kw.codigo_pdm)
where r.vencedor is distinct from false
  and coalesce(r.situacao, '') <> 'Cancelado';

-- v_bi_orgaos_match (igual à 20261003170000, menos o join com catmat_itens)
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
    -- NULL quando nenhum item planejado do órgão tem valor informado
    sum(r.valor_total)::numeric(18,2) as valor_planejado_pca,
    max(r.data_prevista) as ultima_data_prevista,
    -- v_bi_pca_radar cai no CNPJ quando não tem nome: aqui isso não conta como nome
    (array_agg(btrim(r.orgao_nome) order by r.data_prevista desc nulls last)
       filter (where nullif(btrim(r.orgao_nome), '') is not null
                 and regexp_replace(r.orgao_nome, '\D', '', 'g') is distinct from r.orgao_cnpj))[1] as nome_origem
  from public.v_bi_pca_radar r
  group by r.orgao_cnpj
),
compras_14133_homolog as (
  select
    'compras_14133'::text as fonte_origem,
    'compras_14133:' || res.id::text as linha_id,
    regexp_replace(coalesce(res.orgao_entidade_cnpj, ''), '\D', '', 'g') as orgao_cnpj,
    coalesce(nullif(res.numero_controle_pncp_compra, ''), nullif(res.id_contratacao_pncp, ''),
             'ext:compras_14133:' || nullif(res.id_compra, '')) as compra_id,
    res.numero_item_pncp as numero_item,
    res.valor_total_homologado,
    coalesce(res.data_resultado_pncp::date, res.data_inclusao_pncp::date) as data_resultado,
    null::text as nome_origem,
    nullif(btrim(res.unidade_orgao_uf_sigla), '') as uf_origem
  from public.resultados_itens_14133 res
  left join public.catmat_itens ci on ci.codigo_item = res.codigo_item_catalogo
  where res.orgao_entidade_cnpj is not null
    and coalesce(res.situacao_compra_item_resultado_nome, '') <> 'Cancelado'
    and coalesce(res.material_ou_servico, res.tipo_item, 'M') ~* '^(m|material)'
    and coalesce(case when res.codigo_pdm ~ '^\d+$' then res.codigo_pdm::integer end, case when ci.codigo_pdm ~ '^\d+$' then ci.codigo_pdm::integer end) in (select codigo_pdm from pdms_escopo)
),
licitacoes_homolog as (
  select
    'licitacao_resultados'::text as fonte_origem,
    'licitacao_resultados:' || r.id::text as linha_id,
    regexp_replace(coalesce(l.orgao_cnpj, ''), '\D', '', 'g') as orgao_cnpj,
    case
      when l.fonte = 'pncp' and nullif(l.codigo_externo, '') is not null then l.codigo_externo
      when l.modulo is not null and l.id_externo is not null then 'ext:' || l.fonte || ':' || l.modulo::text || '/' || l.id_externo::text
      when nullif(l.codigo_externo, '') is not null then 'ext:' || l.fonte || ':cod:' || l.codigo_externo
    end as compra_id,
    r.numero_item,
    r.valor_total_homologado,
    coalesce(r.data_resultado::date, l.data_homologacao::date) as data_resultado,
    coalesce(nullif(btrim(l.orgao_nome), ''), nullif(btrim(l.unidade_compradora), '')) as nome_origem,
    nullif(btrim(l.uf), '') as uf_origem
  from public.licitacao_resultados r
  join public.licitacoes_externas_prioridade_efetiva l on l.id = r.licitacao_id
  left join public.licitacao_itens li on li.licitacao_id = r.licitacao_id and li.numero_item = r.numero_item
  -- CATMAT só do Catálogo Compras.gov.br (catalogo_id = 1) em material (20261003180000)
  left join public.catmat_itens ci on li.catalogo_id = 1 and li.material_ou_servico = 'M'
                                 and ci.codigo_item::text = li.catalogo_codigo_item
  left join lateral (
    select w.codigo_pdm from public.catmat_pdm_palavras w
    where ci.codigo_pdm is null and w.ativo and public.norm_txt(li.descricao) ~ w.padrao
    order by length(w.padrao) desc limit 1
  ) kw on true
  where r.vencedor is distinct from false
    and coalesce(r.situacao, '') <> 'Cancelado'
    and l.prioridade = 'historico'
    and l.eh_canonica
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
-- Uma fonte por (órgão, certame, item); todos os resultados dessa fonte entram (vários vencedores/cotas do
-- mesmo item não colapsam). Desempate determinístico: valor presente, nome da fonte, id da linha de origem.
fonte_escolhida as (
  select distinct on (orgao_cnpj, compra_id, numero_item)
    orgao_cnpj, compra_id, numero_item, fonte_origem
  from todas_homolog
  where orgao_cnpj <> '' and compra_id is not null
  order by orgao_cnpj, compra_id, numero_item,
           (valor_total_homologado is not null) desc, fonte_origem, linha_id
),
homolog_dedup as (
  select t.*
  from todas_homolog t
  where t.orgao_cnpj <> ''
    and (
      t.compra_id is null  -- sem identificador externo: nada com que casar, cada resultado conta
      or exists (
        select 1 from fonte_escolhida f
        where f.orgao_cnpj = t.orgao_cnpj
          and f.compra_id = t.compra_id
          and f.numero_item is not distinct from t.numero_item
          and f.fonte_origem = t.fonte_origem
      )
    )
),
homologado_por_orgao as (
  select
    orgao_cnpj,
    count(*)::integer as qtd_itens_homologados,
    -- NULL quando nenhum resultado do órgão tem valor informado
    sum(valor_total_homologado)::numeric(18,2) as valor_homologado,
    max(data_resultado) as ultima_data_homologada,
    (array_agg(nome_origem order by data_resultado desc nulls last, linha_id) filter (where nome_origem is not null))[1] as nome_origem,
    (array_agg(uf_origem order by data_resultado desc nulls last, linha_id) filter (where uf_origem is not null))[1] as uf_origem
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
  coalesce(nullif(btrim(o.nome_orgao), ''), nullif(btrim(o.razao_social), ''), h.nome_origem, pl.nome_origem) as orgao_nome,
  coalesce(o.esfera_canon, o.esfera) as esfera,
  coalesce(nullif(btrim(o.uf), ''), h.uf_origem) as uf,
  coalesce(pl.qtd_itens_planejados, 0) as qtd_itens_planejados,
  pl.valor_planejado_pca,
  coalesce(h.qtd_itens_homologados, 0) as qtd_itens_homologados,
  h.valor_homologado,
  pl.ultima_data_prevista,
  h.ultima_data_homologada
from todos_cnpjs c
left join public.orgaos o on o.cnpj = c.orgao_cnpj
left join planejado_por_orgao pl on pl.orgao_cnpj = c.orgao_cnpj
left join homologado_por_orgao h on h.orgao_cnpj = c.orgao_cnpj
order by h.valor_homologado desc nulls last, pl.valor_planejado_pca desc nulls last, c.orgao_cnpj;

-- v_bi_fornecedor_historico (igual à 20261003170000, menos codigo_item, cobertura e o join com catmat_itens)
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
    -- compra PNCP republicada: a ponte aponta para o número de controle da canônica
    select substring(le.raw->>'link_sistema_origem' from '[?&]compra=(\d{17})') as id_compra,
           lc.codigo_externo as numero_controle_pncp_compra,
           3 as prio
    from public.licitacoes_externas le
    join public.licitacoes_pncp_canonica cn on cn.id = le.id
    join public.licitacoes_externas lc on lc.id = cn.canonica_id
    where le.fonte = 'pncp'
      and le.codigo_externo is not null
      and le.raw->>'link_sistema_origem' is not null
      and substring(le.raw->>'link_sistema_origem' from '[?&]compra=(\d{17})') is not null
  ) m
  where id_compra is not null and numero_controle_pncp_compra is not null
  order by id_compra, prio, numero_controle_pncp_compra
),
-- Origem 1: licitacao_resultados homologados do banco (PNCP e Paradigma/SEST)
f_resultados as (
  select
    regexp_replace(r.fornecedor_cnpj, '\D', '', 'g') as cnpj,
    r.fornecedor_nome as nome_fornecedor,
    'licitacao_resultados'::text as fonte_origem,
    'licitacao_resultados:' || r.id::text as linha_id,
    case
      when l.fonte = 'pncp' and nullif(l.codigo_externo, '') is not null then l.codigo_externo
      when l.modulo is not null and l.id_externo is not null then 'ext:' || l.fonte || ':' || l.modulo::text || '/' || l.id_externo::text
      when nullif(l.codigo_externo, '') is not null then 'ext:' || l.fonte || ':cod:' || l.codigo_externo
    end as compra_id_canonico,
    r.numero_item,
    coalesce(case when ci.codigo_pdm ~ '^\d+$' then ci.codigo_pdm::integer end, kw.codigo_pdm) as codigo_pdm,
    case when li.catalogo_id = 1 and li.material_ou_servico = 'M' and li.catalogo_codigo_item ~ '^\d+$' then li.catalogo_codigo_item::bigint else null end
      as codigo_item,
    coalesce(r.marca_normalizada, r.marca) as marca,
    null::text as fabricante,
    r.modelo,
    r.quantidade_homologada as quantidade,
    r.valor_unitario_homologado as preco_unitario,
    r.valor_total_homologado as valor_total,
    coalesce(r.data_resultado::date, l.data_homologacao::date) as data_venda,
    -- CNPJ; sem CNPJ, chave da 20260929181500 (sem-cnpj:<fonte>:md5(nome normalizado)); sem nome, NULL
    coalesce(
      nullif(regexp_replace(coalesce(l.orgao_cnpj, ''), '\D', '', 'g'), ''),
      -- norm_txt(NULL) devolve '': sem nome não há chave (senão todos os sem nome virariam um órgão só)
      case when coalesce(nullif(btrim(l.orgao_nome), ''), nullif(btrim(l.unidade_compradora), '')) is not null then
        'sem-cnpj:' || l.fonte || ':'
          || md5(btrim(regexp_replace(public.norm_txt(
               coalesce(nullif(btrim(l.orgao_nome), ''), nullif(btrim(l.unidade_compradora), ''))), '\s+', ' ', 'g')))
      end
    ) as orgao_identificador,
    coalesce(nullif(btrim(l.orgao_nome), ''), nullif(btrim(l.unidade_compradora), '')) as orgao_nome,
    case
      when li.catalogo_id = 1 and li.material_ou_servico = 'M' and li.catalogo_codigo_item ~ '^\d+$' and ci.codigo_item is not null then 'catmat_oficial'
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
  -- CATMAT só do Catálogo Compras.gov.br (catalogo_id = 1) em material (20261003180000)
  left join public.catmat_itens ci on li.catalogo_id = 1 and li.material_ou_servico = 'M'
                                 and ci.codigo_item::text = li.catalogo_codigo_item
  left join lateral (
    select w.codigo_pdm from public.catmat_pdm_palavras w
    where ci.codigo_pdm is null and w.ativo and public.norm_txt(li.descricao) ~ w.padrao
    order by length(w.padrao) desc limit 1
  ) kw on true
  where r.fornecedor_cnpj is not null
    and r.vencedor is distinct from false
    and coalesce(r.situacao, '') <> 'Cancelado'
    and l.prioridade = 'historico'
    and l.eh_canonica
    and (
      li.material_ou_servico = 'M'
      or (li.material_ou_servico is null and coalesce(case when ci.codigo_pdm ~ '^\d+$' then ci.codigo_pdm::integer end, kw.codigo_pdm) in (select codigo_pdm from pdms_escopo))
    )
    and coalesce(case when ci.codigo_pdm ~ '^\d+$' then ci.codigo_pdm::integer end, kw.codigo_pdm) in (select codigo_pdm from pdms_escopo)
),
-- Origem 2: precos_praticados_itens (módulo Pesquisa de Preço Compras.gov - preços praticados/homologados)
f_precos as (
  select
    regexp_replace(p.ni_fornecedor, '\D', '', 'g') as cnpj,
    p.nome_fornecedor,
    'compras_pesquisa_preco'::text as fonte_origem,
    'compras_pesquisa_preco:' || p.id_compra || ':' || p.id_item_compra::text as linha_id,
    coalesce(b.numero_controle_pncp_compra, 'ext:compras_gov:' || nullif(p.id_compra, '')) as compra_id_canonico,
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
    coalesce(
      nullif(regexp_replace(coalesce(p.codigo_uasg, ''), '\D', '', 'g'), ''),
      case when nullif(btrim(p.nome_uasg), '') is not null then
        'sem-cnpj:compras_pesquisa_preco:'
          || md5(btrim(regexp_replace(public.norm_txt(btrim(p.nome_uasg)), '\s+', ' ', 'g')))
      end
    ) as orgao_identificador,
    nullif(btrim(p.nome_uasg), '') as orgao_nome,
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
-- Origem 3: atas_rp_itens (módulo ARP Compras.gov - valores registrados em ata)
f_atas as (
  select
    regexp_replace(a.ni_fornecedor, '\D', '', 'g') as cnpj,
    a.nome_fornecedor,
    'compras_arp'::text as fonte_origem,
    'compras_arp:' || a.id::text as linha_id,
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
    coalesce(
      nullif(regexp_replace(coalesce(a.codigo_unidade_gerenciadora::text, ''), '\D', '', 'g'), ''),
      case when nullif(btrim(a.nome_unidade_gerenciadora), '') is not null then
        'sem-cnpj:compras_arp:'
          || md5(btrim(regexp_replace(public.norm_txt(btrim(a.nome_unidade_gerenciadora)), '\s+', ' ', 'g')))
      end
    ) as orgao_identificador,
    nullif(btrim(a.nome_unidade_gerenciadora), '') as orgao_nome,
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
-- Origem 4: resultados_itens_14133 (apenas materiais/produtos)
f_14133 as (
  select
    regexp_replace(res.ni_fornecedor, '\D', '', 'g') as cnpj,
    res.nome_fornecedor,
    'compras_14133'::text as fonte_origem,
    'compras_14133:' || res.id::text as linha_id,
    coalesce(nullif(res.numero_controle_pncp_compra, ''), nullif(res.id_contratacao_pncp, ''), b.numero_controle_pncp_compra, 'ext:compras_14133:' || nullif(res.id_compra, '')) as compra_id_canonico,
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
    -- unidade, senão CNPJ do órgão; sem os dois, NULL (a 14.133 não traz nome para a chave sem-cnpj)
    coalesce(
      nullif(regexp_replace(coalesce(res.unidade_orgao_codigo_unidade::text, ''), '\D', '', 'g'), ''),
      nullif(regexp_replace(coalesce(res.orgao_entidade_cnpj, ''), '\D', '', 'g'), '')
    ) as orgao_identificador,
    -- nome oficial do cadastro de órgãos; nunca o CNPJ
    coalesce(nullif(btrim(o.nome_orgao), ''), nullif(btrim(o.razao_social), '')) as orgao_nome,
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
  left join public.orgaos o on o.cnpj = nullif(regexp_replace(coalesce(res.orgao_entidade_cnpj, ''), '\D', '', 'g'), '')
  where res.ni_fornecedor is not null
    and coalesce(res.situacao_compra_item_resultado_nome, '') <> 'Cancelado'
    -- Filtro estrito: somente produtos/materiais, nunca servicos
    and coalesce(res.material_ou_servico, res.tipo_item, 'M') ~* '^(m|material)'
    and coalesce(case when res.codigo_pdm ~ '^\d+$' then res.codigo_pdm::integer end, case when ci.codigo_pdm ~ '^\d+$' then ci.codigo_pdm::integer end) in (select codigo_pdm from pdms_escopo)
),
todas_vendas as (
  select v.*,
         coalesce(v.numero_item::text, 'cod:' || coalesce(v.codigo_item::text, 'pdm:' || coalesce(v.codigo_pdm::text, '0'))) as item_chave
  from (
    select * from f_resultados
    union all
    select * from f_precos
    union all
    select * from f_atas
    union all
    select * from f_14133
  ) v
),
-- Uma fonte por (fornecedor, certame, item): ata RP primeiro, depois completude, data, fonte e id da linha.
fonte_escolhida as (
  select distinct on (cnpj, compra_id_canonico, item_chave)
    cnpj, compra_id_canonico, item_chave, fonte_origem
  from todas_vendas
  where compra_id_canonico is not null
  order by cnpj, compra_id_canonico, item_chave,
           eh_ata_rp desc,
           (codigo_item is not null) desc,
           (preco_unitario is not null) desc,
           (marca is not null) desc,
           (quantidade is not null) desc,
           data_venda desc nulls last,
           fonte_origem,
           linha_id
),
-- Todos os resultados da fonte escolhida entram (vários resultados do mesmo item não colapsam).
vendas_dedup as (
  select t.*
  from todas_vendas t
  where t.compra_id_canonico is null  -- sem identificador externo: nada com que casar
     or exists (
       select 1 from fonte_escolhida f
       where f.cnpj = t.cnpj
         and f.compra_id_canonico = t.compra_id_canonico
         and f.item_chave = t.item_chave
         and f.fonte_origem = t.fonte_origem
     )
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
    ) order by fi.valor_total_item desc nulls last, fi.codigo_pdm, fi.codigo_item) as itens_praticados
  from fornecedor_itens fi
  group by fi.cnpj
),
orgaos_frequencia as (
  select
    o.cnpj,
    jsonb_agg(jsonb_build_object(
      'orgao_identificador', o.orgao_identificador,
      'orgao_nome', o.nome_amostra,
      'frequencia_vendas', o.frequencia,
      'valor_total', o.total_valor,
      'ultima_venda', o.ultima_data
    ) order by o.frequencia desc, o.total_valor desc nulls last, o.orgao_identificador) as orgaos_clientes
  from (
    select
      cnpj,
      orgao_identificador,
      (array_agg(orgao_nome order by data_venda desc nulls last, linha_id) filter (where orgao_nome is not null))[1] as nome_amostra,
      count(*)::integer as frequencia,
      sum(valor_total)::numeric(18,2) as total_valor,
      max(data_venda) as ultima_data
    from vendas_dedup
    where orgao_identificador is not null
    group by cnpj, orgao_identificador
  ) o
  group by o.cnpj
),
fornecedor_totais as (
  select
    v.cnpj,
    (array_agg(v.nome_fornecedor order by v.data_venda desc nulls last, v.linha_id) filter (where v.nome_fornecedor is not null))[1] as nome_fornecedor,
    count(*)::integer as total_vendas_homologadas,
    count(distinct v.compra_id_canonico)::integer as total_certames,
    count(distinct v.orgao_identificador)::integer as total_orgaos,
    -- Separação: valor_registrado_ata x valor_homologado_contratacao; NULL se nenhum valor oficial informado
    sum(v.valor_total) filter (where not v.eh_ata_rp)::numeric(18,2) as valor_homologado_contratacao,
    sum(v.valor_total) filter (where v.eh_ata_rp)::numeric(18,2) as valor_registrado_ata,
    sum(v.valor_total)::numeric(18,2) as valor_total_vendido,
    array_agg(distinct upper(trim(v.marca))) filter (where v.marca is not null and trim(v.marca) <> '') as marcas_entregues,
    array_agg(distinct upper(trim(v.fabricante))) filter (where v.fabricante is not null and trim(v.fabricante) <> '') as fabricantes_entregues,
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


-- 5) ACL: create or replace mantém os grants; reafirma o estado de produção (como 20261002170000, 20261002205000,
-- 20261002160000 e 20261003170000) ----------------------------------------------------------------------------------------------------
revoke execute on function public.licitacoes_ids_por_catmat(int[], int[], int[], int[], boolean) from PUBLIC, anon, authenticated;
grant execute on function public.licitacoes_ids_por_catmat(int[], int[], int[], int[], boolean) to service_role;

revoke all on public.homologacoes_itens from anon, authenticated, PUBLIC;
grant all on public.homologacoes_itens to service_role;

revoke all on public.v_bi_orgaos_match from anon, authenticated, PUBLIC;
revoke all on public.v_bi_fornecedor_historico from anon, authenticated, PUBLIC;
grant select on public.v_bi_orgaos_match to service_role;
grant select on public.v_bi_fornecedor_historico to service_role;

commit;
