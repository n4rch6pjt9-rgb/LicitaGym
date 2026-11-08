-- Spec 0042 (K-1): aposentadoria do sync de legislação.
--   CA-1: não existe cron.job 'licitagym-sync-pncp-legislation' (só confere onde há pg_cron; o validar-migrations
--         roda sem pg_cron e a idempotência vem da reaplicação da migration).
--   CA-2: pncp_sync_dias_sem_sucesso não olha mais 'legislacao'; com uma execução 'pca' concluída há 1 dia e
--         nenhuma de 'legislacao', o detalhe não tem a chave 'legislacao' e o valor é o pior entre
--         pca, orgaos e compras_catmat (regressão do falso crítico da issue #245).
-- As linhas de teste são desfeitas no fim (bloco interno encerrado por exceção sentinela).

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    if exists (select 1 from cron.job where jobname = 'licitagym-sync-pncp-legislation') then
      raise exception 'LEGISLACAO CHECK FALHOU (CA-1): cron licitagym-sync-pncp-legislation ainda agendado';
    end if;
  else
    raise notice 'pg_cron indisponível: CA-1 conferido só pela migration (cron_sync_jobs_test.ts)';
  end if;
end $$;

do $$
declare
  v_detalhe jsonb;
  v_valor numeric;
  v_esperado numeric;
begin
  begin
    insert into private.pncp_sync_run (resource_type, modo, status, iniciada_em, finalizada_em)
    values ('pca', 'incremental', 'concluida', now() - interval '1 day', now() - interval '1 day'),
           ('orgaos', 'incremental', 'concluida', now() - interval '2 days', now() - interval '2 days'),
           ('compras_catmat', 'incremental', 'concluida', now() - interval '3 days', now() - interval '3 days'),
           -- legislação parada há 40 dias: antes da 0042 seria o pior recurso
           ('legislacao', 'incremental', 'concluida', now() - interval '40 days', now() - interval '40 days');

    select r.detalhe, r.valor into v_detalhe, v_valor
      from private.saude_operacional_resumo() r where r.verificacao = 'pncp_sync_dias_sem_sucesso';

    if v_detalhe ? 'legislacao' then
      raise exception 'LEGISLACAO CHECK FALHOU (CA-2): detalhe ainda tem a chave legislacao: %', v_detalhe;
    end if;
    if not (v_detalhe ? 'pca' and v_detalhe ? 'orgaos' and v_detalhe ? 'compras_catmat') then
      raise exception 'LEGISLACAO CHECK FALHOU (CA-2): detalhe sem pca/orgaos/compras_catmat: %', v_detalhe;
    end if;
    select max(x.v) into v_esperado
      from (select (v_detalhe ->> k)::numeric as v from unnest(array['pca', 'orgaos', 'compras_catmat']) k) x;
    if v_valor is distinct from v_esperado or v_valor >= 40 then
      raise exception 'LEGISLACAO CHECK FALHOU (CA-2): valor % (esperado %, sem a legislação)', v_valor, v_esperado;
    end if;

    raise exception 'desfaz_dados_de_teste';
  exception when raise_exception then
    if sqlerrm <> 'desfaz_dados_de_teste' then
      raise;
    end if;
  end;
  raise notice 'SUCESSO: legislação fora do cron e do indicador pncp_sync_dias_sem_sucesso';
end $$;
