-- LicitaGym: a rota /pca precisa responder, por órgão, o plano das classes do catálogo CATMAT da empresa e o que
-- disso apareceu como compra. A lista crua de planos não separa planejado, compra observada e execução confirmada.
--
-- O que muda:
--   1. private.catalogo_classes_efetivas(): as classes CATMAT que o catálogo da empresa (catalogo_empresa_catmat)
--      deixa efetivas, depois da herança e das exclusões: classe com regra efetiva incluída no nível classe ou grupo
--      (a regra da classe vence a do grupo; incluido=false exclui), mais as classes com ao menos um PDM efetivo
--      incluído (catalogo_catmat_pdms_efetivos; PDM reincluído em classe excluída traz a classe). Item avulso
--      (nivel='item') sozinho não traz a classe: item avulso casa só por código, não expande (20260930100000).
--      É o padrão de classes do histórico e do link-pca-edital; nada fica fixo no código.
--   2. public.pca_historico_orgao_ano(p_classes, p_ano_inicio, p_ano_fim): uma linha por CNPJ e ano, só com itens de
--      PCA das classes pedidas. Função, e não view, para contar planos e execuções sem repetir o plano que tem itens
--      em mais de uma classe.
--      - Planejado: soma dos itens (não do plano), e classes_presentes lista as classes que apareceram.
--      - Compra observada no escopo: licitação já coletada do mesmo CNPJ, no ano da publicação (em Brasília), nas
--        categorias de objeto do escopo fitness. Os itens de licitação não trazem classe CATMAT (catalogo_codigo_item
--        em 239 de 92.295, nenhum casando com catmat_itens em 10/10/2026), então essa parte não é por classe: é o
--        escopo inteiro, e os nomes dizem isso (compras_escopo_observadas, valor_escopo_observado). Republicação do
--        PNCP conta uma vez (licitacoes_pncp_canonica.eh_canonica). A lista de categorias do escopo é fixa no código
--        da função (não lê objeto_categorias). Se a linha canônica de um grupo republicado cair fora da categoria ou
--        do ano, a compra não conta (as não canônicas do grupo não a substituem).
--      - Execução confirmada: só plano com pca_plano_id e pca_link_evidencia, e com item ativo das classes pedidas.
--      - Prazo: dias entre a data prevista do item e a publicação (data em Brasília) da primeira evidência do plano.
--        lag_medio_dias é a média do ano; lag_soma_dias e lag_n deixam o chamador ponderar vários anos por item.
--      Ano e data seguem o horário de Brasília (America/Sao_Paulo), como private.pncp_instante_brt (20260930200000).
--   Nada aqui grava vínculo.
--
-- Quem lê: service_role, via api-pncp-pca (depois do login) e link-pca-edital. authenticated não executa: a função
-- lê licitacoes_externas, fechada ao usuário direto. security invoker: o service_role vê só o que já pode ler.
-- Verificar: supabase/tests/pca_historico_orgao_ano_check.sql

begin;

set local lock_timeout = '10s';

-- 1) Classes efetivas do catálogo -------------------------------------------------------------------------------
create or replace function private.catalogo_classes_efetivas()
returns text[]
language sql
stable
security invoker
set search_path = ''
as $fn$
  with classes as (
    select k.codigo_grupo, k.codigo_classe from public.catmat_classes k
    union
    select r.codigo_grupo, r.codigo_classe
      from public.catalogo_empresa_catmat r
     where r.nivel = 'classe'
  )
  select coalesce(array_agg(distinct c.classe order by c.classe), '{}'::text[])
    from (
      -- regra da classe vence a do grupo; incluido=false exclui
      select k.codigo_classe::text as classe
        from classes k
        left join public.catalogo_empresa_catmat rc on rc.nivel = 'classe' and rc.codigo_classe = k.codigo_classe
        left join public.catalogo_empresa_catmat rg on rg.nivel = 'grupo' and rg.codigo_grupo = k.codigo_grupo
       where coalesce(rc.incluido, rg.incluido) is true
      union
      -- PDM efetivo incluído traz a classe (inclusive reincluído em classe excluída); item avulso não
      select e.codigo_classe::text
        from public.catalogo_catmat_pdms_efetivos() e
       where e.codigo_classe is not null
    ) c;
$fn$;

comment on function private.catalogo_classes_efetivas() is
  'Classes CATMAT efetivas do catálogo da empresa: regra incluída no nível classe ou grupo (classe vence grupo; incluido=false exclui) mais as classes com PDM efetivo incluído. Item avulso sozinho não traz a classe (casa só por código). Padrão de classes do histórico do PCA e do link-pca-edital. EXECUTE só service_role.';

revoke all on function private.catalogo_classes_efetivas() from PUBLIC, anon, authenticated, service_role;
grant execute on function private.catalogo_classes_efetivas() to service_role;

-- 2) Histórico por órgão e ano ----------------------------------------------------------------------------------
drop view if exists public.pca_historico_orgao_ano;

create or replace function public.pca_historico_orgao_ano(p_classes text[], p_ano_inicio integer, p_ano_fim integer)
returns table (
  orgao_cnpj text,
  orgao_nome text,
  uf text,
  ano_exercicio integer,
  classes_presentes text[],
  planos integer,
  itens integer,
  itens_com_valor integer,
  itens_sem_valor integer,
  valor_planejado numeric,
  unidades text[],
  compras_escopo_observadas integer,
  valor_escopo_observado numeric,
  execucoes_confirmadas integer,
  lag_medio_dias numeric,
  lag_soma_dias numeric,
  lag_n integer
)
language sql
stable
security invoker
set search_path = ''
as $fn$
with orgao as (
  select distinct on (regexp_replace(o.cnpj, '\D', '', 'g'))
         regexp_replace(o.cnpj, '\D', '', 'g') as cnpj,
         coalesce(nullif(btrim(o.uf), ''), 'sem_uf') as uf,
         coalesce(o.nome_orgao, o.razao_social) as nome
    from public.orgaos o
   where o.ativo
     and nullif(regexp_replace(o.cnpj, '\D', '', 'g'), '') is not null
   order by regexp_replace(o.cnpj, '\D', '', 'g'), (nullif(btrim(o.uf), '') is null), o.uf
),
itens as (
  select regexp_replace(p.orgao_cnpj, '\D', '', 'g') as cnpj,
         p.ano_exercicio,
         p.id as plano_id,
         p.unidade_codigo,
         i.id as item_id,
         i.classe_material_servico,
         i.valor_total_estimado,
         i.data_prevista_contratacao
    from public.pca_itens i
    join public.pca_planos p on p.id = i.pca_plano_id
   where i.ativo
     and p.ativo
     and i.classe_material_servico = any(p_classes)
     and p.ano_exercicio between p_ano_inicio and p_ano_fim
     and nullif(regexp_replace(p.orgao_cnpj, '\D', '', 'g'), '') is not null
),
planejado as (
  select cnpj,
         ano_exercicio,
         array_agg(distinct classe_material_servico order by classe_material_servico) as classes_presentes,
         count(distinct plano_id)::int as planos,
         count(item_id)::int as itens,
         (count(item_id) filter (where valor_total_estimado is not null))::int as itens_com_valor,
         sum(valor_total_estimado) filter (where valor_total_estimado is not null) as valor_planejado,
         coalesce(
           array_agg(distinct unidade_codigo) filter (where nullif(btrim(unidade_codigo), '') is not null),
           '{}'::text[]
         ) as unidades
    from itens
   group by 1, 2
),
evidencia as (
  select e.pca_plano_id, e.data_publicacao
    from public.contratacoes_editais e
   where e.ativo
     and e.pca_plano_id is not null
     and e.pca_link_evidencia is not null
     and e.pca_plano_id in (select plano_id from itens)
  union all
  select l.pca_plano_id, l.data_publicacao
    from public.licitacoes_externas l
   where l.pca_plano_id is not null
     and l.pca_link_evidencia is not null
     and l.pca_plano_id in (select plano_id from itens)
),
uma as (
  select distinct on (pca_plano_id) pca_plano_id, data_publicacao
    from evidencia
   order by pca_plano_id, data_publicacao nulls last
),
confirmado as (
  select it.cnpj,
         it.ano_exercicio,
         count(distinct it.plano_id)::int as execucoes_confirmadas,
         avg(((u.data_publicacao at time zone 'America/Sao_Paulo')::date - it.data_prevista_contratacao))
           filter (where u.data_publicacao is not null and it.data_prevista_contratacao is not null) as lag_medio_dias,
         (sum(((u.data_publicacao at time zone 'America/Sao_Paulo')::date - it.data_prevista_contratacao))
           filter (where u.data_publicacao is not null and it.data_prevista_contratacao is not null))::numeric as lag_soma_dias,
         (count(*) filter (where u.data_publicacao is not null and it.data_prevista_contratacao is not null))::int as lag_n
    from itens it
    join uma u on u.pca_plano_id = it.plano_id
   group by 1, 2
),
compras as (
  select regexp_replace(l.orgao_cnpj, '\D', '', 'g') as cnpj,
         extract(year from (l.data_publicacao at time zone 'America/Sao_Paulo'))::int as ano,
         count(*)::int as compras,
         sum(l.valor_total) filter (where l.valor_total is not null) as valor
    from public.licitacoes_externas l
    left join public.licitacoes_pncp_canonica c on c.id = l.id
   where coalesce(c.eh_canonica, true)
     -- só os CNPJs com plano nas classes e os anos pedidos (ano em Brasília)
     and regexp_replace(l.orgao_cnpj, '\D', '', 'g') in (select cnpj from itens)
     and l.data_publicacao >= make_timestamptz(p_ano_inicio, 1, 1, 0, 0, 0, 'America/Sao_Paulo')
     and l.data_publicacao < make_timestamptz(p_ano_fim + 1, 1, 1, 0, 0, 0, 'America/Sao_Paulo')
     -- lista fixa no código; não acompanha edição de objeto_categorias
     and l.objeto_categoria in (
       'academia_ar_livre',
       'equipamento_musculacao',
       'equipamento_fisioterapia',
       'piso_esportivo',
       'playground',
       'material_esportivo'
     )
   group by 1, 2
)
select pl.cnpj,
       og.nome,
       coalesce(og.uf, 'sem_uf'),
       pl.ano_exercicio,
       pl.classes_presentes,
       pl.planos,
       pl.itens,
       pl.itens_com_valor,
       (pl.itens - pl.itens_com_valor),
       pl.valor_planejado,
       pl.unidades,
       coalesce(c.compras, 0),
       c.valor,
       coalesce(cf.execucoes_confirmadas, 0),
       cf.lag_medio_dias,
       cf.lag_soma_dias,
       coalesce(cf.lag_n, 0)
  from planejado pl
  left join orgao og on og.cnpj = pl.cnpj
  left join compras c on c.cnpj = pl.cnpj and c.ano = pl.ano_exercicio
  left join confirmado cf on cf.cnpj = pl.cnpj and cf.ano_exercicio = pl.ano_exercicio
 order by pl.cnpj, pl.ano_exercicio;
$fn$;

comment on function public.pca_historico_orgao_ano(text[], integer, integer) is
  'Histórico do PCA por CNPJ e ano nas classes pedidas. valor_planejado soma itens, não o plano. compras_escopo_* é licitação das categorias do escopo fitness (lista fixa no código da função) no mesmo CNPJ e ano de publicação em Brasília (não é por classe nem execução; republicação conta uma vez pela linha canônica, e se a canônica cair fora da categoria ou do ano a compra não conta). execucoes_confirmadas exige pca_link_evidencia. lag_soma_dias/lag_n: soma e contagem dos itens com prazo, para média ponderada por item. EXECUTE só service_role.';

revoke all on function public.pca_historico_orgao_ano(text[], integer, integer) from PUBLIC, anon, authenticated, service_role;
grant execute on function public.pca_historico_orgao_ano(text[], integer, integer) to service_role;

commit;
