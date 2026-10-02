-- =============================================================================
-- Teste de validação real da view v_bi_fornecedor_historico
--
-- Casos testados:
-- 1. Deduplicação PNCP x Pesquisa de Preço (Compras.gov):
--    Uma venda homologada no PNCP com link_sistema_origem (?compra=16021105900032024)
--    que também aparece em precos_praticados_itens (id_compra=16021105900032024),
--    SEM linha na 14.133 nem na ARP.
--    Esperado: exatamente 1 venda homologada / 1 certame.
--
-- 2. Sistema S / Paradigma (sem colisão):
--    3 certames com o mesmo nCdProcesso (id_externo = 42), mesmo CNPJ e mesmo item:
--    - 2 de tenants diferentes (sestsenat e fiesc, modulo 59);
--    - 1 do mesmo tenant de um deles, mas outro módulo (sestsenat, modulo 58).
--    Esperado: exatamente 3 linhas Paradigma / 3 certames.
-- =============================================================================

do $$
declare
  v_lic_pncp_id bigint;
  v_lic_par1_id bigint;
  v_lic_par2_id bigint;
  v_lic_par3_id bigint;
  v_total_vendas_pncp int;
  v_total_certames_pncp int;
  v_total_vendas_par int;
  v_total_certames_par int;
  v_itens_pncp jsonb;
  v_itens_par jsonb;
begin
  -- Limpeza prévia de execuções anteriores do teste
  delete from public.precos_praticados_itens where id_compra = '16021105900032024';
  delete from public.licitacoes_externas where codigo_externo = '00394429000100-1-000003/2024' or (id_externo = 42 and fonte in ('sestsenat', 'fiesc'));

  -- Setup: Catálogo e escopo CATMAT (PDM 2640 e Item 480144)
  insert into public.catmat_grupos (codigo_grupo, nome, payload_hash)
  values (78, 'EQUIPAMENTO PARA GINÁSTICA', 'hash_g78')
  on conflict (codigo_grupo) do nothing;

  insert into public.catmat_classes (codigo_grupo, codigo_classe, nome, payload_hash)
  values (78, 7830, 'EQUIPAMENTO GINÁSTICA', 'hash_c7830')
  on conflict (codigo_grupo, codigo_classe) do nothing;

  insert into public.catmat_pdms (codigo_pdm, codigo_grupo, codigo_classe, nome_pdm, payload_hash)
  values (2640, 78, 7830, 'APARELHO CONDICIONAMENTO FISICO', 'hash_pdm2640')
  on conflict (codigo_pdm) do nothing;

  insert into public.catalogo_empresa_catmat (nivel, codigo_grupo, codigo_classe, codigo_pdm, nome_snapshot, incluido)
  values ('pdm', 78, 7830, 2640, 'APARELHO CONDICIONAMENTO FISICO', true)
  on conflict do nothing;

  insert into public.catmat_itens (codigo_item, codigo_pdm, descricao_item)
  values (480144, '2640', 'APARELHO MUSCULACAO CROSS OVER')
  on conflict (codigo_item) do nothing;

  -- Setup: Fontes externas
  insert into public.fontes_externas (slug, entidade, plataforma, base_url, modo_coleta)
  values
    ('pncp', 'PNCP', 'pncp', 'https://pncp.gov.br', 'automatico'),
    ('sestsenat', 'SEST SENAT', 'paradigma', 'https://compras.sestsenat.org.br', 'automatico'),
    ('fiesc', 'FIESC', 'paradigma', 'https://portaldecompras.fiesc.com.br', 'automatico')
  on conflict (slug) do nothing;

  -- Setup: Fornecedores
  insert into public.fornecedores (cnpj, cnpj_raiz, razao_social, cnae_principal, consulta_status)
  values
    ('04372852000160', '04372852', 'W.E.V COMERCIAL LTDA', 4763602, 'ok'),
    ('99999999000199', '99999999', 'FABRICANTE FITNESS BRASIL LTDA', 3230200, 'ok')
  on conflict (cnpj) do nothing;

  -- ---------------------------------------------------------------------------
  -- CASO 1: PNCP + Pesquisa de Preço Compras.gov (mesma compra via link_sistema_origem)
  -- ---------------------------------------------------------------------------
  insert into public.licitacoes_externas (
    fonte, codigo_externo, orgao_cnpj, orgao_nome, data_homologacao, prioridade, raw
  ) values (
    'pncp',
    '00394429000100-1-000003/2024',
    '00394429000100',
    'GAP DO GALEAO - COMAER',
    '2026-09-18'::timestamptz,
    'historico',
    jsonb_build_object('link_sistema_origem', 'https://cnetmobile.estaleiro.serpro.gov.br/comprasnet-web/public/compras/acompanhamento-compra?compra=16021105900032024')
  ) returning id into v_lic_pncp_id;

  insert into public.licitacao_itens (
    licitacao_id, numero_item, catalogo_codigo_item, material_ou_servico, quantidade, valor_unitario_estimado
  ) values (
    v_lic_pncp_id, 1, '480144', 'M', 2, 9500.0
  );

  insert into public.licitacao_resultados (
    licitacao_id, numero_item, sequencial_resultado, fornecedor_cnpj, fornecedor_nome,
    vencedor, quantidade_homologada, valor_unitario_homologado, valor_total_homologado, data_resultado
  ) values (
    v_lic_pncp_id, 1, 1, '04372852000160', 'W.E.V COMERCIAL LTDA',
    true, 2, 9000.0, 18000.0, '2026-09-18'::timestamptz
  );

  -- Mesma compra em precos_praticados_itens (Compras.gov pesquisa de preço)
  insert into public.precos_praticados_itens (
    id_compra, id_item_compra, numero_item_compra, codigo_item_catalogo, codigo_pdm,
    ni_fornecedor, nome_fornecedor, preco_unitario, quantidade, marca, data_resultado,
    codigo_uasg, nome_uasg
  ) values (
    '16021105900032024', 5858679, 1, 480144, '2640',
    '04372852000160', 'W.E.V COMERCIAL LTDA', 9000.0, 2, 'FORTIX', '2026-09-18'::date,
    '120645', 'GAP DO GALEAO'
  );

  -- ---------------------------------------------------------------------------
  -- CASO 2: 3 Certames Paradigma com o mesmo nCdProcesso (id_externo = 42)
  -- ---------------------------------------------------------------------------
  -- Certame 2.1: sestsenat, modulo 59, id_externo 42
  insert into public.licitacoes_externas (
    fonte, modulo, id_externo, codigo_externo, orgao_nome, data_homologacao, prioridade
  ) values (
    'sestsenat', 59, 42, '42', 'SEST SENAT UNIDADE A', '2026-09-01'::timestamptz, 'historico'
  ) returning id into v_lic_par1_id;

  insert into public.licitacao_itens (
    licitacao_id, numero_item, catalogo_codigo_item, material_ou_servico, quantidade, descricao
  ) values (
    v_lic_par1_id, 1, '480144', 'M', 1, 'APARELHO CROSS OVER'
  );

  insert into public.licitacao_resultados (
    licitacao_id, numero_item, sequencial_resultado, fornecedor_cnpj, fornecedor_nome,
    vencedor, quantidade_homologada, valor_unitario_homologado, valor_total_homologado, data_resultado
  ) values (
    v_lic_par1_id, 1, 1, '99999999000199', 'FABRICANTE FITNESS BRASIL LTDA',
    true, 1, 8500.0, 8500.0, '2026-09-01'::timestamptz
  );

  -- Certame 2.2: fiesc, modulo 59, id_externo 42
  insert into public.licitacoes_externas (
    fonte, modulo, id_externo, codigo_externo, orgao_nome, data_homologacao, prioridade
  ) values (
    'fiesc', 59, 42, '42', 'FIESC SESI SENAI', '2026-09-02'::timestamptz, 'historico'
  ) returning id into v_lic_par2_id;

  insert into public.licitacao_itens (
    licitacao_id, numero_item, catalogo_codigo_item, material_ou_servico, quantidade, descricao
  ) values (
    v_lic_par2_id, 1, '480144', 'M', 1, 'APARELHO CROSS OVER'
  );

  insert into public.licitacao_resultados (
    licitacao_id, numero_item, sequencial_resultado, fornecedor_cnpj, fornecedor_nome,
    vencedor, quantidade_homologada, valor_unitario_homologado, valor_total_homologado, data_resultado
  ) values (
    v_lic_par2_id, 1, 1, '99999999000199', 'FABRICANTE FITNESS BRASIL LTDA',
    true, 1, 8600.0, 8600.0, '2026-09-02'::timestamptz
  );

  -- Certame 2.3: sestsenat, modulo 58 (outro módulo), id_externo 42 (upsert usa fonte,modulo,id_externo)
  insert into public.licitacoes_externas (
    fonte, modulo, id_externo, codigo_externo, orgao_nome, data_homologacao, prioridade
  ) values (
    'sestsenat', 58, 42, null, 'SEST SENAT UNIDADE B', '2026-09-03'::timestamptz, 'historico'
  ) returning id into v_lic_par3_id;

  insert into public.licitacao_itens (
    licitacao_id, numero_item, catalogo_codigo_item, material_ou_servico, quantidade, descricao
  ) values (
    v_lic_par3_id, 1, '480144', 'M', 1, 'APARELHO CROSS OVER'
  );

  insert into public.licitacao_resultados (
    licitacao_id, numero_item, sequencial_resultado, fornecedor_cnpj, fornecedor_nome,
    vencedor, quantidade_homologada, valor_unitario_homologado, valor_total_homologado, data_resultado
  ) values (
    v_lic_par3_id, 1, 1, '99999999000199', 'FABRICANTE FITNESS BRASIL LTDA',
    true, 1, 8700.0, 8700.0, '2026-09-03'::timestamptz
  );

  -- ---------------------------------------------------------------------------
  -- VERIFICAÇÕES DIRETAS NA VIEW public.v_bi_fornecedor_historico
  -- ---------------------------------------------------------------------------

  -- Verificação Caso 1 (Deduplicação Federal PNCP x Compras.gov):
  select total_vendas_homologadas, total_certames, itens_praticados
    into v_total_vendas_pncp, v_total_certames_pncp, v_itens_pncp
    from public.v_bi_fornecedor_historico
   where cnpj = '04372852000160';

  raise notice 'CASO 1: total_vendas_homologadas = %, total_certames = %',
               v_total_vendas_pncp, v_total_certames_pncp;

  if v_total_vendas_pncp <> 1 then
    raise exception 'TESTE CASO 1 FALHOU: esperado 1 venda homologada, obtido %', v_total_vendas_pncp;
  end if;

  if v_total_certames_pncp <> 1 then
    raise exception 'TESTE CASO 1 FALHOU: esperado 1 certame, obtido %', v_total_certames_pncp;
  end if;

  -- Verificação Caso 2 (Paradigma 3 certames sem colisão):
  select total_vendas_homologadas, total_certames, itens_praticados
    into v_total_vendas_par, v_total_certames_par, v_itens_par
    from public.v_bi_fornecedor_historico
   where cnpj = '99999999000199';

  raise notice 'CASO 2: total_vendas_homologadas = %, total_certames = %',
               v_total_vendas_par, v_total_certames_par;

  if v_total_vendas_par <> 3 then
    raise exception 'TESTE CASO 2 FALHOU: esperado 3 vendas homologadas Paradigma, obtido %', v_total_vendas_par;
  end if;

  if v_total_certames_par <> 3 then
    raise exception 'TESTE CASO 2 FALHOU: esperado 3 certames Paradigma, obtido %', v_total_certames_par;
  end if;

  raise notice 'SUCESSO: Todos os testes reais contra v_bi_fornecedor_historico passaram com louvor!';
end $$;
