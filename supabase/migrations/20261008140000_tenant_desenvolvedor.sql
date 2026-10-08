-- LicitaGym: a conta com licitagym_role = admin é o desenvolvedor da parametrização inicial.
--
-- Login não exige tenant. O papel admin/operacao vale depois que a empresa tem membros.
-- O primeiro cadastro não pode depender de já existir um membro: a policy de tenant_membros
-- só deixa escrever quem já é admin da empresa. Esta migration abre a mesma escrita, e a
-- leitura de tenants, para o desenvolvedor (app_metadata.licitagym_role = admin).
-- Não usa user_metadata. Não abre catalogo_precos nem dado de operação.
-- Verificar: supabase/tests/tenant_membros_check.sql e catalogo_drift_tenant_acl_check.sql
-- Aditiva. O merge na main aplica em produção.

begin;

set local lock_timeout = '10s';

create or replace function public.licitagym_desenvolvedor()
returns boolean
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  select ((select auth.jwt()) -> 'app_metadata' ->> 'licitagym_role') = 'admin'
$$;

comment on function public.licitagym_desenvolvedor() is
  'Verdadeiro só para app_metadata.licitagym_role = admin. É o desenvolvedor da parametrização inicial do tenant. Não é o papel admin da empresa.';

revoke all on function public.licitagym_desenvolvedor() from PUBLIC, anon, authenticated, service_role;
grant execute on function public.licitagym_desenvolvedor() to authenticated, service_role;

drop policy if exists tenant_membros_desenvolvedor on public.tenant_membros;
create policy tenant_membros_desenvolvedor on public.tenant_membros
  for all to authenticated
  using (public.licitagym_desenvolvedor())
  with check (public.licitagym_desenvolvedor());

drop policy if exists tenant_dados_restritos_desenvolvedor on public.tenant_dados_restritos;
create policy tenant_dados_restritos_desenvolvedor on public.tenant_dados_restritos
  for all to authenticated
  using (public.licitagym_desenvolvedor())
  with check (public.licitagym_desenvolvedor());

drop policy if exists tenants_desenvolvedor on public.tenants;
create policy tenants_desenvolvedor on public.tenants
  for all to authenticated
  using (public.licitagym_desenvolvedor())
  with check (public.licitagym_desenvolvedor());

grant select, insert, update on table public.tenants to authenticated;
grant usage, select on sequence public.tenants_id_seq to authenticated;

commit;
