-- Regra (decisão do Marcelo, 09/10/2026): em v_bi_pca_radar, item do PNCP com PDM vindo do campo oficial pdmCodigo
-- (pca_itens.pdm_codigo_origem) e existente em catmat_pdms é aderência confirmada, mesmo sem vínculo em pca_item_pdm.
-- Caso real: Academia Nacional de Polícia, item 435 do plano 00394494000136-0-000032/2026 (PDM 18452) aparecia
-- "Não confirmada" porque o sync do PCA não completava e não gravava o vínculo.
-- Falha com EXCEPTION se:
--   A) item com PDM oficial e sem vínculo não sair confirmado (metodo 'pncp_pdm_origem');
--   B) item com vínculo confirmado deixar de sair confirmado (metodo 'pncp_pdm_confirmado');
--   C) item identificado só por codigoItem (catmat_itens), sem PDM oficial nem vínculo, sair confirmado.
-- Fixtures fictícias (grupo 99, PDM 999911, CNPJ 99000002000100, ano 2099); termina em rollback.

begin;

do $chk$
declare
  v_plano uuid;
  v_item_vinculo uuid;
  v_a boolean; v_a_met text;
  v_b boolean; v_b_met text;
  v_c boolean; v_c_met text;
begin
  insert into public.catmat_grupos (codigo_grupo, nome, status, payload_hash) values (99, 'CHK GRUPO', true, 'chk');
  insert into public.catmat_classes (codigo_grupo, codigo_classe, nome, status, payload_hash) values (99, 9901, 'CHK CLASSE', true, 'chk');
  insert into public.catmat_pdms (codigo_pdm, codigo_grupo, codigo_classe, nome_pdm, status, payload_hash)
    values (999911, 99, 9901, 'CHK PDM', true, 'chk');
  insert into public.catalogo_empresa_catmat (nivel, codigo_grupo, codigo_classe, codigo_pdm, nome_snapshot)
    values ('pdm', 99, 9901, 999911, 'CHK PDM');
  insert into public.catmat_itens (codigo_item, codigo_grupo, codigo_classe, codigo_pdm, descricao_item)
    values (999911001, 99, 9901, '999911', 'CHK ITEM');

  insert into public.pca_planos (id_pca_pncp, ano_exercicio, orgao_cnpj, unidade_codigo, titulo, payload_hash, ativo)
    values ('CHK-RADAR-PDM-OFICIAL', 2099, '99000002000100', '999998', 'CHK ACADEMIA', 'chk', true)
    returning id into v_plano;

  -- A: PDM oficial, sem vínculo (como o item 435)
  insert into public.pca_itens (pca_plano_id, numero_item, pdm_codigo_origem, valor_total_estimado,
                                data_prevista_contratacao, payload_hash, ativo)
    values (v_plano, 1, '999911', 125000, '2099-10-01', 'chk', true);
  -- B: PDM oficial com vínculo confirmado
  insert into public.pca_itens (pca_plano_id, numero_item, pdm_codigo_origem, valor_total_estimado,
                                data_prevista_contratacao, payload_hash, ativo)
    values (v_plano, 2, '999911', 1000, '2099-10-01', 'chk', true)
    returning id into v_item_vinculo;
  insert into public.pca_item_pdm (pca_item_id, codigo_pdm, tipo_correspondencia, evidencia, confirmado)
    values (v_item_vinculo, 999911, 'exata', 'pncp:pdmCodigo', true);
  -- C: só codigoItem (sem pdmCodigo oficial, sem vínculo)
  insert into public.pca_itens (pca_plano_id, numero_item, codigo_item_origem, valor_total_estimado,
                                data_prevista_contratacao, payload_hash, ativo)
    values (v_plano, 3, '999911001', 500, '2099-10-01', 'chk', true);

  select casamento_confirmado, metodo_identificacao into v_a, v_a_met
    from public.v_bi_pca_radar where orgao_cnpj = '99000002000100' and ano_pca = 2099 and numero_item_pncp = 1;
  select casamento_confirmado, metodo_identificacao into v_b, v_b_met
    from public.v_bi_pca_radar where orgao_cnpj = '99000002000100' and ano_pca = 2099 and numero_item_pncp = 2;
  select casamento_confirmado, metodo_identificacao into v_c, v_c_met
    from public.v_bi_pca_radar where orgao_cnpj = '99000002000100' and ano_pca = 2099 and numero_item_pncp = 3;

  if v_a is not true or v_a_met is distinct from 'pncp_pdm_origem' then
    raise exception 'pca_radar_pdm_oficial_check A: PDM oficial sem vínculo deveria ser confirmado (veio %, %)',
      coalesce(v_a::text, 'NULL'), coalesce(v_a_met, 'NULL');
  end if;
  if v_b is not true or v_b_met is distinct from 'pncp_pdm_confirmado' then
    raise exception 'pca_radar_pdm_oficial_check B: vínculo confirmado deveria continuar confirmado (veio %, %)',
      coalesce(v_b::text, 'NULL'), coalesce(v_b_met, 'NULL');
  end if;
  if v_c is not false or v_c_met is distinct from 'pncp_catmat_item' then
    raise exception 'pca_radar_pdm_oficial_check C: item só por codigoItem não pode sair confirmado (veio %, %)',
      coalesce(v_c::text, 'NULL'), coalesce(v_c_met, 'NULL');
  end if;
  raise notice 'SUCESSO: pca_radar_pdm_oficial_check: PDM oficial confirmado, vínculo mantido, codigoItem sozinho não';
end $chk$;

rollback;
