-- Verificação (SOMENTE LEITURA) do estado esperado após a migration 20261001110000_licitacao_itens_ms_normalizar.
-- Só SELECT em catálogo e na própria tabela (nenhuma escrita, nenhuma tabela temporária).
-- Executar após aplicar a migration, ex.:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/licitacao_itens_ms_check.sql
-- Resultado esperado: NOTICE "licitacao_itens_ms_check: N checagens, 0 falhas" e exit code 0.
-- Qualquer falha é listada em NOTICE ("FALHA ...") e o script termina com RAISE EXCEPTION.
--
-- O que confere:
--   constraint: licitem_ms_chk existe em public.licitacao_itens, está validada e só aceita NULL/'M'/'S'.
--   dados:      nenhuma linha com material_ou_servico fora de NULL/'M'/'S'.

do $$
declare
  v_chk record;
  n     int := 0;
  f     int := 0;
begin
  for v_chk in
    with
    c as (select oid, convalidated, pg_get_constraintdef(oid) as def
            from pg_constraint
           where conname = 'licitem_ms_chk' and conrelid = to_regclass('public.licitacao_itens')),
    checks(grupo, objeto, esperado, atual) as (
      select 'constraint', 'licitem_ms_chk', 'existe', case when exists (select 1 from c) then 'existe' else 'ausente' end
      union all
      select 'constraint', 'licitem_ms_chk validada', 'true', coalesce((select convalidated::text from c), 'ausente')
      union all
      select 'constraint', 'licitem_ms_chk domínio M/S', 'true',
             coalesce((select (def ilike '%material_ou_servico IS NULL%' and def like '%''M''%' and def like '%''S''%'
                               and def not ilike '%NOT VALID%')::text from c), 'ausente')
      union all
      select 'dados', 'licitacao_itens com material_ou_servico fora de NULL/M/S', '0',
             (select count(*)::text from public.licitacao_itens
               where material_ou_servico is not null and material_ou_servico not in ('M', 'S'))
    )
    select * from checks order by grupo, objeto
  loop
    n := n + 1;
    if v_chk.atual is distinct from v_chk.esperado then
      f := f + 1;
      raise notice 'FALHA [%] %: esperado "%", atual "%"', v_chk.grupo, v_chk.objeto, v_chk.esperado, v_chk.atual;
    end if;
  end loop;

  raise notice 'licitacao_itens_ms_check: % checagens, % falhas', n, f;
  if f > 0 then
    raise exception 'licitacao_itens_ms_check FALHOU: % de % checagens', f, n;
  end if;
end $$;
