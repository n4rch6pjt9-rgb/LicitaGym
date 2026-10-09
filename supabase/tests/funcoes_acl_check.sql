-- Checagem de ACL das funções do projeto (spec specs/0003-funcoes-acl-drift.md, migration 20261009120000).
-- Falha com EXCEPTION se:
--   1. alguma função própria de `public`/`private` for executável por `anon`/`authenticated` fora da lista intencional
--      (inclui EXECUTE herdado de PUBLIC);
--   2. alguma função da lista intencional (por assinatura) sumir ou perder o EXECUTE previsto (quebraria fluxo com
--      JWT do usuário);
--   3. alguma função de `private` chamada pelas Edge Functions perder o EXECUTE de `service_role`.
-- Só lê o catálogo (cria uma tabela temporária e termina em rollback). Roda no banco descartável
-- (scripts/validar-migrations.sh) e pode rodar em produção pelo SQL Editor; não roda em transação read only.

begin;

do $chk$
declare
  v_falhas text[] := array[]::text[];
  r record;
begin
  -- Lista intencional: mesma da migration 20261009120000_funcoes_acl_drift.sql (mudou aqui, mude lá).
  create temporary table funcoes_acl_intencional_chk (sig text primary key, papeis text[] not null) on commit drop;
  insert into funcoes_acl_intencional_chk values
    ('public.catalogo_condicao_avaliar(jsonb,jsonb)',                 array['authenticated']),
    ('public.catalogo_tarefas_da_fase(text,jsonb)',                   array['authenticated']),
    ('public.catalogo_tarefas_do_evento(text,jsonb)',                 array['authenticated']),
    ('public.licitagym_desenvolvedor()',                              array['authenticated']),
    ('public.match_catalogo_chunks(public.vector,integer,text,text)', array['authenticated']),
    ('public.tenant_documento_alerta(date,date)',                     array['authenticated']),
    ('public.tenant_documento_validade(date,date,integer)',           array['authenticated']),
    ('public.tenant_papel(bigint)',                                   array['authenticated']),
    ('public.taxonomia_bloco(text)',                                  array['anon', 'authenticated']),
    ('public.update_updated_at_column()',                             array['anon', 'authenticated']);

  -- 1) Ninguém fora da lista (por assinatura: sobrecarga nova não herda) executa como anon/authenticated
  for r in
    select p.oid::regprocedure::text as fn, papel
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      cross join unnest(array['anon', 'authenticated']) as papel
      left join funcoes_acl_intencional_chk i on to_regprocedure(i.sig) = p.oid
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

  -- 2) Lista intencional: toda assinatura existe e mantém o EXECUTE previsto
  for r in
    select i.sig, papel
      from funcoes_acl_intencional_chk i cross join unnest(i.papeis) as papel
     where to_regprocedure(i.sig) is null
        or not has_function_privilege(papel, to_regprocedure(i.sig), 'EXECUTE')
  loop
    v_falhas := v_falhas || format('%s ausente ou sem EXECUTE de %s', r.sig, r.papel);
  end loop;

  -- 3) service_role continua executando o que as Edge Functions chamam em private
  for r in
    select f as fn from unnest(array[
      'private.acquire_http_slot(text,integer)',
      'private.report_http_rate_limit(text,integer)',
      'private.acquire_sync_lock(text,text,jsonb,interval,interval)',
      'private.saude_operacional_resumo()',
      'private.pca_fila_enfileirar(jsonb)',
      'private.pca_fila_reservar(integer,integer,integer)',
      'private.pca_marcar_descoberta(integer,text[],text[])']) as f
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

rollback;
