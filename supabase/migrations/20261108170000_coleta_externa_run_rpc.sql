-- LicitaGym: coletor do Sistema S registra cada execução em private.coleta_externa_run (issue #245)
--
-- Contexto: a verificação de saúde coleta_externa_dias_sem_sucesso lê private.coleta_externa_run, mas nenhum
-- código grava nessa tabela (0 linhas desde a criação em 20260925120000). O alerta fica crítico para sempre
-- ("sem dado"), embora o coletor Paradigma (`python3 -m coletor.paradigma`, workflow coletor-sistema-s.yml) rode
-- todo dia e grave licitações. O cliente do coletor fala só com o schema public (Accept-Profile: public), então o
-- registro passa por duas RPCs em public, no padrão de acesso a private.* por RPC.
--
-- O que muda:
--   * public.coleta_externa_iniciar(fonte, modo, termos) -> id: abre a execução com status 'executando';
--   * public.coleta_externa_finalizar(id, status, contagens, detalhe) -> boolean: fecha a execução que ainda está
--     'executando' (devolve false se não achar, sem sobrescrever execução já fechada).
--   Vocabulário de modo e status é o das constraints da tabela (20260925120000): a CHECK de modo e a FK de fonte
--   (fontes_externas.slug) da própria tabela recusam valor inválido; a RPC valida só o status final.
--   * ao abrir, execuções da mesma fonte presas em 'executando' há mais de 6 h (processo morto pelo runner) viram
--     'incompleta', para não ficar linha órfã;
--   * contagens negativas viram 0.
--   Só a coleta agendada (origem cron) registra: é ela que a saúde acompanha.
--
-- ACL: security definer com search_path fixo; EXECUTE só service_role (o coletor usa a service role key).
-- Verificação: supabase/tests/coleta_externa_run_rpc_check.sql. Idempotente.

begin;

create or replace function public.coleta_externa_iniciar(p_fonte text, p_modo text, p_termos text[] default null)
returns bigint
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
as $fn$
declare
  v_id bigint;
begin
  if p_fonte is null or p_modo is null then
    raise exception 'coleta_externa_iniciar: fonte e modo são obrigatórios' using errcode = '22004';
  end if;
  update private.coleta_externa_run r
     set status = 'incompleta', finished_at = now(),
         detalhe_erros = coalesce(r.detalhe_erros, '{}'::jsonb)
                         || jsonb_build_object('erro', 'execução não fechada em 6 h (processo interrompido)')
   where r.fonte = p_fonte and r.status = 'executando' and r.started_at < now() - interval '6 hours';
  insert into private.coleta_externa_run (fonte, modo, status, termos)
  values (p_fonte, p_modo, 'executando', p_termos)
  returning id into v_id;
  return v_id;
end
$fn$;

create or replace function public.coleta_externa_finalizar(
  p_id bigint,
  p_status text,
  p_listados integer default 0,
  p_processos integer default 0,
  p_no_escopo integer default 0,
  p_itens_escopo integer default 0,
  p_erros integer default 0,
  p_detalhe_erros jsonb default null
)
returns boolean
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
as $fn$
begin
  if p_status is null or p_status not in ('concluida', 'concluida_com_erros', 'falhou', 'cancelada', 'incompleta') then
    raise exception 'coleta_externa_finalizar: status final inválido: %', p_status using errcode = '22023';
  end if;
  update private.coleta_externa_run r
     set status = p_status,
         listados = greatest(coalesce(p_listados, 0), 0),
         processos = greatest(coalesce(p_processos, 0), 0),
         no_escopo = greatest(coalesce(p_no_escopo, 0), 0),
         itens_escopo = greatest(coalesce(p_itens_escopo, 0), 0),
         erros = greatest(coalesce(p_erros, 0), 0),
         detalhe_erros = p_detalhe_erros,
         finished_at = now()
   where r.id = p_id and r.status = 'executando';
  return found;
end
$fn$;

comment on function public.coleta_externa_iniciar(text, text, text[]) is
  'Abre uma execução do coletor do Sistema S em private.coleta_externa_run (status executando). Só service_role.';
comment on function public.coleta_externa_finalizar(bigint, text, integer, integer, integer, integer, integer, jsonb) is
  'Fecha uma execução ainda em andamento de private.coleta_externa_run com status final e contagens. Só service_role.';

revoke all on function public.coleta_externa_iniciar(text, text, text[]) from public, anon, authenticated;
revoke all on function public.coleta_externa_finalizar(bigint, text, integer, integer, integer, integer, integer, jsonb)
  from public, anon, authenticated;
grant execute on function public.coleta_externa_iniciar(text, text, text[]) to service_role;
grant execute on function public.coleta_externa_finalizar(bigint, text, integer, integer, integer, integer, integer, jsonb)
  to service_role;

commit;
