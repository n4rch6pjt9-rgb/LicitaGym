-- 20261014150000_catalogo_rls_tenant: leitura direta do catálogo do tenant filtrada pela empresa (spec 0022, #358)
--
-- Por quê: catprod_select (20260926160000) e catalogo_produto_atributos_select (20261011100600) eram
--   `for select to authenticated using (true)`. Desde que catalogo_produtos ganhou tenant_id (20261002220000), qualquer
--   usuário logado lia, pelo PostgREST, o catálogo de todas as empresas (código, nome, URL, taxonomia, atributos
--   técnicos). O Dashboard não lê essas tabelas direto (usa a api-catalogo-ficha com service_role, filtrada pela
--   empresa de quem chama); o isolamento existia só na função.
-- O que muda: as duas policies passam a filtrar pela empresa, com a mesma regra das outras tabelas de tenant:
--   * produto com tenant_id: visível a membro ativo da empresa ativa (public.tenant_papel(tenant_id) is not null, #263);
--   * produto sem tenant_id (catálogo de fabricantes gravado por coletor/catalogos.py): visível a todo logado
--     (decisão do Marcelo, 14/10/2026);
--   * desenvolvedor (public.licitagym_desenvolvedor(): app_metadata.licitagym_role = 'admin') lê tudo (decisão do
--     Marcelo, 14/10/2026), como em tenant_membros_desenvolvedor;
--   * atributos seguem o produto (exists na linha de catalogo_produtos).
--   (select licitagym_desenvolvedor()) não depende da linha: o planejador avalia uma vez por consulta.
--   Grants inalterados: authenticated continua com SELECT (a policy filtra); escrita segue só service_role.
--   Aditiva, idempotente (drop policy if exists + create policy). Sem backfill. Sem branch Supabase (decisão de 14/10).
-- Quem lê/escreve: api-catalogo-ficha (service_role, ignora RLS), coletor/catalogos.py (service_role).
-- Verificação: supabase/tests/catalogo_rls_tenant_check.sql (CA-1..CA-6, CA-8, CA-9 da spec 0022).

begin;

set local lock_timeout = '10s';

alter table public.catalogo_produtos enable row level security;
alter table public.catalogo_produto_atributos enable row level security;

drop policy if exists catprod_select on public.catalogo_produtos;
create policy catprod_select on public.catalogo_produtos
  for select to authenticated
  using (
    tenant_id is null
    or public.tenant_papel(tenant_id) is not null
    or (select public.licitagym_desenvolvedor())
  );

drop policy if exists catalogo_produto_atributos_select on public.catalogo_produto_atributos;
create policy catalogo_produto_atributos_select on public.catalogo_produto_atributos
  for select to authenticated
  using (
    exists (
      select 1
        from public.catalogo_produtos p
       where p.id = catalogo_produto_atributos.produto_id
         and (
           p.tenant_id is null
           or public.tenant_papel(p.tenant_id) is not null
           or (select public.licitagym_desenvolvedor())
         )
    )
  );

comment on policy catprod_select on public.catalogo_produtos is
  'Produto da empresa só para membro ativo da empresa ativa (tenant_papel) ou desenvolvedor; produto sem empresa '
  '(catálogo de fabricantes) para todo logado. Spec 0022, #358.';
comment on policy catalogo_produto_atributos_select on public.catalogo_produto_atributos is
  'Segue a visibilidade do produto (catprod_select). Spec 0022, #358.';

commit;
