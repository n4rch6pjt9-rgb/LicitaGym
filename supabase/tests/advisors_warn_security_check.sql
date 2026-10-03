-- Verificação (SOMENTE LEITURA) do estado esperado após a migration 20261004120000_advisors_warn_security.
-- Só SELECT em catálogo e funções has_*_privilege (nenhuma escrita, nenhuma tabela temporária, nenhum dado).
-- Executar após aplicar a migration, ex.:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/advisors_warn_security_check.sql
-- Resultado esperado: NOTICE "advisors_warn_security_check: N checagens, 0 falhas" e exit code 0.
-- Qualquer falha é listada em NOTICE ("FALHA ...") e o script termina com RAISE EXCEPTION.
--
-- O que confere:
--   (a) catmat_item_completo: anon/authenticated/PUBLIC sem nenhum privilégio; service_role com SELECT.
--   (c) update_updated_at_column() e taxonomia_bloco(text) com search_path vazio; nenhuma outra função
--       de usuário em public/private sem search_path fixo.
--   (d-prep) match_* com search_path = public, extensions; ACL inalterado (anon sem EXECUTE).

do $$
declare
  v_chk record;
  n     int := 0;
  f     int := 0;
begin
  for v_chk in
    with
    roles(r) as (values ('anon'), ('authenticated'), ('public')),
    privs(p) as (values ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE'), ('REFERENCES'), ('TRIGGER')),
    mv as (select to_regclass('public.catmat_item_completo') as oid),
    fns(sig, esperado) as (values
      ('public.update_updated_at_column()', 'search_path=""'),
      ('public.taxonomia_bloco(text)', 'search_path=""'),
      ('public.match_legislacao_embeddings(vector,double precision,integer)', 'search_path=public, extensions'),
      ('public.match_licitacao_chunks(vector,integer,text,text)', 'search_path=public, extensions'),
      ('public.match_licitacao_chunks_v2(vector,integer,text,text,boolean)', 'search_path=public, extensions'),
      ('public.match_catalogo_chunks(vector,integer,text,text)', 'search_path=public, extensions'))
    select 'MV existe' as nome, (select oid from mv) is not null as ok
    union all
    select format('MV: %s sem %s', r, p),
           not exists (select 1 from mv, aclexplode(coalesce((select relacl from pg_class where oid = mv.oid), '{}')) a
                        where a.privilege_type = p
                          and a.grantee = case r when 'public' then 0 else (select oid from pg_roles where rolname = r) end)
           and case when r = 'public' then true else not has_table_privilege(r, (select oid from mv), p) end
      from roles, privs
    union all
    select 'MV: service_role com SELECT', has_table_privilege('service_role', (select oid from mv), 'SELECT')
    union all
    select format('%s com %s', sig, esperado),
           coalesce(esperado = any(coalesce((select proconfig from pg_proc where oid = to_regprocedure(sig)), '{}'::text[])), false)
      from fns
    union all
    select format('%s sem EXECUTE para anon', sig),
           to_regprocedure(sig) is not null and not has_function_privilege('anon', to_regprocedure(sig), 'EXECUTE')
      from fns where sig like 'public.match\_%'
    union all
    select 'nenhuma função de usuário em public/private sem search_path',
           not exists (
             select 1 from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
              where ns.nspname in ('public', 'private') and p.prokind in ('f', 'p')
                and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')
                and not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%'))
  loop
    n := n + 1;
    if not coalesce(v_chk.ok, false) then
      f := f + 1;
      raise notice 'FALHA %', v_chk.nome;
    end if;
  end loop;
  raise notice 'advisors_warn_security_check: % checagens, % falhas', n, f;
  if f > 0 then
    raise exception 'advisors_warn_security_check: % falhas', f;
  end if;
end
$$;
