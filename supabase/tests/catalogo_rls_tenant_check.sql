-- Checagem da spec 0022 (issue #358): leitura direta de catalogo_produtos e catalogo_produto_atributos filtrada
-- pela empresa de quem chama.
--   CA-1 membro ativo da empresa T lê o produto de T          CA-5 anon sem grant e sem policy
--   CA-2 sem vínculo (ou vínculo só em U) não lê o produto de T  CA-6 policies únicas, sem `true` nem user_metadata
--   CA-3 atributos seguem o produto (U não vê os de T; T vê)    CA-8 produto sem tenant_id visível a todo logado
--   CA-4 vínculo inativo ou empresa inativa não lê             CA-9 desenvolvedor (app_metadata.licitagym_role) lê tudo
-- Como: begin/rollback; fixtures próprias; auth.uid()/auth.jwt() redefinidos dentro da transação (stub de
-- supabase/tests/pre.sql); `set local role authenticated` para a policy valer (superusuário ignora RLS).
-- Só para o Postgres descartável do scripts/validar-migrations.sh: redefine funções do schema auth (desfeito no rollback).
-- Travas: aborta se auth.uid() não for o stub de pre.sql ou existir supabase_auth_admin (produção), e se
-- catalogo_produtos tiver mais de 100 linhas.

begin;

-- Assume a identidade p_uid (e o JWT p_jwt) como o papel authenticated. Temporária: some no rollback.
create function pg_temp.como(p_uid uuid, p_jwt jsonb) returns void language plpgsql as $f$
begin
  execute 'reset role';
  execute format('create or replace function auth.uid() returns uuid language sql stable as %L',
                 format('select %L::uuid', p_uid));
  execute format('create or replace function auth.jwt() returns jsonb language sql stable as %L',
                 format('select %L::jsonb', coalesce(p_jwt, '{}'::jsonb)));
  execute 'set local role authenticated';
end
$f$;

do $$
declare
  v_qtd        int;
  v_t          bigint;  -- empresa T (ativa)
  v_u          bigint;  -- empresa U (ativa)
  v_v          bigint;  -- empresa V (inativa)
  v_pt         bigint;  -- produto de T
  v_pu         bigint;  -- produto de U
  v_pn         bigint;  -- produto sem empresa (catálogo de fabricantes)
  v_pv         bigint;  -- produto de V
  u_t   constant uuid := '00000000-0000-4000-8000-000000000022';  -- membro ativo de T
  u_u   constant uuid := '00000000-0000-4000-8000-000000000023';  -- membro ativo de U
  u_ti  constant uuid := '00000000-0000-4000-8000-000000000024';  -- vínculo inativo em T
  u_v   constant uuid := '00000000-0000-4000-8000-000000000025';  -- membro ativo de V (empresa inativa)
  n_prod int; n_attr int;
  f int := 0;
  n int := 0;
  v_qual text;
begin
  -- Guarda: esta checagem redefine auth.uid()/auth.jwt(). Só roda onde elas são o stub de supabase/tests/pre.sql
  -- (Postgres descartável). Em Supabase (papel supabase_auth_admin) aborta antes de qualquer fixture.
  if exists (select 1 from pg_roles where rolname = 'supabase_auth_admin')
     or coalesce((select p.prosrc from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                   where n.nspname = 'auth' and p.proname = 'uid' and p.pronargs = 0), '') not like '%select null::uuid%' then
    raise exception 'TRAVA DE SEGURANCA: catalogo_rls_tenant_check so roda no Postgres descartavel (auth.uid() nao e o stub de pre.sql).';
  end if;
  select count(*) into v_qtd from public.catalogo_produtos;
  if v_qtd > 100 then
    raise exception 'TRAVA DE SEGURANCA: catalogo_produtos tem % linhas (> 100). Abortando para proteger producao.', v_qtd;
  end if;

  -- fixtures --------------------------------------------------------------------------------------------------------
  insert into public.tenants (slug, nome, ativo) values ('chk-0022-t', 'Empresa T', true)  returning id into v_t;
  insert into public.tenants (slug, nome, ativo) values ('chk-0022-u', 'Empresa U', true)  returning id into v_u;
  insert into public.tenants (slug, nome, ativo) values ('chk-0022-v', 'Empresa V', false) returning id into v_v;
  insert into public.tenant_membros (tenant_id, user_id, papel, ativo) values
    (v_t, u_t,  'operacao', true),
    (v_u, u_u,  'operacao', true),
    (v_t, u_ti, 'operacao', false),
    (v_v, u_v,  'admin',    true);
  insert into public.catalogo_produtos (marca, codigo, nome, url, tenant_id)
    values ('CHK', 'T-1', 'Produto T', 'https://chk-0022.test/t', v_t) returning id into v_pt;
  insert into public.catalogo_produtos (marca, codigo, nome, url, tenant_id)
    values ('CHK', 'U-1', 'Produto U', 'https://chk-0022.test/u', v_u) returning id into v_pu;
  insert into public.catalogo_produtos (marca, codigo, nome, url, tenant_id)
    values ('CHK', 'N-1', 'Produto fabricante', 'https://chk-0022.test/n', null) returning id into v_pn;
  insert into public.catalogo_produtos (marca, codigo, nome, url, tenant_id)
    values ('CHK', 'V-1', 'Produto V', 'https://chk-0022.test/v', v_v) returning id into v_pv;
  insert into public.catalogo_produto_atributos (produto_id, atributo, valor_num) values
    (v_pt, 'motor_hp_min', 3), (v_pu, 'motor_hp_min', 3), (v_pn, 'motor_hp_min', 3), (v_pv, 'motor_hp_min', 3);

  -- CA-1 / CA-2 / CA-3 / CA-8: membro ativo de T vê T e o sem empresa; não vê U nem V --------------------------------
  perform pg_temp.como(u_t, null);
  n := n + 4;
  if not exists (select 1 from public.catalogo_produtos where id = v_pt) then
    f := f + 1; raise notice 'FALHA CA-1: membro de T nao le o produto de T'; end if;
  if exists (select 1 from public.catalogo_produtos where id in (v_pu, v_pv)) then
    f := f + 1; raise notice 'FALHA CA-2: membro de T le produto de outra empresa'; end if;
  if not exists (select 1 from public.catalogo_produtos where id = v_pn) then
    f := f + 1; raise notice 'FALHA CA-8: membro de T nao le o produto sem empresa'; end if;
  select count(*) into n_attr from public.catalogo_produto_atributos where produto_id in (v_pt, v_pu, v_pn, v_pv);
  if n_attr <> 2 then
    f := f + 1; raise notice 'FALHA CA-3: membro de T ve % atributos (esperado 2: T e sem empresa)', n_attr; end if;

  -- CA-2 / CA-8: sem vínculo algum (auth.uid() nulo) só vê o produto sem empresa ------------------------------------
  perform pg_temp.como(null, null);
  n := n + 2;
  select count(*) into n_prod from public.catalogo_produtos where id in (v_pt, v_pu, v_pn, v_pv);
  select count(*) into n_attr from public.catalogo_produto_atributos where produto_id in (v_pt, v_pu, v_pn, v_pv);
  if n_prod <> 1 or not exists (select 1 from public.catalogo_produtos where id = v_pn) then
    f := f + 1; raise notice 'FALHA CA-2: sem vinculo ve % produtos (esperado 1, o sem empresa)', n_prod; end if;
  if n_attr <> 1 then
    f := f + 1; raise notice 'FALHA CA-3: sem vinculo ve % atributos (esperado 1)', n_attr; end if;

  -- CA-2 / CA-3: membro de U não vê o produto nem o atributo de T; vê o de U --------------------------------------
  perform pg_temp.como(u_u, null);
  n := n + 2;
  if exists (select 1 from public.catalogo_produtos where id = v_pt)
     or not exists (select 1 from public.catalogo_produtos where id = v_pu) then
    f := f + 1; raise notice 'FALHA CA-2: membro de U ve o produto de T ou nao ve o de U'; end if;
  if exists (select 1 from public.catalogo_produto_atributos where produto_id = v_pt)
     or not exists (select 1 from public.catalogo_produto_atributos where produto_id = v_pu) then
    f := f + 1; raise notice 'FALHA CA-3: membro de U ve atributo de T ou nao ve o de U'; end if;

  -- CA-4: vínculo inativo em T, e empresa V inativa --------------------------------------------------------------
  perform pg_temp.como(u_ti, null);
  n := n + 1;
  if exists (select 1 from public.catalogo_produtos where id = v_pt)
     or exists (select 1 from public.catalogo_produto_atributos where produto_id = v_pt) then
    f := f + 1; raise notice 'FALHA CA-4: vinculo inativo le o produto de T'; end if;
  perform pg_temp.como(u_v, null);
  n := n + 1;
  if exists (select 1 from public.catalogo_produtos where id = v_pv)
     or exists (select 1 from public.catalogo_produto_atributos where produto_id = v_pv) then
    f := f + 1; raise notice 'FALHA CA-4: membro de empresa inativa le o produto dela'; end if;

  -- CA-9: desenvolvedor (app_metadata.licitagym_role = admin), sem vínculo, lê tudo --------------------------------
  perform pg_temp.como(null, '{"app_metadata": {"licitagym_role": "admin"}}'::jsonb);
  n := n + 1;
  select count(*) into n_prod from public.catalogo_produtos where id in (v_pt, v_pu, v_pn, v_pv);
  select count(*) into n_attr from public.catalogo_produto_atributos where produto_id in (v_pt, v_pu, v_pn, v_pv);
  if n_prod <> 4 or n_attr <> 4 then
    f := f + 1; raise notice 'FALHA CA-9: desenvolvedor ve % produtos e % atributos (esperado 4 e 4)', n_prod, n_attr; end if;
  -- user_metadata não dá papel
  perform pg_temp.como(null, '{"user_metadata": {"licitagym_role": "admin"}}'::jsonb);
  n := n + 1;
  if exists (select 1 from public.catalogo_produtos where id = v_pt) then
    f := f + 1; raise notice 'FALHA CA-9: user_metadata deu acesso de desenvolvedor'; end if;

  execute 'reset role';

  -- CA-5: anon sem grant e sem policy ------------------------------------------------------------------------------
  n := n + 2;
  if has_table_privilege('anon', 'public.catalogo_produtos', 'SELECT')
     or has_table_privilege('anon', 'public.catalogo_produto_atributos', 'SELECT') then
    f := f + 1; raise notice 'FALHA CA-5: anon tem SELECT no catalogo'; end if;
  if exists (
    select 1 from pg_policy p
     where p.polrelid in ('public.catalogo_produtos'::regclass, 'public.catalogo_produto_atributos'::regclass)
       and (p.polroles = '{0}'::oid[] or 'anon'::regrole::oid = any (p.polroles))
  ) then
    f := f + 1; raise notice 'FALHA CA-5: policy do catalogo vale para anon ou PUBLIC'; end if;

  -- CA-6: uma policy de SELECT por tabela, com filtro (sem `true`), sem user_metadata ------------------------------
  n := n + 2;
  for v_qual in
    select pg_get_expr(p.polqual, p.polrelid)
      from pg_policy p
     where p.polrelid in ('public.catalogo_produtos'::regclass, 'public.catalogo_produto_atributos'::regclass)
       and p.polcmd = 'r'
  loop
    if v_qual is null or v_qual = 'true' or v_qual ilike '%user_metadata%' or v_qual not ilike '%tenant_papel%' then
      f := f + 1; raise notice 'FALHA CA-6: policy de SELECT sem filtro por empresa: %', v_qual;
    end if;
  end loop;
  -- exatamente uma policy por tabela (qualquer comando): nada além de catprod_select / catalogo_produto_atributos_select
  if (select count(*) from pg_policy where polrelid = 'public.catalogo_produtos'::regclass) <> 1
     or not exists (select 1 from pg_policy where polrelid = 'public.catalogo_produtos'::regclass and polname = 'catprod_select')
     or (select count(*) from pg_policy where polrelid = 'public.catalogo_produto_atributos'::regclass) <> 1
     or not exists (select 1 from pg_policy where polrelid = 'public.catalogo_produto_atributos'::regclass
                     and polname = 'catalogo_produto_atributos_select') then
    f := f + 1; raise notice 'FALHA CA-6: esperada exatamente uma policy por tabela (catprod_select / catalogo_produto_atributos_select)';
  end if;

  if f > 0 then
    raise exception 'CHECK FALHOU: catalogo_rls_tenant % checagens, % falhas', n, f;
  end if;
  raise notice 'SUCESSO: catalogo_rls_tenant % checagens, 0 falhas (CA-1..CA-6, CA-8, CA-9 da spec 0022)', n;
end
$$;

rollback;
