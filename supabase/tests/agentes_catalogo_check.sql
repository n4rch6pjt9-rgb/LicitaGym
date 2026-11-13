-- Checagem da migration 20261021130000_agentes_catalogo (spec 0035, K-10, CA-20 e R-17).
--   ACL (RLS ligada, só service_role lê, ninguém do cliente escreve); semente edital e jurídico ativos, preço inativo;
--   código fora do padrão é recusado. Tudo o que grava é desfeito ao final (exceção proposital).

do $$
declare
  r    text;
  v_ok boolean;
begin
  if not (select relrowsecurity from pg_class where oid = 'public.agentes_catalogo'::regclass) then
    raise exception 'CHECK FALHOU: agentes_catalogo sem RLS';
  end if;
  foreach r in array array['anon', 'authenticated'] loop
    if has_table_privilege(r, 'public.agentes_catalogo', 'SELECT')
       or has_table_privilege(r, 'public.agentes_catalogo', 'INSERT')
       or has_table_privilege(r, 'public.agentes_catalogo', 'UPDATE')
       or has_table_privilege(r, 'public.agentes_catalogo', 'DELETE') then
      raise exception 'CHECK FALHOU: % tem acesso a agentes_catalogo', r;
    end if;
  end loop;
  if not has_table_privilege('service_role', 'public.agentes_catalogo', 'SELECT') then
    raise exception 'CHECK FALHOU: service_role não lê agentes_catalogo';
  end if;
  if has_table_privilege('service_role', 'public.agentes_catalogo', 'INSERT')
     or has_table_privilege('service_role', 'public.agentes_catalogo', 'UPDATE') then
    raise exception 'CHECK FALHOU: service_role escreve em agentes_catalogo (muda só por migration)';
  end if;

  if (select count(*) from public.agentes_catalogo where codigo in ('edital', 'juridico') and ativo
        and api = 'api-agentes' and acao_api = 'analise_executar' and agente_api = codigo) <> 2 then
    raise exception 'CHECK FALHOU: semente de edital e jurídico ausente ou diferente';
  end if;
  if not exists (select 1 from public.agentes_catalogo where codigo = 'preco' and not ativo) then
    raise exception 'CHECK FALHOU: preço deveria estar inativo nesta spec';
  end if;

  begin
    v_ok := false;
    begin
      insert into public.agentes_catalogo (codigo, nome, api, acao_api, agente_api)
      values ('Edital X', 'x', 'api-agentes', 'analise_executar', 'edital');
    exception when check_violation then v_ok := true;
    end;
    if not v_ok then
      raise exception 'CHECK FALHOU: código fora do padrão aceito';
    end if;
    raise exception 'ROLLBACK_PROPOSITAL';
  exception when others then
    if sqlerrm <> 'ROLLBACK_PROPOSITAL' then
      raise;
    end if;
  end;
  raise notice 'SUCESSO: agentes_catalogo ok (desfeito)';
end
$$;
