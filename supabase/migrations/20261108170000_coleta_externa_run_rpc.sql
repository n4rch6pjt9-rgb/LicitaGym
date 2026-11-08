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
--   Vocabulário de modo e status é o das constraints da tabela (20260925120000).
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
         listados = coalesce(p_listados, 0),
         processos = coalesce(p_processos, 0),
         no_escopo = coalesce(p_no_escopo, 0),
         itens_escopo = coalesce(p_itens_escopo, 0),
         erros = coalesce(p_erros, 0),
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
