-- Checagem dos jobs do sync CATMAT por catálogo (migration 20261004004000).
-- pg_cron não existe no Postgres descartável da validação: nesse caso a checagem
-- só avisa. No Supabase (depois de aplicar a migration) os jobs precisam existir
-- e o comando não pode carregar segredo.

do $$
declare
  v_catalogo text;
  v_retomada text;
  v_agenda_catalogo text;
  v_agenda_retomada text;
  v_ativo_catalogo boolean;
  v_ativo_retomada boolean;
begin
  if to_regclass('cron.job') is null then
    raise notice 'SUCESSO: cron.job ausente neste Postgres; jobs do catálogo só são conferidos onde pg_cron existe.';
    return;
  end if;

  select command, schedule, active
    into v_catalogo, v_agenda_catalogo, v_ativo_catalogo
    from cron.job where jobname = 'licitagym-sync-compras-catmat-catalogo';
  select command, schedule, active
    into v_retomada, v_agenda_retomada, v_ativo_retomada
    from cron.job where jobname = 'licitagym-sync-compras-catmat-catalogo-continuacao';

  if v_catalogo is null then
    raise exception 'ACL CHECK FALHOU: job licitagym-sync-compras-catmat-catalogo ausente';
  end if;
  if v_retomada is null then
    raise exception 'ACL CHECK FALHOU: job licitagym-sync-compras-catmat-catalogo-continuacao ausente';
  end if;
  if v_catalogo not like '%"modo":"catalogo"%' or v_catalogo not like '%"incluir_inativos":false%' then
    raise exception 'ACL CHECK FALHOU: job do catálogo sem modo ou sem incluir_inativos explícito';
  end if;
  if v_retomada not like '%somente_retomada%' then
    raise exception 'ACL CHECK FALHOU: job de retomada sem somente_retomada';
  end if;
  if v_agenda_catalogo is distinct from '7 5 * * 0' then
    raise exception 'ACL CHECK FALHOU: schedule do catálogo é %, esperado 7 5 * * 0', v_agenda_catalogo;
  end if;
  if v_agenda_retomada is distinct from '27 5 * * 0' then
    raise exception 'ACL CHECK FALHOU: schedule da retomada é %, esperado 27 5 * * 0', v_agenda_retomada;
  end if;
  if v_ativo_catalogo is distinct from v_ativo_retomada then
    raise exception 'ACL CHECK FALHOU: estado misto dos jobs do catálogo (catalogo=% , retomada=%). Os dois precisam estar ambos ativos ou ambos inativos.',
      v_ativo_catalogo, v_ativo_retomada;
  end if;
  if v_catalogo ilike '%bearer%' or v_retomada ilike '%bearer%' or v_catalogo ilike '%service_role%' then
    raise exception 'ACL CHECK FALHOU: comando do cron contém segredo ou bearer';
  end if;
  if exists (
    select 1 from cron.job
     where jobname in ('licitagym-sync-compras-catmat-7830', 'licitagym-sync-compras-catmat-7220')
  ) then
    raise exception 'ACL CHECK FALHOU: jobs por classe 7830/7220 ainda agendados';
  end if;

  raise notice 'SUCESSO: sync CATMAT segue o catálogo (jobs catalogo e retomada, sem 7830/7220).';
end
$$;
