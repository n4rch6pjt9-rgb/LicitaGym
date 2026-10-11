-- Spec 0012 (#289): troca o sync do PCA para o fluxo por fila de planos (#294).
--
-- Contexto: o fluxo antigo (licitagym-sync-pncp-pca 03:13 BRT + continuação 03:43 BRT) morre por "CPU Time exceeded"
-- na página 2 desde 26/09, e em 11/10 também por HTTP 429. O fluxo novo (descoberta pela consulta, itens pela integração
-- por plano, gravação em lote) entrou no #294 com os três jobs criados com active = false
-- (20261011100100_cron_pca_fila.sql). Decisão do Marcelo em 11/10: ligar o fluxo novo e medir antes de levar o backfill
-- ao Cloud Run Job.
--
-- O que muda (só cron.job.active; agenda e comando não mudam):
--   liga     licitagym-sync-pncp-pca-fila, licitagym-sync-pncp-pca-fila-continuacao, licitagym-sync-pncp-pca-reconciliacao
--   desliga  licitagym-sync-pncp-pca, licitagym-sync-pncp-pca-continuacao
-- Os dois fluxos usam locks diferentes (pca-sync* e pca-fila:<ano>); deixar os dois ligados faria duas cargas no mesmo
-- horário disputando o 1 req/s do pncp.gov.br.
-- Idempotente: reaplicar só reafirma o estado. Nada é criado nem apagado. Se faltar algum dos 3 jobs da fila, a
-- migration falha antes de mexer em qualquer job; job antigo ausente só gera aviso.
--
-- ROLLBACK: nova migration com o mesmo bloco e o active invertido (liga os dois antigos, desliga os três novos).
-- Execução antiga órfã: com os jobs antigos desligados, ninguém mais pede o lock pca-sync:<ano>:7830, e uma execução
-- desse lock parada em 'executando' não vira 'falhou' sozinha (só private.acquire_sync_lock faz isso). Isso deixaria
-- pncp_sync_heartbeat_parado crítico para sempre. Em 11/10/2026 às 21:00 UTC não havia nenhuma (consulta abaixo).
-- Conferir depois do merge e, se houver, encerrar pelo SQL Editor com o Marcelo:
--   select id, lock_key, status, last_heartbeat_at from private.pncp_sync_run
--    where lock_key like 'pca-sync:%' and status in ('executando','incompleta');
-- Quem lê/escreve: só postgres (pg_cron). Nenhum grant novo.
-- Como verificar: supabase/tests/cron_pca_fila_ligar_check.sql; em produção,
--   select jobname, active from cron.job where jobname like 'licitagym-sync-pncp-pca%';

begin;

set local lock_timeout = '10s';

do $troca$
declare
  j record;
  v_achados int := 0;
  v_ausentes text;
begin
  if to_regclass('cron.job') is null then
    raise notice 'pg_cron indisponível: troca do fluxo do PCA não aplicada neste Postgres.';
    return;
  end if;

  -- Antes de mexer em qualquer job: os três da fila precisam existir. Sem eles, desligar os antigos deixaria o PCA
  -- sem nenhuma agenda (revisão do Codex no #338). Falha a transação, nada muda.
  select string_agg(t.nome, ', ') into v_ausentes
    from (values ('licitagym-sync-pncp-pca-fila'), ('licitagym-sync-pncp-pca-fila-continuacao'),
                 ('licitagym-sync-pncp-pca-reconciliacao')) as t(nome)
   where not exists (select 1 from cron.job c where c.jobname = t.nome);
  if v_ausentes is not null then
    raise exception 'troca do fluxo do PCA abortada: job(s) da fila ausente(s): %. Os antigos continuam ligados.',
      v_ausentes;
  end if;

  for j in
    select c.jobid, c.jobname
      from cron.job c
     where c.jobname in ('licitagym-sync-pncp-pca-fila', 'licitagym-sync-pncp-pca-fila-continuacao',
                         'licitagym-sync-pncp-pca-reconciliacao',
                         'licitagym-sync-pncp-pca', 'licitagym-sync-pncp-pca-continuacao')
  loop
    v_achados := v_achados + 1;
    perform cron.alter_job(j.jobid, active := j.jobname like 'licitagym-sync-pncp-pca-fila%'
                                             or j.jobname = 'licitagym-sync-pncp-pca-reconciliacao');
  end loop;

  if v_achados <> 5 then
    raise notice 'troca do fluxo do PCA: % de 5 jobs encontrados (job antigo ausente: nada a desligar).', v_achados;
  end if;
end
$troca$;

commit;
