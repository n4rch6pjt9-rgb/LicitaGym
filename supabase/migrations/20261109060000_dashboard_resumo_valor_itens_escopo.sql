-- LicitaGym: "Valor no escopo" do painel soma só os itens no escopo (spec 0050, K-1).
--
-- Por quê: a 0048 somava valor_total do certame inteiro. Editais amplos (incêndio florestal, enfermagem, mobiliário)
-- entravam com centenas de milhões por causa de um ou dois itens no escopo. Em 09/11/2026 (prioridade gravada, sem
-- recorte de catálogo): 1798 certames somavam R$ 4,25 bi; nos 10 maiores, o edital somava ~R$ 1,57 bi e os itens com
-- categoria de escopo ~R$ 325 mi. Medição completa na spec.
--
-- O que muda (mesma assinatura e mesmas colunas da 0048; create or replace, sem drop):
--   - valor_potencial_total = soma de licitacao_itens.valor_total_estimado dos itens das ativas cuja categoria_escopo
--     está em (forte, catmat, borracha, piso, obra_piso). fraco e item sem categoria ficam fora (decisão P-2 de 09/11);
--   - com_valor_total = ativas com pelo menos um desses itens com valor;
--   - prazo_amanha_valor e prazo_7_dias_valor no mesmo critério (P-5);
--   - somas NULL quando nenhum item conta (nunca 0 inventado). Contagens de leads, monitoradas e prazos inalteradas.
-- A categoria vem do coletor (CATMAT e termos), não do TR: aceito pelo Marcelo com o rótulo "Valor no escopo" (P-3).
--
-- Quem lê: api-dashboard-oportunidades action=resumo_executivo (service_role). Leitura nova: public.licitacao_itens
-- (service_role já tem SELECT; função segue security invoker). Join pelo índice único (licitacao_id, numero_item).
-- Verificar: supabase/tests/dashboard_resumo_executivo_check.sql (blocos "0050 CA-1..CA-3").
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
    -- Spec 0050: valor = soma dos itens no escopo (P-2). NULL quando nenhum item que conta tem valor.
    select i.licitacao_id, sum(i.valor_total_estimado) as valor
      from public.licitacao_itens i
      join escopo e on e.id = i.licitacao_id
     where i.categoria_escopo in ('forte', 'catmat', 'borracha', 'piso', 'obra_piso')
       -- Sem este filtro, certame só com item sem valor geraria linha com soma NULL; com ele, não gera linha e
       -- count(v.valor) conta só quem tem valor.
       and i.valor_total_estimado is not null
     group by i.licitacao_id
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
  'borracha, piso e obra_piso (fraco e sem categoria fora); NULL quando nenhum item conta. Janelas de prazo em '
  'Brasília. p_ids_filtro NULL = todas; vazio = nenhuma. EXECUTE só service_role.';

revoke all on function public.dashboard_resumo_executivo(bigint[], timestamptz) from public, anon, authenticated;
grant execute on function public.dashboard_resumo_executivo(bigint[], timestamptz) to service_role;

commit;
