-- Verificação (SOMENTE LEITURA) do estado esperado após a migration 20261003010000_licitacoes_pncp_canonica.
-- Só SELECT em catálogo, funções has_*_privilege e nas views (nenhuma escrita, nenhuma tabela temporária),
-- então pode rodar em produção. Executar após aplicar a migration, ex.:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/licitacoes_pncp_canonica_check.sql
-- Resultado esperado: NOTICE "licitacoes_pncp_canonica_check: N checagens, 0 falhas" e exit code 0.
-- Qualquer falha é listada em NOTICE ("FALHA ...") e o script termina com RAISE EXCEPTION.
-- Casos sintéticos da regra de desempate: supabase/tests/licitacoes_pncp_canonica_fixtures_check.sql.
--
-- O que confere:
--   view:     licitacoes_pncp_canonica existe e tem security_invoker=true; prioridade_efetiva também.
--   grants:   anon/PUBLIC/authenticated sem nenhum privilégio na view nova (relação e coluna); service_role só SELECT.
--   regra:    uma linha por linha de licitacoes_externas; exatamente uma canônica por grupo; canonica_id aponta
--             para uma canônica do mesmo grupo (fonte/órgão/processo/edital); linha não PNCP ou com chave NULL é
--             sempre canônica de si mesma; n_publicacoes = tamanho do grupo.
--   leitura:  licitacoes_externas_prioridade_efetiva expõe o mesmo canonica_id/eh_canonica; nenhuma linha
--             não canônica em v_bi_resultados_itens e oportunidades_borracha.

do $$
declare
  v_chk record;
  n     int := 0;
  f     int := 0;
begin
  for v_chk in
    with
    v(obj) as (values ('public.licitacoes_pncp_canonica')),
    privs(p) as (select x.p from (values ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE'), ('REFERENCES'),
                                         ('TRIGGER')) x(p)
                 union all
                 select 'MAINTAIN' where current_setting('server_version_num')::int >= 170000),
    lc as (
      select c.id, c.canonica_id, c.eh_canonica, c.n_publicacoes,
             l.fonte, l.orgao_cnpj, l.processo_norm, l.numero_edital
        from public.licitacoes_pncp_canonica c
        join public.licitacoes_externas l on l.id = c.id
    ),
    checks(grupo, objeto, esperado, atual) as (
      select 'view', v.obj, 'existe', case when to_regclass(v.obj) is null then 'ausente' else 'existe' end
        from v
      union all
      select 'security_invoker', x.obj, 'true',
             coalesce((select (coalesce(c.reloptions, '{}') @> array['security_invoker=true'])::text
                         from pg_class c where c.oid = to_regclass(x.obj)), 'ausente')
        from (values ('public.licitacoes_pncp_canonica'), ('public.licitacoes_externas_prioridade_efetiva')) x(obj)
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
      select 'regra', 'linhas da view = linhas da tabela (sem repetir id)', 'true',
             ((select count(*) from public.licitacoes_pncp_canonica)
               = (select count(*) from public.licitacoes_externas)
              and (select count(distinct id) from public.licitacoes_pncp_canonica)
               = (select count(*) from public.licitacoes_externas))::text
      union all
      select 'regra', 'colunas NOT NULL (canonica_id, eh_canonica, n_publicacoes)', '0',
             (select count(*)::text from lc
               where canonica_id is null or eh_canonica is null or n_publicacoes is null)
      union all
      select 'regra', 'eh_canonica = (canonica_id = id)', '0',
             (select count(*)::text from lc where eh_canonica is distinct from (canonica_id = id))
      union all
      select 'regra', 'não PNCP ou chave NULL é canônica de si mesma com n_publicacoes 1', '0',
             (select count(*)::text from lc
               where (fonte is distinct from 'pncp' or orgao_cnpj is null or processo_norm is null
                      or numero_edital is null)
                 and (canonica_id <> id or not eh_canonica or n_publicacoes <> 1))
      union all
      select 'regra', 'canonica_id aponta para canônica do mesmo grupo', '0',
             (select count(*)::text from lc a
                left join lc c on c.id = a.canonica_id
               where c.id is null or not c.eh_canonica
                  or c.fonte is distinct from a.fonte
                  or c.orgao_cnpj is distinct from a.orgao_cnpj
                  or c.processo_norm is distinct from a.processo_norm
                  or c.numero_edital is distinct from a.numero_edital)
      union all
      select 'regra', 'exatamente uma canônica por grupo PNCP; n_publicacoes = tamanho do grupo', '0',
             (select count(*)::text from (
                select 1 from lc
                 where fonte = 'pncp' and orgao_cnpj is not null and processo_norm is not null
                   and numero_edital is not null
                 group by orgao_cnpj, processo_norm, numero_edital
                having count(*) filter (where eh_canonica) <> 1
                    or min(n_publicacoes) <> count(*) or max(n_publicacoes) <> count(*)) g)
      union all
      select 'leitura', 'prioridade_efetiva: mesmo canonica_id/eh_canonica', '0',
             (select count(*)::text from public.licitacoes_externas_prioridade_efetiva p
                join public.licitacoes_pncp_canonica c on c.id = p.id
               where p.canonica_id is distinct from c.canonica_id or p.eh_canonica is distinct from c.eh_canonica)
      union all
      select 'leitura', 'v_bi_resultados_itens sem não canônica', '0',
             (select count(*)::text from public.v_bi_resultados_itens b
                join public.licitacoes_pncp_canonica c on c.id = b.licitacao_id
               where not c.eh_canonica)
      union all
      select 'leitura', 'oportunidades_borracha sem não canônica', '0',
             (select count(*)::text from public.oportunidades_borracha o
                join public.licitacoes_pncp_canonica c on c.id = o.licitacao_id
               where not c.eh_canonica)
    )
    select * from checks order by grupo, objeto
  loop
    n := n + 1;
    if v_chk.atual is distinct from v_chk.esperado then
      f := f + 1;
      raise notice 'FALHA [%] %: esperado "%", atual "%"', v_chk.grupo, v_chk.objeto, v_chk.esperado, v_chk.atual;
    end if;
  end loop;

  raise notice 'licitacoes_pncp_canonica_check: % checagens, % falhas', n, f;
  if f > 0 then
    raise exception 'licitacoes_pncp_canonica_check FALHOU: % de % checagens', f, n;
  end if;
end $$;
