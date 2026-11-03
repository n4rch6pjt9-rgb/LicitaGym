-- Sync CATMAT pelo catálogo da empresa, não pelas classes fixas 78/7830 e 72/7220.
--
-- Contexto: o espelho de itens só era agendado para 7830 e 7220. PDMs efetivos de
-- 78/7810 e 93/9320 (catalogo_catmat_pdms_efetivos) nunca entravam no cron.
-- O que muda: remove os dois jobs por classe e cria o modo "catalogo"
-- (mais um job de retomada). Na primeira vez o job nasce com active = false.
-- Reaplicar não dá unschedule nesses dois: se o jobname já existe, só
-- cron.alter_job(schedule, command), sem mexer em active. jobid, active e o
-- histórico em cron.job_run_details ficam. A ativação é manual, com
-- cron.alter_job(..., active := true), só depois do deploy da Edge Function
-- que entende modo=catalogo e recusa modo desconhecido com 400.
--
-- ATIVAÇÃO (não executada aqui; rodar depois que o deploy de sync-compras-catmat
-- estiver confirmado):
--   do $ativar$
--   declare j record;
--   begin
--     for j in
--       select jobid from cron.job
--        where jobname in (
--          'licitagym-sync-compras-catmat-catalogo',
--          'licitagym-sync-compras-catmat-catalogo-continuacao'
--        )
--     loop
--       perform cron.alter_job(j.jobid, active := true);
--     end loop;
--   end
--   $ativar$;
-- Quem lê/escreve: só postgres, via cron.schedule. Nenhum grant novo.
-- Como verificar: supabase/tests/cron_sync_catmat_catalogo_check.sql
--   (no Postgres sem pg_cron a checagem avisa e passa; no Supabase ela exige os jobs).
--
-- Não altera PCA, link-catmat-pca nem sync de órgãos.
-- incluir_inativos fica explícito false no corpo: o espelho periódico guarda só
-- itens ativos. Inativos exigem CATMAT_SYNC_INCLUIR_INATIVOS=true ou
-- incluir_inativos true no corpo. A flag não apaga linha já gravada.
--
-- ROLLBACK (não executado; rodar à mão se precisar voltar os jobs por classe):
--   select cron.unschedule(jobid) from cron.job
--    where jobname in (
--      'licitagym-sync-compras-catmat-catalogo',
--      'licitagym-sync-compras-catmat-catalogo-continuacao'
--    );
--   select cron.schedule(
--     'licitagym-sync-compras-catmat-7830', '7 5 * * 0',
--     $cmd$select private.cron_chamar_edge('licitagym-sync-compras-catmat-7830', 'sync-compras-catmat', '{"codigo_grupo": 78, "codigo_classe": 7830}'::jsonb, 150000)$cmd$
--   );
--   select cron.schedule(
--     'licitagym-sync-compras-catmat-7220', '27 5 * * 0',
--     $cmd$select private.cron_chamar_edge('licitagym-sync-compras-catmat-7220', 'sync-compras-catmat', '{"codigo_grupo": 72, "codigo_classe": 7220}'::jsonb, 150000)$cmd$
--   );

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
      -- Sem o pacote: "extension pg_cron is not available" é feature_not_supported.
      -- Os outros códigos são objeto, função, schema ou parâmetro ausentes.
      -- Não usa WHEN OTHERS: erro interno (ex.: biblioteca fora do shared_preload) sobe.
      when undefined_object
        or invalid_parameter_value
        or undefined_function
        or invalid_schema_name
        or feature_not_supported then
      raise notice 'pg_cron indisponível (%): jobs do catálogo não agendados neste Postgres.', sqlerrm;
      return;
    end;
  end if;

  -- Só os jobs por classe. Os do catálogo, se já existirem, são alterados abaixo
  -- sem unschedule, para não trocar jobid nem apagar cron.job_run_details.
  perform cron.unschedule(c.jobid)
    from cron.job c
   where c.jobname in (
     'licitagym-sync-compras-catmat-7830',
     'licitagym-sync-compras-catmat-7220'
   );

  for j in
    select *
      from (values
        ('licitagym-sync-compras-catmat-catalogo', '7 5 * * 0',
         $cmd$select private.cron_chamar_edge('licitagym-sync-compras-catmat-catalogo', 'sync-compras-catmat', '{"modo":"catalogo","incluir_inativos":false,"async":true}'::jsonb, 150000)$cmd$),
        ('licitagym-sync-compras-catmat-catalogo-continuacao', '27 5 * * 0',
         $cmd$select private.cron_chamar_edge('licitagym-sync-compras-catmat-catalogo-continuacao', 'sync-compras-catmat', '{"modo":"catalogo","incluir_inativos":false,"async":true,"somente_retomada":true}'::jsonb, 150000)$cmd$)
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
