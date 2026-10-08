-- Checagem da migration 20261008030000_tenant_documentos.
-- Validade calculada, alerta de calendário, falência não sanável, anon sem leitura.

do $$
declare
  v_chk record;
  n int := 0;
  f int := 0;
  v_val date;
  v_calc boolean;
begin
  select (public.tenant_documento_validade('2026-01-01'::date, null, 90)->>'validade')::date,
         (public.tenant_documento_validade('2026-01-01'::date, null, 90)->>'calculada')::boolean
    into v_val, v_calc;
  if v_val is distinct from date '2026-04-01' or v_calc is distinct from true then
    raise exception 'CHECK FALHOU: validade calculada esperada 2026-04-01 calculada, veio % %', v_val, v_calc;
  end if;
  if (public.tenant_documento_validade('2026-01-01'::date, '2026-06-01'::date, 90)->>'calculada')::boolean then
    raise exception 'CHECK FALHOU: validade informada foi marcada como calculada';
  end if;
  if public.tenant_documento_alerta('2026-10-01'::date, '2026-10-07'::date) is distinct from 'vencido' then
    raise exception 'CHECK FALHOU: documento vencido não alertou';
  end if;
  if public.tenant_documento_alerta('2026-10-10'::date, '2026-10-07'::date) is distinct from 'd7' then
    raise exception 'CHECK FALHOU: janela de 7 dias';
  end if;
  if public.tenant_documento_alerta('2026-10-20'::date, '2026-10-07'::date) is distinct from 'd15' then
    raise exception 'CHECK FALHOU: janela de 15 dias';
  end if;
  if public.tenant_documento_alerta('2026-11-01'::date, '2026-10-07'::date) is distinct from 'd30' then
    raise exception 'CHECK FALHOU: janela de 30 dias';
  end if;
  if public.tenant_documento_alerta('2027-01-01'::date, '2026-10-07'::date) is distinct from 'ok' then
    raise exception 'CHECK FALHOU: documento longe do vencimento';
  end if;
  if public.tenant_documento_alerta(null, '2026-10-07'::date) is distinct from 'sem_data' then
    raise exception 'CHECK FALHOU: sem data não ficou sem_data';
  end if;
  if exists (select 1 from public.documento_tipos where codigo = 'certidao_falencia' and sanavel) then
    raise exception 'CHECK FALHOU: certidão de falência nasceu sanável';
  end if;
  if exists (select 1 from public.documento_tipos where codigo = 'certidao_federal' and not sanavel) then
    raise exception 'CHECK FALHOU: certidão federal nasceu não sanável';
  end if;

  for v_chk in
    with
    privs(p) as (
      select v.p from (values ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE'), ('REFERENCES'), ('TRIGGER')) v(p)
      union all
      select 'MAINTAIN' where current_setting('server_version_num')::int >= 170000
    ),
    checks(grupo, objeto, esperado, atual) as (
      select 'bucket', 'tenant-documentos', 'false',
             coalesce((select public::text from storage.buckets where id = 'tenant-documentos'), 'ausente')
      union all
      select 'rls', t.rel, 'true',
             coalesce((select c.relrowsecurity::text from pg_class c where c.oid = to_regclass(t.rel)), 'ausente')
        from (values ('public.documento_tipos'), ('public.tenant_documentos')) t(rel)
      union all
      select 'grant', 'anon ' || t.rel || ' SELECT', 'false',
             coalesce(has_table_privilege('anon', to_regclass(t.rel), 'SELECT')::text, 'ausente')
        from (values ('public.documento_tipos'), ('public.tenant_documentos')) t(rel)
      union all
      select 'grant', 'authenticated documento_tipos ' || p.p, 'false',
             coalesce(has_table_privilege('authenticated', 'public.documento_tipos'::regclass, p.p)::text, 'ausente')
        from privs p
       where p.p <> 'SELECT'
      union all
      select 'sanavel', 'falencia', 'false',
             coalesce((select sanavel::text from public.documento_tipos where codigo = 'certidao_falencia'), 'ausente')
    )
    select * from checks
  loop
    n := n + 1;
    if v_chk.atual is distinct from v_chk.esperado then
      f := f + 1;
      raise notice 'FALHA % % esperado=% atual=%', v_chk.grupo, v_chk.objeto, v_chk.esperado, v_chk.atual;
    end if;
  end loop;
  if f > 0 then
    raise exception 'ACL CHECK FALHOU: tenant_documentos % checagens, % falhas', n, f;
  end if;
  raise notice 'SUCESSO: tenant_documentos % checagens, 0 falhas', n;
end
$$;
