-- Spec 0012, PR 2 (#289): crons do sync do PCA por fila de planos.
--
-- O que muda: cria três jobs, todos com active = false na primeira vez:
--   licitagym-sync-pncp-pca-fila              diário 03:13 BRT ('13 6 * * *')     descoberta + carga (incremental)
--   licitagym-sync-pncp-pca-fila-continuacao  a cada 10 min, 03:00–04:50 BRT ('*/10 6-7 * * *')  só a carga da fila
--   licitagym-sync-pncp-pca-reconciliacao     dia 1, 02:13 BRT ('13 5 1 * *')    descoberta completa + ausentes
-- Reaplicar não dá unschedule: se o jobname já existe, só cron.alter_job(schedule, command), sem mexer em active.
-- Os jobs antigos (licitagym-sync-pncp-pca e licitagym-sync-pncp-pca-continuacao) NÃO mudam aqui.
--
-- TROCA DE FLUXO (não executada aqui; decisão 4 da spec: só depois do incremental do PR 1 conferido em produção e do
-- deploy da Edge Function que entende "rotina"):
--   do $troca$
--   declare j record;
--   begin
--     for j in select jobid, jobname from cron.job
--               where jobname in ('licitagym-sync-pncp-pca-fila', 'licitagym-sync-pncp-pca-fila-continuacao',
--                                 'licitagym-sync-pncp-pca-reconciliacao',
--                                 'licitagym-sync-pncp-pca', 'licitagym-sync-pncp-pca-continuacao')
--     loop
--       perform cron.alter_job(j.jobid, active := j.jobname like 'licitagym-sync-pncp-pca-fila%'
--                                                or j.jobname = 'licitagym-sync-pncp-pca-reconciliacao');
--     end loop;
--   end
--   $troca$;
-- ROLLBACK da troca: o mesmo bloco com active invertido (liga os dois antigos, desliga os três novos).
--
-- Quem lê/escreve: só postgres, via cron.schedule. Nenhum grant novo.
-- Como verificar: supabase/tests/pca_plano_fila_check.sql (sem pg_cron a checagem dos jobs avisa e passa).

begin;

set local lock_timeout = '10s';

do $do$
declare
  j record;
  v_jobid bigint;
  v_existente bigint;
begin
  if not exists (select 1 from pg_extension where extname = 'pg_cron') then
    begin
      create extension if not exists pg_cron with schema pg_catalog;
    exception
      when undefined_object
        or invalid_parameter_value
        or undefined_function
        or invalid_schema_name
        or feature_not_supported then
      raise notice 'pg_cron indisponível (%): jobs da fila do PCA não agendados neste Postgres.', sqlerrm;
      return;
    end;
  end if;

  for j in
    select *
      from (values
        ('licitagym-sync-pncp-pca-fila', '13 6 * * *',
         $cmd$select private.cron_chamar_edge('licitagym-sync-pncp-pca-fila', 'sync-pncp-pca', '{"rotina":"incremental","async":true}'::jsonb, 150000)$cmd$),
        ('licitagym-sync-pncp-pca-fila-continuacao', '*/10 6-7 * * *',
         $cmd$select private.cron_chamar_edge('licitagym-sync-pncp-pca-fila-continuacao', 'sync-pncp-pca', '{"rotina":"incremental","somente_retomada":true,"async":true}'::jsonb, 150000)$cmd$),
        ('licitagym-sync-pncp-pca-reconciliacao', '13 5 1 * *',
         $cmd$select private.cron_chamar_edge('licitagym-sync-pncp-pca-reconciliacao', 'sync-pncp-pca', '{"rotina":"reconciliacao","async":true}'::jsonb, 150000)$cmd$)
      ) as t(nome, agenda, comando)
  loop
    select c.jobid into v_existente
      from cron.job c
     where c.jobname = j.nome;

    if v_existente is not null then
      perform cron.alter_job(v_existente, schedule := j.agenda, command := j.comando);
    else
      v_jobid := cron.schedule(j.nome, j.agenda, j.comando);
      perform cron.alter_job(v_jobid, active := false);
    end if;
  end loop;
end
$do$;

commit;
