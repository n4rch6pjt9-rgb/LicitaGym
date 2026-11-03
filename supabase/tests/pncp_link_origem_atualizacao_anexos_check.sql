-- Verificação (SOMENTE LEITURA) do estado esperado após a migration 20261002230000_pncp_link_origem_atualizacao_anexos.
-- Só SELECT em catálogo e nas próprias tabelas. Uso:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/pncp_link_origem_atualizacao_anexos_check.sql
-- Resultado esperado: NOTICE "pncp_link_origem_atualizacao_anexos_check: N checagens, 0 falhas"; falha -> EXCEPTION.

do $$
declare
  v record;
  n int := 0;
  f int := 0;
begin
  for v in
    with col as (
      select c.table_name, c.column_name, c.data_type, c.is_nullable, c.column_default
        from information_schema.columns c
       where c.table_schema = 'public'
         and (c.table_name, c.column_name) in (
           ('licitacoes_externas', 'link_sistema_origem'),
           ('licitacoes_externas', 'pncp_data_atualizacao'),
           ('licitacoes_externas', 'pncp_data_atualizacao_global'))),
    checks(objeto, esperado, atual) as (
      select 'licitacoes_externas.link_sistema_origem tipo', 'text',
             coalesce((select data_type from col where column_name = 'link_sistema_origem'), 'ausente')
      union all
      select 'licitacoes_externas.pncp_data_atualizacao tipo', 'timestamp with time zone',
             coalesce((select data_type from col where column_name = 'pncp_data_atualizacao'), 'ausente')
      union all
      select 'licitacoes_externas.pncp_data_atualizacao_global tipo', 'timestamp with time zone',
             coalesce((select data_type from col where column_name = 'pncp_data_atualizacao_global'), 'ausente')
      union all
      select 'licitacoes_externas pncp com link no raw e coluna NULL', '0',
             (select count(*)::text from public.licitacoes_externas
               where fonte = 'pncp' and link_sistema_origem is null
                 and btrim(raw->>'link_sistema_origem') ~* '^https?://[^/\s]+')
      union all
      select 'licitacoes_externas com link_sistema_origem fora de http(s)', '0',
             (select count(*)::text from public.licitacoes_externas
               where link_sistema_origem is not null and link_sistema_origem !~* '^https?://')
    )
    select * from checks
  loop
    n := n + 1;
    if v.atual is distinct from v.esperado then
      f := f + 1;
      raise notice 'FALHA %: esperado %, atual %', v.objeto, v.esperado, v.atual;
    end if;
  end loop;
  raise notice 'pncp_link_origem_atualizacao_anexos_check: % checagens, % falhas', n, f;
  if f > 0 then
    raise exception 'pncp_link_origem_atualizacao_anexos_check: % falha(s)', f;
  end if;
end
$$;
