-- LicitaGym: "Analisar" pede a preparação do edital (spec 0032, fase 1, CA-1). Em 20/10/2026 o Marcelo rodou o agente
-- na #252 (fora do pipeline): os documentos estavam pendentes, sem chunks, e nada foi baixado, porque só a entrada em
-- "Triagem" enfileirava. Agora a api-agentes (service_role) enfileira o mesmo pedido 'preparar_triagem' quando o edital
-- não tem chunks e não há pedido aberto (ou o último falhou). O consumidor (Cloud Run, a cada 15 min) é o mesmo.
--
--   public.fila_preparacao_solicitar(p_tenant, p_licitacao) → 'enfileirado' | 'ja_na_fila'
--     empresa inativa ou inexistente: 42501; licitação inexistente: P0002. Respeita o índice único parcial
--     job_queue_preparar_triagem_aberto_uq (no máximo um pedido aberto por empresa e licitação).
-- Só service_role executa. Verificar: supabase/tests/fila_preparacao_solicitar_check.sql. Idempotente.

begin;

set local lock_timeout = '5s';

create or replace function public.fila_preparacao_solicitar(p_tenant bigint, p_licitacao bigint)
returns text
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_fonte text;
  v_id    uuid;
begin
  if not exists (select 1 from public.tenants t where t.id = p_tenant and t.ativo) then
    raise exception 'Empresa % inativa ou inexistente.', p_tenant using errcode = '42501';
  end if;
  select l.fonte into v_fonte from public.licitacoes_externas l where l.id = p_licitacao;
  if not found then
    raise exception 'Licitação % não encontrada.', p_licitacao using errcode = 'P0002';
  end if;

  insert into private.job_queue (job_type, payload)
  values ('preparar_triagem', jsonb_build_object(
    'tenant_id', p_tenant::text,
    'licitacao_id', p_licitacao::text,
    'fonte', v_fonte,
    'origem', 'analisar'))
  on conflict ((payload ->> 'tenant_id'), (payload ->> 'licitacao_id'))
    where job_type = 'preparar_triagem' and status in ('pending', 'processing')
  do nothing
  returning id into v_id;

  return case when v_id is null then 'ja_na_fila' else 'enfileirado' end;
end;
$$;

revoke all on function public.fila_preparacao_solicitar(bigint, bigint) from PUBLIC, anon, authenticated;
grant execute on function public.fila_preparacao_solicitar(bigint, bigint) to service_role;

commit;
