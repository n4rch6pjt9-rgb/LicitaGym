-- Spec 0063 (K-2): fechamento de execução órfã de private.coleta_externa_run sem depender de coleta nova.
--   CA-3: private.coleta_externa_fechar_orfaos() fecha a linha executando há mais de 6 h (devolve 1), deixa a viva
--         e, rodando de novo, devolve 0 (idempotente);
--   CA-4: anon, authenticated e service_role não executam a função; com pg_cron, o job
--         licitagym-coleta-externa-orfaos (de hora em hora) existe com o comando esperado (o Postgres da CI não tem
--         pg_cron: lá a checagem do job é pulada).
-- Fixtures revertidas ao final.
begin;

do $$
declare
  f regprocedure := to_regprocedure('private.coleta_externa_fechar_orfaos()');
  v_id bigint;
  v_viva bigint;
  v_n integer;
  r record;
  v_cmd text;
  v_agenda text;
begin
  if f is null then
    raise exception 'ORFAOS CHECK FALHOU: private.coleta_externa_fechar_orfaos() não existe';
  end if;

  -- CA-4: ACL
  if has_function_privilege('anon', f, 'EXECUTE') or has_function_privilege('authenticated', f, 'EXECUTE')
     or has_function_privilege('service_role', f, 'EXECUTE') then
    raise exception 'ORFAOS CHECK FALHOU: CA-4: anon/authenticated/service_role executam a função';
  end if;
  if exists (select 1 from pg_proc p where p.oid = f
              and not exists (select 1 from unnest(p.proconfig) c where c like 'search_path=%')) then
    raise exception 'ORFAOS CHECK FALHOU: função sem search_path fixo';
  end if;

  -- O iniciar (security definer) chama a função como o próprio dono: os donos têm de ser o mesmo papel.
  if (select pg_get_userbyid(p.proowner) from pg_proc p where p.oid = f) is distinct from
     (select pg_get_userbyid(p.proowner) from pg_proc p
       where p.oid = to_regprocedure('public.coleta_externa_iniciar(text, text, text[])')) then
    raise exception 'ORFAOS CHECK FALHOU: dono de coleta_externa_fechar_orfaos difere do de coleta_externa_iniciar';
  end if;

  -- CA-3: fecha a órfã, deixa a viva, e é idempotente
  update private.coleta_externa_run set status = 'incompleta', finished_at = now() where status = 'executando';
  insert into private.coleta_externa_run (fonte, modo, status, started_at)
  values ('fiesc', 'leads', 'executando', now() - interval '7 hours') returning id into v_id;
  insert into private.coleta_externa_run (fonte, modo, status, started_at)
  values ('firjan', 'leads', 'executando', now() - interval '1 hour') returning id into v_viva;

  v_n := private.coleta_externa_fechar_orfaos();
  if v_n is distinct from 1 then
    raise exception 'ORFAOS CHECK FALHOU: CA-3: esperava 1 linha fechada, veio %', v_n;
  end if;
  select * into r from private.coleta_externa_run where id = v_id;
  if r.status <> 'incompleta' or r.finished_at is null
     or r.detalhe_erros ->> 'erro' is distinct from 'execução não fechada em 6 h (processo interrompido)' then
    raise exception 'ORFAOS CHECK FALHOU: CA-3: órfã não encerrada: %', row_to_json(r);
  end if;
  select * into r from private.coleta_externa_run where id = v_viva;
  if r.status <> 'executando' then
    raise exception 'ORFAOS CHECK FALHOU: CA-3: execução viva foi fechada: %', row_to_json(r);
  end if;
  v_n := private.coleta_externa_fechar_orfaos();
  if v_n is distinct from 0 then
    raise exception 'ORFAOS CHECK FALHOU: CA-3: segunda execução devia devolver 0, veio %', v_n;
  end if;

  -- Caminho real do coletor: service_role abre execução pelo iniciar, que fecha a órfã sem EXECUTE direto na função.
  update private.coleta_externa_run set started_at = now() - interval '7 hours' where id = v_viva;
  set local role service_role;
  perform public.coleta_externa_iniciar('fiesc', 'leads', null);
  reset role;
  select * into r from private.coleta_externa_run where id = v_viva;
  if r.status <> 'incompleta' then
    raise exception 'ORFAOS CHECK FALHOU: iniciar como service_role não fechou a órfã: %', row_to_json(r);
  end if;

  -- CA-4: jobs do pg_cron
  if to_regclass('cron.job') is not null then
    select c.command, c.schedule into v_cmd, v_agenda
      from cron.job c where c.jobname = 'licitagym-coleta-externa-orfaos';
    if v_cmd is null or v_cmd not like '%private.coleta_externa_fechar_orfaos()%' or v_agenda not like '% * * * *' then
      raise exception 'ORFAOS CHECK FALHOU: CA-4: job licitagym-coleta-externa-orfaos ausente ou errado (%, %)',
        v_cmd, v_agenda;
    end if;
  else
    raise notice 'coleta_externa_orfaos_check: sem pg_cron, checagem dos jobs pulada';
  end if;

  raise notice 'SUCESSO: coleta_externa_orfaos_check (fechamento de órfã, idempotência, ACL, jobs)';
end $$;

rollback;
