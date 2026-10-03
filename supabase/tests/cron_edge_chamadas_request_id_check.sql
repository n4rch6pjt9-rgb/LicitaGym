-- Colisão do request_id do pg_net (issue #152, migration 20261003230000).
--
-- Reproduz o restart: a tabela já tem os ids 1..17 e o próximo net.http_post devolve 1 de novo.
-- A linha nova tem de ser gravada, a antiga tem de ficar como estava, e a resposta HTTP nova
-- tem de ir para a chamada nova — inclusive quando a antiga ainda está sem resposta.
--
-- Postgres descartável, sem pg_net real (o stub não abre rede). begin/rollback: nada persiste.
-- Trava se a tabela já tiver linha ou se net/vault já existirem (não rode em produção).

begin;

do $$
declare
  v_n bigint;
begin
  if to_regclass('private.cron_edge_chamadas') is null then
    raise exception 'CRON REQUEST_ID CHECK FALHOU: private.cron_edge_chamadas não existe';
  end if;
  if exists (select 1 from pg_extension where extname = 'pg_net') then
    raise exception 'TRAVA: pg_net real instalado. Este check só roda no Postgres de validação, com stub.';
  end if;
  select count(*) into v_n from private.cron_edge_chamadas;
  if v_n > 0 then
    raise exception 'TRAVA: cron_edge_chamadas tem % linha(s). Abortando para não misturar com dado existente.', v_n;
  end if;
  if to_regclass('vault.decrypted_secrets') is not null or to_regclass('net._http_response') is not null then
    raise exception 'TRAVA: vault.decrypted_secrets ou net._http_response já existe.';
  end if;
end $$;

create schema if not exists net;
create schema if not exists vault;

create table vault.decrypted_secrets (
  name text,
  decrypted_secret text
);
insert into vault.decrypted_secrets (name, decrypted_secret)
values ('sync_cron_secret', 'teste-nao-e-segredo');

create table net._http_response (
  id bigint,
  status_code integer,
  content text,
  timed_out boolean,
  error_msg text,
  created timestamptz not null default now()
);

create table net._stub_proximo_id (id bigint);
insert into net._stub_proximo_id (id) values (1);

create function net.http_post(
  url text,
  body jsonb default '{}'::jsonb,
  params jsonb default '{}'::jsonb,
  headers jsonb default '{}'::jsonb,
  timeout_milliseconds integer default 1000
) returns bigint
language plpgsql
volatile
as $$
declare
  v bigint;
begin
  if url is null or timeout_milliseconds is null then
    raise exception 'stub http_post: url e timeout são obrigatórios';
  end if;
  select s.id into v from net._stub_proximo_id s for update;
  update net._stub_proximo_id set id = v + 1;
  return v;
end $$;

do $$
declare
  v_pk text[];
  v_fn_chamar text;
  v_fn_coletar text;
  v_n integer;
  v_copiadas integer;
  v_erros bigint;
  v_id_nova_1 bigint;
  v_id_nova_2 bigint;
  v_id_antiga_1 bigint;
  v_id_isca bigint;
begin
  -- Schema: PK em id, request_id sem unique, NOT NULL, RLS, funções sem EXECUTE para a API.
  select coalesce(array_agg(a.attname::text order by k.ord), '{}')
    into v_pk
    from pg_constraint c
    join lateral unnest(c.conkey) with ordinality as k(attnum, ord) on true
    join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.attnum
   where c.conrelid = 'private.cron_edge_chamadas'::regclass
     and c.contype = 'p';
  if v_pk is distinct from array['id'] then
    raise exception 'CRON REQUEST_ID CHECK FALHOU: PK é %, esperado {id}', v_pk;
  end if;
  if exists (
    select 1
      from pg_index i
      join pg_attribute a on a.attrelid = i.indrelid and a.attnum = any (i.indkey)
     where i.indrelid = 'private.cron_edge_chamadas'::regclass
       and i.indisunique
       and a.attname = 'request_id'
  ) then
    raise exception 'CRON REQUEST_ID CHECK FALHOU: request_id ainda é único';
  end if;
  if not exists (
    select 1 from pg_attribute
     where attrelid = 'private.cron_edge_chamadas'::regclass
       and attname = 'request_id' and attnotnull and not attisdropped
  ) then
    raise exception 'CRON REQUEST_ID CHECK FALHOU: request_id sem NOT NULL';
  end if;
  if not (select c.relrowsecurity from pg_class c where c.oid = 'private.cron_edge_chamadas'::regclass) then
    raise exception 'CRON REQUEST_ID CHECK FALHOU: RLS desligado';
  end if;

  v_fn_chamar := pg_get_functiondef('private.cron_chamar_edge(text,text,jsonb,integer)'::regprocedure);
  v_fn_coletar := pg_get_functiondef('private.cron_coletar_respostas()'::regprocedure);
  if position('on conflict (request_id)' in lower(v_fn_chamar)) > 0 then
    raise exception 'CRON REQUEST_ID CHECK FALHOU: cron_chamar_edge ainda descarta request_id repetido';
  end if;
  if position('6 hours' in v_fn_coletar) = 0 or position('2 seconds' in v_fn_coletar) = 0 then
    raise exception 'CRON REQUEST_ID CHECK FALHOU: cron_coletar_respostas sem a janela de chamado_em';
  end if;
  if has_function_privilege('anon', 'private.cron_chamar_edge(text,text,jsonb,integer)', 'EXECUTE')
     or has_function_privilege('authenticated', 'private.cron_chamar_edge(text,text,jsonb,integer)', 'EXECUTE')
     or has_function_privilege('service_role', 'private.cron_chamar_edge(text,text,jsonb,integer)', 'EXECUTE')
     or has_function_privilege('anon', 'private.cron_coletar_respostas()', 'EXECUTE')
     or has_function_privilege('authenticated', 'private.cron_coletar_respostas()', 'EXECUTE')
     or has_function_privilege('service_role', 'private.cron_coletar_respostas()', 'EXECUTE') then
    raise exception 'CRON REQUEST_ID CHECK FALHOU: anon, authenticated ou service_role executa função do cron';
  end if;

  -- 17 linhas no formato de produção. A 1 é o caso perigoso: mesmo request_id, ainda sem resposta,
  -- chamado_em fora da janela de 6 h. As outras 16 já têm HTTP 200.
  insert into private.cron_edge_chamadas
    (request_id, job, funcao, corpo, chamado_em, status_code, timed_out, erro, resposta, respondido_em)
  select g,
         'job-antigo-' || g,
         'sync-pncp-legislation',
         jsonb_build_object('n', g),
         now() - interval '7 days' + (g || ' minutes')::interval,
         case when g = 1 then null else 200 end,
         case when g = 1 then null else false end,
         null,
         case when g = 1 then null else 'ok-' || g end,
         case when g = 1 then null else now() - interval '7 days' + (g || ' minutes')::interval + interval '2 seconds' end
    from generate_series(1, 17) g;
  select c.id into v_id_antiga_1
    from private.cron_edge_chamadas c
   where c.job = 'job-antigo-1';

  create temp table cron_edge_snapshot on commit drop as
  select id, request_id, job, funcao, corpo, chamado_em, status_code, timed_out, erro, resposta, respondido_em
    from private.cron_edge_chamadas;

  -- Isca dentro da janela de 6 h, request_id 2, ainda sem resposta. A resposta nova não pode cair nela.
  insert into private.cron_edge_chamadas (request_id, job, funcao, corpo, chamado_em)
  values (2, 'isca-30min', 'sync-pncp-orgaos', '{}'::jsonb, now() - interval '30 minutes')
  returning id into v_id_isca;

  -- Restart da sequência: o stub devolve 1 e depois 2.
  select private.cron_chamar_edge('licitagym-sync-pncp-orgaos', 'sync-pncp-orgaos', '{}'::jsonb, 60000) into v_n;
  if v_n is distinct from 1 then
    raise exception 'CRON REQUEST_ID CHECK FALHOU: primeira chamada devolveu request_id %', v_n;
  end if;
  select c.id into v_id_nova_1
    from private.cron_edge_chamadas c
   where c.job = 'licitagym-sync-pncp-orgaos' and c.request_id = 1
   order by c.id desc
   limit 1;

  select private.cron_chamar_edge('licitagym-sync-pncp-pca', 'sync-pncp-pca', '{"async":true}'::jsonb, 150000) into v_n;
  if v_n is distinct from 2 then
    raise exception 'CRON REQUEST_ID CHECK FALHOU: segunda chamada devolveu request_id %', v_n;
  end if;
  select c.id into v_id_nova_2
    from private.cron_edge_chamadas c
   where c.job = 'licitagym-sync-pncp-pca' and c.request_id = 2
   order by c.id desc
   limit 1;

  if (select count(*) from private.cron_edge_chamadas) is distinct from 20 then
    raise exception 'CRON REQUEST_ID CHECK FALHOU: esperado 20 linhas (17 antigas + isca + 2 novas), há %',
      (select count(*) from private.cron_edge_chamadas);
  end if;
  if (select count(*) from private.cron_edge_chamadas where request_id = 1) is distinct from 2
     or (select count(*) from private.cron_edge_chamadas where request_id = 2) is distinct from 3 then
    raise exception 'CRON REQUEST_ID CHECK FALHOU: request_id repetido não ficou gravado';
  end if;

  insert into net._http_response (id, status_code, content, timed_out, error_msg, created)
  values
    (1, 500, 'error sending request', false, 'error sending request', now()),
    (2, 503, 'PNCP_DEGRADADO', false, null, now());

  v_copiadas := private.cron_coletar_respostas();
  if v_copiadas is distinct from 2 then
    raise exception 'CRON REQUEST_ID CHECK FALHOU: cron_coletar_respostas copiou % linha(s), esperado 2', v_copiadas;
  end if;

  if exists (
    select 1
      from cron_edge_snapshot s
      join private.cron_edge_chamadas c on c.id = s.id
     where c.request_id is distinct from s.request_id
        or c.job is distinct from s.job
        or c.funcao is distinct from s.funcao
        or c.corpo is distinct from s.corpo
        or c.chamado_em is distinct from s.chamado_em
        or c.status_code is distinct from s.status_code
        or c.timed_out is distinct from s.timed_out
        or c.erro is distinct from s.erro
        or c.resposta is distinct from s.resposta
        or c.respondido_em is distinct from s.respondido_em
  ) then
    raise exception 'CRON REQUEST_ID CHECK FALHOU: linha antiga foi alterada';
  end if;

  if (select c.status_code from private.cron_edge_chamadas c where c.id = v_id_antiga_1) is not null
     or (select c.respondido_em from private.cron_edge_chamadas c where c.id = v_id_antiga_1) is not null then
    raise exception 'CRON REQUEST_ID CHECK FALHOU: a chamada antiga sem resposta (request_id 1) recebeu o HTTP novo';
  end if;
  if (select c.status_code from private.cron_edge_chamadas c where c.id = v_id_isca) is not null then
    raise exception 'CRON REQUEST_ID CHECK FALHOU: a isca de 30 min (request_id 2) recebeu o HTTP novo';
  end if;
  if (select c.status_code from private.cron_edge_chamadas c where c.id = v_id_nova_1) is distinct from 500
     or (select c.erro from private.cron_edge_chamadas c where c.id = v_id_nova_1) is distinct from 'error sending request'
     or (select c.respondido_em from private.cron_edge_chamadas c where c.id = v_id_nova_1) is null then
    raise exception 'CRON REQUEST_ID CHECK FALHOU: a chamada nova do request_id 1 não ficou com HTTP 500';
  end if;
  if (select c.status_code from private.cron_edge_chamadas c where c.id = v_id_nova_2) is distinct from 503
     or (select left(c.resposta, 20) from private.cron_edge_chamadas c where c.id = v_id_nova_2) is distinct from 'PNCP_DEGRADADO' then
    raise exception 'CRON REQUEST_ID CHECK FALHOU: a chamada nova do request_id 2 não ficou com HTTP 503';
  end if;

  -- O predicado de private.saude_operacional_resumo / cron_http_erros_24h (20261001100000, linhas 92–93).
  select count(*) into v_erros
    from private.cron_edge_chamadas c
   where c.chamado_em > now() - interval '24 hours'
     and (c.status_code >= 400 or c.timed_out or c.erro is not null);
  if v_erros is distinct from 2 then
    raise exception 'CRON REQUEST_ID CHECK FALHOU: cron_http_erros_24h veria % erro(s), esperado 2', v_erros;
  end if;

  -- Segunda passagem (o job roda de hora em hora): a resposta já copiada não vai para a isca
  -- nem para uma chamada feita depois dela.
  insert into private.cron_edge_chamadas (request_id, job, funcao, corpo, chamado_em)
  values (1, 'depois-da-resposta', 'sync-pncp-orgaos', '{}'::jsonb, now() + interval '1 minute');
  if private.cron_coletar_respostas() is distinct from 0 then
    raise exception 'CRON REQUEST_ID CHECK FALHOU: coletor reprocessou resposta já casada';
  end if;
  if (select c.status_code from private.cron_edge_chamadas c where c.job = 'depois-da-resposta') is not null then
    raise exception 'CRON REQUEST_ID CHECK FALHOU: chamada 1 min depois da resposta herdou o HTTP 500';
  end if;
  if (select c.status_code from private.cron_edge_chamadas c where c.id = v_id_isca) is not null then
    raise exception 'CRON REQUEST_ID CHECK FALHOU: segunda passagem colou o HTTP 503 na isca de 30 min';
  end if;

  raise notice 'SUCESSO: request_id repetido gravado; 17 linhas antigas intactas; HTTP novo na chamada nova';
end $$;

rollback;
