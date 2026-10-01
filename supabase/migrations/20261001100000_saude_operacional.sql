-- LicitaGym: saúde operacional (observabilidade mínima, plano DevOps Fase 3)
--
-- Contexto:
-- Com os jobs pg_cron (20260930180000) a ingestão roda sozinha, mas nada avisa quando falha: em 30/09 houve 401/500
-- nas chamadas às Edge Functions sem ninguém ver, o coletor do Sistema S não registra execução desde 24/09 e 0 de
-- 1.976 itens têm taxonomia. Esta migration junta, numa função só de leitura, as verificações com limiares
-- definidos antes (editáveis em private.saude_limiares). A Edge Function api-saude a expõe (admin ou cron secret) e o
-- workflow .github/workflows/saude.yml a consulta a cada 30 min e abre/fecha a issue "Alerta operacional".
--
-- Verificações (valor -> status pelo limiar; sem dado -> saude_limiares.sem_dado):
--   cron_falhas_24h              jobs licitagym-* com status failed em cron.job_run_details (24 h)
--   cron_http_erros_24h          chamadas às Edge Functions com HTTP >= 400, timeout ou erro (cron_edge_chamadas, 24 h)
--   cron_sem_resposta            chamadas sem resposta há mais de 30 min (pg_net perdeu ou a função travou)
--   pncp_sync_heartbeat_parado   minutos sem heartbeat da sync PNCP mais parada em 'executando'
--   pncp_sync_falhas_24h         execuções da sync PNCP com status falhou (24 h)
--   pncp_sync_dias_sem_sucesso   dias desde a última conclusão, no pior resource agendado (pca, orgaos, legislacao,
--                                compras_catmat); detalhe por resource
--   coleta_externa_dias_sem_sucesso  dias desde a última coleta concluída do Sistema S (nenhuma = crítico)
--   licitacoes_horas_sem_novas   horas desde a última licitação nova (qualquer fonte)
--   itens_sem_taxonomia_pct      % de itens sem nó de taxonomia (coluna ou JSONB): só atenção, nunca crítico
-- cron.* e net.* são lidos por SQL dinâmico: sem pg_cron (banco de teste) a verificação some, em vez de quebrar.
--
-- ACL: tudo só service_role. A função é security definer (dono postgres) para ler cron.job_run_details.
-- Verificação: supabase/tests/saude_operacional_check.sql. Idempotente.

begin;

create schema if not exists private;

-- 1) Limiares ---------------------------------------------------------------------------------------------------------
create table if not exists private.saude_limiares (
  verificacao text primary key,
  descricao   text not null,
  unidade     text not null,
  atencao     numeric not null,
  critico     numeric,                       -- null: nunca vira crítico (só informa)
  sem_dado    text not null default 'atencao' check (sem_dado in ('ok', 'atencao', 'critico')),
  ativo       boolean not null default true,
  updated_at  timestamptz not null default now()
);
comment on table private.saude_limiares is
  'Limiares das verificações de private.saude_operacional_resumo() (valor >= atencao -> atencao; >= critico -> critico; '
  'sem dado -> sem_dado). Editar aqui muda os alertas sem deploy. Só service_role.';

insert into private.saude_limiares (verificacao, descricao, unidade, atencao, critico, sem_dado) values
  ('cron_falhas_24h',                 'Jobs pg_cron com falha nas últimas 24 h',                 'execuções', 1,  3,    'ok'),
  ('cron_http_erros_24h',             'Chamadas de cron às Edge Functions com erro (24 h)',      'chamadas',  1,  3,    'ok'),
  ('cron_sem_resposta',               'Chamadas de cron sem resposta há mais de 30 min',        'chamadas',  1,  3,    'ok'),
  ('pncp_sync_heartbeat_parado',      'Sync PNCP em execução sem heartbeat',                    'min',       15, 60,   'ok'),
  ('pncp_sync_falhas_24h',            'Syncs PNCP com status falhou (24 h)',                    'execuções', 1,  3,    'ok'),
  ('pncp_sync_dias_sem_sucesso',      'Dias desde a última sync PNCP concluída (pior resource)', 'dias',      2,  8,    'critico'),
  ('coleta_externa_dias_sem_sucesso', 'Dias desde a última coleta do Sistema S concluída',      'dias',      8,  15,   'critico'),
  ('licitacoes_horas_sem_novas',      'Horas desde a última licitação nova',                   'horas',     48, 96,   'critico'),
  ('itens_sem_taxonomia_pct',         'Itens de licitação sem nó de taxonomia',                '%',         50, null, 'ok')
on conflict (verificacao) do nothing;

alter table private.saude_limiares enable row level security;
revoke all on table private.saude_limiares from public, anon, authenticated;
grant all on table private.saude_limiares to service_role;

-- 2) Resumo ------------------------------------------------------------------------------------------------------------
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
  'Verificações de saúde da ingestão (cron, sync PNCP, coleta externa, volume, taxonomia) com status por limiar de '
  'private.saude_limiares. Só leitura. EXECUTE só service_role (api-saude).';

revoke all on function private.saude_operacional_resumo() from public, anon, authenticated;
grant execute on function private.saude_operacional_resumo() to service_role;

commit;
