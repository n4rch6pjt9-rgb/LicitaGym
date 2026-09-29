-- Verificação de ACL do catálogo CATMAT da empresa (migrations 20260930100000_catalogo_empresa_catmat,
-- 20260930110000_taxonomia_no_pdm e 20260930120000_taxonomia_pisos).
-- Executar após aplicar as migrations (ex.: psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/catalogo_catmat_acl_check.sql):
--   1. anon sem nenhum privilégio nas tabelas e sequences
--   2. authenticated só SELECT em regras, mapa de itens, padrões e exclusões; nada no cache
--   3. service_role com leitura e escrita
--   4. funções de resolução executáveis só por service_role
--   5. RLS ligado e nenhuma policy de escrita
-- Falha com EXCEPTION na primeira regra violada.

do $$
declare
  v_obj text;
  v_priv text;
  v_leitura text[] := array['public.catalogo_empresa_catmat', 'public.catmat_item_pdm', 'public.catmat_pdm_palavras', 'public.taxonomia_no_pdm',
                             'public.catmat_pdm_exclusoes'];
  v_todas   text[] := array['public.catalogo_empresa_catmat', 'public.catmat_item_pdm', 'public.catmat_pdm_palavras', 'public.compras_catmat_cache',
                             'public.taxonomia_no_pdm', 'public.catmat_pdm_exclusoes'];
  v_seqs    text[] := array['public.catalogo_empresa_catmat_id_seq', 'public.catmat_pdm_palavras_id_seq', 'public.catmat_pdm_exclusoes_id_seq'];
  v_fns     text[] := array[
    'public.lg_normalizar(text)',
    'public.catmat_regex_valido(text)',
    'public.catalogo_catmat_pdms_efetivos()',
    'public.catmat_itens_mapa()',
    'public.licitacoes_ids_por_catmat(integer[],integer[],integer[],integer[],boolean)'
  ];
  v_fn text;
begin
  foreach v_obj in array v_todas loop
    if to_regclass(v_obj) is null then
      raise exception 'ACL CHECK FALHOU: objeto % não existe', v_obj;
    end if;
    if not coalesce((select relrowsecurity from pg_class where oid = to_regclass(v_obj)), false) then
      raise exception 'ACL CHECK FALHOU: RLS desligado em %', v_obj;
    end if;
    foreach v_priv in array array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER'] loop
      if has_table_privilege('anon', v_obj, v_priv) then
        raise exception 'ACL CHECK FALHOU: anon possui % em %', v_priv, v_obj;
      end if;
    end loop;
    foreach v_priv in array array['INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER'] loop
      if has_table_privilege('authenticated', v_obj, v_priv) then
        raise exception 'ACL CHECK FALHOU: authenticated possui % em %', v_priv, v_obj;
      end if;
    end loop;
    if not (has_table_privilege('service_role', v_obj, 'SELECT') and has_table_privilege('service_role', v_obj, 'INSERT')
            and has_table_privilege('service_role', v_obj, 'UPDATE') and has_table_privilege('service_role', v_obj, 'DELETE')) then
      raise exception 'ACL CHECK FALHOU: service_role sem leitura/escrita em %', v_obj;
    end if;
    if exists (select 1 from pg_policies p
                where p.schemaname || '.' || p.tablename = v_obj and p.cmd <> 'SELECT') then
      raise exception 'ACL CHECK FALHOU: policy de escrita em %', v_obj;
    end if;
  end loop;

  foreach v_obj in array v_leitura loop
    if not has_table_privilege('authenticated', v_obj, 'SELECT') then
      raise exception 'ACL CHECK FALHOU: authenticated sem SELECT em %', v_obj;
    end if;
  end loop;
  if has_table_privilege('authenticated', 'public.compras_catmat_cache', 'SELECT') then
    raise exception 'ACL CHECK FALHOU: authenticated possui SELECT em public.compras_catmat_cache';
  end if;

  foreach v_obj in array v_seqs loop
    if has_sequence_privilege('anon', v_obj, 'USAGE') or has_sequence_privilege('anon', v_obj, 'SELECT')
       or has_sequence_privilege('anon', v_obj, 'UPDATE') or has_sequence_privilege('authenticated', v_obj, 'UPDATE')
       or has_sequence_privilege('authenticated', v_obj, 'USAGE') then
      raise exception 'ACL CHECK FALHOU: anon/authenticated com privilégio na sequence %', v_obj;
    end if;
  end loop;

  foreach v_fn in array v_fns loop
    if to_regprocedure(v_fn) is null then
      raise exception 'ACL CHECK FALHOU: função % não existe', v_fn;
    end if;
    if has_function_privilege('anon', v_fn, 'EXECUTE') or has_function_privilege('authenticated', v_fn, 'EXECUTE') then
      raise exception 'ACL CHECK FALHOU: anon/authenticated executa %', v_fn;
    end if;
    if not has_function_privilege('service_role', v_fn, 'EXECUTE') then
      raise exception 'ACL CHECK FALHOU: service_role não executa %', v_fn;
    end if;
  end loop;

  raise notice 'SUCESSO: ACL do catálogo CATMAT conferida';
end $$;
