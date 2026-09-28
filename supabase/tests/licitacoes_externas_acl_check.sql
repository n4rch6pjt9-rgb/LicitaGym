-- Verificação de ACL e RLS efetivo na tabela public.licitacoes_externas (D1.2).
-- Executar após aplicar as migrations (ex.: psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/licitacoes_externas_acl_check.sql):
--   1. has_table_privilege('anon', 'public.licitacoes_externas', 'SELECT') = false
--   2. has_table_privilege('authenticated', 'public.licitacoes_externas', 'SELECT') = false
--   3. has_table_privilege('service_role', 'public.licitacoes_externas', 'SELECT') = true (e escrita mantida)
--   4. Nenhuma policy em pg_policies para public.licitacoes_externas concedendo a anon ou authenticated
--   5. RLS habilitado (pg_class.relrowsecurity = true)
-- Cada bloco falha com EXCEPTION caso a regra seja violada.

do $$
declare
  v_priv_anon boolean;
  v_priv_auth boolean;
  v_priv_service_select boolean;
  v_priv_service_insert boolean;
  v_policy_count int;
  v_rls_enabled boolean;
  v_comment text;
begin
  -- 1. Checagem de privilégio de SELECT para anon (negativo)
  select has_table_privilege('anon', 'public.licitacoes_externas', 'SELECT') into v_priv_anon;
  if v_priv_anon then
    raise exception 'ACL CHECK FALHOU: role anon ainda possui SELECT em public.licitacoes_externas';
  end if;

  -- 2. Checagem de privilégio de SELECT para authenticated (negativo)
  select has_table_privilege('authenticated', 'public.licitacoes_externas', 'SELECT') into v_priv_auth;
  if v_priv_auth then
    raise exception 'ACL CHECK FALHOU: role authenticated ainda possui SELECT em public.licitacoes_externas';
  end if;

  -- 3. Asserção positiva de privilégios para service_role (usado pela Edge Function e pelos coletores)
  select has_table_privilege('service_role', 'public.licitacoes_externas', 'SELECT') into v_priv_service_select;
  if not v_priv_service_select then
    raise exception 'ACL CHECK FALHOU: role service_role nao possui SELECT em public.licitacoes_externas';
  end if;

  select has_table_privilege('service_role', 'public.licitacoes_externas', 'INSERT') into v_priv_service_insert;
  if not v_priv_service_insert then
    raise exception 'ACL CHECK FALHOU: role service_role nao possui INSERT em public.licitacoes_externas';
  end if;

  -- 4. Nenhuma policy para anon ou authenticated em pg_policies
  select count(*) into v_policy_count
    from pg_policies
   where schemaname = 'public'
     and tablename = 'licitacoes_externas'
     and (
       roles && array['anon'::name, 'authenticated'::name, 'public'::name]
       or 'anon' = any(roles)
       or 'authenticated' = any(roles)
       or 'public' = any(roles)
     );
  if v_policy_count > 0 then
    raise exception 'RLS CHECK FALHOU: existem % policies para anon/authenticated/public em public.licitacoes_externas', v_policy_count;
  end if;

  -- 5. RLS habilitado (relrowsecurity = true)
  select relrowsecurity into v_rls_enabled
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public'
     and c.relname = 'licitacoes_externas';

  if not v_rls_enabled then
    raise exception 'RLS CHECK FALHOU: relrowsecurity nao esta habilitado em public.licitacoes_externas';
  end if;

  -- 6. Comentário da tabela reflete leituras de dashboard via Edge Function e acesso interno via service_role
  select obj_description(c.oid, 'pg_class') into v_comment
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public'
     and c.relname = 'licitacoes_externas';

  if v_comment is null
     or v_comment not like '%api-dashboard-oportunidades%'
     or v_comment not like '%service_role%'
     or v_comment not like '%coletores%' then
    raise exception 'COMMENT CHECK FALHOU: comentario da tabela nao documenta leitura de dashboard via Edge Function e acesso interno de coletores via service_role. Comentario atual: %', v_comment;
  end if;

  raise notice 'SUCESSO: Todas as checagens de ACL e RLS em public.licitacoes_externas passaram!';
end $$;
