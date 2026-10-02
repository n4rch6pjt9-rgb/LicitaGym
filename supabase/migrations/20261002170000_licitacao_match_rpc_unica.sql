-- LicitaGym: licitacao_match (casamento por texto materializado) e RPC única para o recorte CATMAT
--
-- Contexto:
-- Depois da 20261002140000 (índices trgm), licitacoes_ids_por_catmat(catalogo=true) leva ~7 s quente / ~11 s
-- frio em prod (8,3 s no EXPLAIN ANALYZE), contra ~2 s no PG17 local com os mesmos dados. O plano é o mesmo
-- (mesmas linhas, buffers todos em cache): a diferença é CPU. Mais de 90% do tempo é o recheck da regex
-- nos candidatos do GIN (36 ramos x ~575 candidatos). E a api-dashboard-oportunidades chamava a RPC uma vez por
-- página de 1000 linhas (4 chamadas no catálogo), cada uma perto do statement_timeout de 8 s.
--
-- Esta migration:
--   1) public.licitacao_match: casamento por texto já calculado, com as mesmas regras da RPC: padrão ativo
--      do PDM (catmat_pdm_palavras) casa lg_normalizar(texto) e nenhuma exclusão ativa do PDM
--      (catmat_pdm_exclusoes) casa. Uma linha por (item, PDM) em 'texto_item' e por (licitação, PDM) em
--      'texto_objeto';
--   2) public.licitacao_match_pendente: texto alterado ainda não recalculado (id do item ou da licitação);
--   3) public.licitacao_match_estado: carregado_em null até a carga (backfill). Enquanto for null, tudo
--      fica inerte: triggers não marcam, licitacao_match_atualizar não grava, e licitacoes_ids_por_catmat
--      usa o caminho ao vivo da 20261002140000 (fallback; mesmo resultado e mesmo tempo de hoje);
--   4) quem atualiza, depois da carga:
--      - escrita em licitacao_itens.descricao / licitacoes_externas.objeto (coletores): triggers de
--        statement só marcam a pendência (barato, nenhuma regex na escrita);
--      - a pendência é drenada por licitacao_match_atualizar(p_limite), que os coletores chamam
--        (destino.Supabase.drenar_licitacao_match) a cada ~300 linhas de texto gravadas e no fim de cada
--        execução, em lotes até zerar (~60-80 ms por lote de 300 no PG17 local);
--      - padrões e exclusões (api-catmat, migrations): trigger recalcula na hora os PDMs alterados
--        (caminho GIN por ramo);
--      - nenhum cron/job novo;
--   5) licitacoes_ids_por_catmat: depois da carga, os ramos de texto leem licitacao_match e o texto
--      pendente é casado ao vivo (o resultado não depende de a drenagem estar em dia; só o tempo). Assinatura,
--      STABLE, SECURITY INVOKER, search_path e grants iguais;
--   6) licitacoes_ids_por_catmat_unica: a mesma resolução numa linha só (ids bigint[] distintos +
--      matches jsonb), para a Edge Function chamar uma vez, sem a paginação do PostgREST (max_rows);
--   7) licitacao_match_carregar(): a carga (backfill). NÃO roda nesta migration: é um passo separado, com
--      ok do owner, fora da janela dos coletores, pelo SQL editor (owner; sem EXECUTE para os roles da API):
--        begin; set local statement_timeout = '10min'; set local lock_timeout = '10s';
--        select public.licitacao_match_carregar(); commit;
--      Trava escritas em licitacao_itens, licitacoes_externas, catmat_pdm_palavras e catmat_pdm_exclusoes
--      durante a carga: ~8 s no PG17 local com o volume de prod, estimada em 30-40 s em prod (CPU ~4-5x).
--      Reverter para o fallback: update public.licitacao_match_estado set carregado_em = null.
--
-- A migration em si é curta (DDL + funções; nenhuma carga): os create trigger pegam SHARE ROW EXCLUSIVE nas
-- 4 tabelas só pelo tempo do DDL. Se lg_normalizar, lg_regex_ramos ou a regra de casamento mudar, a migration
-- que mudar deve recalcular (se carregado): select public.licitacao_match_recalcular_pdms(null).
-- Não depende da 20261002160000 (PR #132): só objetos da 20261002140000 e anteriores.
--
-- Idempotente (reaplicar não apaga a carga nem o estado). ACL: só service_role; a carga, só o owner.

begin;

set local lock_timeout = '10s';
set local statement_timeout = '2min';

-- 1) Casamento materializado -------------------------------------------------------------------------------------------
create table if not exists public.licitacao_match (
  origem        text   not null,
  licitacao_id  bigint not null references public.licitacoes_externas(id) on delete cascade,
  item_id       bigint references public.licitacao_itens(id) on delete cascade,
  codigo_pdm    int    not null references public.catmat_pdms(codigo_pdm) on delete cascade,
  calculado_em  timestamptz not null default now(),
  constraint licitacao_match_origem_chk check (origem in ('texto_item', 'texto_objeto')),
  constraint licitacao_match_item_chk check ((origem = 'texto_item') = (item_id is not null)),
  constraint licitacao_match_key unique nulls not distinct (origem, licitacao_id, item_id, codigo_pdm)
);
create index if not exists licitacao_match_pdm_idx on public.licitacao_match (codigo_pdm, origem);
create index if not exists licitacao_match_item_idx on public.licitacao_match (item_id) where item_id is not null;
create index if not exists licitacao_match_licitacao_idx on public.licitacao_match (licitacao_id);
comment on table public.licitacao_match is
  'Casamento por texto CATMAT materializado (padrões ativos de catmat_pdm_palavras menos exclusões ativas de catmat_pdm_exclusoes, sobre lg_normalizar). Lido por licitacoes_ids_por_catmat. Texto alterado vai para licitacao_match_pendente e é drenado por licitacao_match_atualizar (coletores, a cada ~300 linhas de texto e no fim da execução); padrões recalculam por trigger.';

-- 2) Pendências de texto -----------------------------------------------------------------------------------------------
create table if not exists public.licitacao_match_pendente (
  origem     text   not null,
  ref_id     bigint not null,
  marcado_em timestamptz not null default now(),
  constraint licitacao_match_pendente_pkey primary key (origem, ref_id),
  constraint licitacao_match_pendente_origem_chk check (origem in ('texto_item', 'texto_objeto'))
);
comment on table public.licitacao_match_pendente is
  'Texto alterado ainda não recalculado em licitacao_match: ref_id = licitacao_itens.id (texto_item) ou licitacoes_externas.id (texto_objeto). Marcado por trigger; drenado por licitacao_match_atualizar.';

alter table public.licitacao_match enable row level security;
alter table public.licitacao_match_pendente enable row level security;
revoke all on table public.licitacao_match, public.licitacao_match_pendente from PUBLIC, anon, authenticated;
grant all on table public.licitacao_match, public.licitacao_match_pendente to service_role;

-- 2b) Estado da carga: uma linha; carregado_em null = ainda sem backfill (tudo inerte, RPC no caminho ao vivo).
create table if not exists public.licitacao_match_estado (
  id           boolean primary key default true constraint licitacao_match_estado_uma_linha check (id),
  carregado_em timestamptz
);
insert into public.licitacao_match_estado (id, carregado_em) values (true, null) on conflict (id) do nothing;
comment on table public.licitacao_match_estado is
  'carregado_em: quando licitacao_match_carregar() rodou. Null = sem backfill: triggers e drenagem inertes, licitacoes_ids_por_catmat no caminho ao vivo (fallback).';
alter table public.licitacao_match_estado enable row level security;
revoke all on table public.licitacao_match_estado from PUBLIC, anon, authenticated;
grant select on table public.licitacao_match_estado to service_role;

-- 3) Recálculo ---------------------------------------------------------------------------------------------------------
-- PDMs inteiros (null = todos com padrão ativo), pelo caminho GIN: cada ramo de topo do padrão num lateral.
create or replace function public.licitacao_match_recalcular_pdms(p_pdms int[])
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  delete from public.licitacao_match m
   where p_pdms is null or m.codigo_pdm = any (p_pdms);

  insert into public.licitacao_match (origem, licitacao_id, item_id, codigo_pdm)
  with
  padroes as materialized (
    select w.codigo_pdm, w.padrao from public.catmat_pdm_palavras w
     where w.ativo and (p_pdms is null or w.codigo_pdm = any (p_pdms))
  ),
  exclusoes as materialized (
    select x.codigo_pdm, x.padrao from public.catmat_pdm_exclusoes x
     where x.ativo and (p_pdms is null or x.codigo_pdm = any (p_pdms))
  ),
  ramos as materialized (
    select distinct pa.codigo_pdm, r.ramo
      from padroes pa
      cross join lateral unnest(public.lg_regex_ramos(pa.padrao)) as r(ramo)
  )
  select distinct 'texto_item', li.licitacao_id, li.id, ra.codigo_pdm
    from ramos ra
    cross join lateral (
      select i.id, i.licitacao_id, i.descricao from public.licitacao_itens i
       where public.lg_normalizar(i.descricao) ~ ra.ramo
    ) li
   where not exists (select 1 from exclusoes x
                      where x.codigo_pdm = ra.codigo_pdm and public.lg_normalizar(li.descricao) ~ x.padrao)
  union
  select distinct 'texto_objeto', le.id, null::bigint, ra.codigo_pdm
    from ramos ra
    cross join lateral (
      select e.id, e.objeto from public.licitacoes_externas e
       where public.lg_normalizar(e.objeto) ~ ra.ramo
    ) le
   where not exists (select 1 from exclusoes x
                      where x.codigo_pdm = ra.codigo_pdm and public.lg_normalizar(le.objeto) ~ x.padrao)
  on conflict on constraint licitacao_match_key do nothing;
end
$$;

-- Drena até p_limite pendências (as mais antigas; skip locked deixa drenagens concorrentes seguirem).
-- Casamento direto, com o padrão no laço externo. Devolve quantas pendências ainda restam.
create or replace function public.licitacao_match_atualizar(p_limite int default 300)
returns bigint
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_itens   bigint[];
  v_objetos bigint[];
begin
  if not exists (select 1 from public.licitacao_match_estado where carregado_em is not null) then
    return 0;  -- sem carga: nada a drenar (e nada é marcado)
  end if;
  select coalesce(array_agg(l.ref_id) filter (where l.origem = 'texto_item'), '{}'),
         coalesce(array_agg(l.ref_id) filter (where l.origem = 'texto_objeto'), '{}')
    into v_itens, v_objetos
    from (select p.origem, p.ref_id from public.licitacao_match_pendente p
           order by p.marcado_em, p.origem, p.ref_id
           limit greatest(coalesce(p_limite, 300), 1)
           for update skip locked) l;

  if cardinality(v_itens) > 0 then
    delete from public.licitacao_match m where m.origem = 'texto_item' and m.item_id = any (v_itens);
    insert into public.licitacao_match (origem, licitacao_id, item_id, codigo_pdm)
    with
    textos as materialized (
      select i.id, i.licitacao_id, public.lg_normalizar(i.descricao) as s
        from public.licitacao_itens i where i.id = any (v_itens)
    ),
    padroes as materialized (select w.codigo_pdm, w.padrao from public.catmat_pdm_palavras w where w.ativo),
    exclusoes as materialized (select x.codigo_pdm, x.padrao from public.catmat_pdm_exclusoes x where x.ativo)
    select distinct 'texto_item', t.licitacao_id, t.id, pa.codigo_pdm
      from padroes pa
      cross join lateral (select t.id, t.licitacao_id, t.s from textos t where t.s ~ pa.padrao) t
     where not exists (select 1 from exclusoes x where x.codigo_pdm = pa.codigo_pdm and t.s ~ x.padrao)
    on conflict on constraint licitacao_match_key do nothing;
    delete from public.licitacao_match_pendente p where p.origem = 'texto_item' and p.ref_id = any (v_itens);
  end if;

  if cardinality(v_objetos) > 0 then
    delete from public.licitacao_match m where m.origem = 'texto_objeto' and m.licitacao_id = any (v_objetos);
    insert into public.licitacao_match (origem, licitacao_id, item_id, codigo_pdm)
    with
    textos as materialized (
      select e.id, public.lg_normalizar(e.objeto) as s
        from public.licitacoes_externas e where e.id = any (v_objetos)
    ),
    padroes as materialized (select w.codigo_pdm, w.padrao from public.catmat_pdm_palavras w where w.ativo),
    exclusoes as materialized (select x.codigo_pdm, x.padrao from public.catmat_pdm_exclusoes x where x.ativo)
    select distinct 'texto_objeto', t.id, null::bigint, pa.codigo_pdm
      from padroes pa
      cross join lateral (select t.id, t.s from textos t where t.s ~ pa.padrao) t
     where not exists (select 1 from exclusoes x where x.codigo_pdm = pa.codigo_pdm and t.s ~ x.padrao)
    on conflict on constraint licitacao_match_key do nothing;
    delete from public.licitacao_match_pendente p where p.origem = 'texto_objeto' and p.ref_id = any (v_objetos);
  end if;

  return (select count(*) from public.licitacao_match_pendente);
end
$$;

-- 4) Triggers ----------------------------------------------------------------------------------------------------------
-- A marcação usa "do update" (e não "do nothing") de propósito: se uma drenagem segura a pendência (for update),
-- a escrita espera o fim dela e remarca depois; com "do nothing" a drenagem poderia apagar a pendência tendo
-- lido o texto antigo.
-- Itens: inserção, ou descrição/licitação alterada. Remoção: o FK de licitacao_match apaga em cascata.
create or replace function public.licitacao_match_marcar_itens()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not exists (select 1 from public.licitacao_match_estado where carregado_em is not null) then
    return null;
  end if;
  if tg_op = 'INSERT' then
    insert into public.licitacao_match_pendente (origem, ref_id)
    select 'texto_item', n.id from novos n
    on conflict (origem, ref_id) do update set marcado_em = excluded.marcado_em;
  else
    insert into public.licitacao_match_pendente (origem, ref_id)
    select 'texto_item', n.id from novos n join antigos o on o.id = n.id
     where n.descricao is distinct from o.descricao or n.licitacao_id is distinct from o.licitacao_id
    on conflict (origem, ref_id) do update set marcado_em = excluded.marcado_em;
  end if;
  return null;
end
$$;

-- Licitações: inserção ou objeto alterado.
create or replace function public.licitacao_match_marcar_objetos()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not exists (select 1 from public.licitacao_match_estado where carregado_em is not null) then
    return null;
  end if;
  if tg_op = 'INSERT' then
    insert into public.licitacao_match_pendente (origem, ref_id)
    select 'texto_objeto', n.id from novos n
    on conflict (origem, ref_id) do update set marcado_em = excluded.marcado_em;
  else
    insert into public.licitacao_match_pendente (origem, ref_id)
    select 'texto_objeto', n.id from novos n join antigos o on o.id = n.id
     where n.objeto is distinct from o.objeto
    on conflict (origem, ref_id) do update set marcado_em = excluded.marcado_em;
  end if;
  return null;
end
$$;

-- Padrões e exclusões: recalcula na hora os PDMs tocados (antes e depois da alteração).
create or replace function public.licitacao_match_padroes_alterados()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_pdms int[];
begin
  if not exists (select 1 from public.licitacao_match_estado where carregado_em is not null) then
    return null;
  end if;
  if tg_op = 'INSERT' then
    select array_agg(distinct n.codigo_pdm) into v_pdms from novos n;
  elsif tg_op = 'DELETE' then
    select array_agg(distinct o.codigo_pdm) into v_pdms from antigos o;
  else
    select array_agg(distinct c) into v_pdms
      from (select n.codigo_pdm as c from novos n union select o.codigo_pdm from antigos o) s;
  end if;
  if v_pdms is not null then
    perform public.licitacao_match_recalcular_pdms(v_pdms);
  end if;
  return null;
end
$$;

drop trigger if exists licitacao_match_itens_ins on public.licitacao_itens;
create trigger licitacao_match_itens_ins after insert on public.licitacao_itens
  referencing new table as novos for each statement execute function public.licitacao_match_marcar_itens();
drop trigger if exists licitacao_match_itens_upd on public.licitacao_itens;
create trigger licitacao_match_itens_upd after update on public.licitacao_itens
  referencing old table as antigos new table as novos for each statement execute function public.licitacao_match_marcar_itens();

drop trigger if exists licitacao_match_objetos_ins on public.licitacoes_externas;
create trigger licitacao_match_objetos_ins after insert on public.licitacoes_externas
  referencing new table as novos for each statement execute function public.licitacao_match_marcar_objetos();
drop trigger if exists licitacao_match_objetos_upd on public.licitacoes_externas;
create trigger licitacao_match_objetos_upd after update on public.licitacoes_externas
  referencing old table as antigos new table as novos for each statement execute function public.licitacao_match_marcar_objetos();

drop trigger if exists licitacao_match_palavras_ins on public.catmat_pdm_palavras;
create trigger licitacao_match_palavras_ins after insert on public.catmat_pdm_palavras
  referencing new table as novos for each statement execute function public.licitacao_match_padroes_alterados();
drop trigger if exists licitacao_match_palavras_upd on public.catmat_pdm_palavras;
create trigger licitacao_match_palavras_upd after update on public.catmat_pdm_palavras
  referencing old table as antigos new table as novos for each statement execute function public.licitacao_match_padroes_alterados();
drop trigger if exists licitacao_match_palavras_del on public.catmat_pdm_palavras;
create trigger licitacao_match_palavras_del after delete on public.catmat_pdm_palavras
  referencing old table as antigos for each statement execute function public.licitacao_match_padroes_alterados();

drop trigger if exists licitacao_match_exclusoes_ins on public.catmat_pdm_exclusoes;
create trigger licitacao_match_exclusoes_ins after insert on public.catmat_pdm_exclusoes
  referencing new table as novos for each statement execute function public.licitacao_match_padroes_alterados();
drop trigger if exists licitacao_match_exclusoes_upd on public.catmat_pdm_exclusoes;
create trigger licitacao_match_exclusoes_upd after update on public.catmat_pdm_exclusoes
  referencing old table as antigos new table as novos for each statement execute function public.licitacao_match_padroes_alterados();
drop trigger if exists licitacao_match_exclusoes_del on public.catmat_pdm_exclusoes;
create trigger licitacao_match_exclusoes_del after delete on public.catmat_pdm_exclusoes
  referencing old table as antigos for each statement execute function public.licitacao_match_padroes_alterados();

-- 5) licitacoes_ids_por_catmat lendo licitacao_match quando carregada; senão o caminho ao vivo (resto igual a 20261002140000) ------------------------------------
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
-- 6) Uma chamada só: ids distintos (bigint[], ordem crescente) e os casamentos (jsonb, na ordem que a Edge Function
-- usava ao paginar), numa linha. Sem LIMIT; o teto de licitações continua no chamador.
create or replace function public.licitacoes_ids_por_catmat_unica(
  p_grupos int[] default null,
  p_classes int[] default null,
  p_pdms int[] default null,
  p_itens int[] default null,
  p_somente_catalogo boolean default false
)
returns table (ids bigint[], matches jsonb)
language sql
stable
set search_path = public, pg_temp
as $$
  select coalesce(array_agg(distinct r.licitacao_id order by r.licitacao_id), '{}'::bigint[]),
         coalesce(jsonb_agg(jsonb_build_object('licitacao_id', r.licitacao_id, 'codigo_pdm', r.codigo_pdm,
                                               'codigo_item', r.codigo_item, 'motivo', r.motivo)
                            order by r.licitacao_id, r.codigo_pdm, r.codigo_item nulls first, r.motivo), '[]'::jsonb)
    from public.licitacoes_ids_por_catmat(p_grupos, p_classes, p_pdms, p_itens, p_somente_catalogo) r
$$;

-- ACL: create or replace preserva os grants; reafirmados. Só service_role; recálculo completo e carga, só o owner
-- (os triggers chamam o recálculo como owner, por SECURITY DEFINER).
revoke execute on function public.licitacao_match_recalcular_pdms(int[]) from PUBLIC, anon, authenticated, service_role;
revoke execute on function public.licitacao_match_atualizar(int) from PUBLIC, anon, authenticated;
revoke execute on function public.licitacao_match_marcar_itens() from PUBLIC, anon, authenticated, service_role;
revoke execute on function public.licitacao_match_marcar_objetos() from PUBLIC, anon, authenticated, service_role;
revoke execute on function public.licitacao_match_padroes_alterados() from PUBLIC, anon, authenticated, service_role;
revoke execute on function public.licitacoes_ids_por_catmat(int[], int[], int[], int[], boolean) from PUBLIC, anon, authenticated;
revoke execute on function public.licitacoes_ids_por_catmat_unica(int[], int[], int[], int[], boolean) from PUBLIC, anon, authenticated;
grant execute on function public.licitacao_match_atualizar(int) to service_role;
grant execute on function public.licitacoes_ids_por_catmat(int[], int[], int[], int[], boolean) to service_role;
grant execute on function public.licitacoes_ids_por_catmat_unica(int[], int[], int[], int[], boolean) to service_role;

-- 7) Carga (backfill): passo separado, NÃO executado aqui (ver o cabeçalho). Trava as escritas de texto e de
-- padrões durante a carga, para nada escrito no meio ficar sem casamento nem pendência.
create or replace function public.licitacao_match_carregar()
returns bigint
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  lock table public.licitacao_itens, public.licitacoes_externas,
             public.catmat_pdm_palavras, public.catmat_pdm_exclusoes in share row exclusive mode;
  perform public.licitacao_match_recalcular_pdms(null);
  delete from public.licitacao_match_pendente;
  update public.licitacao_match_estado set carregado_em = now() where id;
  analyze public.licitacao_match;
  return (select count(*) from public.licitacao_match);
end
$$;
comment on function public.licitacao_match_carregar() is
  'Backfill de licitacao_match (passo separado, com ok do owner, fora da janela dos coletores): recalcula tudo, limpa pendências e marca licitacao_match_estado.carregado_em. Sem EXECUTE para os roles da API.';
revoke execute on function public.licitacao_match_carregar() from PUBLIC, anon, authenticated, service_role;

commit;
