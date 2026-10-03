-- =============================================================================
-- Teste de validação real da view v_bi_fornecedor_historico
--
-- Casos testados:
-- 1. Deduplicação PNCP x Pesquisa de Preço (Compras.gov):
--    Uma venda homologada no PNCP com link_sistema_origem (?compra=99999999900012026)
--    que também aparece em precos_praticados_itens (id_compra=99999999900012026),
--    SEM linha na 14.133 nem na ARP.
--    Esperado: exatamente 1 venda homologada / 1 certame.
--
-- 2. Sistema S / Paradigma (sem colisão):
--    3 certames com o mesmo nCdProcesso (id_externo = 42), mesmo CNPJ e mesmo item:
--    - 2 de tenants diferentes (sestsenat e fiesc, modulo 59);
--    - 1 do mesmo tenant de um deles, mas outro módulo (sestsenat, modulo 58).
--    Esperado: exatamente 3 linhas Paradigma / 3 certames.
--
-- Proteção contra produção:
--    - Envolvido em begin; ... rollback; para não persistir dados.
--    - Trava aborta com EXCEPTION se licitacoes_externas tiver mais de 100 linhas.
-- =============================================================================

begin;

-- Trava de segurança: impede execução se apontar acidentalmente para produção
do $$
declare
  v_qtd_licitacoes int;
begin
  select count(*) into v_qtd_licitacoes from public.licitacoes_externas;
  if v_qtd_licitacoes > 100 then
    raise exception 'TRAVA DE SEGURANCA: licitacoes_externas contem % linhas (> 100). Abortando para proteger producao.', v_qtd_licitacoes;
  end if;
end $$;

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
  delete from public.precos_praticados_itens where id_compra = '99999999900012026';
  delete from public.licitacoes_externas where codigo_externo = '12345678000195-1-000003/2024' or (id_externo = 42 and fonte in ('sestsenat', 'fiesc'));

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
    ('fiesc', 'FIESC', 'paradigma', 'https://portaldecompras.fiesc.com.br', 'automatico'),
    ('paradigma_teste', 'PARADIGMA TESTE', 'paradigma', 'https://paradigma.test.org.br', 'automatico')
  on conflict (slug) do nothing;

  -- Setup: Fornecedores
  insert into public.fornecedores (cnpj, cnpj_raiz, razao_social, cnae_principal, consulta_status)
  values
    ('11222333000181', '11222333', 'COMERCIAL FICTICIA DE TESTE LTDA', 4763602, 'ok'),
    ('99999999000199', '99999999', 'FABRICANTE FITNESS BRASIL LTDA', 3230200, 'ok')
  on conflict (cnpj) do nothing;

  -- ---------------------------------------------------------------------------
  -- CASO 1: PNCP + Pesquisa de Preço Compras.gov (mesma compra via link_sistema_origem)
  -- ---------------------------------------------------------------------------
  insert into public.licitacoes_externas (
    fonte, codigo_externo, orgao_cnpj, orgao_nome, data_homologacao, prioridade, raw
  ) values (
    'pncp',
    '12345678000195-1-000003/2024',
    '12345678000195',
    'ORGAO FICTICIO DE TESTE',
    '2026-09-18'::timestamptz,
    'historico',
    jsonb_build_object('link_sistema_origem', 'https://cnetmobile.estaleiro.serpro.gov.br/comprasnet-web/public/compras/acompanhamento-compra?compra=99999999900012026')
  ) returning id into v_lic_pncp_id;

  insert into public.licitacao_itens (
    licitacao_id, numero_item, catalogo_codigo_item, material_ou_servico, quantidade, valor_unitario_estimado, catalogo_id
  ) values (
    v_lic_pncp_id, 1, '480144', 'M', 2, 9500.0, 1
  );

  insert into public.licitacao_resultados (
    licitacao_id, numero_item, sequencial_resultado, fornecedor_cnpj, fornecedor_nome,
    vencedor, quantidade_homologada, valor_unitario_homologado, valor_total_homologado, data_resultado
  ) values (
    v_lic_pncp_id, 1, 1, '11222333000181', 'COMERCIAL FICTICIA DE TESTE LTDA',
    true, 2, 9000.0, 18000.0, '2026-09-18'::timestamptz
  );

  -- Mesma compra em precos_praticados_itens (Compras.gov pesquisa de preço)
  insert into public.precos_praticados_itens (
    id_compra, id_item_compra, numero_item_compra, codigo_item_catalogo, codigo_pdm,
    ni_fornecedor, nome_fornecedor, preco_unitario, quantidade, marca, data_resultado,
    codigo_uasg, nome_uasg
  ) values (
    '99999999900012026', 5858679, 1, 480144, '2640',
    '11222333000181', 'COMERCIAL FICTICIA DE TESTE LTDA', 9000.0, 2, 'MARCA TESTE', '2026-09-18'::date,
    '999001', 'UASG FICTICIA DE TESTE'
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
    licitacao_id, numero_item, catalogo_codigo_item, material_ou_servico, quantidade, descricao, catalogo_id
  ) values (
    v_lic_par1_id, 1, '480144', 'M', 1, 'APARELHO CROSS OVER', 1
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
    licitacao_id, numero_item, catalogo_codigo_item, material_ou_servico, quantidade, descricao, catalogo_id
  ) values (
    v_lic_par2_id, 1, '480144', 'M', 1, 'APARELHO CROSS OVER', 1
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
    licitacao_id, numero_item, catalogo_codigo_item, material_ou_servico, quantidade, descricao, catalogo_id
  ) values (
    v_lic_par3_id, 1, '480144', 'M', 1, 'APARELHO CROSS OVER', 1
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
  declare
    v_cobertura text;
    v_eh_ata boolean;
    v_valor_homologado numeric;
    v_valor_ata numeric;
  begin
    select total_vendas_homologadas, total_certames, itens_praticados,
           cobertura_predominante, valor_homologado_contratacao, valor_registrado_ata
      into v_total_vendas_pncp, v_total_certames_pncp, v_itens_pncp,
           v_cobertura, v_valor_homologado, v_valor_ata
      from public.v_bi_fornecedor_historico
     where cnpj = '11222333000181';

    raise notice 'CASO 1: total_vendas_homologadas = %, total_certames = %, cobertura = %, valor_homologado = %, valor_ata = %',
                 v_total_vendas_pncp, v_total_certames_pncp, v_cobertura, v_valor_homologado, v_valor_ata;

    if v_total_vendas_pncp is distinct from 1 then
      raise exception 'TESTE CASO 1 FALHOU: esperado 1 venda homologada, obtido %', v_total_vendas_pncp;
    end if;

    if v_total_certames_pncp is distinct from 1 then
      raise exception 'TESTE CASO 1 FALHOU: esperado 1 certame, obtido %', v_total_certames_pncp;
    end if;

    if v_cobertura is distinct from 'catmat_oficial' then
      raise exception 'TESTE CASO 1 FALHOU: esperado cobertura catmat_oficial, obtido %', v_cobertura;
    end if;
  end;

  -- Verificação Caso 2 (Paradigma 3 certames sem colisão):
  declare
    v_cobertura_par text;
  begin
    select total_vendas_homologadas, total_certames, itens_praticados, cobertura_predominante
      into v_total_vendas_par, v_total_certames_par, v_itens_par, v_cobertura_par
      from public.v_bi_fornecedor_historico
     where cnpj = '99999999000199';

    raise notice 'CASO 2: total_vendas_homologadas = %, total_certames = %, cobertura = %',
                 v_total_vendas_par, v_total_certames_par, v_cobertura_par;

    if v_total_vendas_par is distinct from 3 then
      raise exception 'TESTE CASO 2 FALHOU: esperado 3 vendas homologadas Paradigma, obtido %', v_total_vendas_par;
    end if;

    if v_total_certames_par is distinct from 3 then
      raise exception 'TESTE CASO 2 FALHOU: esperado 3 certames Paradigma, obtido %', v_total_certames_par;
    end if;
  end;

  -- Verificação Caso 3 (Cobertura pdm_palavra via catmat_pdm_palavras):
  declare
    v_lic_palavra_id bigint;
    v_cobertura_palavra text;
  begin
    -- Insere regra de palavra para PDM 2640 se não existir
    insert into public.catmat_pdm_palavras (codigo_pdm, padrao, ativo)
    values (2640, 'halteres? especiais', true)
    on conflict do nothing;

    insert into public.licitacoes_externas (
      fonte, codigo_externo, orgao_cnpj, orgao_nome, data_homologacao, prioridade
    ) values (
      'pncp',
      '11111111000111-1-000001/2026',
      '11111111000111',
      'ORGAO TESTE PALAVRA',
      '2026-09-20'::timestamptz,
      'historico'
    ) returning id into v_lic_palavra_id;

    insert into public.licitacao_itens (
      licitacao_id, numero_item, catalogo_codigo_item, material_ou_servico, quantidade, descricao, catalogo_id
    ) values (
      v_lic_palavra_id, 1, null, 'M', 10, 'HALTERES ESPECIAIS EMBORRACHADOS', null
    );

    insert into public.licitacao_resultados (
      licitacao_id, numero_item, sequencial_resultado, fornecedor_cnpj, fornecedor_nome,
      vencedor, quantidade_homologada, valor_unitario_homologado, valor_total_homologado, data_resultado
    ) values (
      v_lic_palavra_id, 1, 1, '88888888000188', 'FORNECEDOR PALAVRA LTDA',
      true, 10, 50.0, 500.0, '2026-09-20'::timestamptz
    );

    select cobertura_predominante into v_cobertura_palavra
      from public.v_bi_fornecedor_historico
     where cnpj = '88888888000188';

    raise notice 'CASO 3 (pdm_palavra): cobertura = %', v_cobertura_palavra;

    if v_cobertura_palavra is distinct from 'pdm_palavra' then
      raise exception 'TESTE CASO 3 FALHOU: esperado cobertura pdm_palavra, obtido %', v_cobertura_palavra;
    end if;
  end;

  -- ---------------------------------------------------------------------------
  -- CASO 4: Validação da regra do eh_ata_rp / valor_origem (a, b, c, d)
  -- ---------------------------------------------------------------------------
  declare
    v_lic_srp_a bigint;
    v_lic_srp_b bigint;
    v_lic_srp_c bigint;
    v_lic_srp_d bigint;
    v_val_origem text;
    v_val_ata numeric;
    v_val_contrato numeric;
  begin
    -- Setup fornecedor do teste de SRP
    insert into public.fornecedores (cnpj, cnpj_raiz, razao_social, cnae_principal, consulta_status)
    values
      ('77777777000171', '77777777', 'FORNECEDOR SRP A LTDA', 4763602, 'ok'),
      ('77777777000172', '77777777', 'FORNECEDOR SRP B LTDA', 4763602, 'ok'),
      ('77777777000173', '77777777', 'FORNECEDOR SRP C LTDA', 4763602, 'ok'),
      ('77777777000174', '77777777', 'FORNECEDOR SRP D LTDA', 4763602, 'ok')
    on conflict (cnpj) do nothing;

    -- (a) srp=true com objeto sem o texto, esperando ata_rp
    insert into public.licitacoes_externas (
      fonte, codigo_externo, orgao_cnpj, orgao_nome, data_homologacao, prioridade, raw, modalidade, objeto
    ) values (
      'pncp', '77777777000171-1-000001/2026', '77777777000171', 'ORGAO A', '2026-09-21'::timestamptz,
      'historico', jsonb_build_object('srp', true), 'Pregão Eletrônico', 'Aquisição de esteiras para ginásio'
    ) returning id into v_lic_srp_a;

    insert into public.licitacao_itens (licitacao_id, numero_item, catalogo_codigo_item, material_ou_servico, quantidade, catalogo_id)
    values (v_lic_srp_a, 1, '480144', 'M', 1, 1);

    insert into public.licitacao_resultados (licitacao_id, numero_item, sequencial_resultado, fornecedor_cnpj, vencedor, valor_unitario_homologado, valor_total_homologado, data_resultado)
    values (v_lic_srp_a, 1, 1, '77777777000171', true, 1000.0, 1000.0, '2026-09-21'::timestamptz);

    select valor_registrado_ata, valor_homologado_contratacao into v_val_ata, v_val_contrato
      from public.v_bi_fornecedor_historico where cnpj = '77777777000171';
    raise notice 'CASO 4a (srp=true): valor_registrado_ata = %, valor_homologado_contratacao = %', v_val_ata, v_val_contrato;
    if v_val_ata is distinct from 1000.0 or v_val_contrato is not null then
      raise exception 'TESTE CASO 4a FALHOU: esperado valor_registrado_ata = 1000 e valor_homologado_contratacao null';
    end if;

    -- (b) srp nulo com objeto "REGISTRO DE PREÇOS para aquisição de esteira", esperando ata_rp
    insert into public.licitacoes_externas (
      fonte, codigo_externo, orgao_cnpj, orgao_nome, data_homologacao, prioridade, raw, modalidade, objeto
    ) values (
      'pncp', '77777777000172-1-000001/2026', '77777777000172', 'ORGAO B', '2026-09-22'::timestamptz,
      'historico', '{}'::jsonb, 'Pregão Eletrônico', 'REGISTRO DE PREÇOS para aquisição de esteira'
    ) returning id into v_lic_srp_b;

    insert into public.licitacao_itens (licitacao_id, numero_item, catalogo_codigo_item, material_ou_servico, quantidade, catalogo_id)
    values (v_lic_srp_b, 1, '480144', 'M', 1, 1);

    insert into public.licitacao_resultados (licitacao_id, numero_item, sequencial_resultado, fornecedor_cnpj, vencedor, valor_unitario_homologado, valor_total_homologado, data_resultado)
    values (v_lic_srp_b, 1, 1, '77777777000172', true, 2000.0, 2000.0, '2026-09-22'::timestamptz);

    select valor_registrado_ata, valor_homologado_contratacao into v_val_ata, v_val_contrato
      from public.v_bi_fornecedor_historico where cnpj = '77777777000172';
    raise notice 'CASO 4b (srp nulo com texto): valor_registrado_ata = %, valor_homologado_contratacao = %', v_val_ata, v_val_contrato;
    if v_val_ata is distinct from 2000.0 or v_val_contrato is not null then
      raise exception 'TESTE CASO 4b FALHOU: esperado valor_registrado_ata = 2000 e valor_homologado_contratacao null';
    end if;

    -- (c) srp=false com o texto no objeto, esperando contratacao_direta
    insert into public.licitacoes_externas (
      fonte, codigo_externo, orgao_cnpj, orgao_nome, data_homologacao, prioridade, raw, modalidade, objeto
    ) values (
      'pncp', '77777777000173-1-000001/2026', '77777777000173', 'ORGAO C', '2026-09-23'::timestamptz,
      'historico', jsonb_build_object('srp', false), 'Pregão Eletrônico', 'REGISTRO DE PREÇOS para aquisição de esteira'
    ) returning id into v_lic_srp_c;

    insert into public.licitacao_itens (licitacao_id, numero_item, catalogo_codigo_item, material_ou_servico, quantidade, catalogo_id)
    values (v_lic_srp_c, 1, '480144', 'M', 1, 1);

    insert into public.licitacao_resultados (licitacao_id, numero_item, sequencial_resultado, fornecedor_cnpj, vencedor, valor_unitario_homologado, valor_total_homologado, data_resultado)
    values (v_lic_srp_c, 1, 1, '77777777000173', true, 3000.0, 3000.0, '2026-09-23'::timestamptz);

    select valor_registrado_ata, valor_homologado_contratacao into v_val_ata, v_val_contrato
      from public.v_bi_fornecedor_historico where cnpj = '77777777000173';
    raise notice 'CASO 4c (srp=false): valor_registrado_ata = %, valor_homologado_contratacao = %', v_val_ata, v_val_contrato;
    if v_val_contrato is distinct from 3000.0 or v_val_ata is not null then
      raise exception 'TESTE CASO 4c FALHOU: esperado valor_homologado_contratacao = 3000 e valor_registrado_ata null';
    end if;

    -- (d) certame ext: (fonte paradigma) com raw sem a chave srp, modalidade 'Pregão Eletrônico - Registro de Preços' e objeto sem o texto, esperando ata_rp
    insert into public.licitacoes_externas (
      fonte, modulo, id_externo, orgao_nome, data_homologacao, prioridade, raw, modalidade, objeto
    ) values (
      'paradigma_teste', 59, 999, 'SESI TESTE SRP', '2026-09-24'::timestamptz,
      'historico', '{}'::jsonb, 'Pregão Eletrônico - Registro de Preços', 'Aquisição de esteiras esportivas'
    ) returning id into v_lic_srp_d;

    insert into public.licitacao_itens (licitacao_id, numero_item, catalogo_codigo_item, material_ou_servico, quantidade, catalogo_id)
    values (v_lic_srp_d, 1, '480144', 'M', 1, 1);

    insert into public.licitacao_resultados (licitacao_id, numero_item, sequencial_resultado, fornecedor_cnpj, vencedor, valor_unitario_homologado, valor_total_homologado, data_resultado)
    values (v_lic_srp_d, 1, 1, '77777777000174', true, 4000.0, 4000.0, '2026-09-24'::timestamptz);

    select valor_registrado_ata, valor_homologado_contratacao into v_val_ata, v_val_contrato
      from public.v_bi_fornecedor_historico where cnpj = '77777777000174';
    raise notice 'CASO 4d (paradigma modalidade SRP): valor_registrado_ata = %, valor_homologado_contratacao = %', v_val_ata, v_val_contrato;
    if v_val_ata is distinct from 4000.0 or v_val_contrato is not null then
      raise exception 'TESTE CASO 4d FALHOU: esperado valor_registrado_ata = 4000 e valor_homologado_contratacao null';
    end if;
  end;

  raise notice 'SUCESSO: Todos os testes reais contra v_bi_fornecedor_historico passaram com louvor!';
end $$;

rollback;
