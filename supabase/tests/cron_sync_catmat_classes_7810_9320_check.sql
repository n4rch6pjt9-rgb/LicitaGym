-- Checagem dos jobs CATMAT 7810 e 9320 (migration 20261004006000).
-- Sem pg_cron a checagem só avisa. No Supabase exige os dois jobs, sem segredo no comando.

do $$
declare
  v_7810 text;
  v_9320 text;
begin
  if to_regclass('cron.job') is null then
    raise notice 'SUCESSO: cron.job ausente neste Postgres; jobs 7810/9320 só são conferidos onde pg_cron existe.';
    return;
  end if;

  select command into v_7810 from cron.job where jobname = 'licitagym-sync-compras-catmat-7810';
  select command into v_9320 from cron.job where jobname = 'licitagym-sync-compras-catmat-9320';

  if v_7810 is null or v_7810 not like '%"codigo_classe": 7810%' then
    raise exception 'ACL CHECK FALHOU: job licitagym-sync-compras-catmat-7810 ausente ou sem a classe';
  end if;
  if v_9320 is null or v_9320 not like '%"codigo_classe": 9320%' then
    raise exception 'ACL CHECK FALHOU: job licitagym-sync-compras-catmat-9320 ausente ou sem a classe';
  end if;
  if v_7810 not like '%"codigo_grupo": 78%' or v_9320 not like '%"codigo_grupo": 93%' then
    raise exception 'ACL CHECK FALHOU: par grupo/classe trocado';
  end if;
  if v_7810 ilike '%bearer%' or v_9320 ilike '%bearer%' or v_7810 ilike '%service_role%' or v_9320 ilike '%service_role%' then
    raise exception 'ACL CHECK FALHOU: comando do cron contém segredo ou bearer';
  end if;

  raise notice 'SUCESSO: jobs de sync CATMAT 7810 e 9320 agendados.';
end
$$;
