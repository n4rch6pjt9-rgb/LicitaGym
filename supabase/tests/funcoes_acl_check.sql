-- Checagem de ACL das funções do projeto (spec specs/0003-funcoes-acl-drift.md, migration 20261009120000).
-- Falha com EXCEPTION se:
--   1. alguma função própria de `public`/`private` for executável por `anon`/`authenticated` fora da lista intencional
--      (inclui EXECUTE herdado de PUBLIC);
--   2. alguma função da lista intencional tiver sobrecarga (a migration casa por schema + nome) ou perder o EXECUTE
--      de `authenticated` (quebraria fluxo com JWT do usuário);
--   3. alguma função de `private` chamada pelas Edge Functions perder o EXECUTE de `service_role`.
-- Só lê o catálogo. Roda no banco descartável (scripts/validar-migrations.sh) e pode rodar em produção (só leitura).

do $chk$
declare
  v_falhas text[] := array[]::text[];
  r record;
begin
  -- 1) Ninguém fora da lista executa como anon/authenticated
  for r in
    with intencional(schema_nome, funcao, papeis) as (
      values
        ('public', 'catalogo_condicao_avaliar',  array['authenticated']),
        ('public', 'catalogo_tarefas_da_fase',   array['authenticated']),
        ('public', 'catalogo_tarefas_do_evento', array['authenticated']),
        ('public', 'licitagym_desenvolvedor',    array['authenticated']),
        ('public', 'match_catalogo_chunks',      array['authenticated']),
        ('public', 'tenant_documento_alerta',    array['authenticated']),
        ('public', 'tenant_documento_validade',  array['authenticated']),
        ('public', 'tenant_papel',               array['authenticated']),
        ('public', 'taxonomia_bloco',            array['anon','authenticated']),
        ('public', 'update_updated_at_column',   array['anon','authenticated'])
    )
    select p.oid::regprocedure::text as fn, papel
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      cross join unnest(array['anon', 'authenticated']) as papel
      left join intencional i on i.schema_nome = n.nspname and i.funcao = p.proname
     where n.nspname in ('public', 'private')
       and not exists (
             select 1 from pg_depend d join pg_extension e on e.oid = d.refobjid
              where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e'
                and e.extnamespace = p.pronamespace)
       and has_function_privilege(papel, p.oid, 'EXECUTE')
       and not (papel = any (coalesce(i.papeis, array[]::text[])))
     order by 1, 2
  loop
    v_falhas := v_falhas || format('%s executável por %s', r.fn, r.papel);
  end loop;

  -- 2) Lista intencional: sem sobrecarga e com authenticated
  for r in
    select x.funcao, count(p.oid) as n,
           bool_and(has_function_privilege('authenticated', p.oid, 'EXECUTE')) as auth_ok
      from unnest(array['catalogo_condicao_avaliar', 'catalogo_tarefas_da_fase', 'catalogo_tarefas_do_evento',
                        'licitagym_desenvolvedor', 'match_catalogo_chunks', 'tenant_documento_alerta',
                        'tenant_documento_validade', 'tenant_papel']) as x(funcao)
      left join pg_proc p on p.proname = x.funcao and p.pronamespace = 'public'::regnamespace
     group by x.funcao
  loop
    if r.n <> 1 then
      v_falhas := v_falhas || format('public.%s: esperado 1 função, achei %s', r.funcao, r.n);
    elsif not r.auth_ok then
      v_falhas := v_falhas || format('public.%s perdeu EXECUTE de authenticated', r.funcao);
    end if;
  end loop;

  -- 3) service_role continua executando o que as Edge Functions chamam em private
  for r in
    select f as fn from unnest(array[
      'private.acquire_http_slot(text,integer)',
      'private.report_http_rate_limit(text,integer)',
      'private.acquire_sync_lock(text,text,jsonb,interval,interval)',
      'private.saude_operacional_resumo()']) as f
     where to_regprocedure(f) is null
        or not has_function_privilege('service_role', to_regprocedure(f), 'EXECUTE')
  loop
    v_falhas := v_falhas || format('%s ausente ou sem EXECUTE de service_role', r.fn);
  end loop;

  if cardinality(v_falhas) > 0 then
    raise exception 'funcoes_acl_check: % falha(s): %', cardinality(v_falhas), array_to_string(v_falhas, '; ');
  end if;
  raise notice 'SUCESSO: funcoes_acl_check: ACL de funções de public/private conferida';
end $chk$;
