-- Verificação do job licitagym-link-catmat-pca escalonado (migration 20261108180000_cron_link_catmat_pca_escalonado).
--   Com pg_cron (Supabase): agenda '*/2 7 * * *' e comando por rodada (minuto / 2), uma chamada por vez.
--   Sem pg_cron (Postgres descartável): só avisa; o EXPLAIN do comando já roda dentro da migration.
-- Só leitura.
do $$
declare
  v_agenda text;
  v_comando text;
begin
  if not exists (select 1 from pg_extension where extname = 'pg_cron') then
    raise notice 'SUCESSO: pg_cron ausente; job licitagym-link-catmat-pca não verificável aqui';
    return;
  end if;
  execute $q$select schedule, command from cron.job where jobname = 'licitagym-link-catmat-pca'$q$
    into v_agenda, v_comando;
  if v_agenda is null then
    raise exception 'CRON LINK CHECK FALHOU: job licitagym-link-catmat-pca ausente';
  end if;
  if v_agenda <> '*/2 7 * * *' then
    raise exception 'CRON LINK CHECK FALHOU: agenda %, esperado */2 7 * * *', v_agenda;
  end if;
  if v_comando not like '%/ 2) as rodada%' or v_comando like '%generate_series%' then
    raise exception 'CRON LINK CHECK FALHOU: comando não é o escalonado por rodada: %', left(v_comando, 200);
  end if;
  raise notice 'SUCESSO: licitagym-link-catmat-pca escalonado (uma chamada por rodada)';
end $$;
