-- LicitaGym: compra PNCP republicada conta uma vez (Oportunidades e BI), sem mexer nas linhas gravadas.
--
-- Por quê (diagnóstico só leitura no projeto ifaiagegyicjzlpskafh em 02/10/2026, ~21:30 BRT; detalhes em
--   docs da análise "duplicatas PNCP"): o órgão publica o mesmo pregão duas vezes no PNCP (uma pelo sistema
--   próprio e outra pela plataforma de disputa, ou uma republicação com prazo novo). Agrupando fonte='pncp' por
--   (orgao_cnpj, processo_norm, numero_edital) há 11 grupos / 22 linhas, todos a mesma compra (itens com as
--   mesmas quantidades e valores). Efeito: +8 linhas em Oportunidades (+4 leads, +4 monitorar; 673 -> 665 em
--   02/10 22:36 BRT, escopo leads+monitorar do #134) e resultados homologados somados em dobro no BI (ex.: Monte
--   Santo de Minas, compras PNCP 228 e 229: 48.026,00 -> 43.702,00 em v_bi_orgaos_match).
--
-- Decisão (02/10/2026): as linhas continuam fiéis ao PNCP (nenhum dado muda); deduplica na leitura.
--   Chave: fonte='pncp' e (orgao_cnpj, processo_norm, numero_edital) iguais, os três NOT NULL. Linha fora de
--     grupo é canônica de si mesma (inclusive toda linha não PNCP ou com processo/edital NULL).
--   Canônica do grupo: maior data_fim -> mais itens com valor_unitario_estimado > 0 -> mais resultados ->
--     valor_total preenchido -> data_publicacao mais recente -> menor id.
--
-- O que esta migration faz (só views; nenhuma tabela é alterada; nenhuma linha é escrita):
--   public.licitacoes_pncp_canonica (nova): id, canonica_id, eh_canonica, n_publicacoes para TODA linha de
--     licitacoes_externas. security_invoker; SELECT só para service_role.
--   public.licitacoes_externas_prioridade_efetiva: + canonica_id, eh_canonica no fim (resto idêntico ao
--     20260930200000). A Edge Function api-dashboard-oportunidades filtra eh_canonica na lista/contagem.
--   public.v_bi_resultados_itens, public.oportunidades_borracha: só linhas canônicas.
--   public.v_bi_orgaos_match (licitacoes_homolog) e public.v_bi_fornecedor_historico (f_resultados): só canônica;
--     na ponte Compras.gov -> PNCP da v_bi_fornecedor_historico, o número de controle é o da canônica.
--   Corpos copiados de 20260929140100, 20260924100000 e 20261002160000 (conferidos com pg_get_viewdef de prod
--   em 02/10/2026); só as linhas marcadas mudam. create or replace mantém ACL e comentários das views existentes.
--
-- Fora daqui (PR do RAG, logo depois): indexador e match_licitacao_chunks_v2 usam canonica_id desta view.
--
-- Idempotente (create or replace + revoke/grant; pode rodar duas vezes). Verificação (só leitura):
--   supabase/tests/licitacoes_pncp_canonica_check.sql; casos sintéticos: supabase/tests/licitacoes_pncp_canonica_fixtures_check.sql
-- Rollback (sem DROP): reaplicar com create or replace os corpos anteriores das 4 views BI (20260929140100,
--   20260924100000, 20261002160000) e reverter a Edge Function. canonica_id/eh_canonica podem ficar na view de
--   prioridade (create or replace não remove coluna; removê-las exigiria drop/recreate das dependentes v_bi_*).

begin;

-- Falha rápido em vez de esperar atrás de uma transação longa do coletor.
set local lock_timeout = '10s';

-- 1. Canônica por grupo de republicação
create or replace view public.licitacoes_pncp_canonica
with (security_invoker = true) as
with grupos as (
  -- só grupos com 2+ compras: as contagens abaixo ficam restritas a essas linhas
  select l.orgao_cnpj, l.processo_norm, l.numero_edital
  from public.licitacoes_externas l
  where l.fonte = 'pncp'
    and l.orgao_cnpj is not null
    and l.processo_norm is not null
    and l.numero_edital is not null
  group by l.orgao_cnpj, l.processo_norm, l.numero_edital
  having count(*) > 1
),
membros as (
  select
    l.id, l.orgao_cnpj, l.processo_norm, l.numero_edital, l.data_fim, l.valor_total, l.data_publicacao,
    (select count(*) from public.licitacao_itens i
      where i.licitacao_id = l.id and i.valor_unitario_estimado > 0) as itens_com_valor,
    (select count(*) from public.licitacao_resultados r where r.licitacao_id = l.id) as n_resultados
  from public.licitacoes_externas l
  join grupos g
    on g.orgao_cnpj = l.orgao_cnpj and g.processo_norm = l.processo_norm and g.numero_edital = l.numero_edital
  where l.fonte = 'pncp'
),
ordenados as (
  select
    m.id,
    first_value(m.id) over w as canonica_id,
    count(*) over (partition by m.orgao_cnpj, m.processo_norm, m.numero_edital) as n_publicacoes
  from membros m
  window w as (
    partition by m.orgao_cnpj, m.processo_norm, m.numero_edital
    order by m.data_fim desc nulls last,
             m.itens_com_valor desc,
             m.n_resultados desc,
             (m.valor_total is not null) desc,
             m.data_publicacao desc nulls last,
             m.id
  )
)
select
  l.id,
  coalesce(o.canonica_id, l.id) as canonica_id,
  (o.canonica_id is null or o.canonica_id = l.id) as eh_canonica,
  coalesce(o.n_publicacoes, 1)::integer as n_publicacoes
from public.licitacoes_externas l
left join ordenados o on o.id = l.id;

-- 2. Oportunidades (Edge Function api-dashboard-oportunidades): mesma view, duas colunas novas no fim.
create or replace view public.licitacoes_externas_prioridade_efetiva
with (security_invoker = true) as
select
  l.id,
  l.fonte,
  l.modulo,
  l.id_externo,
  l.codigo_externo,
  l.numero_processo,
  l.processo_norm,
  l.numero_edital,
  l.objeto,
  l.unidade_compradora,
  l.modalidade,
  l.fase,
  l.situacao,
  l.data_inicio,
  l.data_fim,
  l.valor_total,
  l.orgao_cnpj,
  l.orgao_nome,
  l.municipio,
  l.uf,
  l.data_publicacao,
  l.data_homologacao,
  l.categoria_escopo,
  l.interesse_borracha,
  case
    when e.encerramento is not null then 'historico'
    when j.prazo_encerrado then 'monitorar'
    else l.prioridade
  end as prioridade,
  l.termos_busca,
  l.created_at,
  l.updated_at,
  l.last_synced_at,
  l.prioridade as prioridade_gravada,
  case
    when e.encerramento is not null then e.encerramento
    when j.prazo_encerrado then 'prazo_encerrado'
  end as prioridade_motivo,
  c.canonica_id,
  c.eh_canonica
from public.licitacoes_externas l
join public.licitacoes_pncp_canonica c on c.id = l.id
cross join lateral (
  select case
    when l.data_homologacao is not null then 'data_homologacao'
    when exists (select 1 from public.licitacao_resultados r where r.licitacao_id = l.id) then 'resultado'
    when lower(coalesce(l.raw ->> 'tem_resultado', '')) in ('true', 't', '1', 'sim') then 'tem_resultado'
    when lower(coalesce(l.raw ->> 'cancelado', '')) in ('true', 't', '1', 'sim') then 'cancelado'
    when coalesce(nullif(l.situacao, ''), l.raw ->> 'situacao_nome', '')
         ~* '(revogad|anulad|cancelad|desert|fracassad|encerrad|homologad|adjudicad|conclu[ií]d|finalizad)'
      then 'situacao'
  end as encerramento
) e
cross join lateral (
  select (
    l.prioridade = 'leads'
    and coalesce(private.pncp_instante_brt(l.raw ->> 'data_fim_vigencia'), l.data_fim) <= now()
  ) is true as prazo_encerrado
) j;

-- 3. BI: compra republicada conta uma vez (só a canônica).
create or replace view public.v_bi_resultados_itens
with (security_invoker = true) as
select l.id                         as licitacao_id,
       l.fonte, l.numero_edital, l.orgao_nome, l.uf as uf_orgao, l.objeto,
       l.data_homologacao,
       i.numero_item,
       i.catalogo_codigo_item       as codigo_produto,
       i.descricao                  as descricao_item,
       i.familia_equipamento,
       i.no_taxonomia,
       i.fonte_carga,
       i.quantidade,
       i.valor_unitario_estimado    as valor_referencia_unit,
       i.situacao                   as situacao_item,
       r.ranking, r.vencedor, r.situacao as situacao_proposta,
       r.fornecedor_nome, r.fornecedor_cnpj,
       f.razao_social               as razao_social_receita,
       f.fabricante,
       case when f.fabricante then 'fabricante' when f.cnpj is not null then 'comercio/revenda' end as tipo_fornecedor,
       f.cnae_principal, f.cnae_principal_descricao, f.uf as uf_fornecedor, f.municipio as municipio_fornecedor, f.porte,
       r.marca, r.marca_normalizada, r.modelo,
       r.valor_proposta             as valor_unit,
       r.valor_total_homologado,
       case when i.valor_unitario_estimado > 0 then round(1 - r.valor_proposta / i.valor_unitario_estimado, 4) end
                                    as desconto_vs_referencia
from public.licitacao_resultados r
join public.licitacao_itens i       on i.licitacao_id = r.licitacao_id and i.numero_item = r.numero_item
join public.licitacoes_externas l   on l.id = r.licitacao_id
join public.licitacoes_pncp_canonica cn on cn.id = l.id and cn.eh_canonica
left join public.fornecedores f     on f.cnpj = r.fornecedor_cnpj;

create or replace view public.oportunidades_borracha with (security_invoker = true) as
select l.id as licitacao_id, l.codigo_externo as numero_controle_pncp, l.orgao_nome, l.municipio, l.uf,
       l.objeto, l.situacao, l.categoria_escopo, l.prioridade, l.data_publicacao, l.data_homologacao,
       (current_date - l.data_homologacao::date) as dias_desde_homologacao,
       i.numero_item, i.descricao as item_descricao, i.quantidade, i.unidade_medida,
       i.valor_unitario_estimado,
       r.fornecedor_nome as vencedor, r.fornecedor_cnpj as vencedor_cnpj,
       r.quantidade_homologada, r.valor_unitario_homologado, r.valor_total_homologado, r.data_resultado
from public.licitacoes_externas l
join public.licitacoes_pncp_canonica cn on cn.id = l.id and cn.eh_canonica
left join public.licitacao_itens i on i.licitacao_id = l.id and (i.interesse_borracha or l.categoria_escopo = 'obra_piso')
left join public.licitacao_resultados r on r.licitacao_id = l.id and r.numero_item = i.numero_item
where l.interesse_borracha
order by (l.prioridade = 'leads') desc, l.data_homologacao desc nulls last, l.data_publicacao desc;

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
  left join public.catmat_itens ci on ci.codigo_item::text = li.catalogo_codigo_item
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
    case when li.catalogo_codigo_item ~ '^\d+$' then li.catalogo_codigo_item::bigint else null end as codigo_item,
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

-- ACL: a view nova e a de prioridade só para service_role (mesmo padrão de 20260930200000).
-- REVOKE na relação também revoga privilégios de coluna; o default privileges do schema public dá ALL a
-- anon/authenticated em objeto novo: por isso o revoke explícito.
revoke all on table public.licitacoes_pncp_canonica
  from PUBLIC, anon, authenticated, service_role;
grant select on table public.licitacoes_pncp_canonica to service_role;

revoke all on table public.licitacoes_externas_prioridade_efetiva
  from PUBLIC, anon, authenticated, service_role;
grant select on table public.licitacoes_externas_prioridade_efetiva to service_role;
-- v_bi_resultados_itens, oportunidades_borracha, v_bi_orgaos_match, v_bi_fornecedor_historico: create or replace
-- preserva os grants atuais (não mexidos aqui).

comment on view public.licitacoes_pncp_canonica is
  'Canônica de cada compra PNCP republicada. Grupo: fonte=pncp e (orgao_cnpj, processo_norm, numero_edital) iguais, os três NOT NULL; fora de grupo a linha é canônica de si mesma. Canônica: maior data_fim > mais itens com valor_unitario_estimado>0 > mais resultados > valor_total preenchido > data_publicacao mais recente > menor id. Nenhuma linha é apagada ou mesclada. security_invoker; SELECT só para service_role.';
comment on view public.licitacoes_externas_prioridade_efetiva is
  'Colunas públicas de licitacoes_externas com prioridade EFETIVA (só rebaixa): historico com qualquer sinal de encerramento; leads -> monitorar com prazo vencido (raw.data_fim_vigencia em BRT, senão data_fim); senão a gravada. prioridade_gravada = coluna da tabela. canonica_id/eh_canonica = licitacoes_pncp_canonica (Oportunidades lista só eh_canonica). security_invoker; SELECT só para service_role.';

commit;
