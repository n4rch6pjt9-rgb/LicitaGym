-- Leitura da view pca_historico_orgao_ano (migration 20261010100000).
-- authenticated não lê: a view usa licitacoes_externas, fechada ao usuário direto.

do $$
declare
  v_chk record;
  n int := 0;
  f int := 0;
begin
  for v_chk in
    with
    privs(p) as (
      select v.p from (values ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE'), ('REFERENCES'), ('TRIGGER')) v(p)
      union all
      select 'MAINTAIN' where current_setting('server_version_num')::int >= 170000
    ),
    checks(grupo, objeto, esperado, atual) as (
      select 'view', 'public.pca_historico_orgao_ano', 'existe',
             case when to_regclass('public.pca_historico_orgao_ano') is null then 'ausente' else 'existe' end
      union all
      select 'security_invoker', 'public.pca_historico_orgao_ano', 'true',
             coalesce((select (coalesce(c.reloptions, '{}') @> array['security_invoker=true'])::text
                         from pg_class c where c.oid = to_regclass('public.pca_historico_orgao_ano')), 'ausente')
      union all
      select 'grant', r.papel || ' ' || p.p, 'false',
             coalesce(has_table_privilege(r.papel, to_regclass('public.pca_historico_orgao_ano'), p.p)::text, 'ausente')
        from privs p
        cross join (values ('anon'), ('public'), ('authenticated')) r(papel)
      union all
      select 'grant', 'service_role ' || p.p, (p.p = 'SELECT')::text,
             coalesce(has_table_privilege('service_role', to_regclass('public.pca_historico_orgao_ano'), p.p)::text, 'ausente')
        from privs p
    )
    select * from checks
  loop
    n := n + 1;
    if v_chk.atual is distinct from v_chk.esperado then
      f := f + 1;
      raise notice 'FALHA % % esperado=% atual=%', v_chk.grupo, v_chk.objeto, v_chk.esperado, v_chk.atual;
    end if;
  end loop;
  if f > 0 then
    raise exception 'ACL CHECK FALHOU: pca_historico_orgao_ano % checagens, % falhas', n, f;
  end if;
  raise notice 'SUCESSO: pca_historico_orgao_ano % checagens, 0 falhas', n;
end
$$;
