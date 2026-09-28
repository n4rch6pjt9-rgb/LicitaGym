-- icatmat_pdm_completa e icatmat_grupo_material: ativa RLS e alinha com as catmat_*.
-- Antes: RLS desativado e anon/authenticated com todos os privilégios.
-- Depois: anon sem acesso; authenticated só leitura; escrita só service_role.

alter table public.icatmat_pdm_completa enable row level security;
alter table public.icatmat_grupo_material enable row level security;

revoke all on table public.icatmat_pdm_completa from anon;
revoke all on table public.icatmat_grupo_material from anon;

create policy icatmat_pdm_completa_select
  on public.icatmat_pdm_completa
  for select
  to authenticated
  using (true);

create policy icatmat_grupo_material_select
  on public.icatmat_grupo_material
  for select
  to authenticated
  using (true);
