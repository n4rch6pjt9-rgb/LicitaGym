-- LicitaGym: saúde operacional acusa coleta de preço parada (spec 0009, CA-6)
--
-- Contexto: a coleta da Pesquisa de Preço do Compras.gov (services/coletor-externo/coletor/compras_precos.py) passa
-- a rodar no Cloud Run Job (coletor.main), uma vez por semana. Até 09/10 ela rodava à mão (última: 03/10) e nada
-- avisava quando parava.
--
-- O que muda:
--   * private.saude_limiares ganha 'precos_dias_sem_coleta' (atenção >= 7,5 dias; crítico >= 8 dias; sem dado =
--     crítico). Valor = dias desde max(last_synced_at) de public.precos_praticados_itens, com 1 casa.
--     Por que last_synced_at e não private.coleta_externa_run: o coletor de preços não registra execução lá
--     (coleta_externa_run.fonte referencia fontes_externas, que é a lista de portais de licitação do Sistema S, e
--     modo só aceita leads/monitorar/historico/dry_run). last_synced_at é gravado pelo upsert do coletor em toda
--     linha que a API devolve, então só anda quando a coleta grava de fato. Falha parcial (um PDM com erro) aparece
--     no código de saída do Job, não aqui.
--   * private.saude_operacional_resumo() é recriada igual à de 20261001100000, mais o bloco da verificação nova
--     (detalhe: última coleta, linhas, linhas sem descrição detalhada, linhas com detalhe sincronizado).
--   O invólucro public.saude_operacional_resumo() (20261007133000) chama a private e não muda.
--
-- ACL: inalterada (security definer com search_path fixo; EXECUTE só service_role), reaplicada abaixo.
-- Verificação: supabase/tests/saude_coleta_precos_check.sql e saude_operacional_check.sql. Idempotente.

begin;

set local lock_timeout = '10s';

insert into private.saude_limiares (verificacao, descricao, unidade, atencao, critico, sem_dado) values
  ('precos_dias_sem_coleta', 'Dias desde a última coleta de preços (Pesquisa de Preço Compras.gov)', 'dias', 7.5, 8, 'critico')
on conflict (verificacao) do nothing;

create or replace function private.saude_operacional_resumo()
returns table (verificacao text, status text, valor numeric, unidade text, atencao numeric, critico numeric,
               mensagem text, detalhe jsonb)
language plpgsql
stable
security definer
set search_path = pg_catalog, pg_temp
as $fn$
#variable_conflict use_column
declare
  m jsonb := '[]'::jsonb;   -- [{verificacao, valor, detalhe}]
  v numeric;
  d jsonb;
begin
  if to_regclass('cron.job_run_details') is not null then
    execute $q$
      select count(*), coalesce(jsonb_agg(jsonb_build_object('job', j.jobname, 'em', r.start_time,
                                          'erro', left(r.return_message, 200)) order by r.start_time desc), '[]'::jsonb)
        from cron.job_run_details r join cron.job j on j.jobid = r.jobid
       where j.jobname like 'licitagym-%' and r.status = 'failed' and r.start_time > now() - interval '24 hours'$q$
      into v, d;
    m := m || jsonb_build_array(jsonb_build_object('verificacao', 'cron_falhas_24h', 'valor', v, 'detalhe', d));
  end if;

  if to_regclass('private.cron_edge_chamadas') is not null then
    select count(*), coalesce(jsonb_agg(jsonb_build_object('job', c.job, 'funcao', c.funcao, 'http', c.status_code,
                                        'timeout', c.timed_out, 'erro', left(coalesce(c.erro, c.resposta), 200),
                                        'em', c.chamado_em) order by c.chamado_em desc), '[]'::jsonb)
      into v, d
      from private.cron_edge_chamadas c
     where c.chamado_em > now() - interval '24 hours'
       and (c.status_code >= 400 or c.timed_out or c.erro is not null);
    m := m || jsonb_build_array(jsonb_build_object('verificacao', 'cron_http_erros_24h', 'valor', v, 'detalhe', d));

    select count(*), coalesce(jsonb_agg(jsonb_build_object('job', c.job, 'funcao', c.funcao, 'em', c.chamado_em)), '[]'::jsonb)
      into v, d
      from private.cron_edge_chamadas c
     where c.respondido_em is null and c.chamado_em < now() - interval '30 minutes'
       and c.chamado_em > now() - interval '7 days';
    m := m || jsonb_build_array(jsonb_build_object('verificacao', 'cron_sem_resposta', 'valor', v, 'detalhe', d));
  end if;

  select round(max(extract(epoch from now() - coalesce(r.last_heartbeat_at, r.iniciada_em)) / 60)),
         coalesce(jsonb_agg(jsonb_build_object('id', r.id, 'resource', r.resource_type,
                            'heartbeat', coalesce(r.last_heartbeat_at, r.iniciada_em))), '[]'::jsonb)
    into v, d
    from private.pncp_sync_run r where r.status = 'executando';
  m := m || jsonb_build_array(jsonb_build_object('verificacao', 'pncp_sync_heartbeat_parado', 'valor', coalesce(v, 0), 'detalhe', d));

  select count(*), coalesce(jsonb_agg(jsonb_build_object('id', r.id, 'resource', r.resource_type,
                                      'erro', left(r.erro_principal, 200), 'em', r.iniciada_em)), '[]'::jsonb)
    into v, d
    from private.pncp_sync_run r where r.status = 'falhou' and r.iniciada_em > now() - interval '24 hours';
  m := m || jsonb_build_array(jsonb_build_object('verificacao', 'pncp_sync_falhas_24h', 'valor', v, 'detalhe', d));

  select max(t.dias), jsonb_object_agg(t.resource_type, t.dias)
    into v, d
    from (select x.resource_type,
                 round((extract(epoch from now() - max(r.finalizada_em)) / 86400)::numeric, 1) as dias
            from (values ('pca'), ('orgaos'), ('legislacao'), ('compras_catmat')) x(resource_type)
            left join private.pncp_sync_run r
              on r.resource_type = x.resource_type and r.status in ('concluida', 'concluida_com_erros')
           group by x.resource_type) t;
  m := m || jsonb_build_array(jsonb_build_object('verificacao', 'pncp_sync_dias_sem_sucesso', 'valor', v, 'detalhe', d));

  if to_regclass('private.coleta_externa_run') is not null then
    -- pior fonte entre as que já concluíram alguma vez; nenhuma conclusão = sem dado (crítico)
    select round((extract(epoch from now() - min(r.ultima)) / 86400)::numeric, 1),
           coalesce(jsonb_object_agg(r.fonte, r.ultima), '{}'::jsonb)
      into v, d
      from (select fonte, max(finished_at) as ultima
              from private.coleta_externa_run where status in ('concluida', 'concluida_com_erros')
             group by fonte) r;
    m := m || jsonb_build_array(jsonb_build_object('verificacao', 'coleta_externa_dias_sem_sucesso', 'valor', v, 'detalhe', d));
  end if;

  if to_regclass('public.precos_praticados_itens') is not null then
    -- Pesquisa de Preço (spec 0009): dias desde a última gravação de preço. last_synced_at só muda quando o upsert
    -- do coletor grava; uma coleta que falha inteira não move a data. Nenhum preço = sem dado (crítico).
    select round((extract(epoch from now() - max(p.last_synced_at)) / 86400)::numeric, 1),
           jsonb_build_object(
             'ultima_coleta', max(p.last_synced_at),
             'linhas', count(*),
             'sem_descricao_detalhada', count(*) filter (where nullif(btrim(p.descricao_detalhada_item), '') is null),
             'detalhe_sincronizado', count(*) filter (where p.detalhe_sincronizado_em is not null))
      into v, d
      from public.precos_praticados_itens p;
    m := m || jsonb_build_array(jsonb_build_object('verificacao', 'precos_dias_sem_coleta', 'valor', v, 'detalhe', d));
  end if;

  select round((extract(epoch from now() - max(l.created_at)) / 3600)::numeric, 1),
         coalesce((select jsonb_object_agg(f.fonte, f.ultima)
                     from (select fonte, max(created_at) as ultima from public.licitacoes_externas group by fonte) f), '{}'::jsonb)
    into v, d
    from public.licitacoes_externas l;
  m := m || jsonb_build_array(jsonb_build_object('verificacao', 'licitacoes_horas_sem_novas', 'valor', v, 'detalhe', d));

  select round(100.0 * count(*) filter (where coalesce(i.no_taxonomia, i.taxonomia ->> 'no_taxonomia') is null)
               / nullif(count(*), 0), 1),
         jsonb_build_object('itens', count(*),
                            'sem_taxonomia', count(*) filter (where coalesce(i.no_taxonomia, i.taxonomia ->> 'no_taxonomia') is null))
    into v, d
    from public.licitacao_itens i;
  m := m || jsonb_build_array(jsonb_build_object('verificacao', 'itens_sem_taxonomia_pct', 'valor', v, 'detalhe', d));

  return query
    with medidas as (
      select e ->> 'verificacao' as verificacao, (e ->> 'valor')::numeric as valor, e -> 'detalhe' as detalhe
        from jsonb_array_elements(m) e
    ), avaliadas as (
      select x.verificacao,
             case when x.valor is null then l.sem_dado
                  when l.critico is not null and x.valor >= l.critico then 'critico'
                  when x.valor >= l.atencao then 'atencao'
                  else 'ok' end as status,
             x.valor, l.unidade, l.atencao, l.critico, l.descricao, x.detalhe
        from medidas x join private.saude_limiares l on l.verificacao = x.verificacao
       where l.ativo
    )
    select a.verificacao, a.status, a.valor, a.unidade, a.atencao, a.critico,
           a.descricao || ': ' || coalesce(a.valor::text || ' ' || a.unidade, 'sem dado') ||
             ' (atenção ≥ ' || a.atencao || coalesce(', crítico ≥ ' || a.critico, '') || ')',
           a.detalhe
      from avaliadas a
     order by case a.status when 'critico' then 0 when 'atencao' then 1 else 2 end, a.verificacao;
end
$fn$;

comment on function private.saude_operacional_resumo() is
  'Verificações de saúde da ingestão (cron, sync PNCP, coleta externa, coleta de preços, volume, taxonomia) com '
  'status por limiar de private.saude_limiares. Só leitura. EXECUTE só service_role (api-saude).';

revoke all on function private.saude_operacional_resumo() from public, anon, authenticated;
grant execute on function private.saude_operacional_resumo() to service_role;

commit;
