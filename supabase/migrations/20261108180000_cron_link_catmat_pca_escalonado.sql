-- LicitaGym: link-catmat-pca em chamadas escalonadas, uma por vez (issue #245, alerta cron_http_erros_24h)
--
-- Contexto: o job licitagym-link-catmat-pca (20260930180000) disparava, às 07:23 UTC, uma chamada por fatia de 500
-- itens de pca_itens, todas no mesmo instante (13 chamadas com 6.122 itens da classe 7830). O pg_net envia tudo
-- junto, as chamadas caem no mesmo worker da Edge Function e ele é derrubado por "CPU Time exceeded" (HTTP 546,
-- WORKER_RESOURCE_LIMIT): 10 de 13 chamadas falharam em 08/11/2026, 11 em 07/11. Piorou com o crescimento do PCA.
--
-- O que muda (junto com a gravação em lote na função, mesmo PR):
--   * o job roda a cada 2 minutos entre 07:00 e 07:58 UTC (30 rodadas), uma chamada por rodada;
--   * a rodada N processa a fatia offset = N * limite, com limite = total / 30 (mínimo 200, máximo 1000, o teto da
--     função), contado na hora sobre a maior classe atendida (7830 ou 7220, ativos);
--   * rodada sem fatia (offset além do total) não chama nada. Capacidade: 30 x 1000 = 30 mil itens por classe.
--   A rodada vem do minuto de now(): se o total mudar dentro da janela (sync do PCA às 06:43) ou o pg_cron atrasar
--   um disparo para o minuto seguinte, uma fatia pode repetir ou pular itens nesse dia; o
--   vínculo é idempotente (upsert) e o dia seguinte cobre o que faltou.
--
-- pg_cron só existe no Supabase: no Postgres descartável da validação o bloco não agenda nada (mesmo padrão de
-- 20261108130000). Reaplicar não religa um job desligado à mão: só troca agenda e comando.
-- Verificação em produção: select schedule, command from cron.job where jobname = 'licitagym-link-catmat-pca';
-- e, no dia seguinte, private.cron_edge_chamadas sem HTTP 546 para esse job.

begin;

do $do$
declare
  v_existente bigint;
  v_total bigint;
  v_agenda constant text := '*/2 7 * * *';
  v_comando constant text := $cmd$select private.cron_chamar_edge('licitagym-link-catmat-pca', 'link-catmat-pca',
         jsonb_build_object('limite', p.limite, 'offset', p.rodada * p.limite), 120000)
  from (select (extract(minute from now())::int / 2) as rodada,
               least(1000, greatest(200, ceil(c.total / 30.0)::int)) as limite,
               c.total
          from (select greatest(
                  (select count(*) from public.pca_itens where ativo and classe_material_servico = '7830'),
                  (select count(*) from public.pca_itens where ativo and classe_material_servico = '7220')) as total) c) p
 where p.rodada * p.limite < p.total$cmd$;
begin
  if not exists (select 1 from pg_extension where extname = 'pg_cron') then
    raise notice 'pg_cron indisponível: licitagym-link-catmat-pca não reagendado neste Postgres.';
    return;
  end if;
  select c.jobid into v_existente from cron.job c where c.jobname = 'licitagym-link-catmat-pca';
  if v_existente is not null then
    perform cron.alter_job(v_existente, schedule := v_agenda, command := v_comando);
  else
    raise notice 'licitagym-link-catmat-pca não existia: job recriado com a agenda escalonada.';
    perform cron.schedule('licitagym-link-catmat-pca', v_agenda, v_comando);
  end if;
  -- Capacidade da janela: 30 rodadas x 1000 itens. Acima disso, o excedente fica sem vínculo diário.
  select greatest(
           (select count(*) from public.pca_itens where ativo and classe_material_servico = '7830'),
           (select count(*) from public.pca_itens where ativo and classe_material_servico = '7220'))
    into v_total;
  if v_total > 30000 then
    raise warning 'link-catmat-pca: % itens ativos na maior classe passam da capacidade de 30 mil da janela', v_total;
  end if;
end
$do$;

commit;
