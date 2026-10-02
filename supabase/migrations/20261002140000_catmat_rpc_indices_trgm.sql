-- LicitaGym: índices para public.licitacoes_ids_por_catmat (dashboard /oportunidades com p_somente_catalogo)
--
-- Contexto:
-- Com licitacao_itens em ~92 mil linhas, a RPC passou do statement_timeout de 8s (PostgREST) e o
-- /oportunidades respondeu 500. O custo estava no ramo por_texto_item: nested loop licitacao_itens x padrões
-- com `lg_normalizar(descricao) ~ padrao` como join filter (~1,8 milhão de chamadas de lg_normalizar, que não
-- é inlinada por ter SET search_path). por_codigo e por_taxonomia faziam seq scan avaliando a expressão
-- em todas as linhas.
--
-- Esta migration:
--   1) pg_trgm no schema extensions;
--   2) GIN trgm em lg_normalizar(descricao) (licitacao_itens) e lg_normalizar(objeto) (licitacoes_externas).
--      lg_normalizar já é IMMUTABLE, PARALLEL SAFE, com search_path fixo (pg_catalog, pg_temp) e sem
--      unaccent (translate explícito): entra no índice como está e não muda;
--   3) btree nas expressões de por_codigo e por_taxonomia (licitacao_itens), idênticas às da RPC;
--   4) lg_regex_ramos: divide um padrão nos ramos de topo da alternância ('a|b|c');
--   5) licitacoes_ids_por_catmat: por_texto_item e por_texto_objeto aplicam cada ramo num cross join lateral.
--      Só com os índices o planner já usa o GIN (bitmap index scan parametrizado pelo padrão), mas padrões com
--      alternância longa (ex.: 'academia (...)|aparelhos? de musculacao|...|\msupino') perdem seletividade no
--      pg_trgm e mandam milhares de linhas para o recheck da regex. Por ramo, cada um tem trigramas próprios.
--      Mesmo conjunto de linhas (texto ~ 'a|b' <=> texto ~ 'a' or texto ~ 'b'; o distinct final já existia),
--      mesma assinatura, STABLE, SECURITY INVOKER, search_path e grants. Exclusões seguem inteiras;
--   6) analyze das tabelas indexadas.
--
-- Locks: create index sem CONCURRENTLY (a migration roda em transação) pega SHARE em licitacao_itens e
-- licitacoes_externas: leituras seguem, escritas (coletores) esperam o build. Medido localmente com o
-- volume de prod (PG17, maintenance_work_mem 32MB como em prod): GIN de licitacao_itens ~8,5s, os dois btree
-- ~0,06s cada, GIN de licitacoes_externas ~0,14s, analyze ~0,2s; licitacao_itens fica ~9s sem escrita e a
-- migration inteira ~10s. lock_timeout evita ficar na fila atrás de uma transação longa.
--
-- Idempotente.

begin;

set local lock_timeout = '10s';

-- 1) pg_trgm ----------------------------------------------------------------------------------------------------------
create schema if not exists extensions;  -- já existe no Supabase; no Postgres puro (validar-migrations) não
create extension if not exists pg_trgm with schema extensions;

-- 2) GIN trgm sobre o texto normalizado (mesma expressão da RPC: public.lg_normalizar(<coluna>)) --------------------
create index if not exists licitacao_itens_descricao_norm_trgm_idx
  on public.licitacao_itens using gin (public.lg_normalizar(descricao) extensions.gin_trgm_ops);

create index if not exists licitacoes_externas_objeto_norm_trgm_idx
  on public.licitacoes_externas using gin (public.lg_normalizar(objeto) extensions.gin_trgm_ops);

-- 3) Expressões de por_codigo e por_taxonomia (idênticas às da RPC) ---------------------------------------------------
create index if not exists licitacao_itens_catalogo_codigo_item_num_idx
  on public.licitacao_itens ((case when catalogo_codigo_item ~ '^\d{1,15}$' then catalogo_codigo_item::bigint end));

create index if not exists licitacao_itens_no_taxonomia_efetiva_idx
  on public.licitacao_itens ((coalesce(no_taxonomia, taxonomia->>'no_taxonomia')));

-- 4) Ramos de topo de uma regex ARE ---------------------------------------------------------------------------------
-- 'a|b(c|d)|[x|y]' -> {a, b(c|d), [x|y]}: divide só no '|' fora de parênteses, colchetes e escapes. Para o casamento
-- booleano do ~, texto ~ 'a|b' equivale a texto ~ 'a' or texto ~ 'b'. Sem divisão (devolve {p}): diretor (***),
-- opções embutidas ou grupo especial '(?' no início, retrovisor (\1..\9, cuja numeração mudaria) e padrão
-- desbalanceado. Usada só para o índice trgm achar trigramas por ramo; não valida o padrão.
create or replace function public.lg_regex_ramos(p text)
returns text[]
language plpgsql
immutable
strict
parallel safe
set search_path = pg_catalog, pg_temp
as $$
declare
  ramos text[] := '{}';
  ini   int := 1;
  i     int := 1;
  n     int := length(p);
  nivel int := 0;
  c     text;
  pos   int;
begin
  if left(p, 1) = '*' or left(p, 2) = '(?' or p ~ '\\[1-9]' then
    return array[p];
  end if;
  while i <= n loop
    c := substr(p, i, 1);
    if c = '\' then
      i := i + 2;                                         -- escape: o caractere seguinte não é especial
      continue;
    elsif c = '[' then                                    -- colchetes: '|', '(' e ')' são literais
      i := i + 1;
      if substr(p, i, 1) = '^' then i := i + 1; end if;
      if substr(p, i, 1) = ']' then i := i + 1; end if;   -- ']' logo após '[' ou '[^' é literal
      while i <= n and substr(p, i, 1) <> ']' loop
        if substr(p, i, 1) = '\' then
          i := i + 2;
        elsif substr(p, i, 2) in ('[:', '[.', '[=') then  -- [:classe:], [.elemento.], [=equivalência=]
          pos := strpos(substr(p, i + 2), substr(p, i + 1, 1) || ']');
          if pos = 0 then return array[p]; end if;
          i := i + pos + 3;
        else
          i := i + 1;
        end if;
      end loop;
      if i > n then return array[p]; end if;              -- colchete sem fechamento
      i := i + 1;
      continue;
    elsif c = '(' then
      nivel := nivel + 1;
    elsif c = ')' then
      nivel := nivel - 1;
      if nivel < 0 then return array[p]; end if;
    elsif c = '|' and nivel = 0 then
      ramos := ramos || substr(p, ini, i - ini);
      ini := i + 1;
    end if;
    i := i + 1;
  end loop;
  if nivel <> 0 then return array[p]; end if;
  return ramos || substr(p, ini);
end
$$;

-- 5) licitacoes_ids_por_catmat: texto por ramo em cross join lateral (resto igual a 20260930120000) ------------------
-- Mesma assinatura, retorno, STABLE, SECURITY INVOKER e search_path da versão atual.
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
      -- cast protegido: códigos não numéricos (ex.: Paradigma 'AI0300075') viram null e não casam
      join itens_alvo ia on ia.codigo_item =
           case when li.catalogo_codigo_item ~ '^\d{1,15}$' then li.catalogo_codigo_item::bigint end
  ),
  -- Cada ramo de topo do padrão ('a|b|c') vira uma linha: o pg_trgm extrai trigramas por ramo (numa alternância
  -- longa inteira ele perde seletividade e o GIN devolve milhares de candidatos para o recheck). Mesmo resultado:
  -- texto ~ 'a|b' <=> texto ~ 'a' or texto ~ 'b'; duplicatas somem no distinct final. Exclusões seguem inteiras.
  ramos as (
    select pa.codigo_pdm, r.ramo
      from padroes pa
      cross join lateral unnest(public.lg_regex_ramos(pa.padrao)) as r(ramo)
  ),
  -- cross join lateral por ramo: o ramo é parâmetro do lateral e o GIN trgm (licitacao_itens_descricao_norm_trgm_idx)
  -- entra como bitmap index scan parametrizado, sem avaliar lg_normalizar ~ padrão em todas as linhas
  por_texto_item as (
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

-- create or replace preserva os grants; reafirmados por clareza (mesma ACL de lg_normalizar e da RPC)
revoke execute on function public.lg_regex_ramos(text) from PUBLIC, anon, authenticated;
grant execute on function public.lg_regex_ramos(text) to service_role;
revoke execute on function public.licitacoes_ids_por_catmat(int[], int[], int[], int[], boolean) from PUBLIC, anon, authenticated;
grant execute on function public.licitacoes_ids_por_catmat(int[], int[], int[], int[], boolean) to service_role;

-- 6) Estatísticas (inclui as das expressões indexadas) ----------------------------------------------------------------
analyze public.licitacao_itens;
analyze public.licitacoes_externas;

commit;
