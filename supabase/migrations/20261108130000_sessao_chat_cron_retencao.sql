-- Spec 0039, etapa 1: coleta agendada do chat da sessão (K-3) e retenção do texto bruto (K-7).
--
-- O que muda:
--   1. private.integra_compras_run ganha licitacao_id: a licitação de onde veio a chave consultada. É a ligação entre
--      a mensagem (dado global, por chave_compra) e a data de homologação, sem repetir no SQL a extração da chave
--      (que fica só em supabase/functions/_shared/sessao_chat.ts). Sem FK: o registro de execução não pode impedir
--      a limpeza de licitacoes_externas.
--   2. private.sessao_mensagens_retencao(): decisão do Marcelo de 08/11/2026, texto bruto apagado 90 dias depois da
--      homologação. Marca expira_em = menor data_homologacao das licitações consultadas com aquela chave + 90 dias,
--      e põe texto = null nas linhas vencidas. A linha fica (chave, item, categoria, data): a contagem de K-2 e a
--      avaliação não mudam (CA-8). Compra sem data_homologacao não expira.
--   3. Dois jobs do pg_cron, já ligados:
--      licitagym-sync-sessao-chat  a cada 30 min, 8h às 19h30 de Brasília, segunda a sexta (Edge Function
--                                  sync-sessao-chat, até 10 compras por rodada, teto de 300 chamadas por dia);
--      licitagym-sessao-retencao   uma vez por dia, 03:41 de Brasília.
--      O merge publica a Edge Function junto. Se o primeiro disparo vier antes do deploy, a chamada falha com 404 e
--      fica em private.cron_edge_chamadas; nada é consultado nem cobrado.
--
-- Quem lê e escreve: só postgres (pg_cron) executa a função; service_role continua com select/insert/update na
-- tabela de execução. Nenhum grant novo para anon ou authenticated.
-- Verificação: supabase/tests/sessao_chat_cron_retencao_check.sql.
--
-- ROLLBACK (não executado):
--   select cron.unschedule(jobid) from cron.job
--    where jobname in ('licitagym-sync-sessao-chat', 'licitagym-sessao-retencao');
--   drop function if exists private.sessao_mensagens_retencao();
--   alter table private.integra_compras_run drop column if exists licitacao_id;

begin;

set local lock_timeout = '10s';

alter table private.integra_compras_run add column if not exists licitacao_id bigint;

comment on column private.integra_compras_run.licitacao_id is
  'Licitação (licitacoes_externas.id) de onde veio a chave consultada. Base da retenção (K-7). Sem FK.';

create index if not exists integra_compras_run_licitacao_idx
  on private.integra_compras_run (licitacao_id) where licitacao_id is not null;

create or replace function private.sessao_mensagens_retencao()
returns jsonb
language plpgsql
volatile
security invoker
set search_path = pg_catalog, pg_temp
as $fn$
declare
  v_marcadas integer;
  v_apagadas integer;
begin
  with prazo as (
    select r.chave_compra, min(l.data_homologacao) + interval '90 days' as expira_em
      from private.integra_compras_run r
      join public.licitacoes_externas l on l.id = r.licitacao_id
     where l.data_homologacao is not null
     group by r.chave_compra
  )
  update public.sessao_mensagens m
     set expira_em = p.expira_em
    from prazo p
   where m.chave_compra = p.chave_compra
     and m.expira_em is distinct from p.expira_em;
  get diagnostics v_marcadas = row_count;

  update public.sessao_mensagens
     set texto = null
   where expira_em <= now()
     and texto is not null;
  get diagnostics v_apagadas = row_count;

  return jsonb_build_object('marcadas', v_marcadas, 'textos_apagados', v_apagadas, 'executado_em', now());
end
$fn$;

revoke all on function private.sessao_mensagens_retencao() from public, anon, authenticated, service_role;

comment on function private.sessao_mensagens_retencao() is
  'Spec 0039 K-7. Marca expira_em = homologação + 90 dias e apaga o texto bruto vencido (a linha fica). '
  'Execução só para o dono (postgres), pelo job licitagym-sessao-retencao.';

do $do$
declare
  j record;
  v_existente bigint;
begin
  if not exists (select 1 from pg_extension where extname = 'pg_cron') then
    begin
      create extension if not exists pg_cron with schema pg_catalog;
    exception
      when undefined_object
        or invalid_parameter_value
        or undefined_function
        or invalid_schema_name
        or feature_not_supported then
      raise notice 'pg_cron indisponível (%): jobs do chat da sessão não agendados neste Postgres.', sqlerrm;
      return;
    end;
  end if;

  for j in
    select *
      from (values
        ('licitagym-sync-sessao-chat', '*/30 11-22 * * 1-5',
         $cmd$select private.cron_chamar_edge('licitagym-sync-sessao-chat', 'sync-sessao-chat', '{"limite": 10, "max_chamadas_dia": 300}'::jsonb, 150000)$cmd$),
        ('licitagym-sessao-retencao', '41 6 * * *',
         $cmd$select private.sessao_mensagens_retencao()$cmd$)
      ) as t(nome, agenda, comando)
  loop
    select c.jobid into v_existente from cron.job c where c.jobname = j.nome;
    if v_existente is not null then
      -- Reaplicar não religa um job desligado à mão: só agenda e comando.
      perform cron.alter_job(v_existente, schedule := j.agenda, command := j.comando);
    else
      perform cron.schedule(j.nome, j.agenda, j.comando);
    end if;
  end loop;
end
$do$;

commit;
