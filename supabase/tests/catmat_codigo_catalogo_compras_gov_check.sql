-- =============================================================================
-- Verificação da 20261003180000_catmat_codigo_so_catalogo_compras_gov
-- Dados fictícios. begin ... rollback: nada persiste. Trava contra produção (> 100 licitações).
--   A. coluna licitacao_itens.catalogo_id (smallint) e índice da expressão de por_codigo
--   B. licitacoes_ids_por_catmat, ramo 'codigo': só catalogo_id = 1 e material ('M'). Catálogo Outros (2), CATSER
--      ('S') e item sem catalogo_id (Paradigma) com o mesmo número não casam
--   C. homologacoes_itens: pdm_metodo 'catalogo' só no catálogo 1 em material; Outros não pega o PDM do código
--   D. v_bi_fornecedor_historico: codigo_item e cobertura 'catmat_oficial' só no catálogo 1 em material
--   E. security_invoker = true nas três views recriadas e ACL só service_role
--   F. homologacoes_itens.codigo_catmat (bigint, última coluna; as 13 anteriores iguais): código validado só no
--      catálogo 1 em material; NULL para Outros, CATSER, sem catalogo_id e código não numérico
-- =============================================================================
begin;

do $$
begin
  if (select count(*) from public.licitacoes_externas) > 100 then
    raise exception 'TRAVA DE SEGURANCA: licitacoes_externas tem mais de 100 linhas. Abortando para proteger producao.';
  end if;
end $$;

do $$
declare
  v_lic bigint[] := '{}';
  v_id bigint;
  v_cat int;
  v_txt text;
  v_n int;
  v_rel text;
  v_cols text;
begin
  -- A
  if (select format_type(atttypid, atttypmod) from pg_attribute
       where attrelid = 'public.licitacao_itens'::regclass and attname = 'catalogo_id' and not attisdropped)
     is distinct from 'smallint' then
    raise exception 'TESTE A FALHOU: licitacao_itens.catalogo_id ausente ou com tipo errado';
  end if;
  if to_regclass('public.licitacao_itens_catmat_codigo_item_idx') is null then
    raise exception 'TESTE A FALHOU: índice licitacao_itens_catmat_codigo_item_idx ausente';
  end if;
  if to_regclass('public.licitacao_itens_catalogo_codigo_item_num_idx') is not null then
    raise exception 'TESTE A FALHOU: índice antigo licitacao_itens_catalogo_codigo_item_num_idx ainda existe';
  end if;

  -- Escopo CATMAT fictício mínimo (PDM 2641 / item 480145)
  insert into public.catmat_grupos (codigo_grupo, nome, payload_hash) values (79, 'GRUPO TESTE', 'h79') on conflict (codigo_grupo) do nothing;
  insert into public.catmat_classes (codigo_grupo, codigo_classe, nome, payload_hash) values (79, 7931, 'CLASSE TESTE', 'h7931') on conflict (codigo_grupo, codigo_classe) do nothing;
  insert into public.catmat_pdms (codigo_pdm, codigo_grupo, codigo_classe, nome_pdm, payload_hash) values (2641, 79, 7931, 'PDM TESTE CESTO', 'h2641') on conflict (codigo_pdm) do nothing;
  insert into public.catmat_itens (codigo_item, codigo_pdm, descricao_item) values (480145, '2641', 'CESTO TESTE') on conflict (codigo_item) do nothing;

  -- Uma licitação por caso: (catalogo_id, material_ou_servico) com o mesmo código 480145
  for v_cat, v_txt in select * from (values (1, 'M'), (2, 'M'), (1, 'S'), (null, 'M')) as c(cat, ms) loop
    insert into public.licitacoes_externas (fonte, codigo_externo, objeto, prioridade, data_homologacao)
    values ('pncp', 'zzteste-catalogo-' || coalesce(v_cat::text, 'null') || '-' || v_txt, 'ZZ OBJETO NEUTRO', 'historico', '2026-09-01')
    returning id into v_id;
    insert into public.licitacao_itens (licitacao_id, numero_item, descricao, catalogo_codigo_item, catalogo_id, material_ou_servico, quantidade)
    values (v_id, 1, 'ZZ ITEM NEUTRO', '480145', v_cat, v_txt, 1);
    insert into public.licitacao_resultados (licitacao_id, numero_item, sequencial_resultado, fornecedor_cnpj, fornecedor_nome,
                                             vencedor, quantidade_homologada, valor_unitario_homologado, valor_total_homologado, data_resultado)
    values (v_id, 1, 1, '21111111000102', 'FORNECEDOR CATALOGO TESTE LTDA', true, 1, 10, 10, '2026-09-01');
    v_lic := v_lic || v_id;
  end loop;

  -- B
  select count(*), min(licitacao_id) into v_n, v_id
    from public.licitacoes_ids_por_catmat(null, null, array[2641], null, false)
   where motivo = 'codigo' and licitacao_id = any (v_lic);
  if v_n <> 1 or v_id <> v_lic[1] then
    raise exception 'TESTE B FALHOU: esperado só a licitação do catálogo 1/M (%) no ramo codigo; obtido % linha(s), min %', v_lic[1], v_n, v_id;
  end if;
  select count(*) into v_n from public.licitacoes_ids_por_catmat(null, null, null, array[480145], false)
   where motivo = 'codigo' and licitacao_id = any (v_lic);
  if v_n <> 1 then
    raise exception 'TESTE B FALHOU (p_itens): esperado 1 linha codigo, obtido %', v_n;
  end if;

  -- C
  select count(*) into v_n from public.homologacoes_itens
   where licitacao_id = any (v_lic) and pdm_metodo = 'catalogo';
  if v_n <> 1 or not exists (select 1 from public.homologacoes_itens
                              where licitacao_id = v_lic[1] and pdm_metodo = 'catalogo' and codigo_pdm = 2641) then
    raise exception 'TESTE C FALHOU: pdm_metodo catalogo esperado só no catálogo 1/M; obtido %', v_n;
  end if;
  if exists (select 1 from public.homologacoes_itens where licitacao_id = v_lic[2] and codigo_pdm = 2641) then
    raise exception 'TESTE C FALHOU: item do catálogo Outros pegou o PDM do código';
  end if;
  if (select catalogo_codigo_item from public.homologacoes_itens where licitacao_id = v_lic[2]) is distinct from '480145' then
    raise exception 'TESTE C FALHOU: catalogo_codigo_item cru deveria continuar exposto';
  end if;

  -- F
  select string_agg(attname || ':' || format_type(atttypid, atttypmod), ',' order by attnum) into v_cols
    from pg_attribute where attrelid = 'public.homologacoes_itens'::regclass and attnum > 0 and not attisdropped;
  if v_cols is distinct from 'resultado_id:bigint,fornecedor_cnpj:text,licitacao_id:bigint,numero_item:integer,uf:text,'
       'orgao_cnpj:text,modalidade:text,item_descricao:text,catalogo_codigo_item:text,valor_total_homologado:numeric,'
       'codigo_pdm:integer,nome_pdm:text,pdm_metodo:text,codigo_catmat:bigint' then
    raise exception 'TESTE F FALHOU: colunas de homologacoes_itens fora do esperado: %', v_cols;
  end if;
  if (select codigo_catmat from public.homologacoes_itens where licitacao_id = v_lic[1]) is distinct from 480145 then
    raise exception 'TESTE F FALHOU: codigo_catmat esperado 480145 no catálogo 1/M';
  end if;
  select count(*) into v_n from public.homologacoes_itens
   where licitacao_id = any (v_lic[2:4]) and codigo_catmat is not null;
  if v_n <> 0 then
    raise exception 'TESTE F FALHOU: codigo_catmat deveria ser NULL em Outros, CATSER e sem catalogo_id; % linha(s)', v_n;
  end if;
  insert into public.licitacoes_externas (fonte, codigo_externo, objeto, prioridade, data_homologacao)
  values ('pncp', 'zzteste-catalogo-nao-numerico', 'ZZ OBJETO NEUTRO', 'historico', '2026-09-01') returning id into v_id;
  insert into public.licitacao_itens (licitacao_id, numero_item, descricao, catalogo_codigo_item, catalogo_id, material_ou_servico, quantidade)
  values (v_id, 1, 'ZZ ITEM NEUTRO', 'AI0300075', 1, 'M', 1);
  insert into public.licitacao_resultados (licitacao_id, numero_item, sequencial_resultado, fornecedor_cnpj, vencedor, data_resultado)
  values (v_id, 1, 1, '21111111000102', true, '2026-09-01');
  if exists (select 1 from public.homologacoes_itens where licitacao_id = v_id and codigo_catmat is not null) then
    raise exception 'TESTE F FALHOU: código não numérico virou codigo_catmat';
  end if;

  -- D (a view só lista fornecedores com PDM no escopo; checa a CTE equivalente pelos itens da licitação)
  select count(*) into v_n from (
    select li.licitacao_id
      from public.licitacao_itens li
      left join public.catmat_itens ci on li.catalogo_id = 1 and li.material_ou_servico = 'M'
                                      and ci.codigo_item::text = li.catalogo_codigo_item
     where li.licitacao_id = any (v_lic) and ci.codigo_item is not null) s;
  if v_n <> 1 then
    raise exception 'TESTE D FALHOU: predicado do join esperado em 1 item, obtido %', v_n;
  end if;
  if strpos(pg_get_viewdef('public.v_bi_fornecedor_historico'::regclass), '(li.catalogo_id = 1)') = 0
     or strpos(pg_get_viewdef('public.v_bi_orgaos_match'::regclass), '(li.catalogo_id = 1)') = 0
     or strpos(pg_get_viewdef('public.homologacoes_itens'::regclass), '(i.catalogo_id = 1)') = 0 then
    raise exception 'TESTE D FALHOU: alguma view recriada sem o predicado catalogo_id = 1';
  end if;

  -- E
  foreach v_rel in array array['homologacoes_itens', 'v_bi_orgaos_match', 'v_bi_fornecedor_historico'] loop
    if not exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
                    where n.nspname = 'public' and c.relname = v_rel and 'security_invoker=true' = any (c.reloptions)) then
      raise exception 'TESTE E FALHOU: % sem security_invoker = true', v_rel;
    end if;
    if has_table_privilege('anon', 'public.' || v_rel, 'select') or has_table_privilege('authenticated', 'public.' || v_rel, 'select') then
      raise exception 'TESTE E FALHOU: % legível por anon/authenticated', v_rel;
    end if;
    if not has_table_privilege('service_role', 'public.' || v_rel, 'select') then
      raise exception 'TESTE E FALHOU: % sem select para service_role', v_rel;
    end if;
  end loop;
  if has_function_privilege('anon', 'public.licitacoes_ids_por_catmat(int[], int[], int[], int[], boolean)', 'execute')
     or has_function_privilege('authenticated', 'public.licitacoes_ids_por_catmat(int[], int[], int[], int[], boolean)', 'execute')
     or not has_function_privilege('service_role', 'public.licitacoes_ids_por_catmat(int[], int[], int[], int[], boolean)', 'execute') then
    raise exception 'TESTE E FALHOU: ACL de licitacoes_ids_por_catmat fora do padrão (só service_role)';
  end if;

  raise notice 'SUCESSO: catmat_codigo_catalogo_compras_gov ok';
end $$;

rollback;
