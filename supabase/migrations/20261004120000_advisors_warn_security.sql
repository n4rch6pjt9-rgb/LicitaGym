-- LicitaGym: corrige os WARN do security advisor do Supabase (leitura de 03/10/2026, 19:24 BRT,
-- produção ifaiagegyicjzlpskafh, só leitura). Rollback: supabase/rollback/20261004120000_advisors_warn_security_rollback.sql
-- Verificação: supabase/tests/advisors_warn_security_check.sql
--
-- WARN atuais (get_advisors type=security):
--   0016 materialized_view_in_api    public.catmat_item_completo selecionável por authenticated
--                                    (relacl = postgres=ALL, service_role=ALL, authenticated=r; anon já sem grant)
--   0011 function_search_path_mutable public.update_updated_at_column(), public.taxonomia_bloco(text)
--                                    (são as duas únicas funções de usuário, em public/private, sem search_path fixo)
--   0014 extension_in_public         vector 0.8.2 em public (dono supabase_admin) — NÃO movida aqui (ver abaixo)
--   auth_leaked_password_protection  configuração do Auth, não é SQL (e só existe no plano Pro+)
--
-- O que muda:
--   (a) catmat_item_completo: REVOKE ALL de PUBLIC, anon e authenticated. Só postgres (dono) e service_role
--       continuam lendo. Nenhum código do repositório (Edge Functions, services/, scripts/, Kuib-Harness)
--       lê a MV; o refresh é por public.refresh_catmat_item_completo() (SECURITY DEFINER, só service_role),
--       que não depende do grant de authenticated. Pré-condição: confirmar que o Dashboard privado
--       (fora deste repo) não lê a MV com JWT de usuário logado.
--   (c) search_path = '' nas duas funções. Os corpos só usam pg_catalog (now(), lower, translate,
--       coalesce, ~, !~) e NEW.*; testado em produção (read only) com search_path vazio: mesmo resultado.
--       Efeito colateral: uma função SQL com SET deixa de ser "inlined"; taxonomia_bloco é usada na view
--       catmat_itens_taxonomia (uma chamada por linha) — custo pequeno, sem índice de expressão dependente.
--   (d-prep) match_* passam a ter search_path = public, extensions (antes: public). Hoje é neutro (<=> continua
--       em public, que vem primeiro). Prepara a mudança futura de vector para o schema extensions
--       (supabase/sql/vector_para_extensions.sql, ADIADA): sem isto, <=> deixaria de resolver dentro delas.
--
-- Idempotente: só REVOKE/GRANT/ALTER FUNCTION SET, cada um protegido por to_regclass/to_regprocedure.
-- Sem lock pesado: GRANT/REVOKE e ALTER FUNCTION só atualizam catálogo.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '30s';

-- (a) MV fora da Data API ----------------------------------------------------------------------
do $a$
begin
  if to_regclass('public.catmat_item_completo') is null then
    raise notice '(a) public.catmat_item_completo não existe: nada a fazer.';
    return;
  end if;
  revoke all on table public.catmat_item_completo from public, anon, authenticated;
  grant all on table public.catmat_item_completo to service_role;
  comment on materialized view public.catmat_item_completo is
    'Read model CATMAT consolidado. Fora da Data API: só postgres/service_role (advisor 0016, 2026-10-04). '
    'Refresh: public.refresh_catmat_item_completo() (service_role).';
end
$a$;

-- (c) search_path fixo -------------------------------------------------------------------------
do $c$
begin
  if to_regprocedure('public.update_updated_at_column()') is not null then
    alter function public.update_updated_at_column() set search_path = '';
  else
    raise notice '(c) public.update_updated_at_column() não existe.';
  end if;
  if to_regprocedure('public.taxonomia_bloco(text)') is not null then
    alter function public.taxonomia_bloco(text) set search_path = '';
  else
    raise notice '(c) public.taxonomia_bloco(text) não existe.';
  end if;
end
$c$;

-- (d-prep) match_* enxergam extensions ----------------------------------------------------------
do $d$
declare
  v_sig text;
  v_fn  regprocedure;
begin
  foreach v_sig in array array[
    'public.match_legislacao_embeddings(vector,double precision,integer)',
    'public.match_licitacao_chunks(vector,integer,text,text)',
    'public.match_licitacao_chunks_v2(vector,integer,text,text,boolean)',
    'public.match_catalogo_chunks(vector,integer,text,text)'
  ] loop
    v_fn := to_regprocedure(v_sig);
    if v_fn is null then
      raise notice '(d-prep) % não existe.', v_sig;
      continue;
    end if;
    execute format('alter function %s set search_path = public, extensions', v_fn);
  end loop;
end
$d$;

-- Checks (falham a transação inteira) ----------------------------------------------------------
do $chk$
declare
  v_mv  regclass := to_regclass('public.catmat_item_completo');
  v_r   text;
  v_p   text;
  v_sig text;
  v_fn  regprocedure;
  v_cfg text[];
begin
  if v_mv is not null then
    foreach v_r in array array['anon', 'authenticated'] loop
      foreach v_p in array array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'] loop
        if has_table_privilege(v_r, v_mv, v_p) then
          raise exception 'CHECK FALHOU: % ainda tem % em public.catmat_item_completo', v_r, v_p;
        end if;
      end loop;
    end loop;
    if not has_table_privilege('service_role', v_mv, 'SELECT') then
      raise exception 'CHECK FALHOU: service_role perdeu SELECT em public.catmat_item_completo';
    end if;
  end if;

  foreach v_sig in array array['public.update_updated_at_column()', 'public.taxonomia_bloco(text)'] loop
    v_fn := to_regprocedure(v_sig);
    continue when v_fn is null;
    select proconfig into v_cfg from pg_proc where oid = v_fn;
    if not coalesce('search_path=""' = any(v_cfg), false) then
      raise exception 'CHECK FALHOU: % sem search_path vazio (proconfig=%)', v_sig, v_cfg;
    end if;
  end loop;

  foreach v_sig in array array[
    'public.match_legislacao_embeddings(vector,double precision,integer)',
    'public.match_licitacao_chunks(vector,integer,text,text)',
    'public.match_licitacao_chunks_v2(vector,integer,text,text,boolean)',
    'public.match_catalogo_chunks(vector,integer,text,text)'
  ] loop
    v_fn := to_regprocedure(v_sig);
    continue when v_fn is null;
    select proconfig into v_cfg from pg_proc where oid = v_fn;
    if not coalesce('search_path=public, extensions' = any(v_cfg), false) then
      raise exception 'CHECK FALHOU: % com search_path inesperado (proconfig=%)', v_sig, v_cfg;
    end if;
    -- ACL dos match_* não muda aqui (ALTER FUNCTION SET preserva proacl).
    if has_function_privilege('anon', v_fn, 'EXECUTE') then
      raise exception 'CHECK FALHOU: anon com EXECUTE em %', v_sig;
    end if;
  end loop;

  -- Nenhuma outra função de usuário em public/private sem search_path (advisor 0011).
  if exists (
    select 1
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname in ('public', 'private')
       and p.prokind in ('f', 'p')
       and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')
       and not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%')
  ) then
    raise exception 'CHECK FALHOU: ainda há função em public/private sem search_path fixo';
  end if;

  raise notice 'advisors_warn_security: checks ok';
end
$chk$;

commit;
