-- LicitaGym: saúde operacional sem varrer licitacao_itens (api-saude HTTP 500 por statement timeout)
--
-- Contexto: desde 08/11/2026 o api-saude responde HTTP 500 (alerta api_saude_http, issue #468). Log:
-- "canceling statement due to statement timeout" em private.saude_operacional_resumo(). O PostgREST corta em 8 s
-- (statement_timeout do papel authenticator). O gargalo é a verificação itens_sem_taxonomia_pct: ela varria
-- public.licitacao_itens inteira (280 mil linhas, 596 MB, 3,1 milhões de updates), medido entre 1,8 s e 7,4 s
-- sem paralelismo e com o cache frio. As demais verificações levam milissegundos.
--
-- O que muda (só o bloco itens_sem_taxonomia_pct; o resto é cópia fiel de 20261009181000):
--   * itens com taxonomia: contagem exata pelo índice licitacao_itens_no_taxonomia_efetiva_idx (hoje ~3,2 mil);
--   * total de itens: estimativa do planner (pg_class.reltuples), com detalhe.total_estimado = true; se a tabela
--     nunca foi analisada (reltuples < 0), conta exato;
--   * detalhe mantém itens e sem_taxonomia e ganha com_taxonomia e total_estimado.
--   Valor segue sendo % sem taxonomia com 1 casa; limiares (private.saude_limiares) não mudam.
--
-- ACL: inalterada (security definer, search_path fixo, EXECUTE só service_role), reaplicada abaixo.
-- Verificação: supabase/tests/saude_operacional_check.sql e saude_itens_taxonomia_check.sql. Idempotente.

begin;

set local lock_timeout = '10s';

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
  n_com bigint;
  n_total bigint;
  total_estimado boolean;
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

  -- Itens sem taxonomia: conta exato só os itens COM taxonomia (poucos), pelo índice de expressão
  -- licitacao_itens_no_taxonomia_efetiva_idx (o predicado repete a expressão do índice). O total vem da estimativa
  -- do planner (pg_class.reltuples, mantida por autovacuum/analyze) e o detalhe diz isso em total_estimado.
  -- Tabela nunca analisada (reltuples < 0): conta exato, porque aí ela ainda é pequena.
  select count(*) into n_com
    from public.licitacao_itens i
   where coalesce(i.no_taxonomia, i.taxonomia ->> 'no_taxonomia') is not null;
  select c.reltuples::bigint into n_total from pg_class c where c.oid = 'public.licitacao_itens'::regclass;
  total_estimado := coalesce(n_total, -1) >= 0;
  if not total_estimado then
    select count(*) into n_total from public.licitacao_itens;
  end if;
  n_total := greatest(n_total, n_com);
  v := round(100.0 * (n_total - n_com) / nullif(n_total, 0), 1);
  d := jsonb_build_object('itens', n_total, 'sem_taxonomia', n_total - n_com, 'com_taxonomia', n_com,
                          'total_estimado', total_estimado);
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
