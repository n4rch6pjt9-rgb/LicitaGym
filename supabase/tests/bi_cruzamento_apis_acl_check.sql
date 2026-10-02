-- Verificação de integridade e ACL da migration 20261002100000_bi_cruzamento_apis.sql
-- Valida:
-- 1. Tabelas novas criadas com RLS ligado, SEM grant para anon e SEM grant para authenticated (apenas service_role)
-- 2. Views novas criadas com security_invoker = true, SEM grant para anon e SEM grant para authenticated (apenas service_role)
-- 3. Sequence grants restritos a service_role (anon e authenticated sem privilégios)
-- 4. Colunas de fornecedor/marca/fabricante/modelo presentes nas tabelas

do $$
declare
  v_tabelas text[] := array[
    'public.pca_pgc_itens',
    'public.precos_praticados_itens',
    'public.atas_rp_itens',
    'public.resultados_itens_14133'
  ];
  v_views text[] := array[
    'public.v_bi_pca_radar',
    'public.v_bi_precos_praticados',
    'public.v_bi_atas_vencendo',
    'public.v_bi_orgaos_match',
    'public.v_bi_fornecedor_historico'
  ];
  v_seqs text[] := array[
    'public.pca_pgc_itens_id_seq',
    'public.atas_rp_itens_id_seq',
    'public.resultados_itens_14133_id_seq'
  ];
  v_obj text;
  v_priv text;
begin
  -- 1. Verifica tabelas novas: RLS ligado, nenhum privilégio para anon nem authenticated, CRUD total para service_role
  foreach v_obj in array v_tabelas loop
    if to_regclass(v_obj) is null then
      raise exception 'ACL CHECK FALHOU: tabela % não existe', v_obj;
    end if;

    if not coalesce((select relrowsecurity from pg_class where oid = to_regclass(v_obj)), false) then
      raise exception 'ACL CHECK FALHOU: RLS desligado em %', v_obj;
    end if;

    foreach v_priv in array array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER'] loop
      if has_table_privilege('anon', v_obj, v_priv) then
        raise exception 'ACL CHECK FALHOU: anon possui % em %', v_priv, v_obj;
      end if;
      if has_table_privilege('authenticated', v_obj, v_priv) then
        raise exception 'ACL CHECK FALHOU: authenticated possui % em % (tabelas devem ser exclusivas de service_role)', v_priv, v_obj;
      end if;
    end loop;

    if not (has_table_privilege('service_role', v_obj, 'SELECT')
            and has_table_privilege('service_role', v_obj, 'INSERT')
            and has_table_privilege('service_role', v_obj, 'UPDATE')
            and has_table_privilege('service_role', v_obj, 'DELETE')) then
      raise exception 'ACL CHECK FALHOU: service_role sem CRUD em %', v_obj;
    end if;
  end loop;

  -- 2. Verifica views de BI: security_invoker = true, nenhum privilégio para anon nem authenticated, SELECT apenas para service_role
  foreach v_obj in array v_views loop
    if to_regclass(v_obj) is null then
      raise exception 'ACL CHECK FALHOU: view % não existe', v_obj;
    end if;

    if not coalesce((select (coalesce(c.reloptions, '{}') @> array['security_invoker=true'])
                       from pg_class c where c.oid = to_regclass(v_obj)), false) then
      raise exception 'ACL CHECK FALHOU: view % sem security_invoker=true', v_obj;
    end if;

    foreach v_priv in array array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER'] loop
      if has_table_privilege('anon', v_obj, v_priv) then
        raise exception 'ACL CHECK FALHOU: anon possui % na view %', v_priv, v_obj;
      end if;
      if has_table_privilege('authenticated', v_obj, v_priv) then
        raise exception 'ACL CHECK FALHOU: authenticated possui % na view % (views de BI devem ser exclusivas de service_role)', v_priv, v_obj;
      end if;
    end loop;

    if not has_table_privilege('service_role', v_obj, 'SELECT') then
      raise exception 'ACL CHECK FALHOU: service_role sem SELECT na view %', v_obj;
    end if;
  end loop;

  -- 3. Verifica sequences: sem grant para anon nem authenticated
  foreach v_obj in array v_seqs loop
    if to_regclass(v_obj) is not null then
      if has_sequence_privilege('anon', v_obj, 'USAGE') or has_sequence_privilege('anon', v_obj, 'SELECT')
         or has_sequence_privilege('authenticated', v_obj, 'USAGE') or has_sequence_privilege('authenticated', v_obj, 'SELECT') then
        raise exception 'ACL CHECK FALHOU: anon/authenticated com privilégio na sequence %', v_obj;
      end if;
      if not has_sequence_privilege('service_role', v_obj, 'USAGE') then
        raise exception 'ACL CHECK FALHOU: service_role sem USAGE na sequence %', v_obj;
      end if;
    end if;
  end loop;

  -- 4. Verifica colunas essenciais
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'v_bi_fornecedor_historico' and column_name = 'tipo_fornecedor_motivo') then
    raise exception 'COLUNA CHECK FALHOU: v_bi_fornecedor_historico sem coluna tipo_fornecedor_motivo';
  end if;
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'precos_praticados_itens' and column_name = 'marca') then
    raise exception 'COLUNA CHECK FALHOU: precos_praticados_itens sem coluna marca';
  end if;
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'atas_rp_itens' and column_name = 'ni_fornecedor') then
    raise exception 'COLUNA CHECK FALHOU: atas_rp_itens sem coluna ni_fornecedor';
  end if;
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'resultados_itens_14133' and column_name = 'material_ou_servico') then
    raise exception 'COLUNA CHECK FALHOU: resultados_itens_14133 sem coluna material_ou_servico';
  end if;
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'contratacoes_atas' and column_name = 'ni_fornecedor') then
    raise exception 'COLUNA CHECK FALHOU: contratacoes_atas sem coluna ni_fornecedor';
  end if;

  raise notice 'SUCESSO: bi_cruzamento_apis_acl_check aprovado sem erros';
end $$;
