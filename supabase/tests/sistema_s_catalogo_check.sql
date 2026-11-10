-- Verificação do catálogo do Sistema S por portal (spec 0052 fase 1: K-1 classes, K-2 produtos; spec 0053 K-1).
-- Migration: 20261110100000_sistema_s_catalogo.sql.
-- Executar após aplicar as migrations (psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/sistema_s_catalogo_check.sql):
--   CA-1: RLS ligada, nenhuma policy; anon e authenticated sem nenhum privilégio; service_role com SELECT, INSERT e
--         UPDATE e sem DELETE/TRUNCATE (produto que some do portal fica com a data da última coleta).
--   K-1/K-2: chave única (fonte, id_classe_fonte) e (fonte, id_produto_fonte); produto aponta para classe do mesmo portal
--         (FK composta); fonte com FK para fontes_externas.
-- As inserções de teste rodam num bloco com rollback (exceção capturada): o banco não fica com dado de teste.
-- Falha com EXCEPTION na primeira regra violada.

do $$
declare
  v_obj  text;
  v_priv text;
  v_tabs text[] := array['public.sistema_s_catalogo_classes', 'public.sistema_s_catalogo_produtos'];
  v_fonte text;
begin
  foreach v_obj in array v_tabs loop
    if to_regclass(v_obj) is null then
      raise exception 'CHECK FALHOU: objeto % não existe', v_obj;
    end if;
    if not (select relrowsecurity from pg_class where oid = v_obj::regclass) then
      raise exception 'CHECK FALHOU: RLS desligada em %', v_obj;
    end if;
    if exists (select 1 from pg_policy where polrelid = v_obj::regclass) then
      raise exception 'CHECK FALHOU: % tem policy (leitura só pela Edge Function/coletor)', v_obj;
    end if;
    foreach v_priv in array array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER'] loop
      if has_table_privilege('anon', v_obj, v_priv) or has_table_privilege('authenticated', v_obj, v_priv) then
        raise exception 'CHECK FALHOU: anon/authenticated possui % em %', v_priv, v_obj;
      end if;
    end loop;
    -- GRANT por coluna não aparece em has_table_privilege
    foreach v_priv in array array['SELECT','INSERT','UPDATE','REFERENCES'] loop
      if has_any_column_privilege('anon', v_obj, v_priv) or has_any_column_privilege('authenticated', v_obj, v_priv) then
        raise exception 'CHECK FALHOU: anon/authenticated possui % em coluna de %', v_priv, v_obj;
      end if;
    end loop;
    -- sequence da identity
    if has_sequence_privilege('anon', pg_get_serial_sequence(v_obj, 'id'), 'USAGE,SELECT,UPDATE')
       or has_sequence_privilege('authenticated', pg_get_serial_sequence(v_obj, 'id'), 'USAGE,SELECT,UPDATE') then
      raise exception 'CHECK FALHOU: anon/authenticated possui privilégio na sequence de %', v_obj;
    end if;
    foreach v_priv in array array['SELECT','INSERT','UPDATE'] loop
      if not has_table_privilege('service_role', v_obj, v_priv) then
        raise exception 'CHECK FALHOU: service_role sem % em %', v_priv, v_obj;
      end if;
    end loop;
    foreach v_priv in array array['DELETE','TRUNCATE'] loop
      if has_table_privilege('service_role', v_obj, v_priv) then
        raise exception 'CHECK FALHOU: service_role possui % em % (catálogo não se apaga)', v_priv, v_obj;
      end if;
    end loop;
  end loop;

  -- K-1/K-2: chaves e FK, com dado de teste descartado no fim do bloco.
  select slug into v_fonte from public.fontes_externas order by slug limit 1;
  if v_fonte is null then
    raise notice 'fontes_externas vazia: checagem de chave e FK pulada';
  else
    begin
      insert into public.sistema_s_catalogo_classes (fonte, id_classe_fonte, nome) values (v_fonte, -1, 'CHECK');
      begin
        insert into public.sistema_s_catalogo_classes (fonte, id_classe_fonte, nome) values (v_fonte, -1, 'CHECK 2');
        raise exception 'CHECK FALHOU: classe (fonte, id_classe_fonte) repetida aceita';
      exception when unique_violation then null;
      end;
      insert into public.sistema_s_catalogo_produtos (fonte, id_produto_fonte, id_classe_fonte, descricao, payload_hash)
        values (v_fonte, -1, -1, 'CHECK', 'h');
      begin
        insert into public.sistema_s_catalogo_produtos (fonte, id_produto_fonte, id_classe_fonte, descricao, payload_hash)
          values (v_fonte, -1, -1, 'CHECK 2', 'h2');
        raise exception 'CHECK FALHOU: produto (fonte, id_produto_fonte) repetido aceito';
      exception when unique_violation then null;
      end;
      begin
        insert into public.sistema_s_catalogo_produtos (fonte, id_produto_fonte, id_classe_fonte, descricao, payload_hash)
          values (v_fonte, -2, -999, 'CHECK', 'h');
        raise exception 'CHECK FALHOU: produto com classe inexistente no portal aceito';
      exception when foreign_key_violation then null;
      end;
      begin
        insert into public.sistema_s_catalogo_classes (fonte, id_classe_fonte, nome) values ('fonte_que_nao_existe', -1, 'X');
        raise exception 'CHECK FALHOU: classe de fonte inexistente aceita';
      exception when foreign_key_violation then null;
      end;
      raise exception using errcode = 'P0001', message = 'ROLLBACK_CHECK';
    exception when sqlstate 'P0001' then
      if sqlerrm <> 'ROLLBACK_CHECK' then
        raise;
      end if;
    end;
  end if;

  raise notice 'SUCESSO: catálogo do Sistema S (classes e produtos) conferido';
end $$;
