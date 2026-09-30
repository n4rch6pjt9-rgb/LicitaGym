-- Jobs pg_cron que chamam as Edge Functions de sync (pg_net) com o Bearer lido do Vault.
--
-- Plano completo: docs/pncp/cron-sync-jobs.md. Resumo (cron.timezone = GMT, então as agendas estão em UTC; BRT = UTC-3):
--   licitagym-sync-compras-catmat-7830   dom 02:07 BRT  '7 5 * * 0'    CATMAT 78/7830
--   licitagym-sync-compras-catmat-7220   dom 02:27 BRT  '27 5 * * 0'   CATMAT 72/7220
--   licitagym-sync-pncp-pca              diário 03:13   '13 6 * * *'   PCA com gate de período (async)
--   licitagym-sync-pncp-pca-continuacao  diário 03:43   '43 6 * * *'   retoma páginas pendentes do PCA
--   licitagym-link-catmat-pca            diário 04:23   '23 7 * * *'   vínculo PCA x CATMAT, lotes de 500
--   licitagym-sync-pncp-orgaos           diário 04:43   '43 7 * * *'   entidades/órgãos dos CNPJs do PCA
--   licitagym-orgaos-classificar-escopo  diário 05:03   '3 8 * * *'    fn_orgaos_uasgs_classificar + fn_escopo_match_atualizar
--   licitagym-sync-pncp-legislation      seg 05:27      '27 8 * * 1'   legislação PNCP
--   licitagym-sync-pncp-catalogo         dia 1 05:37    '37 8 1 * *'   categorias de item do PCA
--   licitagym-cron-respostas             de hora em hora '11 * * * *'  guarda o status HTTP (net._http_response vive 6 h)
--   licitagym-cron-limpeza               dom 05:51      '51 8 * * 0'   apaga histórico antigo
--
-- Segredo: o Bearer vem do Vault, segredo 'sync_cron_secret' (mesmo valor do SYNC_CRON_SECRET das Edge Functions).
-- Nenhum valor de segredo neste arquivo. Sem o segredo (ou vazio), private.cron_chamar_edge levanta exceção ANTES de
-- chamar a URL: o job fica 'failed' em cron.job_run_details e nenhuma requisição sai com token vazio.
--
-- Idempotente: extensões "if not exists", tabela/função "if not exists"/"or replace" e, para cada job,
-- cron.unschedule do nome existente seguido de cron.schedule.

-- 1) Extensões (em produção já existem: pg_cron 1.6.4 em pg_catalog, pg_net 0.20.4 em extensions, supabase_vault 0.3.1)
create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;
create extension if not exists supabase_vault with schema vault;

-- 2) Registro persistente das chamadas (net._http_response é apagado pelo pg_net depois de 6 h)
create schema if not exists private;

create table if not exists private.cron_edge_chamadas (
  request_id    bigint primary key,
  job           text not null,
  funcao        text not null,
  corpo         jsonb not null default '{}'::jsonb,
  chamado_em    timestamptz not null default now(),
  status_code   integer,
  timed_out     boolean,
  erro          text,
  resposta      text,
  respondido_em timestamptz
);
create index if not exists cron_edge_chamadas_chamado_em_idx on private.cron_edge_chamadas (chamado_em desc);
create index if not exists cron_edge_chamadas_pendentes_idx on private.cron_edge_chamadas (request_id) where respondido_em is null;

alter table private.cron_edge_chamadas enable row level security;
revoke all on table private.cron_edge_chamadas from public, anon, authenticated;
grant select on table private.cron_edge_chamadas to service_role;

comment on table private.cron_edge_chamadas is
  'Chamadas dos jobs pg_cron às Edge Functions (request_id do pg_net) e o status HTTP copiado de net._http_response '
  'pelo job licitagym-cron-respostas. Sem token: o Authorization não é gravado. Leitura só service_role.';

-- 3) Chamada de Edge Function com o Bearer do Vault (só o dono, postgres, que é quem roda os jobs)
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

revoke all on function private.cron_chamar_edge(text, text, jsonb, integer) from public, anon, authenticated, service_role;

comment on function private.cron_chamar_edge(text, text, jsonb, integer) is
  'Jobs pg_cron: POST na Edge Function com Authorization Bearer lido do Vault (sync_cron_secret). '
  'Sem segredo levanta exceção antes de chamar. Execução só para o dono (postgres).';

-- 4) Copia o resultado HTTP antes do TTL do pg_net
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

-- 5) Agenda (unschedule + schedule por nome)
do $do$
declare
  j record;
begin
  for j in
    select *
      from (values
        ('licitagym-sync-compras-catmat-7830', '7 5 * * 0',
         $cmd$select private.cron_chamar_edge('licitagym-sync-compras-catmat-7830', 'sync-compras-catmat', '{"codigo_grupo": 78, "codigo_classe": 7830}'::jsonb, 150000)$cmd$),
        ('licitagym-sync-compras-catmat-7220', '27 5 * * 0',
         $cmd$select private.cron_chamar_edge('licitagym-sync-compras-catmat-7220', 'sync-compras-catmat', '{"codigo_grupo": 72, "codigo_classe": 7220}'::jsonb, 150000)$cmd$),
        ('licitagym-sync-pncp-pca', '13 6 * * *',
         $cmd$select private.cron_chamar_edge('licitagym-sync-pncp-pca', 'sync-pncp-pca', '{"verificar_periodo": true, "async": true}'::jsonb, 150000)$cmd$),
        ('licitagym-sync-pncp-pca-continuacao', '43 6 * * *',
         $cmd$select private.cron_chamar_edge('licitagym-sync-pncp-pca-continuacao', 'sync-pncp-pca', '{"verificar_periodo": true, "async": true}'::jsonb, 150000)$cmd$),
        ('licitagym-link-catmat-pca', '23 7 * * *',
         $cmd$select private.cron_chamar_edge('licitagym-link-catmat-pca', 'link-catmat-pca', jsonb_build_object('limite', 500, 'offset', o), 120000)
  from generate_series(0, greatest((select count(*) from public.pca_itens where classe_material_servico in ('7830', '7220')) - 1, 0), 500) as o$cmd$),
        ('licitagym-sync-pncp-orgaos', '43 7 * * *',
         $cmd$select private.cron_chamar_edge('licitagym-sync-pncp-orgaos', 'sync-pncp-orgaos', '{}'::jsonb, 150000)$cmd$),
        ('licitagym-orgaos-classificar-escopo', '3 8 * * *',
         $cmd$set local statement_timeout = '10min'; select public.fn_orgaos_uasgs_classificar(); select public.fn_escopo_match_atualizar()$cmd$),
        ('licitagym-sync-pncp-legislation', '27 8 * * 1',
         $cmd$select private.cron_chamar_edge('licitagym-sync-pncp-legislation', 'sync-pncp-legislation', '{}'::jsonb, 60000)$cmd$),
        ('licitagym-sync-pncp-catalogo', '37 8 1 * *',
         $cmd$select private.cron_chamar_edge('licitagym-sync-pncp-catalogo', 'sync-pncp-catalogo', '{}'::jsonb, 150000)$cmd$),
        ('licitagym-cron-respostas', '11 * * * *',
         $cmd$select private.cron_coletar_respostas()$cmd$),
        ('licitagym-cron-limpeza', '51 8 * * 0',
         $cmd$delete from cron.job_run_details where end_time < now() - interval '30 days'; delete from private.cron_edge_chamadas where chamado_em < now() - interval '90 days'$cmd$)
      ) as t(nome, agenda, comando)
  loop
    perform cron.unschedule(c.jobid) from cron.job c where c.jobname = j.nome;
    perform cron.schedule(j.nome, j.agenda, j.comando);
  end loop;
end
$do$;
