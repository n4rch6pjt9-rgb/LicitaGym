-- Checagem da migration 20261107180000_nexor_feriados_regimes (Nexor Fase 0; spec 0041 K-1, CA-1).
--   RLS ligada; anon e authenticated sem nenhum privilégio; service_role só lê; 18 feriados (9 por ano, 2026 e 2027) com
--   lei; 12/10/2026, 25/12/2026 e 01/01/2027 presentes; 5 regimes.

do $$
declare
  r  text;
  t  text;
  n  integer;
begin
  foreach t in array array['feriados_nacionais', 'regimes'] loop
    if not (select relrowsecurity from pg_class where oid = ('public.' || t)::regclass) then
      raise exception 'CHECK FALHOU: RLS desligada em public.%', t;
    end if;
    if exists (select 1 from pg_policies where schemaname = 'public' and tablename = t) then
      raise exception 'CHECK FALHOU: public.% tem policy (esperado: nenhuma, leitura só via service_role)', t;
    end if;
    foreach r in array array['anon', 'authenticated', 'public'] loop
      if has_table_privilege(r, 'public.' || t, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER') then
        raise exception 'CHECK FALHOU: % tem privilégio em public.%', r, t;
      end if;
    end loop;
    if not has_table_privilege('service_role', 'public.' || t, 'SELECT') then
      raise exception 'CHECK FALHOU: service_role não lê public.%', t;
    end if;
    if has_table_privilege('service_role', 'public.' || t, 'INSERT') or has_table_privilege('service_role', 'public.' || t, 'UPDATE')
       or has_table_privilege('service_role', 'public.' || t, 'DELETE') or has_table_privilege('service_role', 'public.' || t, 'TRUNCATE') then
      raise exception 'CHECK FALHOU: service_role escreve em public.% (escrita só por migration)', t;
    end if;
  end loop;

  select count(*) into n from public.feriados_nacionais where data between '2026-01-01' and '2027-12-31';
  if n <> 18 then raise exception 'CHECK FALHOU: esperados 18 feriados em 2026-2027, achei %', n; end if;

  select count(*) into n from public.feriados_nacionais where extract(year from data) = 2026;
  if n <> 9 then raise exception 'CHECK FALHOU: esperados 9 feriados em 2026, achei %', n; end if;

  select count(*) into n from public.feriados_nacionais where extract(year from data) = 2027;
  if n <> 9 then raise exception 'CHECK FALHOU: esperados 9 feriados em 2027, achei %', n; end if;

  if exists (select 1 from public.feriados_nacionais where fundamento !~ '^Lei ') then
    raise exception 'CHECK FALHOU: feriado sem lei no fundamento';
  end if;

  select count(*) into n from public.feriados_nacionais where data in ('2026-10-12', '2026-12-25', '2027-01-01');
  if n <> 3 then raise exception 'CHECK FALHOU: faltam feriados usados nos testes de prazo (achei % de 3)', n; end if;

  select count(*) into n from public.regimes;
  if n <> 5 then raise exception 'CHECK FALHOU: esperados 5 regimes, achei %', n; end if;

  raise notice 'SUCESSO: feriados_nacionais e regimes (RLS, ACL, 18 feriados, 5 regimes)';
end $$;
