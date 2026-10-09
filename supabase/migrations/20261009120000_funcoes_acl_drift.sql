-- Corrige drift de ACL de funções em produção (spec specs/0003-funcoes-acl-drift.md).
--
-- Contexto (medição só leitura em produção, 09/10/2026): 42 funções (14 de `private`, 28 de `public`; 81 pares
-- função × papel) estavam executáveis por `anon`/`authenticated` fora do que as migrations definem, todas por GRANT
-- explícito com grantor `postgres` (nenhuma via PUBLIC ou ACL nula). Num banco limpo (scripts/validar-migrations.sh)
-- só as 10 funções da lista abaixo são executáveis por esses papéis. Origem provável: o painel do Supabase (Data API /
-- "Exposed functions" / exposição automática), não uma migration. As 4 SECURITY DEFINER do drift estão em `private`,
-- onde `anon`/`authenticated` não têm USAGE; as de `public` são SECURITY INVOKER e esses papéis não têm grant em
-- tabela. Não era explorável hoje, mas a defesa em camadas tinha sumido.
--
-- O que faz: para toda função própria do projeto em `public` e `private`, revoga EXECUTE de `anon` e `authenticated`,
-- exceto as concessões intencionais (por assinatura). Não mexe em `service_role`, `postgres` nem PUBLIC. Ignora
-- funções de extensão no schema da própria extensão (pgvector em `public`). Função membro de extensão FORA do schema
-- dela (em produção, 3 funções de `private` aparecem como membros de `supabase_vault`) é tratada como do projeto.
-- No fim confere o resultado com has_function_privilege (inclui PUBLIC) e aborta se sobrar algo: assim a migration
-- não "passa" incompleta em produção. Idempotente. Verificação: supabase/tests/funcoes_acl_check.sql.

begin;

set local lock_timeout = '5s';

do $acl$
declare
  r record;
  v_papel text;
  v_revogados int := 0;
  v_ausentes text;
  v_sobra text;
begin
  -- Lista intencional: mesma de supabase/tests/funcoes_acl_check.sql (mudou aqui, mude lá).
  create temporary table funcoes_acl_intencional (sig text primary key, papeis text[] not null) on commit drop;
  insert into funcoes_acl_intencional values
    -- Concessões intencionais a `authenticated` (fluxos com JWT do usuário).
    ('public.catalogo_condicao_avaliar(jsonb,jsonb)',                 array['authenticated']),
    ('public.catalogo_tarefas_da_fase(text,jsonb)',                   array['authenticated']),
    ('public.catalogo_tarefas_do_evento(text,jsonb)',                 array['authenticated']),
    ('public.licitagym_desenvolvedor()',                              array['authenticated']),
    ('public.match_catalogo_chunks(public.vector,integer,text,text)', array['authenticated']),
    ('public.tenant_documento_alerta(date,date)',                     array['authenticated']),
    ('public.tenant_documento_validade(date,date,integer)',           array['authenticated']),
    ('public.tenant_papel(bigint)',                                   array['authenticated']),
    -- Herdam EXECUTE de PUBLIC desde a criação (fora do escopo desta correção).
    ('public.taxonomia_bloco(text)',                                  array['anon', 'authenticated']),
    ('public.update_updated_at_column()',                             array['anon', 'authenticated']);

  select string_agg(sig, ', ') into v_ausentes from funcoes_acl_intencional where to_regprocedure(sig) is null;
  if v_ausentes is not null then
    raise exception '20261009120000: função da lista intencional não encontrada: %', v_ausentes;
  end if;

  for r in
    select p.oid, p.oid::regprocedure as fn, coalesce(i.papeis, array[]::text[]) as manter
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      left join funcoes_acl_intencional i on to_regprocedure(i.sig) = p.oid
     where n.nspname in ('public', 'private')
       and not exists (
             select 1
               from pg_depend d
               join pg_extension e on e.oid = d.refobjid
              where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e'
                and e.extnamespace = p.pronamespace)
  loop
    foreach v_papel in array array['anon', 'authenticated'] loop
      if not (v_papel = any (r.manter))
         and exists (select 1 from aclexplode(coalesce((select proacl from pg_proc where oid = r.oid), '{}'::aclitem[])) a
                      where a.grantee = to_regrole(v_papel) and a.privilege_type = 'EXECUTE') then
        execute format('revoke execute on function %s from %I', r.fn, v_papel);
        v_revogados := v_revogados + 1;
      end if;
    end loop;
  end loop;

  -- Pós-checagem: nada fora da lista executável por anon/authenticated (inclui EXECUTE herdado de PUBLIC)
  select string_agg(format('%s (%s)', p.oid::regprocedure, papel), ', ') into v_sobra
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    cross join unnest(array['anon', 'authenticated']) as papel
    left join funcoes_acl_intencional i on to_regprocedure(i.sig) = p.oid
   where n.nspname in ('public', 'private')
     and not exists (
           select 1 from pg_depend d join pg_extension e on e.oid = d.refobjid
            where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e'
              and e.extnamespace = p.pronamespace)
     and has_function_privilege(papel, p.oid, 'EXECUTE')
     and not (papel = any (coalesce(i.papeis, array[]::text[])));
  if v_sobra is not null then
    raise exception '20261009120000: depois do revoke, ainda executável fora da lista: %', v_sobra
      using hint = 'Grant via PUBLIC ou com outro grantor; revogue com o grantor certo numa migration nova.';
  end if;

  raise notice '20261009120000: % concessão(ões) de EXECUTE revogada(s) de anon/authenticated', v_revogados;
end $acl$;

commit;
