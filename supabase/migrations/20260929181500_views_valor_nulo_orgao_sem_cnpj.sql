-- LicitaGym: views fornecedores_homologados, orgaos_compradores e homologacoes_itens — lance perdedor não conta
-- como vencedor, valor ausente fica NULL e órgão sem CNPJ ganha chave própria.
--
-- Por que numa migration nova: as três views nasceram nas versões recuperadas 20260929104503, 20260929104936 e
-- 20260929105430 (PR #82), que já constam em supabase_migrations.schema_migrations e são puladas no deploy.
-- Corrigir aqueles arquivos não mudaria produção; esta migration recria as views com create or replace.
-- Usa public.norm_txt(text) (20260929105430). Depois da 20260929145232 (ACL do L3) e antes da 20260930120000
-- (Órgãos PR 1a), que não mexe nestas views.
--
-- 1) Lance perdedor não é homologado/vencedor (review Copilot 4136136390 e 4136136478, PR #82)
--    O coletor Paradigma grava em licitacao_resultados também cada lance perdedor, com vencedor = false. As
--    views tratavam toda linha de resultado como homologada. Agora as três só agregam/listam resultados com
--    "vencedor is distinct from false": entram vencedor = true e vencedor NULL (resultados PNCP legados, que não
--    preenchem o campo); sai só vencedor = false.
--    - fornecedores_homologados (Copilot 4136136390): filtro na CTE r; afeta todas as colunas agregadas
--      (qtd_editais, qtd_itens, valor_total_homologado, qtd_orgaos, ufs_vitoria, marcas, datas, modalidades...).
--      Fornecedor que só tem lances perdedores sai da view.
--    - homologacoes_itens (Copilot 4136136478): filtro no where; resultado perdedor não aparece como item
--      homologado nem entra nos filtros por PDM/item/UF.
--    - orgaos_compradores (mesmo critério, por consistência): filtro na CTE res; qtd_homologadas,
--      qtd_fornecedores_vencedores e valor_homologado ignoram lances perdedores. As colunas vindas de
--      licitacoes_externas (qtd_licitacoes, valor_estimado_total...) não dependem de resultados e não mudam.
--
-- 2) orgaos_compradores: agrupamento de órgão sem CNPJ (review Codex r4135137396)
--    Antes: sem orgao_cnpj, a chave era '' e todos os órgãos sem CNPJ viravam UMA linha (id derivado do menor
--    nome); e o filtro "orgao_cnpj is not null or orgao_nome is not null" descartava as licitações que só têm
--    unidade_compradora. O portal Paradigma não traz CNPJ do órgão (só sNmEmpresa) e o coletor SEST SENAT
--    (coletor/portal.py) grava só unidade_compradora: essas licitações sumiam da view ou se misturavam.
--    Agora: chave = CNPJ (só dígitos) quando existir; senão
--      'sem-cnpj:' || fonte || ':' || md5(nome normalizado)
--    onde nome = coalesce(orgao_nome, unidade_compradora) (vazio conta como ausente) e a normalização é
--    public.norm_txt (minúsculas, sem acento) + espaços colapsados + trim. Entra toda linha com CNPJ ou com
--    orgao_nome ou com unidade_compradora. As homologações (res) passam a ser somadas pela mesma chave, então
--    órgãos sem CNPJ também mostram qtd_homologadas / valor_homologado. Para órgão com CNPJ, id, cnpj e contagens
--    não mudam; a coluna nome passa a ser o nome não vazio mais recente (orgao_nome, ou unidade_compradora).
--    As CTEs listam colunas explícitas (antes "*"), para a view não depender da ordem das colunas da tabela.
--
-- 3) Valor oficial ausente não vira R$ 0 (review Copilot r4135414081, r4135414172, r4135414219, r4135414278)
--    Decisão de produto: agregado monetário sem nenhum valor informado é NULL; contadores continuam 0.
--    - fornecedores_homologados.valor_total_homologado: sum(...) sem coalesce (e ticket_medio_edital, que
--      deriva dele, também fica NULL).
--    - orgaos_compradores.valor_estimado_total: sum(valor_total) sem coalesce.
--    - orgaos_compradores.valor_homologado: sem coalesce dentro de res nem no select final (órgão sem
--      resultado, ou com resultados todos sem valor, fica NULL).
--    sum() ignora NULL: grupo com parte dos valores informados continua somando só os informados.
--    homologacoes_itens não agrega: valor_total_homologado continua o valor da linha, sem mudança.
--
-- Mesmas colunas, nomes, tipos e ordem nas três: create or replace view mantém dono (postgres), grants e
-- dependentes (em 29/09/2026, pg_depend em produção: nenhuma view, função ou policy depende destas três).
-- security_invoker = true continua. ACL em produção (29/09/2026, só leitura, depois da 20260929145232): só
-- postgres e service_role; nada para anon/authenticated/PUBLIC — o revoke/grant abaixo só reafirma.
-- Não altera dados. Idempotente.
-- Verificação (só leitura): supabase/tests/views_valor_nulo_orgao_sem_cnpj_check.sql

begin;

set local lock_timeout = '10s';

-- 1) fornecedores_homologados (igual à 20260929104503, exceto vencedor is distinct from false na CTE r e
--    valor_total_homologado sem coalesce) --------------------------------------------------------------------
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
    and r.vencedor is distinct from false
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
    sum(valor_total_homologado) as valor_total_homologado,
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

-- 2) orgaos_compradores ------------------------------------------------------------------------------------
create or replace view public.orgaos_compradores
with (security_invoker = true) as
with base as (
  select le.id, le.fonte, le.orgao_nome, le.unidade_compradora, le.uf, le.municipio, le.valor_total,
         le.modalidade, le.objeto, le.data_publicacao,
         nullif(regexp_replace(coalesce(le.orgao_cnpj, ''), '\D', '', 'g'), '') as cnpj,
         coalesce(nullif(btrim(le.orgao_nome), ''), nullif(btrim(le.unidade_compradora), '')) as nome_org
  from public.licitacoes_externas le
),
l as (
  select coalesce(b.cnpj,
                  'sem-cnpj:' || b.fonte || ':'
                  || md5(btrim(regexp_replace(public.norm_txt(b.nome_org), '\s+', ' ', 'g')))) as org_key,
         b.*
  from base b
  where b.cnpj is not null or b.nome_org is not null
),
res as (
  select l.org_key,
         count(distinct r.licitacao_id) as qtd_homologadas,
         count(distinct r.fornecedor_cnpj) as qtd_fornecedores_vencedores,
         sum(r.valor_total_homologado) as valor_homologado
  from public.licitacao_resultados r
  join l on l.id = r.licitacao_id
  where r.vencedor is distinct from false
  group by l.org_key
),
por_mod as (
  select org_key, jsonb_object_agg(modalidade, n) as modalidades
  from (select org_key, coalesce(modalidade,'Não informada') modalidade, count(*) n from l group by 1,2) x
  group by org_key
)
select
  l.org_key as id,
  l.cnpj,
  (array_agg(l.nome_org order by l.data_publicacao desc nulls last) filter (where l.nome_org is not null))[1] as nome,
  (array_agg(l.uf order by l.data_publicacao desc nulls last) filter (where l.uf is not null))[1] as uf,
  (array_agg(l.municipio order by l.data_publicacao desc nulls last) filter (where l.municipio is not null))[1] as municipio,
  array_agg(distinct l.unidade_compradora) filter (where l.unidade_compradora is not null) as unidades_compradoras,
  count(*) as qtd_licitacoes,
  sum(l.valor_total) as valor_estimado_total,
  array_agg(distinct l.modalidade) filter (where l.modalidade is not null) as tipos_licitacao,
  array_agg(distinct l.fonte) as fontes,
  (array_agg(distinct l.objeto) filter (where l.objeto is not null))[1:5] as objetos,
  max(l.data_publicacao) as ultima_publicacao,
  min(l.data_publicacao) as primeira_publicacao,
  m.modalidades,
  coalesce(res.qtd_homologadas, 0) as qtd_homologadas,
  coalesce(res.qtd_fornecedores_vencedores, 0) as qtd_fornecedores_vencedores,
  res.valor_homologado
from l
left join por_mod m on m.org_key = l.org_key
left join res on res.org_key = l.org_key
group by l.org_key, l.cnpj, m.modalidades, res.qtd_homologadas, res.qtd_fornecedores_vencedores, res.valor_homologado;

-- 3) homologacoes_itens (igual à 20260929105430, exceto o where vencedor is distinct from false) ---------------
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
  case when ci.codigo_pdm is not null then 'catalogo' when kw.codigo_pdm is not null then 'palavra_chave' end as pdm_metodo
from public.licitacao_resultados r
join public.licitacoes_externas l on l.id = r.licitacao_id
left join public.licitacao_itens i on i.licitacao_id = r.licitacao_id and i.numero_item = r.numero_item
left join public.catmat_itens ci on ci.codigo_item::text = i.catalogo_codigo_item
left join lateral (
  select w.codigo_pdm from public.catmat_pdm_palavras w
  where ci.codigo_pdm is null and w.ativo and public.norm_txt(i.descricao) ~ w.padrao
  order by length(w.padrao) desc limit 1
) kw on true
left join public.catmat_pdms p on p.codigo_pdm = coalesce(ci.codigo_pdm::integer, kw.codigo_pdm)
where r.vencedor is distinct from false;

-- 4) ACL: create or replace mantém os grants; só reafirma o estado de produção (no-op) -----------------------
revoke all on public.fornecedores_homologados, public.orgaos_compradores, public.homologacoes_itens
  from anon, authenticated, PUBLIC;
grant all on public.fornecedores_homologados, public.orgaos_compradores, public.homologacoes_itens
  to service_role;

comment on view public.fornecedores_homologados is 'Fornecedores homologados/vencedores agregados por CNPJ (licitacao_resultados × licitacoes_externas) + enriquecimento Econodata. Só resultados com vencedor distinto de false (true ou NULL legado do PNCP); lance perdedor (vencedor = false) não entra. Leitura via Edge Function api-fornecedores-homologados (service_role).';
comment on view public.orgaos_compradores is 'Órgãos compradores agregados de licitacoes_externas + homologações. id = CNPJ (só dígitos) ou, sem CNPJ, ''sem-cnpj:<fonte>:<md5 do nome normalizado>'' (nome = orgao_nome ou unidade_compradora). Homologações só com vencedor distinto de false (lance perdedor não conta). Valores monetários NULL quando nenhum valor oficial foi informado; contadores 0. Leitura via Edge Function api-fornecedores-homologados (service_role).';
comment on view public.homologacoes_itens is 'Item homologado × fornecedor × PDM CATMAT (catálogo ou regra catmat_pdm_palavras). Só resultados com vencedor distinto de false (true ou NULL legado do PNCP); lance perdedor (vencedor = false) não entra. Base do filtro PDM/item/UF de fornecedores.';
comment on column public.orgaos_compradores.valor_estimado_total is 'Soma de licitacoes_externas.valor_total do órgão; NULL quando nenhuma licitação do órgão tem valor informado.';
comment on column public.orgaos_compradores.valor_homologado is 'Soma de licitacao_resultados.valor_total_homologado do órgão (sem lances com vencedor = false); NULL quando não há resultado com valor informado.';
comment on column public.fornecedores_homologados.valor_total_homologado is 'Soma de licitacao_resultados.valor_total_homologado do fornecedor (sem lances com vencedor = false); NULL quando nenhum resultado tem valor informado.';

commit;
