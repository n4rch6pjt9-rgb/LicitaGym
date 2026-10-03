-- =============================================================================
-- Verificação da 20261002160000_bi_cruzamento_followup_correcoes (review do PR #123)
-- Dados fictícios. begin ... rollback: nada persiste. Trava contra produção (> 100 licitações).
--   A. órgão sem CNPJ: chave sem-cnpj:<fonte>:md5(nome normalizado); sem nome: NULL (não conta)
--   B. certame: fonte + modulo/id_externo; sem identificador externo: NULL (não conta em total_certames)
--   C. vários resultados do mesmo item não colapsam
--   D. mesma venda em Pesquisa de Preço e ARP: ARP vence (valor_registrado_ata)
--   E. 14.133: orgao_nome oficial (public.orgaos) ou NULL, nunca o CNPJ; sem unidade/CNPJ: NULL
--   F. v_bi_orgaos_match: nome/UF de origem preservados; dinheiro ausente = NULL; resultados não colapsam
--   G. constraints: NULLS NOT DISTINCT em uq_pca_pgc_item e uq_resultados_14133; id_compra_item obrigatório;
--      atas_rp_itens com a chave da 20261003020000 (#142), uq_atas_rp_itens_lote_fornecedor =
--      (ata, UASG gerenciadora, numero_grupo, item, ni_fornecedor) NULLS NOT DISTINCT, sem a uq_atas_rp_itens antiga:
--      vencedores diferentes do mesmo item coexistem, lote diferente não colide, mesma chave (lote NULL) colide,
--      upsert pelo alvo do coletor compras_arp atualiza a linha certa, ni_fornecedor NOT NULL, numero_grupo NULL ou > 0
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
  v_id bigint;
  v_id2 bigint;
  v_id3 bigint;
  v_n int;
  v_txt text;
  v_num numeric;
  v_num2 numeric;
  v_j jsonb;
  v_ok boolean;
  v_uuid uuid;
begin
  -- Escopo CATMAT fictício mínimo (PDM 2640 / item 480144)
  insert into public.catmat_grupos (codigo_grupo, nome, payload_hash) values (78, 'GRUPO TESTE', 'h78') on conflict (codigo_grupo) do nothing;
  insert into public.catmat_classes (codigo_grupo, codigo_classe, nome, payload_hash) values (78, 7830, 'CLASSE TESTE', 'h7830') on conflict (codigo_grupo, codigo_classe) do nothing;
  insert into public.catmat_pdms (codigo_pdm, codigo_grupo, codigo_classe, nome_pdm, payload_hash) values (2640, 78, 7830, 'PDM TESTE', 'h2640') on conflict (codigo_pdm) do nothing;
  insert into public.catalogo_empresa_catmat (nivel, codigo_grupo, codigo_classe, codigo_pdm, nome_snapshot, incluido)
  values ('pdm', 78, 7830, 2640, 'PDM TESTE', true) on conflict do nothing;
  insert into public.catmat_itens (codigo_item, codigo_pdm, descricao_item) values (480144, '2640', 'ITEM TESTE') on conflict (codigo_item) do nothing;
  insert into public.fontes_externas (slug, entidade, plataforma, base_url, modo_coleta) values
    ('pncp', 'PNCP', 'pncp', 'https://pncp.gov.br', 'automatico'),
    ('portal_teste', 'PORTAL TESTE', 'paradigma', 'https://portal.teste.invalid', 'automatico')
  on conflict (slug) do nothing;

  -- ---------------------------------------------------------------- A + B + C
  -- Fornecedor 21111111000101: 3 certames do portal_teste sem CNPJ do órgão.
  --   cert 1 (59/501) e cert 2 (59/502): mesma unidade com grafia diferente  -> 1 órgão sem-cnpj
  --   cert 3 (sem modulo/id_externo/codigo_externo, sem nome de órgão)        -> órgão NULL, certame NULL
  --   cert 1 tem 2 resultados do mesmo item (sequencial 1 e 2)                -> não colapsam
  insert into public.licitacoes_externas (fonte, modulo, id_externo, unidade_compradora, data_homologacao, prioridade)
  values ('portal_teste', 59, 501, 'Unidade  Teste São João', '2026-09-01', 'historico') returning id into v_id;
  insert into public.licitacao_itens (licitacao_id, numero_item, catalogo_codigo_item, material_ou_servico, quantidade) values (v_id, 1, '480144', 'M', 2);
  insert into public.licitacao_resultados (licitacao_id, numero_item, sequencial_resultado, fornecedor_cnpj, fornecedor_nome, vencedor, quantidade_homologada, valor_unitario_homologado, valor_total_homologado, data_resultado)
  values (v_id, 1, 1, '21111111000101', 'FORNECEDOR A TESTE LTDA', true, 1, 100, 100, '2026-09-01'),
         (v_id, 1, 2, '21111111000101', 'FORNECEDOR A TESTE LTDA', true, 1, 110, 110, '2026-09-01');

  insert into public.licitacoes_externas (fonte, modulo, id_externo, orgao_nome, data_homologacao, prioridade)
  values ('portal_teste', 59, 502, 'UNIDADE TESTE SAO JOAO ', '2026-09-02', 'historico') returning id into v_id2;
  insert into public.licitacao_itens (licitacao_id, numero_item, catalogo_codigo_item, material_ou_servico, quantidade) values (v_id2, 1, '480144', 'M', 1);
  insert into public.licitacao_resultados (licitacao_id, numero_item, sequencial_resultado, fornecedor_cnpj, fornecedor_nome, vencedor, quantidade_homologada, valor_unitario_homologado, valor_total_homologado, data_resultado)
  values (v_id2, 1, 1, '21111111000101', 'FORNECEDOR A TESTE LTDA', true, 1, 120, 120, '2026-09-02');

  insert into public.licitacoes_externas (fonte, data_homologacao, prioridade)
  values ('portal_teste', '2026-09-03', 'historico') returning id into v_id3;
  insert into public.licitacao_itens (licitacao_id, numero_item, catalogo_codigo_item, material_ou_servico, quantidade) values (v_id3, 1, '480144', 'M', 1);
  insert into public.licitacao_resultados (licitacao_id, numero_item, sequencial_resultado, fornecedor_cnpj, fornecedor_nome, vencedor, quantidade_homologada, valor_unitario_homologado, valor_total_homologado, data_resultado)
  values (v_id3, 1, 1, '21111111000101', 'FORNECEDOR A TESTE LTDA', true, 1, 130, 130, '2026-09-03');

  select total_vendas_homologadas, total_certames, total_orgaos, orgaos_clientes, valor_total_vendido
    into v_n, v_id, v_id2, v_j, v_num
    from public.v_bi_fornecedor_historico where cnpj = '21111111000101';
  raise notice 'A/B/C: vendas = %, certames = %, orgaos = %, valor = %, orgaos_clientes = %', v_n, v_id, v_id2, v_num, v_j;
  if v_n is distinct from 4 then raise exception 'CASO C FALHOU: esperado 4 vendas (2 resultados do mesmo item + 2), obtido %', v_n; end if;
  if v_num is distinct from 460 then raise exception 'CASO C FALHOU: esperado valor 460, obtido %', v_num; end if;
  if v_id is distinct from 2 then raise exception 'CASO B FALHOU: esperado 2 certames identificados (59/501, 59/502), obtido %', v_id; end if;
  if v_id2 is distinct from 1 then raise exception 'CASO A FALHOU: esperado 1 órgão (sem-cnpj, mesmo nome), obtido %', v_id2; end if;
  if jsonb_array_length(v_j) is distinct from 1 then raise exception 'CASO A FALHOU: esperado 1 órgão em orgaos_clientes, obtido %', v_j; end if;
  v_txt := 'sem-cnpj:portal_teste:' || md5(btrim(regexp_replace(public.norm_txt('Unidade  Teste São João'), '\s+', ' ', 'g')));
  if v_j->0->>'orgao_identificador' is distinct from v_txt then
    raise exception 'CASO A FALHOU: chave esperada %, obtida %', v_txt, v_j->0->>'orgao_identificador';
  end if;
  if (v_j->0->>'frequencia_vendas')::int is distinct from 3 then
    raise exception 'CASO A FALHOU: esperado frequência 3 no órgão sem-cnpj, obtido %', v_j->0->>'frequencia_vendas';
  end if;

  -- ---------------------------------------------------------------- D
  -- Mesma venda (fornecedor 22222222000102, compra 99999999900020261, item 1): Pesquisa de Preço mais completa
  -- (marca) x ARP. A ARP vence: valor vai para valor_registrado_ata.
  insert into public.precos_praticados_itens (id_compra, id_item_compra, numero_item_compra, codigo_item_catalogo, codigo_pdm, ni_fornecedor, nome_fornecedor, preco_unitario, quantidade, marca, data_resultado, codigo_uasg, nome_uasg)
  values ('99999999900020261', 1, 1, 480144, '2640', '22222222000102', 'FORNECEDOR D TESTE LTDA', 500, 2, 'MARCA TESTE', '2026-09-10', '999002', 'UASG TESTE D');
  insert into public.atas_rp_itens (numero_ata_registro_preco, codigo_unidade_gerenciadora, nome_unidade_gerenciadora, numero_item, codigo_item, codigo_pdm, ni_fornecedor, nome_fornecedor, quantidade_homologada_item, valor_unitario, valor_total, data_vigencia_inicial, id_compra, tipo_item)
  values ('00001/2026', 999002, 'UASG TESTE D', '1', 480144, '2640', '22222222000102', 'FORNECEDOR D TESTE LTDA', 2, 500, 1000, '2026-09-10', '99999999900020261', 'Material');

  select total_vendas_homologadas, valor_registrado_ata, valor_homologado_contratacao into v_n, v_num, v_num2
    from public.v_bi_fornecedor_historico where cnpj = '22222222000102';
  raise notice 'D: vendas = %, ata = %, contratacao = %', v_n, v_num, v_num2;
  if v_n is distinct from 1 or v_num is distinct from 1000 or v_num2 is not null then
    raise exception 'CASO D FALHOU: esperado 1 venda, valor_registrado_ata = 1000 e contratação NULL; obtido %, %, %', v_n, v_num, v_num2;
  end if;

  -- ---------------------------------------------------------------- E
  -- 14.133: CNPJ fora de public.orgaos -> orgao_nome NULL (nunca o CNPJ); linha sem unidade nem CNPJ -> órgão NULL.
  insert into public.resultados_itens_14133 (id_compra_item, id_compra, orgao_entidade_cnpj, unidade_orgao_codigo_unidade, numero_item_pncp, sequencial_resultado, ni_fornecedor, nome_fornecedor, material_ou_servico, quantidade_homologada, valor_unitario_homologado, valor_total_homologado, data_resultado_pncp, codigo_item_catalogo, codigo_pdm)
  values ('TESTE-E-1', 'TESTE-E', '33333333000103', null, 1, 1, '23333333000103', 'FORNECEDOR E TESTE LTDA', 'M', 1, 50, 50, '2026-09-11', 480144, '2640'),
         ('TESTE-E-2', 'TESTE-E2', null, null, 1, 1, '23333333000103', 'FORNECEDOR E TESTE LTDA', 'M', 1, 60, 60, '2026-09-12', 480144, '2640');

  select orgaos_clientes, total_orgaos into v_j, v_n from public.v_bi_fornecedor_historico where cnpj = '23333333000103';
  raise notice 'E: orgaos = %, orgaos_clientes = %', v_n, v_j;
  if v_n is distinct from 1 or jsonb_array_length(v_j) is distinct from 1 then
    raise exception 'CASO E FALHOU: esperado 1 órgão identificado (o sem unidade/CNPJ fica NULL), obtido % / %', v_n, v_j;
  end if;
  if v_j->0->>'orgao_identificador' is distinct from '33333333000103' or v_j->0->'orgao_nome' is distinct from 'null'::jsonb then
    raise exception 'CASO E FALHOU: esperado identificador 33333333000103 e orgao_nome null, obtido %', v_j->0;
  end if;

  insert into public.entidades (cnpj, razao_social, tipo) values ('33333333000103', 'ORGAO OFICIAL TESTE E', 'orgao') returning id into v_uuid;
  insert into public.orgaos (entidade_id, cnpj, razao_social) values (v_uuid, '33333333000103', 'ORGAO OFICIAL TESTE E');
  select orgaos_clientes into v_j from public.v_bi_fornecedor_historico where cnpj = '23333333000103';
  if v_j->0->>'orgao_nome' is distinct from 'ORGAO OFICIAL TESTE E' then
    raise exception 'CASO E FALHOU: esperado nome oficial ORGAO OFICIAL TESTE E, obtido %', v_j->0;
  end if;

  if exists (select 1 from public.v_bi_fornecedor_historico h, jsonb_array_elements(h.orgaos_clientes) e
             where e->>'orgao_identificador' ~ '^(org:|uasg:desconhecida)') then
    raise exception 'CASO A/E FALHOU: identificador de órgão inventado (org:/uasg:desconhecida) na view';
  end if;

  -- ---------------------------------------------------------------- F
  -- Órgão 44444444000104 fora de public.orgaos: nome e UF de origem; dois vencedores do mesmo item sem valor
  -- -> qtd_itens_homologados 2 e valor_homologado NULL.
  insert into public.licitacoes_externas (fonte, codigo_externo, orgao_cnpj, orgao_nome, uf, data_homologacao, prioridade)
  values ('pncp', '44444444000104-1-000001/2026', '44444444000104', 'ORGAO ORIGEM TESTE F', 'SC', '2026-09-15', 'historico') returning id into v_id;
  insert into public.licitacao_itens (licitacao_id, numero_item, catalogo_codigo_item, material_ou_servico, quantidade) values (v_id, 1, '480144', 'M', 2);
  insert into public.licitacao_resultados (licitacao_id, numero_item, sequencial_resultado, fornecedor_cnpj, fornecedor_nome, vencedor, quantidade_homologada, valor_unitario_homologado, valor_total_homologado, data_resultado)
  values (v_id, 1, 1, '24444444000104', 'FORNECEDOR F1 TESTE LTDA', true, 1, null, null, '2026-09-15'),
         (v_id, 1, 2, '25555555000105', 'FORNECEDOR F2 TESTE LTDA', true, 1, null, null, '2026-09-15');

  select orgao_nome, uf, qtd_itens_homologados, valor_homologado, valor_planejado_pca into v_txt, v_j, v_n, v_num, v_num2
    from (select orgao_nome, to_jsonb(uf) as uf, qtd_itens_homologados, valor_homologado, valor_planejado_pca
            from public.v_bi_orgaos_match where orgao_cnpj = '44444444000104') x;
  raise notice 'F: nome = %, uf = %, itens = %, valor = %, planejado = %', v_txt, v_j, v_n, v_num, v_num2;
  if v_txt is distinct from 'ORGAO ORIGEM TESTE F' or v_j is distinct from '"SC"'::jsonb then
    raise exception 'CASO F FALHOU: esperado nome/UF de origem (ORGAO ORIGEM TESTE F / SC), obtido % / %', v_txt, v_j;
  end if;
  if v_n is distinct from 2 then raise exception 'CASO F FALHOU: esperado 2 resultados do mesmo item, obtido %', v_n; end if;
  if v_num is not null or v_num2 is not null then
    raise exception 'CASO F FALHOU: valores monetários sem dado oficial devem ser NULL, obtido % / %', v_num, v_num2;
  end if;

  -- 14.133 do órgão 33333333000103 (agora em public.orgaos) aparece com o nome oficial, não o CNPJ
  select orgao_nome into v_txt from public.v_bi_orgaos_match where orgao_cnpj = '33333333000103';
  if v_txt is distinct from 'ORGAO OFICIAL TESTE E' then
    raise exception 'CASO F FALHOU: esperado nome oficial do órgão 14.133, obtido %', v_txt;
  end if;
  if exists (select 1 from public.v_bi_orgaos_match where orgao_nome = orgao_cnpj) then
    raise exception 'CASO F FALHOU: v_bi_orgaos_match expõe CNPJ como nome';
  end if;

  -- ---------------------------------------------------------------- G
  select bool_and(pg_get_constraintdef(c.oid) like 'UNIQUE NULLS NOT DISTINCT%') and count(*) = 2 into v_ok
    from pg_constraint c
   where c.conname in ('uq_pca_pgc_item', 'uq_resultados_14133');
  if v_ok is distinct from true then raise exception 'CASO G FALHOU: uq_pca_pgc_item/uq_resultados_14133 sem NULLS NOT DISTINCT'; end if;

  -- atas_rp_itens: chave da 20261003020000 (#142). A uq_atas_rp_itens antiga (ata, UASG, item) ignorava o fornecedor.
  select pg_get_constraintdef(c.oid) into v_txt
    from pg_constraint c
   where c.conrelid = 'public.atas_rp_itens'::regclass and c.conname = 'uq_atas_rp_itens_lote_fornecedor';
  if v_txt is distinct from
     'UNIQUE NULLS NOT DISTINCT (numero_ata_registro_preco, codigo_unidade_gerenciadora, numero_grupo, numero_item, ni_fornecedor)' then
    raise exception 'CASO G FALHOU: uq_atas_rp_itens_lote_fornecedor ausente ou com outra definição: %', v_txt;
  end if;
  if exists (select 1 from pg_constraint where conrelid = 'public.atas_rp_itens'::regclass and conname = 'uq_atas_rp_itens') then
    raise exception 'CASO G FALHOU: a chave antiga uq_atas_rp_itens (sem fornecedor) ainda existe';
  end if;

  -- Dois vencedores do mesmo item da mesma ata (lote NULL): coexistem (com a chave antiga o 2º colidia).
  insert into public.atas_rp_itens (numero_ata_registro_preco, codigo_unidade_gerenciadora, numero_item, ni_fornecedor, valor_unitario)
  values ('00077/2026', 999077, '1', '77777777000101', 100), ('00077/2026', 999077, '1', '77777777000102', 110);
  -- Mesmo fornecedor e item em lotes diferentes: não colidem.
  insert into public.atas_rp_itens (numero_ata_registro_preco, codigo_unidade_gerenciadora, numero_grupo, numero_item, ni_fornecedor, valor_unitario)
  values ('00077/2026', 999077, 1, '2', '77777777000101', 200), ('00077/2026', 999077, 2, '2', '77777777000101', 210);
  -- Mesma chave com lote NULL: colide (NULLS NOT DISTINCT; sem isso o NULL duplicaria a linha).
  begin
    insert into public.atas_rp_itens (numero_ata_registro_preco, codigo_unidade_gerenciadora, numero_item, ni_fornecedor, valor_unitario)
    values ('00077/2026', 999077, '1', '77777777000101', 999);
    raise exception 'CASO G FALHOU: aceitou chave repetida em atas_rp_itens com numero_grupo NULL';
  exception when unique_violation then null;
  end;
  -- Upsert com o alvo do coletor (compras_arp.CONFLITO_ARP) atualiza só a linha daquele fornecedor.
  insert into public.atas_rp_itens (numero_ata_registro_preco, codigo_unidade_gerenciadora, numero_item, ni_fornecedor, valor_unitario)
  values ('00077/2026', 999077, '1', '77777777000102', 120)
  on conflict (numero_ata_registro_preco, codigo_unidade_gerenciadora, numero_grupo, numero_item, ni_fornecedor)
  do update set valor_unitario = excluded.valor_unitario;
  select count(*), sum(valor_unitario) into v_n, v_num
    from public.atas_rp_itens where numero_ata_registro_preco = '00077/2026' and codigo_unidade_gerenciadora = 999077;
  select valor_unitario into v_num2
    from public.atas_rp_itens where numero_ata_registro_preco = '00077/2026' and numero_item = '1' and ni_fornecedor = '77777777000102';
  raise notice 'G: atas_rp_itens linhas = %, soma = %, fornecedor 2 = %', v_n, v_num, v_num2;
  if v_n is distinct from 4 or v_num is distinct from 630 or v_num2 is distinct from 120 then
    raise exception 'CASO G FALHOU: esperado 4 linhas, soma 630 e fornecedor 2 = 120 após upsert; obtido %, %, %', v_n, v_num, v_num2;
  end if;
  -- Sem fornecedor a linha não tem chave; lote 0 não pode virar chave diferente de "sem lote" (NULL).
  begin
    insert into public.atas_rp_itens (numero_ata_registro_preco, codigo_unidade_gerenciadora, numero_item, ni_fornecedor)
    values ('00077/2026', 999077, '3', null);
    raise exception 'CASO G FALHOU: atas_rp_itens aceitou ni_fornecedor NULL';
  exception when not_null_violation then null;
  end;
  begin
    insert into public.atas_rp_itens (numero_ata_registro_preco, codigo_unidade_gerenciadora, numero_grupo, numero_item, ni_fornecedor)
    values ('00077/2026', 999077, 0, '3', '77777777000101');
    raise exception 'CASO G FALHOU: atas_rp_itens aceitou numero_grupo = 0';
  exception when check_violation then null;
  end;

  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'resultados_itens_14133'
                  and column_name = 'id_compra_item' and is_nullable = 'NO') then
    raise exception 'CASO G FALHOU: resultados_itens_14133.id_compra_item deveria ser NOT NULL';
  end if;
  begin
    insert into public.resultados_itens_14133 (id_compra_item, sequencial_resultado) values (null, 1);
    raise exception 'CASO G FALHOU: aceitou id_compra_item NULL';
  exception when not_null_violation then null;
  end;

  raise notice 'SUCESSO: bi_cruzamento_followup_correcoes ok';
end $$;

rollback;
