-- LicitaGym: liga o usuário à empresa do pipeline (fase A, Dashboard #29 / LicitaGym #248).
--
-- Hoje api-pipeline escolhe o único tenant ativo e ignora o usuário. Um segundo tenant ativo
-- faria toda chamada responder 409, inclusive a da Konnen. Esta migration cria o vínculo e
-- separa banco/agência/conta, que OPERAÇÃO não lê.
--
-- Quem lê e escreve:
--   * service_role: tudo (a Edge Function continua conferindo o papel);
--   * authenticated: membros do próprio tenant. ADMIN escreve membros e dados bancários.
--     OPERAÇÃO não lê tenant_dados_restritos. anon não lê nada;
--   * app_metadata.licitagym_role não abre estas tabelas.
-- O primeiro vínculo de uma empresa é gravado com service_role: ainda não existe ADMIN para a policy.
-- tenant_papel é security definer para a policy não recursar em tenant_membros. search_path fixo.
-- Verificar: supabase/tests/tenant_membros_check.sql
-- Aditiva. O merge na main aplica em produção.

begin;

set local lock_timeout = '10s';

create table if not exists public.tenant_membros (
  tenant_id  bigint not null references public.tenants (id) on delete cascade,
  user_id    uuid not null,
  papel      text not null,
  ativo      boolean not null default true,
  created_at timestamptz not null default now(),
  constraint tenant_membros_pkey primary key (tenant_id, user_id),
  constraint tenant_membros_papel_chk check (papel in ('admin', 'operacao'))
);

create index if not exists tenant_membros_user_ativo_idx
  on public.tenant_membros (user_id)
  where ativo;

comment on table public.tenant_membros is
  'Vínculo usuário–empresa do pipeline. papel admin ou operacao. Não usa user_metadata nem licitagym_role.';

create table if not exists public.tenant_dados_restritos (
  tenant_id  bigint primary key references public.tenants (id) on delete cascade,
  banco      text,
  agencia    text,
  conta      text,
  updated_at timestamptz not null default now(),
  updated_by uuid
);

comment on table public.tenant_dados_restritos is
  'Banco, agência e conta do tenant. Só ADMIN lê. RLS não filtra coluna, por isso não mora em tenants.';

create or replace function public.tenant_papel(p_tenant bigint)
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select m.papel
    from public.tenant_membros m
   where m.tenant_id = p_tenant
     and m.user_id = auth.uid()
     and m.ativo
   limit 1
$$;

comment on function public.tenant_papel(bigint) is
  'Papel ativo do usuário corrente na empresa. security definer para a policy de tenant_membros não recursar.';

alter table public.tenant_membros enable row level security;
alter table public.tenant_dados_restritos enable row level security;

drop policy if exists tenant_membros_select on public.tenant_membros;
create policy tenant_membros_select on public.tenant_membros
  for select to authenticated
  using (
    user_id = (select auth.uid())
    or public.tenant_papel(tenant_id) = 'admin'
  );

drop policy if exists tenant_membros_escrever on public.tenant_membros;
create policy tenant_membros_escrever on public.tenant_membros
  for all to authenticated
  using (public.tenant_papel(tenant_id) = 'admin')
  with check (public.tenant_papel(tenant_id) = 'admin');

drop policy if exists tenant_dados_restritos_admin on public.tenant_dados_restritos;
create policy tenant_dados_restritos_admin on public.tenant_dados_restritos
  for all to authenticated
  using (public.tenant_papel(tenant_id) = 'admin')
  with check (public.tenant_papel(tenant_id) = 'admin');

revoke all on table public.tenant_membros, public.tenant_dados_restritos from PUBLIC, anon, authenticated, service_role;
grant select, insert, update, delete on table public.tenant_membros, public.tenant_dados_restritos to authenticated, service_role;

revoke all on function public.tenant_papel(bigint) from PUBLIC, anon, authenticated, service_role;
grant execute on function public.tenant_papel(bigint) to authenticated, service_role;

commit;
