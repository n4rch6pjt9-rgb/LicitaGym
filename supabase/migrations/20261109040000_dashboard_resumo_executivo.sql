-- LicitaGym: resumo executivo do painel calculado no servidor (spec 0048, K-1).
--
-- Por quê: o ExecutiveDashboard somava uma amostra de 100 oportunidades e avisava que "a soma ainda não é calculada
-- no servidor" (issue #42 do Dashboard). Em 09/11/2026 havia 1079 leads e 945 monitorar gravados.
--
-- O que muda: função public.dashboard_resumo_executivo(p_ids_filtro, p_agora), uma linha com os números do painel,
-- lidos da view licitacoes_externas_prioridade_efetiva (prioridade efetiva, só canônicas):
--   - leads_total; monitoradas_total (leads + monitorar);
--   - valor_potencial_total = soma de valor_total das ativas; NULL quando nenhuma tem valor (nunca 0 inventado);
--   - com_valor_total = ativas com valor_total;
--   - prazo_amanha_* = ativas com data_fim depois de p_agora e até 23:59:59 de amanhã (Brasília);
--   - prazo_7_dias_* = idem até 23:59:59 do 7º dia depois de hoje (Brasília); _valor NULL quando nenhuma tem valor;
--   - calculado_em = p_agora.
-- As janelas usam o mesmo instante de prazo da view (normalizacoes -> raw.data_fim_vigencia em Brasília -> data_fim),
-- porque data_fim pode estar deslocado (#339); assim a janela não diverge do rebaixamento leads -> monitorar.
-- Sem "alta aderência" (decisão P-3 de 09/11: volta só com aderência pelo TR).
-- p_ids_filtro NULL = todas as oportunidades; array vazio = nenhuma (recorte de catálogo/CATMAT sem resultado).
--
-- Quem lê: api-dashboard-oportunidades action=resumo_executivo (service_role, depois de checar usuário e tenant).
-- Verificar: supabase/tests/dashboard_resumo_executivo_check.sql.
begin;

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
    select l.prioridade, l.valor_total,
           coalesce(private.pncp_instante_brt(t.normalizacoes #>> '{data_fim,normalizado}'),
                    private.pncp_instante_brt(t.raw ->> 'data_fim_vigencia'),
                    l.data_fim) as prazo
      from public.licitacoes_externas_prioridade_efetiva l
      join public.licitacoes_externas t on t.id = l.id
     where l.eh_canonica is true
       and l.prioridade in ('leads', 'monitorar')
       and (p_ids_filtro is null or l.id = any (p_ids_filtro))
  )
  select
    count(*) filter (where e.prioridade = 'leads'),
    count(*),
    sum(e.valor_total),
    count(e.valor_total),
    count(*) filter (where e.prazo > p_agora and e.prazo < lim.fim_amanha),
    sum(e.valor_total) filter (where e.prazo > p_agora and e.prazo < lim.fim_amanha),
    count(*) filter (where e.prazo > p_agora and e.prazo < lim.fim_7_dias),
    sum(e.valor_total) filter (where e.prazo > p_agora and e.prazo < lim.fim_7_dias),
    p_agora
  -- Agregado sem GROUP BY: sempre uma linha, com contagens 0 e somas NULL quando o escopo é vazio.
  from escopo e
  cross join limites lim
$$;

comment on function public.dashboard_resumo_executivo(bigint[], timestamptz) is
  'Spec 0048 K-1: números do painel executivo sobre licitacoes_externas_prioridade_efetiva (canônicas, leads + '
  'monitorar). Somas NULL quando nenhuma linha tem valor_total. Janelas de prazo em Brasília. p_ids_filtro NULL = '
  'todas; vazio = nenhuma. EXECUTE só service_role.';

revoke all on function public.dashboard_resumo_executivo(bigint[], timestamptz) from public, anon, authenticated;
grant execute on function public.dashboard_resumo_executivo(bigint[], timestamptz) to service_role;

commit;
