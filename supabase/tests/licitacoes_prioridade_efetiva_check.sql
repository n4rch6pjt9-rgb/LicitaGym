-- Verificação (SOMENTE LEITURA) do estado esperado após a migration 20260930200000_licitacoes_prioridade_efetiva.
-- Só SELECT em catálogo, funções has_*_privilege e na própria view (nenhuma escrita, nenhuma tabela temporária).
-- Executar após aplicar a migration, ex.:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/licitacoes_prioridade_efetiva_check.sql
-- Resultado esperado: NOTICE "licitacoes_prioridade_efetiva_check: N checagens, 0 falhas" e exit code 0.
-- Qualquer falha é listada em NOTICE ("FALHA ...") e o script termina com RAISE EXCEPTION.
--
-- O que confere:
--   view:     existe e tem security_invoker=true.
--   grants:   anon/PUBLIC/authenticated sem nenhum privilégio na view (relação e coluna);
--             service_role só SELECT; EXECUTE da função private.pncp_instante_brt só para service_role.
--   regra:    a view nunca promove (nenhuma linha efetiva `leads` com gravada diferente de `leads`);
--             nenhuma linha efetiva `leads` com data_homologacao ou resultado; toda linha com data_homologacao
--             ou resultado sai `historico`; mesma quantidade de linhas que licitacoes_externas.

do $$
declare
  v_chk record;
  n     int := 0;
  f     int := 0;
begin
  for v_chk in
    with
    v(obj) as (values ('public.licitacoes_externas_prioridade_efetiva')),
    privs(p) as (select x.p from (values ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE'), ('REFERENCES'),
                                         ('TRIGGER')) x(p)
                 union all
                 select 'MAINTAIN' where current_setting('server_version_num')::int >= 170000),
    checks(grupo, objeto, esperado, atual) as (
      select 'view', v.obj, 'existe', case when to_regclass(v.obj) is null then 'ausente' else 'existe' end
        from v
      union all
      select 'security_invoker', v.obj, 'true',
             coalesce((select (coalesce(c.reloptions, '{}') @> array['security_invoker=true'])::text
                         from pg_class c where c.oid = to_regclass(v.obj)), 'ausente')
        from v
      union all
      select 'grant', v.obj || ' ' || r.papel || ' ' || p.p, 'false',
             coalesce(has_table_privilege(r.papel, to_regclass(v.obj), p.p)::text, 'ausente')
        from v cross join privs p cross join (values ('anon'), ('public'), ('authenticated')) r(papel)
      union all
      select 'grant', v.obj || ' ' || r.papel || ' qualquer coluna ' || p.p, 'false',
             coalesce(has_any_column_privilege(r.papel, to_regclass(v.obj), p.p)::text, 'ausente')
        from v cross join (values ('SELECT'), ('INSERT'), ('UPDATE'), ('REFERENCES')) p(p)
        cross join (values ('anon'), ('public'), ('authenticated')) r(papel)
      union all
      select 'grant', v.obj || ' service_role ' || p.p, (p.p = 'SELECT')::text,
             coalesce(has_table_privilege('service_role', to_regclass(v.obj), p.p)::text, 'ausente')
        from v cross join privs p
      union all
      select 'grant', 'information_schema.role_table_grants view anon/PUBLIC/authenticated', '0',
             (select count(*)::text from information_schema.role_table_grants g
               where g.table_schema = 'public' and g.table_name = 'licitacoes_externas_prioridade_efetiva'
                 and g.grantee in ('anon', 'PUBLIC', 'authenticated'))
      union all
      select 'função', 'private.pncp_instante_brt(text) ' || r.papel || ' EXECUTE', (r.papel = 'service_role')::text,
             coalesce(has_function_privilege(r.papel, to_regprocedure('private.pncp_instante_brt(text)'), 'EXECUTE')::text,
                      'ausente')
        from (values ('anon'), ('public'), ('authenticated'), ('service_role')) r(papel)
      union all
      select 'regra', 'linhas da view = linhas da tabela', 'true',
             ((select count(*) from public.licitacoes_externas_prioridade_efetiva)
               = (select count(*) from public.licitacoes_externas))::text
      union all
      select 'regra', 'nunca promove a leads', '0',
             (select count(*)::text from public.licitacoes_externas_prioridade_efetiva
               where prioridade = 'leads' and prioridade_gravada is distinct from 'leads')
      union all
      select 'regra', 'só leads/monitorar/historico/NULL', '0',
             (select count(*)::text from public.licitacoes_externas_prioridade_efetiva
               where prioridade is not null and prioridade not in ('leads', 'monitorar', 'historico'))
      union all
      select 'regra', 'homologada ou com resultado sai historico', '0',
             (select count(*)::text from public.licitacoes_externas_prioridade_efetiva p
               where p.prioridade is distinct from 'historico'
                 and (p.data_homologacao is not null
                      or exists (select 1 from public.licitacao_resultados r where r.licitacao_id = p.id)))
      union all
      select 'regra', 'leads efetivo com prazo vencido', '0',
             (select count(*)::text from public.licitacoes_externas_prioridade_efetiva p
                join public.licitacoes_externas l on l.id = p.id
               where p.prioridade = 'leads'
                 and coalesce(private.pncp_instante_brt(l.raw ->> 'data_fim_vigencia'), l.data_fim) <= now())
      union all
      select 'regra', 'prazo sem fuso = BRT', '2026-09-11 18:30:00+00',
             to_char(private.pncp_instante_brt('2026-09-11T15:30') at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS') || '+00'
      union all
      select 'regra', 'prazo inválido = NULL', 'null',
             coalesce(private.pncp_instante_brt('2026-02-30T10:00')::text, 'null')
    )
    select * from checks order by grupo, objeto
  loop
    n := n + 1;
    if v_chk.atual is distinct from v_chk.esperado then
      f := f + 1;
      raise notice 'FALHA [%] %: esperado "%", atual "%"', v_chk.grupo, v_chk.objeto, v_chk.esperado, v_chk.atual;
    end if;
  end loop;

  raise notice 'licitacoes_prioridade_efetiva_check: % checagens, % falhas', n, f;
  if f > 0 then
    raise exception 'licitacoes_prioridade_efetiva_check FALHOU: % de % checagens', f, n;
  end if;
end $$;
