-- =============================================================================
-- Verificação da 20261004005000_catmat_item_atributo_ancoras
-- Dados fictícios. begin ... rollback: nada persiste. Trava contra produção (> 100 licitações).
--   A. estrutura: tabelas com RLS, view catmat_pdm_ancoras_nucleo com security_invoker, catmat_item_pdm.nome_item gerada
--   B. ACL: anon nada; authenticated só lê as duas tabelas (não a view); funções só service_role
--   C. funções puras: cabeça e atributos da descrição ("2,0 KG" não quebra), variantes de plural, tokens sem o
--      enchimento inicial ("LOTE ÚNICO - Item 3 -", "MAT.", "(ID131043)", "kit 10"), sinônimo ergonômica ~ ergométrica
--      (decisão de 03/10/2026 19:47 BRT), palavras da âncora sem conectivos
--   D. catmat_item_atributo_sincronizar: descrição vira linhas; característica do Compras.gov tem precedência
--   E. catmat_itens_ancorados: 1ª palavra do item = núcleo (com plural), demais palavras nas 11 seguintes;
--      item de serviço ('S') e núcleo em outra posição não casam
--   F. catmat_gerar_ancoras() em dry-run (padrão) não grava nada
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
  v_rel text;
  v_fn text;
  v_n int;
  v_txt text;
  v_lic bigint;
  v_antes int;
begin
  -- A
  foreach v_rel in array array['catmat_item_atributo', 'catmat_pdm_ancoras'] loop
    if not (select c.relrowsecurity from pg_class c where c.oid = ('public.' || v_rel)::regclass) then
      raise exception 'TESTE A FALHOU: % sem RLS', v_rel;
    end if;
  end loop;
  if not exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
                  where n.nspname = 'public' and c.relname = 'catmat_pdm_ancoras_nucleo'
                    and 'security_invoker=true' = any (c.reloptions)) then
    raise exception 'TESTE A FALHOU: catmat_pdm_ancoras_nucleo sem security_invoker = true';
  end if;
  if (select attgenerated from pg_attribute where attrelid = 'public.catmat_item_pdm'::regclass
       and attname = 'nome_item' and not attisdropped) is distinct from 's' then
    raise exception 'TESTE A FALHOU: catmat_item_pdm.nome_item ausente ou não gerada (stored)';
  end if;

  -- B
  foreach v_rel in array array['catmat_item_atributo', 'catmat_pdm_ancoras', 'catmat_pdm_ancoras_nucleo'] loop
    if has_table_privilege('anon', 'public.' || v_rel, 'select')
       or has_table_privilege('anon', 'public.' || v_rel, 'insert')
       or has_table_privilege('authenticated', 'public.' || v_rel, 'insert')
       or has_table_privilege('authenticated', 'public.' || v_rel, 'update')
       or has_table_privilege('authenticated', 'public.' || v_rel, 'delete') then
      raise exception 'TESTE B FALHOU: % com privilégio indevido para anon/authenticated', v_rel;
    end if;
    if not has_table_privilege('service_role', 'public.' || v_rel, 'select') then
      raise exception 'TESTE B FALHOU: % sem select para service_role', v_rel;
    end if;
  end loop;
  if not has_table_privilege('authenticated', 'public.catmat_item_atributo', 'select')
     or not has_table_privilege('authenticated', 'public.catmat_pdm_ancoras', 'select')
     or has_table_privilege('authenticated', 'public.catmat_pdm_ancoras_nucleo', 'select') then
    raise exception 'TESTE B FALHOU: authenticated deveria ler só as duas tabelas, não a view';
  end if;
  if has_sequence_privilege('authenticated', 'public.catmat_pdm_ancoras_id_seq', 'usage')
     or has_sequence_privilege('anon', 'public.catmat_pdm_ancoras_id_seq', 'usage') then
    raise exception 'TESTE B FALHOU: sequência catmat_pdm_ancoras_id_seq acessível a anon/authenticated';
  end if;
  foreach v_fn in array array[
      'public.catmat_cabeca_descricao(text)', 'public.catmat_atributos_da_descricao(text)',
      'public.catmat_norm_ancora(text)', 'public.catmat_palavra_variantes(text)', 'public.catmat_texto_tokens(text)',
      'public.catmat_ancora_palavras(text)', 'public.catmat_itens_ancorados(bigint[])',
      'public.catmat_item_atributo_sincronizar(int[])', 'public.catmat_ancoras_geradas()',
      'public.catmat_gerar_ancoras(boolean)'] loop
    if has_function_privilege('anon', v_fn, 'execute') or has_function_privilege('authenticated', v_fn, 'execute')
       or not has_function_privilege('service_role', v_fn, 'execute') then
      raise exception 'TESTE B FALHOU: ACL de % fora do padrão (só service_role)', v_fn;
    end if;
  end loop;

  -- C
  if public.catmat_cabeca_descricao('ANILHA, MATERIAL: FERRO, PESO: 2,0 KG, COR: PRETA') is distinct from 'ANILHA' then
    raise exception 'TESTE C FALHOU: cabeça da descrição';
  end if;
  select string_agg(ordem || '|' || atributo || '|' || valor, ';' order by ordem) into v_txt
    from public.catmat_atributos_da_descricao('ANILHA, MATERIAL: FERRO, PESO: 2,0 KG, COR: PRETA');
  if v_txt is distinct from '1|MATERIAL|FERRO;2|PESO|2,0 KG;3|COR|PRETA' then
    raise exception 'TESTE C FALHOU: atributos da descrição: %', v_txt;
  end if;
  if public.catmat_palavra_variantes('haltere') is distinct from array['halter', 'haltere', 'halteres']
     or not ('cinturoes' = any (public.catmat_palavra_variantes('cinturao')))
     or public.catmat_palavra_variantes('elastica') is distinct from array['elastica', 'elasticas']
     or not ('ergometrica' = any (public.catmat_palavra_variantes('ergonomica')))
     or not ('ergonomicas' = any (public.catmat_palavra_variantes('ergometrica'))) then
    raise exception 'TESTE C FALHOU: variantes de plural';
  end if;
  if public.catmat_texto_tokens('LOTE ÚNICO - Item 3 - Haltere emborrachado 2 kg') is distinct from array['haltere', 'emborrachado', '2', 'kg']
     or public.catmat_texto_tokens('MAT. ERGONÔMICA colchonete') is distinct from array['ergonomica', 'colchonete']
     or public.catmat_texto_tokens('kit 10 cordas de pular') is distinct from array['cordas', 'de', 'pular']
     or public.catmat_texto_tokens('(ID131043) Esteira ergométrica') is distinct from array['esteira', 'ergometrica']
     or public.catmat_texto_tokens('Material esportivo - matéria prima') is distinct from array['materia', 'prima'] then
    raise exception 'TESTE C FALHOU: tokens do item';
  end if;
  if public.catmat_ancora_palavras('Corda de pular para uso') is distinct from array['corda', 'pular']
     or public.catmat_norm_ancora('Bola de Futsal - Nº 4') is distinct from 'bola de futsal n 4' then
    raise exception 'TESTE C FALHOU: palavras/normalização da âncora';
  end if;

  if strpos(pg_get_functiondef('public.catmat_ancoras_geradas()'::regprocedure), 'ancora <> all (array[''gangorra''])') = 0 then
    raise exception 'TESTE C FALHOU: catmat_ancoras_geradas sem o veto de ''gangorra'' (decisão de 03/10/2026 19:47 BRT)';
  end if;

  -- D (item fictício 999990001 / PDM 999901)
  insert into public.catmat_item_pdm (codigo_item, codigo_pdm, codigo_classe, codigo_grupo, descricao, status_item)
  values (999990001, 999901, 7999, 79, 'HALTERE, MATERIAL: FERRO EMBORRACHADO, PESO: 2,0 KG', true),
         (999990002, 999901, 7999, 79, 'HALTERE, MATERIAL: FERRO', true);
  if (select nome_item from public.catmat_item_pdm where codigo_item = 999990001) is distinct from 'HALTERE' then
    raise exception 'TESTE D FALHOU: nome_item gerado';
  end if;
  v_n := public.catmat_item_atributo_sincronizar(array[999990001, 999990002]);
  if v_n <> 3 or (select string_agg(atributo || '=' || valor || '@' || fonte, ';' order by ordem)
                    from public.catmat_item_atributo where codigo_item = 999990001)
                 is distinct from 'MATERIAL=FERRO EMBORRACHADO@descricao;PESO=2,0 KG@descricao' then
    raise exception 'TESTE D FALHOU: atributos da descrição (% linhas)', v_n;
  end if;
  insert into public.catmat_item_caracteristicas (codigo_item, codigo_caracteristica, nome_caracteristica,
                                                  codigo_valor_caracteristica, nome_valor_caracteristica,
                                                  numero_caracteristica, sigla_unidade_medida, payload_hash)
  values (999990002, 'c1', 'MATERIAL', 'v1', 'AÇO', 1, null, 'h1'),
         (999990002, 'c2', 'PESO', 'v2', '5', 2, 'KG', 'h2');
  v_n := public.catmat_item_atributo_sincronizar(array[999990002]);
  if v_n <> 2 or (select string_agg(atributo || '=' || valor || '@' || fonte, ';' order by ordem)
                    from public.catmat_item_atributo where codigo_item = 999990002)
                 is distinct from 'MATERIAL=AÇO@compras_gov;PESO=5 KG@compras_gov' then
    raise exception 'TESTE D FALHOU: característica do Compras.gov deveria ter precedência (% linhas)', v_n;
  end if;
  if (select count(*) from public.catmat_item_atributo where codigo_item = 999990001) <> 2 then
    raise exception 'TESTE D FALHOU: sincronizar de um item apagou atributos de outro';
  end if;

  -- E
  insert into public.catmat_pdm_ancoras (codigo_pdm, ancora, palavras, origem)
  values (999901, 'haltere emborrachado', public.catmat_ancora_palavras('haltere emborrachado'), 'manual');
  insert into public.licitacoes_externas (fonte, codigo_externo, objeto, prioridade, data_homologacao)
  values ('pncp', 'zzteste-ancoras-1', 'ZZ OBJETO NEUTRO', 'historico', '2026-09-01') returning id into v_lic;
  insert into public.licitacao_itens (licitacao_id, numero_item, descricao, material_ou_servico, quantidade)
  values (v_lic, 1, 'LOTE ÚNICO - Item 1 - Halteres de ferro emborrachados 2 kg', 'M', 1),   -- casa (plural nos dois)
         (v_lic, 2, 'Suporte para haltere emborrachado', 'M', 1),                            -- núcleo fora da 1ª posição
         (v_lic, 3, 'Haltere emborrachado - manutenção', 'S', 1),                            -- serviço
         (v_lic, 4, 'Haltere de ferro cromado', null, 1),                                    -- falta "emborrachado"
         (v_lic, 5, 'Haltere a b c d e f g h i j k emborrachado', null, 1);                  -- 2ª palavra além dos 11 tokens
  select string_agg(numero_item::text, ',' order by numero_item) into v_txt
    from public.catmat_itens_ancorados(array[v_lic]) where codigo_pdm = 999901;
  if v_txt is distinct from '1' then
    raise exception 'TESTE E FALHOU: esperado só o item 1 ancorado, obtido %', coalesce(v_txt, '(nenhum)');
  end if;

  -- F
  select count(*) into v_antes from public.catmat_pdm_ancoras;
  perform * from public.catmat_gerar_ancoras();
  if (select count(*) from public.catmat_pdm_ancoras) <> v_antes then
    raise exception 'TESTE F FALHOU: catmat_gerar_ancoras() em dry-run gravou';
  end if;

  raise notice 'SUCESSO: catmat_item_atributo_ancoras ok';
end $$;

rollback;
