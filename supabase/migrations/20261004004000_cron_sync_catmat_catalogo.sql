-- Sync CATMAT pelo catálogo da empresa, não pelas classes fixas 78/7830 e 72/7220.
--
-- Contexto: o espelho de itens só era agendado para 7830 e 7220. PDMs efetivos de
-- 78/7810 e 93/9320 (catalogo_catmat_pdms_efetivos) nunca entravam no cron.
-- O que muda: remove os dois jobs por classe e agenda o modo "catalogo"
-- (mais um job de retomada). A Edge Function sync-compras-catmat precisa já
-- entender modo=catalogo; senão o corpo sem codigo_classe cai no caminho antigo.
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

do $do$
declare
  j record;
begin
  if not exists (select 1 from pg_extension where extname = 'pg_cron') then
    begin
      create extension if not exists pg_cron with schema pg_catalog;
    exception when others then
      raise notice 'pg_cron indisponível (%): jobs do catálogo não agendados neste Postgres.', sqlerrm;
      return;
    end;
  end if;

  perform cron.unschedule(c.jobid)
    from cron.job c
   where c.jobname in (
     'licitagym-sync-compras-catmat-7830',
     'licitagym-sync-compras-catmat-7220',
     'licitagym-sync-compras-catmat-catalogo',
     'licitagym-sync-compras-catmat-catalogo-continuacao'
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
    perform cron.schedule(j.nome, j.agenda, j.comando);
  end loop;
end
$do$;

commit;
