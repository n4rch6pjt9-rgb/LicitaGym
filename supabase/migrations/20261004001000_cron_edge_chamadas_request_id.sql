-- LicitaGym: cron_edge_chamadas deixa de usar o request_id do pg_net como chave
--
-- Contexto (03/10/2026, issue #152): private.cron_chamar_edge grava o id que net.http_post devolve
-- (20260930180000, linhas 32 e 94–96: request_id bigint primary key + on conflict (request_id) do nothing).
-- net._http_response e a fila do pg_net são unlogged: no restart do banco, ou quando a extensão é atualizada,
-- a tabela esvazia e a sequência volta a 1. Em produção os ids 1–17 já estavam em cron_edge_chamadas (último
-- chamado_em em 01/10). A partir de 02/10 o insert novo bate na PK e some. private.cron_coletar_respostas casa
-- só por r.id = c.request_id (mesma migration, linhas 124–126), então uma resposta nova também pode ser colada
-- na chamada antiga.
--
-- Esta migration:
--   1) acrescenta id bigint generated always as identity e troca a PK de request_id para id. request_id continua
--      NOT NULL, sem UNIQUE. As linhas que já existem permanecem (o bloco abaixo aborta se o count mudar);
--   2) cron_chamar_edge passa a inserir sempre. O retorno continua sendo o request_id do pg_net (pode repetir);
--   3) cron_coletar_respostas casa cada linha de net._http_response com uma chamada: mesmo request_id, ainda sem
--      resposta, chamado_em na janela [resposta - 6 h, resposta + 2 s]. 6 h é o TTL padrão do pg_net (a resposta
--      nasce segundos depois da chamada; a janela larga cobre o restart dentro do TTL). O maior id desempata.
--      Se a mesma chamada casar com duas respostas, fica a mais antiga.
--
-- Quem lê/escreve: os jobs pg_cron (dono postgres) chamam as duas funções. service_role só SELECT na tabela,
-- como antes. anon/authenticated/PUBLIC sem privilégio. Funções security invoker, search_path fixo.
-- RLS permanece ligado. Sem segredo neste arquivo.
--
-- Troca de PK e o índice único que ela carregava. Não há DELETE, DROP COLUMN nem SET NOT NULL em dado novo:
-- request_id já era NOT NULL por ser PK; se o drop da PK tirar o NOT NULL, ele é reaplicado (as linhas atuais
-- não têm NULL). Rollback: supabase/rollback/20261004001000_cron_edge_chamadas_request_id.sql
-- (aborta se já existir request_id repetido, para não apagar histórico).
--
-- Idempotente. Verificação: supabase/tests/cron_edge_chamadas_request_id_check.sql

begin;

set local lock_timeout = '10s';
set local statement_timeout = '1min';

create schema if not exists private;

create table if not exists private.cron_edge_chamadas (
  request_id    bigint not null,
  job           text not null,
  funcao        text not null,
  corpo         jsonb not null default '{}'::jsonb,
  chamado_em    timestamptz not null default now(),
  status_code   integer,
  timed_out     boolean,
  erro          text,
  resposta      text,
  respondido_em timestamptz,
  id            bigint generated always as identity,
  primary key (id)
);

do $do$
declare
  v_antes bigint;
  v_depois bigint;
  v_pk text[];
  v_con text;
begin
  select count(*) into v_antes from private.cron_edge_chamadas;

  if not exists (
    select 1 from pg_attribute
     where attrelid = 'private.cron_edge_chamadas'::regclass
       and attname = 'id' and not attisdropped
  ) then
    alter table private.cron_edge_chamadas
      add column id bigint generated always as identity;
  end if;

  select coalesce(array_agg(a.attname::text order by k.ord), '{}')
    into v_pk
    from pg_constraint c
    join lateral unnest(c.conkey) with ordinality as k(attnum, ord) on true
    join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.attnum
   where c.conrelid = 'private.cron_edge_chamadas'::regclass
     and c.contype = 'p';

  if v_pk = array['request_id'] then
    select c.conname into v_con
      from pg_constraint c
     where c.conrelid = 'private.cron_edge_chamadas'::regclass
       and c.contype = 'p';
    execute format('alter table private.cron_edge_chamadas drop constraint %I', v_con);
    alter table private.cron_edge_chamadas
      add constraint cron_edge_chamadas_pkey primary key (id);
  elsif v_pk is distinct from array['id'] then
    raise exception 'cron_edge_chamadas: chave primária inesperada: %', v_pk;
  end if;

  -- A PK antiga implicava NOT NULL. O drop não pode deixar request_id anulável.
  if exists (
    select 1 from pg_attribute
     where attrelid = 'private.cron_edge_chamadas'::regclass
       and attname = 'request_id' and not attisdropped and not attnotnull
  ) then
    alter table private.cron_edge_chamadas alter column request_id set not null;
  end if;

  select count(*) into v_depois from private.cron_edge_chamadas;
  if v_antes is distinct from v_depois then
    raise exception 'cron_edge_chamadas perdeu linhas: antes %, depois %', v_antes, v_depois;
  end if;
  raise notice 'cron_edge_chamadas: % linha(s) preservada(s); PK em id', v_depois;
end
$do$;

create index if not exists cron_edge_chamadas_chamado_em_idx
  on private.cron_edge_chamadas (chamado_em desc);
create index if not exists cron_edge_chamadas_pendentes_idx
  on private.cron_edge_chamadas (request_id)
  where respondido_em is null;

alter table private.cron_edge_chamadas enable row level security;
revoke all on table private.cron_edge_chamadas from public, anon, authenticated;
grant select on table private.cron_edge_chamadas to service_role;

comment on table private.cron_edge_chamadas is
  'Chamadas dos jobs pg_cron às Edge Functions. id é a chave interna. request_id é o id do pg_net e repete '
  'quando net._http_response reinicia (tabela unlogged). O status HTTP é copiado por cron_coletar_respostas, '
  'casando request_id com a janela de chamado_em. Sem token. Leitura só service_role.';
comment on column private.cron_edge_chamadas.id is
  'Identidade da linha. Não é o id do pg_net.';
comment on column private.cron_edge_chamadas.request_id is
  'Id devolvido por net.http_post. Único só dentro de uma vida da sequência do pg_net; recomeça em 1 no restart.';

create or replace function private.cron_chamar_edge(
  p_job text,
  p_funcao text,
  p_corpo jsonb default '{}'::jsonb,
  p_timeout_ms integer default 150000
) returns bigint
language plpgsql
volatile
security invoker
set search_path = pg_catalog, pg_temp
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

  if v_request_id is null then
    raise exception 'cron_chamar_edge: pg_net não devolveu request_id (job %, função %)', p_job, p_funcao;
  end if;

  insert into private.cron_edge_chamadas (request_id, job, funcao, corpo)
  values (v_request_id, p_job, p_funcao, coalesce(p_corpo, '{}'::jsonb));

  return v_request_id;
end
$fn$;

revoke all on function private.cron_chamar_edge(text, text, jsonb, integer)
  from public, anon, authenticated, service_role;

comment on function private.cron_chamar_edge(text, text, jsonb, integer) is
  'Jobs pg_cron: POST na Edge Function com Authorization Bearer lido do Vault (sync_cron_secret). '
  'Grava sempre uma linha nova; request_id do pg_net pode repetir depois de restart. '
  'Sem segredo levanta exceção antes de chamar. Execução só para o dono (postgres).';

create or replace function private.cron_coletar_respostas() returns integer
language plpgsql
volatile
security invoker
set search_path = pg_catalog, pg_temp
as $fn$
declare
  v_n integer;
begin
  -- Janela: a chamada sai antes da resposta (now() da transação) com 2 s de folga, e no máximo 6 h antes
  -- (TTL do pg_net). O maior id ganha a resposta; a chamada fica com a resposta mais antiga que a aceita.
  -- Resposta já copiada (alguma linha com respondido_em = r.created) não é reatribuída na hora seguinte:
  -- senão a chamada antiga, ainda pendente, herdaria o HTTP da chamada nova.
  with candidatos as (
    select c.id as chamada_id,
           r.status_code,
           r.timed_out,
           r.error_msg,
           left(r.content, 2000) as resposta,
           r.created as respondido_em,
           row_number() over (partition by r.ctid order by c.id desc) as na_resposta,
           row_number() over (partition by c.id order by r.created, r.ctid) as na_chamada
      from net._http_response r
      join private.cron_edge_chamadas c
        on c.request_id = r.id
       and c.respondido_em is null
       and c.chamado_em >= r.created - interval '6 hours'
       and c.chamado_em <= r.created + interval '2 seconds'
       and not exists (
         select 1
           from private.cron_edge_chamadas ja
          where ja.request_id = r.id
            and ja.respondido_em = r.created
       )
  )
  update private.cron_edge_chamadas c
     set status_code   = k.status_code,
         timed_out     = k.timed_out,
         erro          = k.error_msg,
         resposta      = k.resposta,
         respondido_em = k.respondido_em
    from candidatos k
   where c.id = k.chamada_id
     and k.na_resposta = 1
     and k.na_chamada = 1
     and c.respondido_em is null;
  get diagnostics v_n = row_count;
  return v_n;
end
$fn$;

revoke all on function private.cron_coletar_respostas() from public, anon, authenticated, service_role;

comment on function private.cron_coletar_respostas() is
  'Copia status HTTP de net._http_response para cron_edge_chamadas. Casa por request_id e pela janela de '
  'chamado_em (6 h para trás, 2 s para a frente), não só pelo id do pg_net, que reinicia. Só o dono executa.';

commit;
