-- LicitaGym: valor no escopo por licitação mantido por trigger; o resumo executivo para de ler o heap dos itens.
--
-- Contexto (medido em 13/11/2026, só leitura): às 10:49:22 UTC um POST de api-dashboard-oportunidades
-- (action=resumo_executivo) respondeu 503 depois de 12,6 s: dashboard_resumo_executivo estourou o statement_timeout
-- do PostgREST (8 s, 57014). No mesmo minuto, licitacoes_ids_por_catmat_unica (3x) e saude_operacional_resumo também
-- estouraram; às 10:50 as mesmas chamadas responderam em 0,6 a 3,6 s. pg_stat_statements desde 08/10: 38 execuções
-- concluídas do resumo, média 2,0 s, mínima 0,5 s e máxima 7,1 s.
-- Causa: o CTE valor_itens (índice parcial licitacao_itens_escopo_valor_idx, 20261111190000) é index-only só no
-- papel. licitacao_itens tem 269 MB de heap (shared_buffers = 256 MB) e só 39% das páginas all-visible
-- (3,49 mi updates contra 203 mil inserts: o coletor regrava os itens a cada coleta). EXPLAIN (ANALYZE, BUFFERS) da
-- mesma consulta: 1,65 s no total, 1,09 s no valor_itens com 5.630 heap fetches e 1.459 blocos lidos do disco para
-- 6.652 itens; os 16.560 itens no escopo estão espalhados em 10.482 páginas. Com o cache frio e outras consultas
-- pesadas no mesmo segundo (abrir o painel dispara as quatro), essas leituras aleatórias passam de 8 s. O resto da
-- função (view de prioridade efetiva e prazo) custou 0,40 s com tudo em cache e zero leitura de disco.
--
-- O que muda:
--   1. public.licitacao_valor_escopo: uma linha por licitação que tem pelo menos um item no escopo com valor
--      (categoria_escopo em forte, catmat, borracha, piso, obra_piso, manutencao e valor_total_estimado não nulo;
--      a mesma regra da spec 0050 / 20261109060000), com a soma e a quantidade de itens. ~2,6 mil linhas, poucas
--      páginas. Sem linha = nenhum item conta (o resumo continua devolvendo NULL, nunca 0 inventado).
--   2. Triggers FOR EACH STATEMENT em licitacao_itens (insert, update, delete, truncate), no padrão de
--      licitacao_match (20261002170000): recalculam só as licitações cujos itens entraram, saíram ou mudaram de
--      categoria, valor ou licitação. Upsert do coletor que não muda esses campos não recalcula nada. O recálculo
--      usa o índice parcial licitacao_itens_escopo_valor_idx (por isso ele fica) e serializa os recálculos com um
--      advisory lock de transação único, para dois coletores na mesma licitação não gravarem soma velha.
--   3. Carga inicial a partir dos itens, depois dos triggers e na mesma transação (nenhuma escrita escapa).
--   4. dashboard_resumo_executivo: mesma assinatura, mesmas colunas, mesma ACL; o CTE valor_itens lê a tabela nova.
--
-- Quem escreve: só os triggers (security definer, dono da migration). Quem lê: dashboard_resumo_executivo
-- (security invoker, chamada por service_role via api-dashboard-oportunidades). anon/authenticated sem acesso; RLS
-- ligada e sem policy (leitura só pela Edge Function).
-- Lock: create or replace trigger pega SHARE ROW EXCLUSIVE em licitacao_itens, e a FK da tabela nova pega o mesmo
-- modo em licitacoes_externas, até o commit (upserts dos coletores nas duas esperam; leituras seguem). A carga lê ~16,5 mil itens pelo índice parcial (alguns segundos com cache frio). lock_timeout de 10 s limita a espera pelo
-- lock; se estourar, a migration falha inteira e precisa ser reaplicada. Preferir o merge fora do horário de coleta.
-- Idempotente. Verificação: supabase/tests/licitacao_valor_escopo_check.sql.

begin;

set local lock_timeout = '10s';

create table if not exists public.licitacao_valor_escopo (
  licitacao_id  bigint primary key references public.licitacoes_externas(id) on delete cascade,
  valor         numeric not null,
  itens         integer not null check (itens > 0),
  atualizado_em timestamptz not null default now()
);

comment on table public.licitacao_valor_escopo is
  'Soma de licitacao_itens.valor_total_estimado dos itens no escopo (forte, catmat, borracha, piso, obra_piso, '
  'manutencao; valor não nulo) por licitação. Mantida pelos triggers licitacao_valor_escopo_* de licitacao_itens; '
  'sem linha = nenhum item conta. Lida por dashboard_resumo_executivo. Migration 20261113140000.';

alter table public.licitacao_valor_escopo enable row level security;
revoke all on table public.licitacao_valor_escopo from public, anon, authenticated, service_role;
grant select on table public.licitacao_valor_escopo to service_role;

-- Recalcula as licitações informadas a partir dos itens. Chamada só pelo trigger (sem EXECUTE para os papéis da API).
create or replace function public.licitacao_valor_escopo_recalcular(p_ids bigint[])
returns void
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_ids bigint[];
begin
  select array_agg(distinct x) into v_ids from unnest(p_ids) as x where x is not null;
  if v_ids is null then
    return;
  end if;
  -- Um lock global (padrão de licitacao_match, 20261002170000): dois recálculos concorrentes nunca gravam soma velha
  -- e uma reclassificação em massa não enche a tabela de locks (um advisory lock por licitação enchia). Depois do
  -- lock, a leitura abaixo (read committed: snapshot novo por comando) já vê o commit de quem segurava. Só
  -- recalcula quem mudou categoria, valor ou licitação de item no escopo, então a espera é curta. Supõe READ
  -- COMMITTED (padrão do PostgREST e do psycopg): em REPEATABLE READ o snapshot seria o do início da transação.
  perform pg_advisory_xact_lock(20261113140000);

  delete from public.licitacao_valor_escopo v
   where v.licitacao_id = any (v_ids)
     and not exists (
       select 1 from public.licitacao_itens i
        where i.licitacao_id = v.licitacao_id
          and i.categoria_escopo in ('forte', 'catmat', 'borracha', 'piso', 'obra_piso', 'manutencao')
          and i.valor_total_estimado is not null);

  insert into public.licitacao_valor_escopo as v (licitacao_id, valor, itens, atualizado_em)
  select i.licitacao_id, sum(i.valor_total_estimado), count(*)::int, now()
    from public.licitacao_itens i
   where i.licitacao_id = any (v_ids)
     and i.categoria_escopo in ('forte', 'catmat', 'borracha', 'piso', 'obra_piso', 'manutencao')
     and i.valor_total_estimado is not null
   group by i.licitacao_id
  on conflict (licitacao_id) do update
    set valor = excluded.valor, itens = excluded.itens, atualizado_em = excluded.atualizado_em
    where (v.valor, v.itens) is distinct from (excluded.valor, excluded.itens);
end
$$;

revoke all on function public.licitacao_valor_escopo_recalcular(bigint[]) from public, anon, authenticated, service_role;

-- Trigger de statement: escolhe as licitações afetadas pelas transition tables e recalcula só elas.
create or replace function public.licitacao_valor_escopo_trg()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_ids bigint[];
begin
  if tg_op = 'TRUNCATE' then
    -- TRUNCATE já segura ACCESS EXCLUSIVE em licitacao_itens: nenhum recálculo concorre.
    delete from public.licitacao_valor_escopo;
    return null;
  elsif tg_op = 'INSERT' then
    select array_agg(distinct n.licitacao_id) into v_ids
      from novos n
     where n.categoria_escopo in ('forte', 'catmat', 'borracha', 'piso', 'obra_piso', 'manutencao')
       and n.valor_total_estimado is not null;
  elsif tg_op = 'DELETE' then
    select array_agg(distinct o.licitacao_id) into v_ids
      from antigos o
     where o.categoria_escopo in ('forte', 'catmat', 'borracha', 'piso', 'obra_piso', 'manutencao')
       and o.valor_total_estimado is not null;
  else
    -- UPDATE (inclui o on conflict do update do coletor): só linhas em que algum campo da regra mudou e que estavam
    -- ou ficaram no escopo; as duas licitações quando o item muda de licitação. O join é por id (ninguém reescreve
    -- o id de licitacao_itens; se reescrever, a linha some do join e o recálculo não acontece).
    select array_agg(distinct x.licitacao_id) into v_ids
      from novos n
      join antigos o on o.id = n.id
      cross join lateral (values (n.licitacao_id), (o.licitacao_id)) as x(licitacao_id)
     where (n.licitacao_id, n.categoria_escopo, n.valor_total_estimado)
             is distinct from (o.licitacao_id, o.categoria_escopo, o.valor_total_estimado)
       and ((n.categoria_escopo in ('forte', 'catmat', 'borracha', 'piso', 'obra_piso', 'manutencao')
              and n.valor_total_estimado is not null)
         or (o.categoria_escopo in ('forte', 'catmat', 'borracha', 'piso', 'obra_piso', 'manutencao')
              and o.valor_total_estimado is not null));
  end if;
  perform public.licitacao_valor_escopo_recalcular(v_ids);
  return null;
end
$$;

revoke all on function public.licitacao_valor_escopo_trg() from public, anon, authenticated, service_role;

create or replace trigger licitacao_valor_escopo_ins after insert on public.licitacao_itens
  referencing new table as novos for each statement execute function public.licitacao_valor_escopo_trg();
create or replace trigger licitacao_valor_escopo_upd after update on public.licitacao_itens
  referencing old table as antigos new table as novos for each statement execute function public.licitacao_valor_escopo_trg();
create or replace trigger licitacao_valor_escopo_del after delete on public.licitacao_itens
  referencing old table as antigos for each statement execute function public.licitacao_valor_escopo_trg();
create or replace trigger licitacao_valor_escopo_trunc after truncate on public.licitacao_itens
  for each statement execute function public.licitacao_valor_escopo_trg();

-- Carga inicial (e acerto, se a migration rodar de novo): a tabela fica igual à soma direta dos itens.
delete from public.licitacao_valor_escopo v
 where not exists (
   select 1 from public.licitacao_itens i
    where i.licitacao_id = v.licitacao_id
      and i.categoria_escopo in ('forte', 'catmat', 'borracha', 'piso', 'obra_piso', 'manutencao')
      and i.valor_total_estimado is not null);

insert into public.licitacao_valor_escopo as v (licitacao_id, valor, itens, atualizado_em)
select i.licitacao_id, sum(i.valor_total_estimado), count(*)::int, now()
  from public.licitacao_itens i
 where i.categoria_escopo in ('forte', 'catmat', 'borracha', 'piso', 'obra_piso', 'manutencao')
   and i.valor_total_estimado is not null
 group by i.licitacao_id
on conflict (licitacao_id) do update
  set valor = excluded.valor, itens = excluded.itens, atualizado_em = excluded.atualizado_em
  where (v.valor, v.itens) is distinct from (excluded.valor, excluded.itens);

-- Resumo executivo: igual à 20261109060000, exceto o CTE valor_itens (lê licitacao_valor_escopo).
create or replace function public.dashboard_resumo_executivo(
  p_ids_filtro bigint[] default null,
  p_agora timestamptz default now()
)
returns table (
  leads_total bigint,
  monitoradas_total bigint,
  valor_potencial_total numeric,
  com_valor_total bigint,
  prazo_amanha_total bigint,
  prazo_amanha_valor numeric,
  prazo_7_dias_total bigint,
  prazo_7_dias_valor numeric,
  calculado_em timestamptz
)
language sql
stable
security invoker
set search_path = pg_catalog, public, pg_temp
as $$
  with limites as (
    select
      -- Início do dia seguinte ao fim da janela, em Brasília (fim exclusivo).
      (((p_agora at time zone 'America/Sao_Paulo')::date + 2)::timestamp at time zone 'America/Sao_Paulo') as fim_amanha,
      (((p_agora at time zone 'America/Sao_Paulo')::date + 8)::timestamp at time zone 'America/Sao_Paulo') as fim_7_dias
  ),
  escopo as (
    -- prazo = o mesmo instante com que a view decide se o prazo passou (normalizado, senão bruto em Brasília,
    -- senão data_fim), para a janela nunca divergir do rebaixamento leads -> monitorar.
    select l.id, l.prioridade,
           coalesce(private.pncp_instante_brt(t.normalizacoes #>> '{data_fim,normalizado}'),
                    private.pncp_instante_brt(t.raw ->> 'data_fim_vigencia'),
                    l.data_fim) as prazo
      from public.licitacoes_externas_prioridade_efetiva l
      join public.licitacoes_externas t on t.id = l.id
     where l.eh_canonica is true
       and l.prioridade in ('leads', 'monitorar')
       and (p_ids_filtro is null or l.id = any (p_ids_filtro))
  ),
  valor_itens as (
    -- Spec 0050: valor = soma dos itens no escopo (P-2), já somada por licitação em licitacao_valor_escopo
    -- (migration 20261113140000). Sem linha = nenhum item que conta tem valor: o left join dá NULL e count(v.valor)
    -- não conta.
    select v.licitacao_id, v.valor
      from public.licitacao_valor_escopo v
      join escopo e on e.id = v.licitacao_id
  )
  select
    count(*) filter (where e.prioridade = 'leads'),
    count(*),
    sum(v.valor),
    count(v.valor),
    count(*) filter (where e.prazo > p_agora and e.prazo < lim.fim_amanha),
    sum(v.valor) filter (where e.prazo > p_agora and e.prazo < lim.fim_amanha),
    count(*) filter (where e.prazo > p_agora and e.prazo < lim.fim_7_dias),
    sum(v.valor) filter (where e.prazo > p_agora and e.prazo < lim.fim_7_dias),
    p_agora
  -- Agregado sem GROUP BY: sempre uma linha, com contagens 0 e somas NULL quando o escopo é vazio.
  from escopo e
  left join valor_itens v on v.licitacao_id = e.id
  cross join limites lim
$$;

comment on function public.dashboard_resumo_executivo(bigint[], timestamptz) is
  'Specs 0048 K-1 e 0050 K-1: números do painel executivo sobre licitacoes_externas_prioridade_efetiva (canônicas, '
  'leads + monitorar). Valores = soma de licitacao_itens.valor_total_estimado das categorias forte, catmat, '
  'borracha, piso, obra_piso e manutencao (fraco e sem categoria fora), lida de licitacao_valor_escopo '
  '(20261113140000); NULL quando nenhum item conta. Janelas de prazo em Brasília. p_ids_filtro NULL = todas; '
  'vazio = nenhuma. EXECUTE só service_role.';

revoke all on function public.dashboard_resumo_executivo(bigint[], timestamptz) from public, anon, authenticated;
grant execute on function public.dashboard_resumo_executivo(bigint[], timestamptz) to service_role;

commit;
