-- LicitaGym: snapshot da leitura diária do Portal de Compras Públicas (issue #266)
--
-- Contexto: o PNCP só repassa link_sistema_origem. A página pública aceita é
-- https://(www.)portaldecompraspublicas.com.br/processos/{UF}/{comprador}/{processo}.
-- BLL, BNC, Licitar Digital, Licitanet, Banco do Brasil, Compras BR, Banrisul e a
-- cauda municipal continuam de fora até a medição. Esta tabela guarda a última
-- leitura bem-sucedida para o alerta do dia em list/get. Não move o pipeline e
-- não cria tarefa.
--
-- Quem lê/escreve: service_role, pelas funções api-dashboard-oportunidades e
-- sync-portal-compras. anon e authenticated sem privilégio.
--
-- O job das 08:00 BRT (11:00 UTC) chama a Edge Function uma vez por dia.
-- Idempotente. Verificação: supabase/tests/portal_consulta_check.sql

begin;

set local lock_timeout = '10s';
set local statement_timeout = '1min';

create table if not exists public.portal_consulta (
  licitacao_id     bigint primary key references public.licitacoes_externas (id) on delete cascade,
  url_pagina       text not null,
  codigo_licitacao text,
  situacao         text,
  consultado_em    timestamptz,
  http_status      integer,
  erro             text,
  payload_hash     text,
  constraint portal_consulta_url_chk check (
    url_pagina ~* '^https://(www\.)?portaldecompraspublicas\.com\.br/processos/[A-Za-z]{2}/[^/]+/[^/]+$'
  ),
  constraint portal_consulta_erro_chk check (erro is null or char_length(erro) <= 500)
);

comment on table public.portal_consulta is
  'Última leitura pública do Portal de Compras Públicas por licitação (issue #266). '
  'consultado_em nulo significa que ainda não houve leitura bem-sucedida. '
  'situacao é o statusProcesso cru da API, sem mapa para etapa do pipeline.';

alter table public.portal_consulta enable row level security;

revoke all on table public.portal_consulta from PUBLIC, anon, authenticated;
grant select, insert, update, delete on table public.portal_consulta to service_role;

do $cron$
begin
  if to_regnamespace('cron') is null
     or to_regprocedure('cron.schedule(text,text,text)') is null then
    raise notice 'pg_cron ausente: job licitagym-sync-portal-compras não agendado.';
    return;
  end if;
  perform cron.unschedule(c.jobid)
    from cron.job c
   where c.jobname = 'licitagym-sync-portal-compras';
  perform cron.schedule(
    'licitagym-sync-portal-compras',
    '0 11 * * *',
    $cmd$select private.cron_chamar_edge('licitagym-sync-portal-compras', 'sync-portal-compras', '{"limite": 40}'::jsonb, 150000)$cmd$);
end
$cron$;

commit;
