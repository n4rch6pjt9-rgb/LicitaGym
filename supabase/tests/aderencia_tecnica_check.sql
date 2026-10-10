-- Checagem da migration 20261010100300_aderencia_tecnica.
-- Ontologia semeada, veredito com não comprovado, eliminatório bloqueia atende, requisito validado não se sobrescreve.

do $$
declare
  t text;
  r text;
begin
  foreach t in array array['ontologia_atributos', 'licitacao_item_requisitos', 'catalogo_produto_atributos'] loop
    if not (select relrowsecurity from pg_class where oid = ('public.' || t)::regclass) then
      raise exception 'CHECK FALHOU: RLS desligada em public.%', t;
    end if;
    if has_table_privilege('anon', ('public.' || t)::regclass, 'SELECT') then
      raise exception 'CHECK FALHOU: anon lê public.%', t;
    end if;
    if not has_table_privilege('authenticated', ('public.' || t)::regclass, 'SELECT') then
      raise exception 'CHECK FALHOU: authenticated sem select em public.%', t;
    end if;
    if has_table_privilege('authenticated', ('public.' || t)::regclass, 'INSERT') then
      raise exception 'CHECK FALHOU: authenticated escreve em public.%', t;
    end if;
  end loop;

  if (select count(*) from public.ontologia_atributos where no_taxonomia = 'esteira_eletrica') < 6 then
    raise exception 'CHECK FALHOU: ontologia da esteira incompleta';
  end if;
  if (select count(*) from public.ontologia_atributos where no_taxonomia = 'piso_emborrachado') < 6 then
    raise exception 'CHECK FALHOU: ontologia do piso incompleta';
  end if;

  if public.classificar_aderencia(3, 0, 1, 0, 0, 0, array['capacidade'], '{}', array['capacidade']) <> 'nao_atende' then
    raise exception 'CHECK FALHOU: eliminatório não derrubou atende';
  end if;
  if public.classificar_aderencia(3, 0, 0, 1, 0, 0, '{}', array['certificacao'], array['certificacao']) <> 'nao_comprovado' then
    raise exception 'CHECK FALHOU: lacuna eliminatória virou outra coisa que não comprovado';
  end if;
  if public.classificar_aderencia(2, 0, 1, 0, 0, 0, array['area'], '{}', '{}') <> 'parcial' then
    raise exception 'CHECK FALHOU: falha não eliminatória não ficou parcial';
  end if;

  foreach r in array array['anon', 'authenticated'] loop
    if has_function_privilege(r, 'public.classificar_aderencia(int,int,int,int,int,int,text[],text[],text[])', 'EXECUTE') then
      raise exception 'CHECK FALHOU: % executa classificar_aderencia', r;
    end if;
  end loop;

  if not exists (
    select 1 from pg_trigger
     where tgname = 'licitacao_item_requisitos_nao_sobrescreve'
       and tgrelid = 'public.licitacao_item_requisitos'::regclass
  ) then
    raise exception 'CHECK FALHOU: gatilho de requisito validado ausente';
  end if;

  if not exists (
    select 1 from pg_constraint
     where conname = 'catalogo_de_para_aderencia_check'
       and pg_get_constraintdef(oid) like '%nao_comprovado%'
  ) then
    raise exception 'CHECK FALHOU: aderencia sem nao_comprovado';
  end if;

  raise notice 'SUCESSO: aderencia tecnica';
end $$;

-- Comportamento (dados fictícios, desfeitos ao fim do bloco): requisito validado imutável, documento da mesma
-- licitação do item e viabilidade só com atende/parcial/supera.
do $$
declare
  v_t bigint;
  v_prod bigint;
  v_lic_a bigint;
  v_lic_b bigint;
  v_item bigint;
  v_doc_a bigint;
  v_doc_b bigint;
  v_req bigint;
  v_ok boolean;
begin
  begin
    insert into public.tenants (slug, nome) values ('check-aderencia', 'Check aderência') returning id into v_t;
    insert into public.catalogo_produtos (marca, url, tenant_id, nome, no_taxonomia)
      values ('CHK', 'https://chk.test/aderencia', v_t, 'Produto check', 'esteira_eletrica') returning id into v_prod;
    insert into public.licitacoes_externas (fonte) values ('pncp') returning id into v_lic_a;
    insert into public.licitacoes_externas (fonte) values ('pncp') returning id into v_lic_b;
    insert into public.licitacao_itens (licitacao_id, numero_item, descricao, valor_unitario_estimado)
      values (v_lic_a, 1, 'ESTEIRA CHK', 1000) returning id into v_item;
    insert into public.licitacao_documentos (licitacao_id, secao, arquivo_origem)
      values (v_lic_a, 'processo', 'edital_a.pdf') returning id into v_doc_a;
    insert into public.licitacao_documentos (licitacao_id, secao, arquivo_origem)
      values (v_lic_b, 'processo', 'edital_b.pdf') returning id into v_doc_b;

    -- documento de outra licitação: recusado
    v_ok := false;
    begin
      insert into public.licitacao_item_requisitos (licitacao_item_id, atributo, valor_num, natureza, metodo, documento_id, pagina, trecho)
        values (v_item, 'motor_hp_min', 2, 'fato', 'regra', v_doc_b, 3, 'motor de 2 HP');
    exception when foreign_key_violation then v_ok := true;
    end;
    if not v_ok then raise exception 'CHECK FALHOU: requisito aceitou documento de outra licitação'; end if;

    insert into public.licitacao_item_requisitos
      (licitacao_item_id, atributo, valor_num, natureza, metodo, documento_id, pagina, trecho, status_validacao)
      values (v_item, 'motor_hp_min', 2, 'fato', 'regra', v_doc_a, 3, 'motor de 2 HP', 'validado')
      returning id into v_req;

    -- validado: nem valor, nem status, nem trecho mudam
    v_ok := false;
    begin
      update public.licitacao_item_requisitos set status_validacao = 'extraido' where id = v_req;
    exception when invalid_parameter_value then v_ok := true;
    end;
    if not v_ok then raise exception 'CHECK FALHOU: requisito validado voltou para extraido'; end if;
    v_ok := false;
    begin
      update public.licitacao_item_requisitos set trecho = 'outro trecho' where id = v_req;
    exception when invalid_parameter_value then v_ok := true;
    end;
    if not v_ok then raise exception 'CHECK FALHOU: trecho de requisito validado foi alterado'; end if;
    -- documento apagado: o on delete set null passa, o trecho fica
    delete from public.licitacao_documentos where id = v_doc_a;
    if (select documento_id is null and trecho = 'motor de 2 HP' from public.licitacao_item_requisitos where id = v_req)
       is not true then
      raise exception 'CHECK FALHOU: apagar o documento não deixou documento_id nulo com o trecho preservado';
    end if;

    -- viabilidade: nao_comprovado não entra em n_itens
    insert into public.catalogo_de_para (tenant_id, produto_id, fonte, licitacao_item_id, no_taxonomia, nivel, score, aderencia, metodo_versao)
      values (v_t, v_prod, 'licitacao', v_item, 'esteira_eletrica', 'texto', 80, 'atende', 'chk'),
             (v_t, v_prod, 'licitacao', v_item, 'esteira_eletrica', 'texto', 50, 'nao_comprovado', 'chk');
    if (select n_itens from public.v_catalogo_viabilidade where produto_id = v_prod) <> 1 then
      raise exception 'CHECK FALHOU: de-para nao_comprovado entrou na referência de viabilidade';
    end if;

    raise exception 'DESFAZER' using errcode = 'P0099';
  exception when sqlstate 'P0099' then null;
  end;
  raise notice 'SUCESSO: aderencia tecnica (comportamento)';
end $$;
