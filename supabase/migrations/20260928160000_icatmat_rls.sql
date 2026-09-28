-- 20260928160000_icatmat_rls.sql
-- Habilita RLS nas tabelas de referência icatmat_* e adiciona policy de leitura
-- para o role authenticated (padrão das demais tabelas de catálogo).
-- Escrita só via service_role, que ignora RLS. anon sem acesso.
-- Revoga grants de tabela (TRUNCATE ignora RLS) e deixa authenticated só com SELECT.
-- Idempotente: pode rodar novamente sem erro.
-- Aplicado manualmente no remoto em 2026-09-28.

begin;

alter table public.icatmat_grupo_material enable row level security;

drop policy if exists icatmat_grupo_material_select on public.icatmat_grupo_material;
create policy icatmat_grupo_material_select
  on public.icatmat_grupo_material
  for select
  to authenticated
  using (true);

alter table public.icatmat_pdm_completa enable row level security;

drop policy if exists icatmat_pdm_completa_select on public.icatmat_pdm_completa;
create policy icatmat_pdm_completa_select
  on public.icatmat_pdm_completa
  for select
  to authenticated
  using (true);

revoke all on table public.icatmat_pdm_completa, public.icatmat_grupo_material from anon;
revoke all on table public.icatmat_pdm_completa, public.icatmat_grupo_material from authenticated;
grant select on table public.icatmat_pdm_completa, public.icatmat_grupo_material to authenticated;

commit;
