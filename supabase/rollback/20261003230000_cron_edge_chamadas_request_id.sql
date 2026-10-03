-- Rollback da 20261003230000_cron_edge_chamadas_request_id.sql
--
-- Devolve a PK para request_id e o corpo antigo das funções (on conflict do nothing, casamento só por id).
-- Isso reintroduz o bug da issue #152: não rode em produção se o objetivo for manter o monitoramento.
--
-- Não apaga linha. Se algum request_id estiver repetido (o caso que a migration passou a permitir),
-- aborta sem mudar nada: a PK antiga não cabe e apagar a duplicata perderia histórico.
-- Se não houver repetido, as linhas ficam, a coluna id sai e as funções voltam ao texto da 20260930180000.
--
-- Rodar no SQL Editor, numa transação só. Não faz parte do fluxo de migration (esta pasta não é aplicada no merge).

begin;

set local lock_timeout = '10s';
set local statement_timeout = '1min';

do $do$
declare
  v_repetido bigint;
  v_pk text[];
  v_con text;
  v_n bigint;
begin
  if to_regclass('private.cron_edge_chamadas') is null then
    raise exception 'rollback: private.cron_edge_chamadas não existe';
  end if;

  select c.request_id into v_repetido
    from private.cron_edge_chamadas c
   group by c.request_id
  having count(*) > 1
   limit 1;
  if v_repetido is not null then
    raise exception
      'rollback abortado: request_id % está repetido. Restaurar a PK antiga exigiria apagar linha. Nada foi alterado.',
      v_repetido;
  end if;

  select coalesce(array_agg(a.attname::text order by k.ord), '{}')
    into v_pk
    from pg_constraint c
    join lateral unnest(c.conkey) with ordinality as k(attnum, ord) on true
    join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.attnum
   where c.conrelid = 'private.cron_edge_chamadas'::regclass
     and c.contype = 'p';

  if v_pk = array['id'] then
    select count(*) into v_n from private.cron_edge_chamadas;
    select c.conname into v_con
      from pg_constraint c
     where c.conrelid = 'private.cron_edge_chamadas'::regclass
       and c.contype = 'p';
    execute format('alter table private.cron_edge_chamadas drop constraint %I', v_con);
    alter table private.cron_edge_chamadas
      add constraint cron_edge_chamadas_pkey primary key (request_id);
    alter table private.cron_edge_chamadas drop column id;
    if (select count(*) from private.cron_edge_chamadas) is distinct from v_n then
      raise exception 'rollback: o count mudou ao tirar a coluna id';
    end if;
  elsif v_pk is distinct from array['request_id'] then
    raise exception 'rollback: chave primária inesperada: %', v_pk;
  end if;
end
$do$;

create or replace function private.cron_chamar_edge(
  p_job text,
  p_funcao text,
  p_corpo jsonb default '{}'::jsonb,
  p_timeout_ms integer default 150000
) returns bigint
language plpgsql
volatile
security invoker
set search_path = pg_catalog
as $fn$
declare
  v_token text;
  v_request_id bigint;
begin
  if p_funcao is null or p_funcao !~ '^[a-z0-9-]+$' then
    raise exception 'cron_chamar_edge: nome de função inválido: %', coalesce(p_funcao, '<null>');
  end if;
  if p_timeout_ms is null or p_timeout_ms < 1000 or p_timeout_ms > 300000 then
    raise exception 'cron_chamar_edge: timeout fora de 1000..300000 ms: %', p_timeout_ms;
  end if;

  select btrim(ds.decrypted_secret) into v_token
    from vault.decrypted_secrets ds
   where ds.name = 'sync_cron_secret'
   limit 1;

  if v_token is null or v_token = '' then
    raise exception 'Vault sem o segredo "sync_cron_secret" (ou vazio): job % não chamou %', p_job, p_funcao
      using hint = 'Crie o segredo com vault.create_secret(<SYNC_CRON_SECRET das Edge Functions>, ''sync_cron_secret'').';
  end if;

  v_request_id := net.http_post(
    url := 'https://ifaiagegyicjzlpskafh.supabase.co/functions/v1/' || p_funcao,
    body := coalesce(p_corpo, '{}'::jsonb),
    headers := jsonb_build_object('Authorization', 'Bearer ' || v_token, 'Content-Type', 'application/json'),
    timeout_milliseconds := p_timeout_ms
  );

  insert into private.cron_edge_chamadas (request_id, job, funcao, corpo)
  values (v_request_id, p_job, p_funcao, coalesce(p_corpo, '{}'::jsonb))
  on conflict (request_id) do nothing;

  return v_request_id;
end
$fn$;

revoke all on function private.cron_chamar_edge(text, text, jsonb, integer)
  from public, anon, authenticated, service_role;

create or replace function private.cron_coletar_respostas() returns integer
language plpgsql
volatile
security invoker
set search_path = pg_catalog
as $fn$
declare
  v_n integer;
begin
  update private.cron_edge_chamadas c
     set status_code   = r.status_code,
         timed_out     = r.timed_out,
         erro          = r.error_msg,
         resposta      = left(r.content, 2000),
         respondido_em = r.created
    from net._http_response r
   where r.id = c.request_id
     and c.respondido_em is null;
  get diagnostics v_n = row_count;
  return v_n;
end
$fn$;

revoke all on function private.cron_coletar_respostas() from public, anon, authenticated, service_role;

comment on table private.cron_edge_chamadas is
  'Chamadas dos jobs pg_cron às Edge Functions (request_id do pg_net) e o status HTTP copiado de net._http_response '
  'pelo job licitagym-cron-respostas. Sem token: o Authorization não é gravado. Leitura só service_role.';

commit;
