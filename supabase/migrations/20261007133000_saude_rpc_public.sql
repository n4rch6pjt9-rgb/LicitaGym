-- api-saude chama private.saude_operacional_resumo via PostgREST (client.schema("private")).
-- Em 07/10/2026 a execução devolveu "Invalid schema: private": o Data API do projeto não inclui
-- private nos schemas expostos, e o ALTER ROLE authenticator da 202609180014 não segura essa
-- configuração do painel. A função continua em private. O que a API chama é um invólucro em public,
-- security definer, EXECUTE só service_role. anon e authenticated não executam.
-- Aditiva. O merge na main aplica em produção e republica a Edge Function.
-- Verificação: supabase/tests/saude_rpc_public_check.sql.

begin;

set local lock_timeout = '10s';

create or replace function public.saude_operacional_resumo()
returns table (
  verificacao text,
  status text,
  valor numeric,
  unidade text,
  atencao numeric,
  critico numeric,
  mensagem text,
  detalhe jsonb
)
language sql
stable
security definer
set search_path = pg_catalog, private, pg_temp
as $$
  select verificacao, status, valor, unidade, atencao, critico, mensagem, detalhe
    from private.saude_operacional_resumo()
$$;

comment on function public.saude_operacional_resumo() is
  'Invólucro de private.saude_operacional_resumo para o PostgREST (schema public). EXECUTE só service_role. A api-saude chama este, não o schema private.';

revoke all on function public.saude_operacional_resumo() from public, anon, authenticated;
grant execute on function public.saude_operacional_resumo() to service_role;

commit;
