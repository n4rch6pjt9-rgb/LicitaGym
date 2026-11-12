-- Checagem de portal_visitante com visitante por CPF (migration 20261112220000_portal_visitante_cpf_hash.sql).
-- 1. colunas tipo_documento e documento_hash existem; cnpj aceita nulo
-- 2. CPF guarda só o hash (64 hex) e nunca o cnpj; CNPJ guarda o cnpj e nunca o hash
-- 3. ACL: nenhum privilégio para anon nem authenticated (só service_role)
do $$
declare
  v_ok boolean;
  v_priv text;
begin
  if not exists (select 1 from information_schema.columns where table_schema = 'public'
                 and table_name = 'portal_visitante' and column_name = 'documento_hash') then
    raise exception 'CHECK FALHOU: portal_visitante.documento_hash não existe';
  end if;
  if not exists (select 1 from information_schema.columns where table_schema = 'public'
                 and table_name = 'portal_visitante' and column_name = 'tipo_documento') then
    raise exception 'CHECK FALHOU: portal_visitante.tipo_documento não existe';
  end if;

  -- CPF com hash válido entra (e sai: o check não deixa dado)
  insert into public.portal_visitante (fonte, n_cd_visitante, tipo_documento, cnpj, documento_hash)
  values ('__check_cpf', 1, 'CPF', null, repeat('a', 64));
  delete from public.portal_visitante where fonte = '__check_cpf';

  -- CPF não pode levar o documento em claro na coluna cnpj
  v_ok := false;
  begin
    insert into public.portal_visitante (fonte, n_cd_visitante, tipo_documento, cnpj, documento_hash)
    values ('__check_cpf', 1, 'CPF', '52998224725000', repeat('a', 64));
  exception when check_violation then v_ok := true;
  end;
  if not v_ok then raise exception 'CHECK FALHOU: linha CPF aceitou cnpj preenchido'; end if;

  -- CPF sem hash no formato (ex.: o próprio CPF) é recusado
  v_ok := false;
  begin
    insert into public.portal_visitante (fonte, n_cd_visitante, tipo_documento, cnpj, documento_hash)
    values ('__check_cpf', 1, 'CPF', null, '52998224725');
  exception when check_violation then v_ok := true;
  end;
  if not v_ok then raise exception 'CHECK FALHOU: linha CPF aceitou documento_hash fora do formato'; end if;

  -- CNPJ continua como antes e não leva hash
  v_ok := false;
  begin
    insert into public.portal_visitante (fonte, n_cd_visitante, tipo_documento, cnpj, documento_hash)
    values ('__check_cnpj', 1, 'CNPJ', '11222333000181', repeat('a', 64));
  exception when check_violation then v_ok := true;
  end;
  if not v_ok then raise exception 'CHECK FALHOU: linha CNPJ aceitou documento_hash'; end if;

  v_ok := false;
  begin
    insert into public.portal_visitante (fonte, n_cd_visitante, tipo_documento, cnpj)
    values ('__check_cnpj', 1, 'CNPJ', null);
  exception when check_violation then v_ok := true;
  end;
  if not v_ok then raise exception 'CHECK FALHOU: linha CNPJ aceitou cnpj nulo'; end if;

  foreach v_priv in array array['SELECT', 'INSERT', 'UPDATE', 'DELETE'] loop
    if has_table_privilege('anon', 'public.portal_visitante', v_priv)
       or has_table_privilege('authenticated', 'public.portal_visitante', v_priv) then
      raise exception 'ACL CHECK FALHOU: portal_visitante com % para anon/authenticated', v_priv;
    end if;
  end loop;

  if not has_table_privilege('service_role', 'public.portal_visitante', 'INSERT')
     or not has_table_privilege('service_role', 'public.portal_visitante', 'UPDATE') then
    raise exception 'ACL CHECK FALHOU: service_role sem INSERT/UPDATE em portal_visitante (o coletor grava aqui)';
  end if;

  raise notice 'SUCESSO: portal_visitante guarda CPF só como hash e segue restrita a service_role';
end $$;
