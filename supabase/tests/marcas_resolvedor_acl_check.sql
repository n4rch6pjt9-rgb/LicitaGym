-- Verificação (SOMENTE LEITURA) do estado esperado após a migration 20261003200000_marcas_resolvedor_fornecedor.
-- Só SELECT em catálogo, funções has_*_privilege e chamadas às funções IMMUTABLE/STABLE do resolvedor
-- (nenhuma escrita, nenhuma tabela temporária). Executar após aplicar a migration, ex.:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/marcas_resolvedor_acl_check.sql
-- Também roda inteiro no SQL Editor do Supabase.
-- Resultado esperado: NOTICE "SUCESSO: marcas_resolvedor_acl_check: N checagens, 0 falhas".
-- Cada falha sai em NOTICE ("FALHA [...]") e o script termina com UMA exceção que lista todas.
-- Sem a migration aplicada o script não quebra: os objetos ausentes viram FALHA e os testes que dependem deles
-- são pulados (também listados como FALHA), porque rodam por SQL dinâmico só quando o objeto existe.
--
-- O que confere, por bloco:
--   1. existência:     schema private, papéis anon/authenticated/service_role, marca_aliases (+ sequence),
--                      4 views e as 2 funções private.marca_*.
--   2. acesso efetivo: has_*_privilege para anon e authenticated (nunca 'public': o acesso de PUBLIC é herdado por
--                      todo papel e é conferido direto no ACL, bloco 3): nada na tabela, nas views, na sequence, nas
--                      colunas, nas funções nem USAGE no schema private; service_role com SELECT/INSERT/UPDATE/DELETE
--                      na tabela, SELECT nas views, USAGE na sequence e no schema e EXECUTE nas funções.
--   3. grants diretos: ACL do catálogo (relacl, attacl, proacl, nspacl via aclexplode; ACL NULL = acldefault, que
--                      em função dá EXECUTE a PUBLIC) sem nenhuma entrada para PUBLIC (grantee 0), anon ou
--                      authenticated; information_schema sem grant para esses três.
--   4. RLS:            ligado em marca_aliases; nenhuma policy; views com security_invoker=true.
--   5. semente:        marcas-v1 com mais de 100 linhas (EXISTS ... OFFSET 100, sem count(*)).
--   6. funções:        normalização e resolução de casos conhecidos (CNPJ 11222333000181 é fictício).

do $$
declare
  v_chk    record;
  v_bool   boolean;
  n        int    := 0;
  v_falhas text[] := '{}';
  v_tem_tabela boolean := to_regclass('public.marca_aliases') is not null;
  v_tem_norm   boolean := to_regprocedure('private.marca_normalizar(text)') is not null;
  v_tem_res    boolean := to_regprocedure('private.marca_resolver(text,text)') is not null;
begin
  -- ===================================================================== blocos 1 a 4 (só catálogo)
  -- Nada aqui referencia os objetos da migration pelo nome no SQL: to_regclass/to_regprocedure/to_regnamespace
  -- devolvem NULL quando o objeto não existe, e has_*_privilege(…, NULL, …) devolve NULL ('ausente').
  for v_chk in
    with
    tabelas(obj) as (values ('public.marca_aliases')),
    views(obj) as (values ('public.v_marca_ocorrencias'), ('public.v_fornecedor_marcas_ranking'),
                          ('public.v_fornecedor_marcas'), ('public.v_marca_aliases_pendentes')),
    seqs(obj) as (values ('public.marca_aliases_id_seq')),
    objs(obj) as (select obj from tabelas union all select obj from views),
    rels(obj) as (select obj from objs union all select obj from seqs),
    funcs(obj) as (values ('private.marca_normalizar(text)'), ('private.marca_resolver(text,text)')),
    -- has_*_privilege só com papéis reais; PUBLIC fica para o bloco 3 (ACL)
    fechados(papel) as (values ('anon'), ('authenticated')),
    papeis(papel, existe) as (
      select r.papel, exists (select 1 from pg_roles pr where pr.rolname = r.papel)
        from (values ('anon'), ('authenticated'), ('service_role')) r(papel)),
    -- grantees proibidos no ACL: PUBLIC (oid 0), anon, authenticated
    proibidos(oid, nome) as (
      select 0::oid, 'PUBLIC'
      union all
      select pr.oid, pr.rolname from pg_roles pr where pr.rolname in ('anon', 'authenticated')),
    -- MAINTAIN só existe a partir do PG17 e não aparece no information_schema.
    privs(p) as (select v.p from (values ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE'), ('REFERENCES'),
                                         ('TRIGGER')) v(p)
                 union all
                 select 'MAINTAIN' where current_setting('server_version_num')::int >= 170000),
    checks(grupo, objeto, esperado, atual) as (
      -- ----------------------------------------------------------------- 1. existência
      select '1 objeto', 'schema private', 'existe', case when to_regnamespace('private') is null then 'ausente' else 'existe' end
      union all
      select '1 objeto', 'papel ' || p.papel, 'existe', case when p.existe then 'existe' else 'ausente' end
        from papeis p
      union all
      select '1 objeto', r.obj, 'existe', case when to_regclass(r.obj) is null then 'ausente' else 'existe' end
        from rels r
      union all
      select '1 objeto', fn.obj, 'existe', case when to_regprocedure(fn.obj) is null then 'ausente' else 'existe' end
        from funcs fn
      union all
      -- ----------------------------------------------------------------- 2. acesso efetivo (has_*_privilege)
      -- anon e authenticated: nenhum privilégio de relação
      select '2 efetivo', o.obj || ' ' || r.papel || ' ' || p.p, 'false',
             case when not pa.existe then 'papel ausente'
                  else coalesce(has_table_privilege(r.papel, to_regclass(o.obj), p.p)::text, 'ausente') end
        from objs o cross join privs p cross join fechados r join papeis pa on pa.papel = r.papel
      union all
      -- ... nem de coluna
      select '2 efetivo', o.obj || ' ' || r.papel || ' qualquer coluna ' || p.p, 'false',
             case when not pa.existe then 'papel ausente'
                  else coalesce(has_any_column_privilege(r.papel, to_regclass(o.obj), p.p)::text, 'ausente') end
        from objs o cross join (values ('SELECT'), ('INSERT'), ('UPDATE'), ('REFERENCES')) p(p)
        cross join fechados r join papeis pa on pa.papel = r.papel
      union all
      -- ... nem na sequence
      select '2 efetivo', s.obj || ' ' || r.papel || ' ' || p.p, 'false',
             case when not pa.existe then 'papel ausente'
                  else coalesce(has_sequence_privilege(r.papel, to_regclass(s.obj), p.p)::text, 'ausente') end
        from seqs s cross join (values ('USAGE'), ('SELECT'), ('UPDATE')) p(p)
        cross join fechados r join papeis pa on pa.papel = r.papel
      union all
      -- ... nem EXECUTE nas funções (inclui o que viria de PUBLIC)
      select '2 efetivo', fn.obj || ' ' || r.papel || ' EXECUTE', 'false',
             case when not pa.existe then 'papel ausente'
                  else coalesce(has_function_privilege(r.papel, to_regprocedure(fn.obj), 'EXECUTE')::text, 'ausente') end
        from funcs fn cross join fechados r join papeis pa on pa.papel = r.papel
      union all
      -- ... nem USAGE/CREATE no schema private
      select '2 efetivo', 'schema private ' || r.papel || ' ' || p.p, 'false',
             case when not pa.existe then 'papel ausente'
                  else coalesce(has_schema_privilege(r.papel, to_regnamespace('private'), p.p)::text, 'ausente') end
        from fechados r cross join (values ('USAGE'), ('CREATE')) p(p) join papeis pa on pa.papel = r.papel
      union all
      -- service_role: acesso de que o backend precisa
      select '2 efetivo', t.obj || ' service_role ' || p.p, 'true',
             case when not pa.existe then 'papel ausente'
                  else coalesce(has_table_privilege('service_role', to_regclass(t.obj), p.p)::text, 'ausente') end
        from tabelas t cross join (values ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE')) p(p)
        join papeis pa on pa.papel = 'service_role'
      union all
      select '2 efetivo', v.obj || ' service_role SELECT', 'true',
             case when not pa.existe then 'papel ausente'
                  else coalesce(has_table_privilege('service_role', to_regclass(v.obj), 'SELECT')::text, 'ausente') end
        from views v join papeis pa on pa.papel = 'service_role'
      union all
      select '2 efetivo', s.obj || ' service_role USAGE', 'true',
             case when not pa.existe then 'papel ausente'
                  else coalesce(has_sequence_privilege('service_role', to_regclass(s.obj), 'USAGE')::text, 'ausente') end
        from seqs s join papeis pa on pa.papel = 'service_role'
      union all
      select '2 efetivo', fn.obj || ' service_role EXECUTE', 'true',
             case when not pa.existe then 'papel ausente'
                  else coalesce(has_function_privilege('service_role', to_regprocedure(fn.obj), 'EXECUTE')::text, 'ausente') end
        from funcs fn join papeis pa on pa.papel = 'service_role'
      union all
      select '2 efetivo', 'schema private service_role USAGE', 'true',
             case when not pa.existe then 'papel ausente'
                  else coalesce(has_schema_privilege('service_role', to_regnamespace('private'), 'USAGE')::text, 'ausente') end
        from papeis pa where pa.papel = 'service_role'
      union all
      -- ----------------------------------------------------------------- 3. grants diretos no ACL
      -- relações e sequence (relacl; NULL = acldefault do dono)
      select '3 acl', r.obj || ' relacl', 'nenhum',
             case when c.oid is null then 'objeto ausente'
                  else coalesce((select string_agg(pb.nome || ':' || a.privilege_type, ', ' order by pb.nome, a.privilege_type)
                                   from aclexplode(coalesce(c.relacl, acldefault(case when c.relkind = 'S' then 's'::"char" else 'r'::"char" end,
                                                                                 c.relowner))) a
                                   join proibidos pb on pb.oid = a.grantee), 'nenhum') end
        from rels r left join pg_class c on c.oid = to_regclass(r.obj)
      union all
      -- colunas (attacl)
      select '3 acl', o.obj || ' attacl (colunas)', 'nenhum',
             case when to_regclass(o.obj) is null then 'objeto ausente'
                  else coalesce((select string_agg(pb.nome || ':' || att.attname || ':' || a.privilege_type, ', '
                                                   order by pb.nome, att.attname, a.privilege_type)
                                   from pg_attribute att
                                   cross join lateral aclexplode(att.attacl) a
                                   join proibidos pb on pb.oid = a.grantee
                                  where att.attrelid = to_regclass(o.obj) and att.attacl is not null), 'nenhum') end
        from objs o
      union all
      -- funções (proacl; NULL = acldefault, que dá EXECUTE a PUBLIC)
      select '3 acl', fn.obj || ' proacl', 'nenhum',
             case when p.oid is null then 'objeto ausente'
                  else coalesce((select string_agg(pb.nome || ':' || a.privilege_type, ', ' order by pb.nome, a.privilege_type)
                                   from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                                   join proibidos pb on pb.oid = a.grantee), 'nenhum') end
        from funcs fn left join pg_proc p on p.oid = to_regprocedure(fn.obj)
      union all
      -- schema private (nspacl)
      select '3 acl', 'schema private nspacl', 'nenhum',
             case when ns.oid is null then 'objeto ausente'
                  else coalesce((select string_agg(pb.nome || ':' || a.privilege_type, ', ' order by pb.nome, a.privilege_type)
                                   from aclexplode(coalesce(ns.nspacl, acldefault('n', ns.nspowner))) a
                                   join proibidos pb on pb.oid = a.grantee), 'nenhum') end
        from (select to_regnamespace('private')::oid as oid) x left join pg_namespace ns on ns.oid = x.oid
      union all
      select '3 acl', 'information_schema anon/authenticated/PUBLIC (tabela + coluna)', '0',
             ((select count(*) from information_schema.role_table_grants g
                where g.table_schema = 'public'
                  and g.table_name in ('marca_aliases', 'v_marca_ocorrencias', 'v_fornecedor_marcas_ranking',
                                       'v_fornecedor_marcas', 'v_marca_aliases_pendentes')
                  and g.grantee in ('anon', 'authenticated', 'PUBLIC'))
              + (select count(*) from information_schema.column_privileges g
                where g.table_schema = 'public'
                  and g.table_name in ('marca_aliases', 'v_marca_ocorrencias', 'v_fornecedor_marcas_ranking',
                                       'v_fornecedor_marcas', 'v_marca_aliases_pendentes')
                  and g.grantee in ('anon', 'authenticated', 'PUBLIC')))::text
      union all
      -- ----------------------------------------------------------------- 4. RLS, policy, security_invoker
      select '4 rls', t.obj, 'true',
             coalesce((select c.relrowsecurity::text from pg_class c where c.oid = to_regclass(t.obj)), 'ausente')
        from tabelas t
      union all
      select '4 rls', t.obj || ' policies', '0',
             case when to_regclass(t.obj) is null then 'ausente'
                  else (select count(*)::text from pg_policy pp where pp.polrelid = to_regclass(t.obj)) end
        from tabelas t
      union all
      select '4 rls', v.obj || ' security_invoker', 'true',
             coalesce((select (coalesce(c.reloptions, '{}') @> array['security_invoker=true'])::text
                         from pg_class c where c.oid = to_regclass(v.obj)), 'ausente')
        from views v
    )
    select * from checks order by grupo, objeto
  loop
    n := n + 1;
    if v_chk.atual is distinct from v_chk.esperado then
      v_falhas := v_falhas || format('[%s] %s: esperado "%s", atual "%s"', v_chk.grupo, v_chk.objeto, v_chk.esperado, v_chk.atual);
    end if;
  end loop;

  -- ===================================================================== 5. semente (SQL dinâmico)
  n := n + 1;
  if v_tem_tabela then
    execute $q$select exists (select 1 from public.marca_aliases a where a.seed_versao = 'marcas-v1' offset 100)$q$ into v_bool;
    if v_bool is distinct from true then
      v_falhas := v_falhas || format('[5 semente] public.marca_aliases marcas-v1 > 100 linhas: esperado "true", atual "%s"', v_bool);
    end if;
  else
    v_falhas := v_falhas || '[5 semente] pulado: public.marca_aliases ausente'::text;
  end if;

  -- ===================================================================== 6. funções (SQL dinâmico)
  if v_tem_norm then
    for v_chk in execute $q$
      select '6 normalizar' as grupo, t.entrada_txt as objeto, t.esperado, coalesce(private.marca_normalizar(t.entrada), 'NULL') as atual
        from (values (''' Flex  Equipment Ltda ''', ' Flex  Equipment Ltda ', 'FLEX EQUIPMENT'),
                     ('''Fundiban Fundiban''', 'Fundiban Fundiban', 'FUNDIBAN'),
                     ('''Açúcar & Cia.''', 'Açúcar & Cia.', 'ACUCAR & CIA'),
                     (''' - ''', ' - ', 'NULL')) as t(entrada_txt, entrada, esperado)
    $q$
    loop
      n := n + 1;
      if v_chk.atual is distinct from v_chk.esperado then
        v_falhas := v_falhas || format('[%s] %s: esperado "%s", atual "%s"', v_chk.grupo, v_chk.objeto, v_chk.esperado, v_chk.atual);
      end if;
    end loop;
  else
    n := n + 1;
    v_falhas := v_falhas || '[6 normalizar] pulado: private.marca_normalizar(text) ausente'::text;
  end if;

  if v_tem_res and v_tem_tabela then
    for v_chk in execute $q$
      with casos(entrada, cnpj, esperado) as (values
        ('CLASSIC', '11222333000181', 'FLEX EQUIPMENT'),
        ('CLASSIC PLUS', '11222333000181', 'FLEX EQUIPMENT'),
        ('XI', '11222333000181', 'FLEX EQUIPMENT'),
        ('Flex Equipment', '11222333000181', 'FLEX EQUIPMENT'),
        ('EVO 3850 AC', '11222333000181', 'EVOLUTION'),
        ('NEW EDGE SHP +', '11222333000181', 'MOVEMENT'),
        ('R55V5', '11222333000181', 'SPEEDO'),
        ('INK', '11222333000181', 'INK FITNESS'),
        ('VAXX DELVA', '11222333000181', 'VAXX'),
        ('ANILHAS MINAS', '11222333000181', 'ANILHAS MINAS'),
        ('AGON', '11222333000181', 'AGON'),
        ('FUNDIBAN FUNDIBAN', '11222333000181', 'FUNDIBAN'),
        ('ANILHA EMBORRACHADA', '11222333000181', null),
        ('1130PC', '11222333000181', null),
        ('SIMILAR', '11222333000181', null),
        ('0', '11222333000181', null),
        ('-', '11222333000181', null),
        ('2 KG', '11222333000181', null),
        ('', '11222333000181', null),
        (null, '11222333000181', null),
        ('PRÓPRIA', '11222333000181', null),
        ('Marca Própria', '11222333000181', null),
        ('MARCA PROPIA', '11222333000181', null),
        ('ESTANTE ANILHAS', '11222333000181', null),
        ('ESQUI TRIPLO', '11222333000181', null),
        ('PRÓPRIA', '08973569000145', 'FLEX EQUIPMENT'),
        ('P ROPIO', '50937669000182', 'SIGMETAL'))
      select '6 resolver' as grupo, coalesce(c.entrada, '<null>') || ' / ' || c.cnpj as objeto,
             coalesce(c.esperado, 'NULL') as esperado,
             coalesce((select r.marca from private.marca_resolver(c.entrada, c.cnpj) r), 'NULL') as atual
        from casos c
      union all
      select '6 resolver', 'AGON metodo/curada', 'bruta/false',
             (select r.metodo || '/' || r.curada::text from private.marca_resolver('AGON', '11222333000181') r)
      union all
      select '6 resolver', 'CLASSIC metodo/curada', 'alias_prefixo/true',
             (select r.metodo || '/' || r.curada::text from private.marca_resolver('CLASSIC', '11222333000181') r)
      union all
      select '6 resolver', 'PRÓPRIA 08973569000145 metodo', 'alias_regex',
             (select r.metodo from private.marca_resolver('PRÓPRIA', '08973569000145') r)
    $q$
    loop
      n := n + 1;
      if v_chk.atual is distinct from v_chk.esperado then
        v_falhas := v_falhas || format('[%s] %s: esperado "%s", atual "%s"', v_chk.grupo, v_chk.objeto, v_chk.esperado, v_chk.atual);
      end if;
    end loop;
  else
    n := n + 1;
    v_falhas := v_falhas || '[6 resolver] pulado: private.marca_resolver(text,text) ou public.marca_aliases ausente'::text;
  end if;

  -- ===================================================================== resultado: uma exceção com a lista
  if coalesce(array_length(v_falhas, 1), 0) > 0 then
    for i in 1 .. array_length(v_falhas, 1) loop
      raise notice 'FALHA %', v_falhas[i];
    end loop;
    raise exception 'ACL CHECK FALHOU: marcas_resolvedor_acl_check: % falha(s) em % checagens:%',
      array_length(v_falhas, 1), n, E'\n  - ' || array_to_string(v_falhas, E'\n  - ');
  end if;
  raise notice 'SUCESSO: marcas_resolvedor_acl_check: % checagens, 0 falhas', n;
end $$;
