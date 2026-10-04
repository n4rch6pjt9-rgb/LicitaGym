-- Agenda o sync CATMAT das classes 78/7810 e 93/9320.
--
-- Contexto: a lista fixa TRANSITIONAL_FITNESS_SCOPE passa a incluir essas classes.
-- Os jobs 7830 e 7220 continuam como estão. Este arquivo só acrescenta os dois novos.
-- Quem lê/escreve: só postgres, via cron.schedule. Nenhum grant novo.
-- Como verificar: supabase/tests/cron_sync_catmat_classes_7810_9320_check.sql
--   (no Postgres sem pg_cron a checagem avisa e passa).
--
-- A mesma lista também amplia, no código da Edge Function (não nesta migration):
--   link-catmat-pca (linkTargetClasses), pcaItemScope e sync-pncp-orgaos (orgSyncClasses).
-- O download do PCA não muda: 7810 e 9320 são CURATED_EXTENSION, e o seed do PCA é só a CORE 7830.
-- O job licitagym-link-catmat-pca não é reescrito aqui. O generate_series dele ainda conta
-- só pca_itens de 7830 e 7220.
--
-- ROLLBACK (não executado; rodar à mão para tirar só estes dois jobs):
--   select cron.unschedule(jobid) from cron.job
--    where jobname in (
--      'licitagym-sync-compras-catmat-7810',
--      'licitagym-sync-compras-catmat-9320'
--    );

begin;

do $do$
declare
  j record;
begin
  if not exists (select 1 from pg_extension where extname = 'pg_cron') then
    begin
      create extension if not exists pg_cron with schema pg_catalog;
    exception when others then
      raise notice 'pg_cron indisponível (%): jobs 7810/9320 não agendados neste Postgres.', sqlerrm;
      return;
    end;
  end if;

  perform cron.unschedule(c.jobid)
    from cron.job c
   where c.jobname in (
     'licitagym-sync-compras-catmat-7810',
     'licitagym-sync-compras-catmat-9320'
   );

  for j in
    select *
      from (values
        ('licitagym-sync-compras-catmat-7810', '47 5 * * 0',
         $cmd$select private.cron_chamar_edge('licitagym-sync-compras-catmat-7810', 'sync-compras-catmat', '{"codigo_grupo": 78, "codigo_classe": 7810, "async": true}'::jsonb, 150000)$cmd$),
        ('licitagym-sync-compras-catmat-9320', '7 6 * * 0',
         $cmd$select private.cron_chamar_edge('licitagym-sync-compras-catmat-9320', 'sync-compras-catmat', '{"codigo_grupo": 93, "codigo_classe": 9320, "async": true}'::jsonb, 150000)$cmd$)
      ) as t(nome, agenda, comando)
  loop
    perform cron.schedule(j.nome, j.agenda, j.comando);
  end loop;
end
$do$;

commit;
