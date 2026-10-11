-- LicitaGym: tenant_papel() só reconhece vínculo com empresa ATIVA (issue #263, PR-A; follow-up do #261).
--
-- Por quê: tenant_papel() não olhava tenants.ativo. Com a empresa desativada e o vínculo ativo, o ADMIN continuava
-- lendo e gravando tenant_membros, tenant_dados_restritos e tenant_documentos (inclusive o Storage tenant-documentos)
-- com o próprio JWT, direto pelo PostgREST. Em 10/10/2026 a Konnen passou a ter 4 membros ligados (api-tenant, spec
-- 0017), então desativar a empresa precisa cortar esse acesso.
--
-- O que muda: só o corpo de public.tenant_papel(bigint), que passa a exigir tenants.ativo. Assinatura, security
-- definer, search_path e grants continuam iguais. Efeito nas policies que usam a função (tenant_membros,
-- tenant_dados_restritos, tenant_documentos, storage tenant-documentos): membro de empresa desativada deixa de gravar e
-- de ler dados da empresa; continua lendo só a própria linha de vínculo (tenant_membros_select tem user_id = auth.uid()).
-- O desenvolvedor (licitagym_desenvolvedor()) não muda.
-- Dados: nenhum. Hoje há 1 empresa (ativa); nenhum acesso atual é removido.
--
-- Quem chama: as policies acima (authenticated) e service_role. Edge Functions usam service_role e conferem o
-- vínculo no código (api-pipeline, api-tenant).
-- Verificar: supabase/tests/tenant_membros_check.sql (checagem "tenant_papel exige empresa ativa").
-- Idempotente (create or replace). O merge na main aplica em produção.

begin;

set local lock_timeout = '10s';
set local statement_timeout = '2min';

create or replace function public.tenant_papel(p_tenant bigint)
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select m.papel
    from public.tenant_membros m
    join public.tenants t on t.id = m.tenant_id
   where m.tenant_id = p_tenant
     and m.user_id = auth.uid()
     and m.ativo
     and t.ativo
   limit 1
$$;

comment on function public.tenant_papel(bigint) is
  'Papel ativo do usuário corrente na empresa, só se a empresa estiver ativa (#263). security definer para a policy '
  'de tenant_membros não recursar.';

revoke all on function public.tenant_papel(bigint) from PUBLIC, anon, authenticated, service_role;
grant execute on function public.tenant_papel(bigint) to authenticated, service_role;

commit;
