-- LicitaGym: a classificação de órgãos/UASGs deixa de compartilhar transação com o refresh
-- de mv_escopo_demanda, e o refresh para de reavaliar o regex de escopo em todo item.
--
-- Por quê (03/10/2026, produção ifaiagegyicjzlpskafh, só leitura):
--   O job pg_cron licitagym-orgaos-classificar-escopo (`3 8 * * *` UTC = 05:03 BRT) era um
--   único simple-query, portanto uma transação só:
--     set local statement_timeout = '10min';
--     select fn_orgaos_uasgs_classificar();
--     select fn_escopo_match_atualizar();
--   statement_timeout no PG 17 vale por statement (os 10 min não são a soma). O timeout
--   estoura dentro do REFRESH, em fn_escopo_item, e o rollback desfaz também a classificação.
--   Por isso classificado_em parou em 01/10: 191 de 12.063 órgãos e 0 de 45.729 UASGs.
--   O REFRESH foi estimado em 825–865 s com 92.295 licitacao_itens (~9 ms/item). ~95% disso
--   são os 167 regex de núcleo/adjacente em plpgsql, que estouram o cache de 32 regex
--   compiladas por conexão. Avaliar padrão por padrão foi ~11,6× mais rápido. Itens novos:
--   78.032 em 01/10, 12.287 em 02/10, 0 em 03/10.
--   A parte SELECT da classificação cabe em 65–80 s; localmente a função inteira (com a
--   gravação das ~57,8 mil linhas) levou 5 min 10 s. Separada, cabe nos 10 min. Não foi
--   tornada incremental: o resultado depende de regras, overrides, moda de UASG/unidade e
--   do tipo do órgão pai; um filtro por classificado_em NULL deixaria órgão antigo desatualizado.
--
-- O que muda:
--   1) Dois jobs, cada um na sua transação e com statement_timeout de 10 min:
--        licitagym-orgaos-classificar   05:03 BRT  `3 8 * * *`   só fn_orgaos_uasgs_classificar()
--        licitagym-escopo-match         05:18 BRT  `18 8 * * *`  só fn_escopo_match_atualizar()
--      O nome antigo é removido. 05:18 fica na faixa livre 05:12–05:26, depois do pior caso
--      da classificação (05:03 + 10 min) e antes da legislação de segunda (05:27). Não encosta
--      no sync de órgãos das 04:43. Sem pg_cron (Postgres puro da validação) o bloco só avisa.
--   2) public.escopo_item_calc guarda (nivel, familia) já resolvidos por item de licitação,
--      edital e item de PCA 7830, com o hash do texto de entrada e a impressão de escopo_termos.
--      fn_escopo_calc_sincronizar() recalcula só linha nova, texto alterado ou termo alterado.
--      Itens de licitação usam o GIN trgm de fn_norm_item(descricao): um bitmap por padrão,
--      não um plpgsql por item. O CREATE INDEX bloqueia escrita em licitacao_itens enquanto
--      constrói (leituras seguem); no volume de produção o GIN parecido levou ~8,5 s, e
--      fn_norm_item em 92 mil linhas foi medido em ~28 s, então a construção fica na casa
--      das dezenas de segundos. Edital e PCA varrem só o conjunto atrasado, padrão por padrão.
--      A semântica continua a de fn_escopo_item / fn_escopo_pca (exclusão vence; núcleo vence
--      adjacente; menor prioridade desempata). Essas duas funções não mudam.
--   3) mv_escopo_demanda passa a agregar o cache. Mesmas colunas e o mesmo índice único de
--      expressão (orgao_cnpj, coalesce(unidade_codigo, ''), fonte). REFRESH CONCURRENTLY não
--      entra: o índice único é de expressão (unidade_codigo é NULL em parte das linhas e nunca
--      é ''), e CONCURRENTLY não pode rodar de dentro da função que também grava match_nivel.
--      Com o cache quente o refresh é um agregado, e o lock exclusivo fica curto.
--   4) fn_escopo_match_atualizar() sincroniza o cache, faz o REFRESH e grava match_nivel
--      com a mesma regra de antes.
--
-- Quem lê/escreve: a tabela de cache e a função de sincronizar ficam só com o dono (pg_cron
-- como postgres). anon, authenticated e service_role não têm privilégio. A MV e
-- v_orgao_match_projeto continuam SELECT só para service_role. A migration também executa
-- o match uma vez, para a MV não ficar vazia entre o deploy e as 05:18.
--
-- Idempotente. Verificação: supabase/tests/orgaos_classificar_escopo_check.sql
-- Volta: supabase/rollback/20261003230000_orgaos_classificar_escopo_separado_rollback.sql

begin;

set local lock_timeout = '10s';
set local statement_timeout = '15min';

-- 1) Índice para o casamento padrão a padrão (a expressão é a mesma de fn_escopo_item) -------------
create schema if not exists extensions;
create extension if not exists pg_trgm with schema extensions;

create index if not exists licitacao_itens_escopo_norm_trgm_idx
  on public.licitacao_itens using gin (public.fn_norm_item(descricao) extensions.gin_trgm_ops);

-- 2) Cache do nível de escopo -----------------------------------------------------------------------
create table if not exists public.escopo_item_calc (
  origem        text not null,
  origem_id     text not null,
  texto_hash    text not null,
  termos_fp     text not null,
  nivel         text,
  familia       text,
  calculado_em  timestamptz not null default now(),
  constraint escopo_item_calc_pkey primary key (origem, origem_id),
  constraint escopo_item_calc_origem_check check (origem in ('licitacao_item', 'edital', 'pca_item')),
  constraint escopo_item_calc_nivel_check check (
    nivel is null or nivel in ('nucleo', 'adjacente', 'escopo', 'vazio', 'recreacao')),
  constraint escopo_item_calc_familia_check check (
    familia is null or familia in (
      'musculacao_academia', 'material_esportivo', 'piso_emborrachado', 'superficie_esportiva'))
);

comment on table public.escopo_item_calc is
  'Nível de escopo já resolvido (fn_escopo_item ou fn_escopo_pca) por item de licitação, edital ou item de PCA 7830. texto_hash = md5 do texto de entrada; termos_fp = impressão de escopo_termos. Recalculado por fn_escopo_calc_sincronizar() só quando o texto ou os termos mudam. nivel NULL é resultado calculado (sem match), não “ainda não calculado”. Só o dono (pg_cron) escreve e lê; a MV agrega daqui.';

comment on column public.escopo_item_calc.origem is 'licitacao_item | edital | pca_item.';
comment on column public.escopo_item_calc.origem_id is 'licitacao_itens.id, contratacoes_editais.id ou pca_itens.id, como texto.';
comment on column public.escopo_item_calc.nivel is 'nucleo/adjacente (item e edital) ou escopo/vazio/recreacao (PCA). NULL = calculado e sem match.';

alter table public.escopo_item_calc enable row level security;
revoke all on table public.escopo_item_calc from PUBLIC, anon, authenticated, service_role;

-- 3) Sincroniza só o que está atrasado --------------------------------------------------------------
create or replace function public.fn_escopo_calc_sincronizar(
  out itens integer, out editais integer, out pca integer)
language plpgsql
volatile
security invoker
set search_path = pg_catalog, public
as $fn$
declare
  v_fp text;
  v_rel text;
begin
  -- to_regclass não emite NOTICE quando a temporária ainda não existe (sessão nova do cron).
  foreach v_rel in array array[
    'escopo_item_stale', 'escopo_item_hit', 'escopo_item_best', 'escopo_item_excl',
    'escopo_ed_stale', 'escopo_ed_hit', 'escopo_ed_best', 'escopo_ed_excl',
    'escopo_pca_stale', 'escopo_pca_rec']
  loop
    if to_regclass('pg_temp.' || v_rel) is not null then
      execute format('drop table pg_temp.%I', v_rel);
    end if;
  end loop;

  select md5(coalesce(string_agg(
           concat_ws(E'\x1f', t.prioridade::text, t.nivel, coalesce(t.familia, ''), t.padrao,
                     coalesce(t.janela_caracteres::text, ''), t.ativo::text),
           E'\x1e' order by t.prioridade), ''))
    into v_fp
    from public.escopo_termos t;

  -- Itens de licitação: normaliza só os atrasados; o regex usa o GIN, um padrão por vez.
  create temp table escopo_item_stale as
  select i.id,
         md5(coalesce(i.descricao, '')) as texto_hash,
         public.fn_norm_item(i.descricao) as d
    from public.licitacao_itens i
    left join public.escopo_item_calc c
      on c.origem = 'licitacao_item' and c.origem_id = i.id::text
   where c.origem_id is null
      or c.texto_hash is distinct from md5(coalesce(i.descricao, ''))
      or c.termos_fp is distinct from v_fp;
  select count(*) into itens from pg_temp.escopo_item_stale;

  create temp table escopo_item_hit (
    id bigint, nivel text, familia text, prioridade integer);
  if itens > 0 then
    analyze pg_temp.escopo_item_stale;
    insert into pg_temp.escopo_item_hit (id, nivel, familia, prioridade)
    select i.id, t.nivel, t.familia, t.prioridade
      from public.escopo_termos t
      cross join lateral (
        select li.id
          from public.licitacao_itens li
         where public.fn_norm_item(li.descricao) ~ t.padrao
      ) i
      join pg_temp.escopo_item_stale s on s.id = i.id
     where t.ativo and t.nivel in ('nucleo', 'adjacente');
  end if;

  create temp table escopo_item_best as
  select distinct on (h.id) h.id, h.nivel, h.familia
    from pg_temp.escopo_item_hit h
   order by h.id, (h.nivel = 'adjacente'), h.prioridade;

  create temp table escopo_item_excl as
  select distinct b.id
    from public.escopo_termos t
    cross join lateral (
      select b.id
        from pg_temp.escopo_item_best b
        join pg_temp.escopo_item_stale s on s.id = b.id
       where s.d <> ''
         and left(s.d, coalesce(t.janela_caracteres, length(s.d))) ~ t.padrao
      offset 0
    ) b
   where t.ativo and t.nivel = 'exclusao';

  insert into public.escopo_item_calc (origem, origem_id, texto_hash, termos_fp, nivel, familia)
  select 'licitacao_item', s.id::text, s.texto_hash, v_fp,
         case when e.id is null then b.nivel end,
         case when e.id is null then b.familia end
    from pg_temp.escopo_item_stale s
    left join pg_temp.escopo_item_best b on b.id = s.id
    left join pg_temp.escopo_item_excl e on e.id = s.id
  on conflict (origem, origem_id) do update
    set texto_hash = excluded.texto_hash,
        termos_fp = excluded.termos_fp,
        nivel = excluded.nivel,
        familia = excluded.familia,
        calculado_em = now()
  where public.escopo_item_calc.texto_hash is distinct from excluded.texto_hash
     or public.escopo_item_calc.termos_fp is distinct from excluded.termos_fp
     or public.escopo_item_calc.nivel is distinct from excluded.nivel
     or public.escopo_item_calc.familia is distinct from excluded.familia;

  delete from public.escopo_item_calc c
   where c.origem = 'licitacao_item'
     and not exists (select 1 from public.licitacao_itens i where i.id::text = c.origem_id);

  -- Editais: conjunto pequeno; padrão por padrão só nas linhas atrasadas.
  create temp table escopo_ed_stale as
  select c.id,
         md5(coalesce(c.objeto, '') || ' ' || coalesce(c.descricao, '')) as texto_hash,
         public.fn_norm_item(coalesce(c.objeto, '') || ' ' || coalesce(c.descricao, '')) as d
    from public.contratacoes_editais c
    left join public.escopo_item_calc k
      on k.origem = 'edital' and k.origem_id = c.id::text
   where k.origem_id is null
      or k.texto_hash is distinct from md5(coalesce(c.objeto, '') || ' ' || coalesce(c.descricao, ''))
      or k.termos_fp is distinct from v_fp;
  select count(*) into editais from pg_temp.escopo_ed_stale;

  create temp table escopo_ed_hit (
    id uuid, nivel text, familia text, prioridade integer);
  if editais > 0 then
    insert into pg_temp.escopo_ed_hit (id, nivel, familia, prioridade)
    select s.id, t.nivel, t.familia, t.prioridade
      from public.escopo_termos t
      cross join lateral (
        select s.id
          from pg_temp.escopo_ed_stale s
         where s.d <> '' and s.d ~ t.padrao
        offset 0
      ) s
     where t.ativo and t.nivel in ('nucleo', 'adjacente');
  end if;

  create temp table escopo_ed_best as
  select distinct on (h.id) h.id, h.nivel, h.familia
    from pg_temp.escopo_ed_hit h
   order by h.id, (h.nivel = 'adjacente'), h.prioridade;

  create temp table escopo_ed_excl as
  select distinct b.id
    from public.escopo_termos t
    cross join lateral (
      select b.id
        from pg_temp.escopo_ed_best b
        join pg_temp.escopo_ed_stale s on s.id = b.id
       where s.d <> ''
         and left(s.d, coalesce(t.janela_caracteres, length(s.d))) ~ t.padrao
      offset 0
    ) b
   where t.ativo and t.nivel = 'exclusao';

  insert into public.escopo_item_calc (origem, origem_id, texto_hash, termos_fp, nivel, familia)
  select 'edital', s.id::text, s.texto_hash, v_fp,
         case when e.id is null then b.nivel end,
         case when e.id is null then b.familia end
    from pg_temp.escopo_ed_stale s
    left join pg_temp.escopo_ed_best b on b.id = s.id
    left join pg_temp.escopo_ed_excl e on e.id = s.id
  on conflict (origem, origem_id) do update
    set texto_hash = excluded.texto_hash,
        termos_fp = excluded.termos_fp,
        nivel = excluded.nivel,
        familia = excluded.familia,
        calculado_em = now()
  where public.escopo_item_calc.texto_hash is distinct from excluded.texto_hash
     or public.escopo_item_calc.termos_fp is distinct from excluded.termos_fp
     or public.escopo_item_calc.nivel is distinct from excluded.nivel
     or public.escopo_item_calc.familia is distinct from excluded.familia;

  delete from public.escopo_item_calc c
   where c.origem = 'edital'
     and not exists (select 1 from public.contratacoes_editais e where e.id::text = c.origem_id);

  -- PCA 7830 ativo: fn_escopo_pca (vazio | recreacao | escopo), também só no atrasado.
  create temp table escopo_pca_stale as
  select i.id,
         md5(coalesce(i.descricao, '')) as texto_hash,
         public.fn_norm_item(i.descricao) as d
    from public.pca_itens i
    join public.pca_planos p on p.id = i.pca_plano_id
    left join public.escopo_item_calc k
      on k.origem = 'pca_item' and k.origem_id = i.id::text
   where i.codigo_classe_catmat = 7830
     and coalesce(i.ativo, true)
     and coalesce(p.ativo, true)
     and (k.origem_id is null
          or k.texto_hash is distinct from md5(coalesce(i.descricao, ''))
          or k.termos_fp is distinct from v_fp);
  select count(*) into pca from pg_temp.escopo_pca_stale;

  create temp table escopo_pca_rec (id uuid primary key);
  if pca > 0 then
    insert into pg_temp.escopo_pca_rec (id)
    select distinct s.id
      from public.escopo_termos t
      cross join lateral (
        select s.id
          from pg_temp.escopo_pca_stale s
         where btrim(s.d) <> '' and s.d ~ t.padrao
        offset 0
      ) s
     where t.ativo and t.nivel = 'recreacao_pca';
  end if;

  insert into public.escopo_item_calc (origem, origem_id, texto_hash, termos_fp, nivel, familia)
  select 'pca_item', s.id::text, s.texto_hash, v_fp,
         case when btrim(s.d) = '' then 'vazio'
              when r.id is not null then 'recreacao'
              else 'escopo' end,
         null
    from pg_temp.escopo_pca_stale s
    left join pg_temp.escopo_pca_rec r on r.id = s.id
  on conflict (origem, origem_id) do update
    set texto_hash = excluded.texto_hash,
        termos_fp = excluded.termos_fp,
        nivel = excluded.nivel,
        familia = excluded.familia,
        calculado_em = now()
  where public.escopo_item_calc.texto_hash is distinct from excluded.texto_hash
     or public.escopo_item_calc.termos_fp is distinct from excluded.termos_fp
     or public.escopo_item_calc.nivel is distinct from excluded.nivel
     or public.escopo_item_calc.familia is distinct from excluded.familia;

  delete from public.escopo_item_calc c
   where c.origem = 'pca_item'
     and not exists (
       select 1
         from public.pca_itens i
         join public.pca_planos p on p.id = i.pca_plano_id
        where i.id::text = c.origem_id
          and i.codigo_classe_catmat = 7830
          and coalesce(i.ativo, true)
          and coalesce(p.ativo, true));
end
$fn$;

comment on function public.fn_escopo_calc_sincronizar() is
  'Recalcula escopo_item_calc só para texto novo/alterado ou quando escopo_termos muda. Itens de licitação: GIN de fn_norm_item(descricao), um padrão por vez. Edital e PCA: só o conjunto atrasado. Não muda a regra de fn_escopo_item nem de fn_escopo_pca. Só o dono executa.';

revoke all on function public.fn_escopo_calc_sincronizar() from PUBLIC, anon, authenticated, service_role;

-- 4) Primeira carga do cache enquanto a MV antiga ainda pode ser lida --------------------------------
select public.fn_escopo_calc_sincronizar();
analyze public.licitacao_itens;
analyze public.escopo_item_calc;

-- 5) MV agrega o cache (mesmas colunas e o mesmo índice único de expressão) ---------------------------
drop view if exists public.v_orgao_match_projeto;
drop materialized view if exists public.mv_escopo_demanda;

create materialized view public.mv_escopo_demanda as
with it as (
  select l.id as licitacao_id, l.orgao_cnpj,
         case when l.raw->>'unidade_codigo' ~ '^\d{6}$' then l.raw->>'unidade_codigo' end as unidade_codigo,
         coalesce(l.data_publicacao, l.data_inicio) as data_pub,
         i.valor_total_estimado, c.nivel,
         r.homologado, r.data_res
    from public.licitacoes_externas l
    join public.licitacao_itens i on i.licitacao_id = l.id
    join public.escopo_item_calc c
      on c.origem = 'licitacao_item' and c.origem_id = i.id::text and c.nivel is not null
    left join lateral (
      select sum(x.valor_total_homologado) as homologado, max(x.data_resultado) as data_res
        from public.licitacao_resultados x
       where x.licitacao_id = i.licitacao_id and x.numero_item = i.numero_item
    ) r on true
   where l.orgao_cnpj ~ '^\d{14}$'
), ed as (
  select c.orgao_cnpj, null::text as unidade_codigo, c.valor_estimado, c.data_publicacao, k.nivel
    from public.contratacoes_editais c
    join public.escopo_item_calc k
      on k.origem = 'edital' and k.origem_id = c.id::text and k.nivel is not null
   where c.orgao_cnpj ~ '^\d{14}$'
), pca as (
  select p.orgao_cnpj, p.unidade_codigo, i.valor_total_estimado, p.data_publicacao, k.nivel as k
    from public.pca_itens i
    join public.pca_planos p on p.id = i.pca_plano_id
    join public.escopo_item_calc k
      on k.origem = 'pca_item' and k.origem_id = i.id::text
   where i.codigo_classe_catmat = 7830
     and coalesce(i.ativo, true) and coalesce(p.ativo, true)
)
select orgao_cnpj, unidade_codigo, 'licitacao'::text as fonte,
       count(distinct licitacao_id) filter (where nivel = 'nucleo') as processos_nucleo,
       count(distinct licitacao_id) as processos,
       count(*) filter (where nivel = 'nucleo') as itens_nucleo,
       count(*) filter (where nivel = 'adjacente') as itens_adjacentes,
       sum(valor_total_estimado) as valor_estimado,
       sum(homologado) as valor_homologado,
       max(data_pub) as ultima_publicacao,
       max(data_res) as ultimo_resultado
  from it
 group by orgao_cnpj, unidade_codigo
union all
select orgao_cnpj, unidade_codigo, 'edital',
       count(*) filter (where nivel = 'nucleo'), count(*),
       null::bigint, null::bigint, sum(valor_estimado), null::numeric, max(data_publicacao), null::timestamptz
  from ed
 group by orgao_cnpj, unidade_codigo
union all
select orgao_cnpj, unidade_codigo, 'pca',
       null::bigint, null::bigint,
       count(*) filter (where k in ('escopo', 'vazio')), null::bigint,
       sum(valor_total_estimado) filter (where k in ('escopo', 'vazio')), null::numeric,
       max(data_publicacao)::timestamptz, null::timestamptz
  from pca
 group by orgao_cnpj, unidade_codigo
having count(*) filter (where k in ('escopo', 'vazio')) > 0
with data;

create unique index mv_escopo_demanda_key
  on public.mv_escopo_demanda (orgao_cnpj, coalesce(unidade_codigo, ''), fonte);

comment on materialized view public.mv_escopo_demanda is
  'Demanda no escopo por CNPJ + unidade + fonte. Agrega escopo_item_calc (nível já resolvido); não chama fn_escopo_item no refresh. Populada por fn_escopo_match_atualizar().';

create or replace view public.v_orgao_match_projeto with (security_invoker = true) as
select d.orgao_cnpj,
       t.id as orgao_id, coalesce(t.nome_orgao, t.razao_social) as orgao_nome, t.tipo_orgao, t.grupo_tipo, t.esfera_canon, t.poder_canon, t.uf,
       sum(d.processos_nucleo) filter (where d.fonte = 'licitacao') as licitacoes_nucleo,
       sum(d.itens_nucleo)     filter (where d.fonte = 'licitacao') as itens_nucleo,
       sum(d.itens_adjacentes) filter (where d.fonte = 'licitacao') as itens_adjacentes,
       sum(d.valor_estimado)   filter (where d.fonte = 'licitacao') as valor_estimado_itens,
       sum(d.valor_homologado) filter (where d.fonte = 'licitacao') as valor_homologado_itens,
       sum(d.processos_nucleo) filter (where d.fonte = 'edital')    as editais_nucleo,
       sum(d.valor_estimado)   filter (where d.fonte = 'edital')    as valor_editais,
       sum(d.itens_nucleo)     filter (where d.fonte = 'pca')       as itens_pca_7830,
       sum(d.valor_estimado)   filter (where d.fonte = 'pca')       as valor_pca_7830,
       max(d.ultima_publicacao) filter (where d.fonte in ('licitacao', 'edital')) as ultima_compra_publicada,
       max(d.ultimo_resultado) as ultimo_resultado
  from public.mv_escopo_demanda d
  left join public.v_orgao_titular_cnpj t on t.cnpj14 = d.orgao_cnpj
 group by d.orgao_cnpj, t.id, t.nome_orgao, t.razao_social, t.tipo_orgao, t.grupo_tipo, t.esfera_canon, t.poder_canon, t.uf;

revoke all on table public.mv_escopo_demanda, public.v_orgao_match_projeto
  from PUBLIC, anon, authenticated, service_role;
grant select on table public.mv_escopo_demanda, public.v_orgao_match_projeto to service_role;

-- 6) Match: sincroniza, refresh, mesma regra de match_nivel ------------------------------------------
create or replace function public.fn_escopo_match_atualizar(out orgaos_com_match integer, out uasgs_com_match integer)
language plpgsql
volatile
security invoker
set search_path = pg_catalog, public
as $fn$
begin
  perform public.fn_escopo_calc_sincronizar();
  refresh materialized view public.mv_escopo_demanda;
  with m as (
    select orgao_cnpj,
           case when bool_or(fonte in ('licitacao', 'edital') and processos_nucleo > 0) then 'comprou'
                when bool_or(fonte = 'pca') then 'planeja'
                when bool_or(fonte = 'licitacao' and itens_adjacentes > 0) then 'adjacente' end as nivel
      from public.mv_escopo_demanda
     group by orgao_cnpj)
  update public.orgaos o
     set match_nivel = m.nivel, match_atualizado_em = now()
    from (select o2.id, m.nivel
            from public.orgaos o2
            left join m on m.orgao_cnpj = regexp_replace(o2.cnpj, '[^0-9]', '', 'g')) m
   where o.id = m.id and o.match_nivel is distinct from m.nivel;
  select count(*) into orgaos_com_match from public.orgaos where match_nivel is not null;

  with m as (
    select orgao_cnpj, unidade_codigo,
           case when bool_or(fonte = 'licitacao' and processos_nucleo > 0) then 'comprou'
                when bool_or(fonte = 'pca') then 'planeja'
                when bool_or(fonte = 'licitacao' and itens_adjacentes > 0) then 'adjacente' end as nivel
      from public.mv_escopo_demanda
     where unidade_codigo is not null
     group by orgao_cnpj, unidade_codigo)
  update public.uasgs u
     set match_nivel = m.nivel, match_atualizado_em = now()
    from (select u2.id,
                 (array_agg(m.nivel order by array_position(array['comprou', 'planeja', 'adjacente'], m.nivel))
                    filter (where m.nivel is not null))[1] as nivel
            from public.uasgs u2
            left join m on m.unidade_codigo = u2.codigo_uasg
                       and m.orgao_cnpj in (u2.cnpj_cpf_orgao_norm, u2.cnpj_cpf_orgao_vinculado_norm)
           group by u2.id) m
   where u.id = m.id and u.match_nivel is distinct from m.nivel;
  select count(*) into uasgs_com_match from public.uasgs where match_nivel is not null;
end
$fn$;

comment on function public.fn_escopo_match_atualizar() is
  'Sincroniza escopo_item_calc, atualiza mv_escopo_demanda e grava match_nivel de órgãos e UASGs. A regra comprou > planeja > adjacente é a mesma de antes. Roda no job licitagym-escopo-match, transação própria, sem a classificação.';

revoke all on function public.fn_escopo_match_atualizar() from PUBLIC, anon, authenticated, service_role;

-- Grava match_nivel já nesta migration, para a MV nova não esperar até as 05:18.
select public.fn_escopo_match_atualizar();

-- 7) Dois jobs. Sem pg_cron (validação local) não faz nada. ------------------------------------------
do $cron$
declare
  r record;
begin
  if to_regnamespace('cron') is null
     or to_regprocedure('cron.schedule(text,text,text)') is null then
    raise notice 'pg_cron ausente: jobs de classificação e de escopo não reagendados.';
    return;
  end if;
  for r in
    select c.jobid
      from cron.job c
     where c.jobname in (
       'licitagym-orgaos-classificar-escopo',
       'licitagym-orgaos-classificar',
       'licitagym-escopo-match')
  loop
    perform cron.unschedule(r.jobid);
  end loop;
  perform cron.schedule(
    'licitagym-orgaos-classificar',
    '3 8 * * *',
    $cmd$set local statement_timeout = '10min'; select public.fn_orgaos_uasgs_classificar();$cmd$);
  perform cron.schedule(
    'licitagym-escopo-match',
    '18 8 * * *',
    $cmd$set local statement_timeout = '10min'; select public.fn_escopo_match_atualizar();$cmd$);
end
$cron$;

commit;
