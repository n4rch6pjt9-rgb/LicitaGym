-- Corrige drift de ACL de funções em produção (spec specs/0003-funcoes-acl-drift.md).
--
-- Contexto (medição só leitura em produção, 09/10/2026): 11 funções de `private` e 27 de `public` estavam
-- executáveis por `anon`/`authenticated`, com GRANT explícito a esses papéis. As migrations que criaram essas funções
-- fazem `revoke ... from anon, authenticated`; num banco limpo (scripts/validar-migrations.sh) nenhuma dessas
-- concessões existe. Origem provável: o painel do Supabase (Data API / "Exposed functions" / exposição automática),
-- não uma migration. Não era explorável hoje (anon/authenticated não têm USAGE em `private`; em `public` as funções
-- liberadas são SECURITY INVOKER e esses papéis não têm grant em tabela), mas a defesa em camadas tinha sumido.
--
-- O que faz: para toda função própria do projeto em `public` e `private`, revoga EXECUTE de `anon` e `authenticated`,
-- exceto as concessões intencionais (lista abaixo, igual ao estado das migrations num banco limpo). Não mexe em
-- `service_role`, `postgres` nem PUBLIC. Ignora funções de extensão (membro de extensão no schema da própria
-- extensão, ex.: pgvector em `public`). Função membro de extensão FORA do schema dela (em produção, 3 funções de
-- `private` aparecem como membros de `supabase_vault`) é tratada como função do projeto.
-- Idempotente (revoke de privilégio inexistente não faz nada). Sem DDL de objeto, sem lock relevante.
-- Verificação: supabase/tests/funcoes_acl_check.sql.

begin;

set local lock_timeout = '5s';

do $acl$
declare
  r record;
  v_papel text;
  v_revogados int := 0;
begin
  for r in
    -- Por schema + nome (nenhuma delas tem sobrecarga; o check confere isso).
    with intencional(schema_nome, funcao, papeis) as (
      values
        -- Concessões intencionais a `authenticated` (fluxos com JWT do usuário).
        ('public', 'catalogo_condicao_avaliar',  array['authenticated']),
        ('public', 'catalogo_tarefas_da_fase',   array['authenticated']),
        ('public', 'catalogo_tarefas_do_evento', array['authenticated']),
        ('public', 'licitagym_desenvolvedor',    array['authenticated']),
        ('public', 'match_catalogo_chunks',      array['authenticated']),
        ('public', 'tenant_documento_alerta',    array['authenticated']),
        ('public', 'tenant_documento_validade',  array['authenticated']),
        ('public', 'tenant_papel',               array['authenticated']),
        -- Herdam EXECUTE de PUBLIC desde a criação (fora do escopo desta correção).
        ('public', 'taxonomia_bloco',            array['anon','authenticated']),
        ('public', 'update_updated_at_column',   array['anon','authenticated'])
    )
    select p.oid, p.oid::regprocedure as fn, coalesce(io.papeis, array[]::text[]) as manter
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      left join intencional io on io.schema_nome = n.nspname and io.funcao = p.proname
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
                      where a.grantee = (select oid from pg_roles where rolname = v_papel) and a.privilege_type = 'EXECUTE') then
        execute format('revoke execute on function %s from %I', r.fn, v_papel);
        v_revogados := v_revogados + 1;
      end if;
    end loop;
  end loop;
  raise notice '20261009120000: % concessão(ões) de EXECUTE revogada(s) de anon/authenticated', v_revogados;
end $acl$;

commit;
