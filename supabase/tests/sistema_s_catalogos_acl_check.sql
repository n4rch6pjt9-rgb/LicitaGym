-- Verificação de ACL dos objetos do coletor Sistema S e dos catálogos de fabricantes
-- (migrations 20260929130000_acl_sistema_s_catalogos, 20260929140000_documentos_no_licitagym e
-- 20260929140100_bi_perfil_equipamento).
-- Executar após aplicar as migrations (ex.: psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/sistema_s_catalogos_acl_check.sql):
--   1. anon sem nenhum privilégio nas tabelas, views e sequences
--   2. authenticated só com SELECT (+ INSERT em licitacao_escopo_decisao); sem TRUNCATE/UPDATE/DELETE
--   3. service_role com SELECT e INSERT nas tabelas (coletores)
--   4. match_catalogo_chunks: sem EXECUTE para anon/PUBLIC; com EXECUTE para authenticated
--   5. portal_visitante: nenhum privilégio para anon nem authenticated (só service_role)
-- Falha com EXCEPTION na primeira regra violada.

do $$
declare
  v_obj text;
  v_priv text;
  v_objs text[] := array[
    'public.fornecedores',
    'public.catalogo_documentos', 'public.catalogo_produtos', 'public.catalogo_chunks',
    'public.fontes_externas', 'public.licitacao_escopo_decisao',
    'public.v_fornecedor_participacoes', 'public.v_oportunidades_externas',
    'public.v_licitacao_documentos', 'public.v_bi_resultados_itens'
  ];
  v_tabelas text[] := array[
    'public.fornecedores',
    'public.catalogo_documentos', 'public.catalogo_produtos', 'public.catalogo_chunks',
    'public.fontes_externas', 'public.licitacao_escopo_decisao'
  ];
  v_seqs text[] := array[
    'public.catalogo_documentos_id_seq', 'public.catalogo_produtos_id_seq', 'public.catalogo_chunks_id_seq',
    'public.licitacao_escopo_decisao_id_seq'
  ];
  v_fn regprocedure := to_regprocedure('public.match_catalogo_chunks(vector,integer,text,text)');
begin
  foreach v_obj in array v_objs loop
    if to_regclass(v_obj) is null then
      raise exception 'ACL CHECK FALHOU: objeto % não existe', v_obj;
    end if;

    -- 1. anon sem nenhum privilégio
    foreach v_priv in array array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER'] loop
      if has_table_privilege('anon', v_obj, v_priv) then
        raise exception 'ACL CHECK FALHOU: anon possui % em %', v_priv, v_obj;
      end if;
    end loop;

    -- 2. authenticated: SELECT sim; escrita/TRUNCATE não (INSERT só em licitacao_escopo_decisao)
    if not has_table_privilege('authenticated', v_obj, 'SELECT') then
      raise exception 'ACL CHECK FALHOU: authenticated sem SELECT em %', v_obj;
    end if;
    foreach v_priv in array array['UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER'] loop
      if has_table_privilege('authenticated', v_obj, v_priv) then
        raise exception 'ACL CHECK FALHOU: authenticated possui % em %', v_priv, v_obj;
      end if;
    end loop;
    if has_table_privilege('authenticated', v_obj, 'INSERT') <> (v_obj = 'public.licitacao_escopo_decisao') then
      raise exception 'ACL CHECK FALHOU: INSERT de authenticated em % diferente do esperado', v_obj;
    end if;
  end loop;

  -- 3. service_role mantém leitura e escrita nas tabelas (coletores)
  foreach v_obj in array v_tabelas loop
    if not (has_table_privilege('service_role', v_obj, 'SELECT') and has_table_privilege('service_role', v_obj, 'INSERT')) then
      raise exception 'ACL CHECK FALHOU: service_role sem SELECT/INSERT em %', v_obj;
    end if;
  end loop;

  -- 1b. sequences fechadas para anon
  foreach v_obj in array v_seqs loop
    if has_sequence_privilege('anon', v_obj, 'USAGE') or has_sequence_privilege('anon', v_obj, 'UPDATE')
       or has_sequence_privilege('anon', v_obj, 'SELECT') then
      raise exception 'ACL CHECK FALHOU: anon possui privilégio na sequence %', v_obj;
    end if;
    if has_sequence_privilege('authenticated', v_obj, 'UPDATE') then
      raise exception 'ACL CHECK FALHOU: authenticated possui UPDATE (setval) na sequence %', v_obj;
    end if;
  end loop;

  -- 4. função de busca nos catálogos
  if v_fn is null then
    raise exception 'ACL CHECK FALHOU: função match_catalogo_chunks não existe';
  end if;
  if has_function_privilege('anon', v_fn, 'EXECUTE') then
    raise exception 'ACL CHECK FALHOU: anon possui EXECUTE em match_catalogo_chunks';
  end if;
  if not has_function_privilege('authenticated', v_fn, 'EXECUTE') then
    raise exception 'ACL CHECK FALHOU: authenticated sem EXECUTE em match_catalogo_chunks';
  end if;

  -- 5. portal_visitante (código de visitante por portal): só service_role
  if to_regclass('public.portal_visitante') is null then
    raise exception 'ACL CHECK FALHOU: objeto public.portal_visitante não existe';
  end if;
  foreach v_priv in array array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER'] loop
    if has_table_privilege('anon', 'public.portal_visitante', v_priv)
       or has_table_privilege('authenticated', 'public.portal_visitante', v_priv) then
      raise exception 'ACL CHECK FALHOU: anon/authenticated possui % em public.portal_visitante', v_priv;
    end if;
  end loop;
  if not has_table_privilege('service_role', 'public.portal_visitante', 'INSERT') then
    raise exception 'ACL CHECK FALHOU: service_role sem INSERT em public.portal_visitante';
  end if;

  raise notice 'SUCESSO: ACL dos objetos do Sistema S e dos catálogos conferida';
end $$;
