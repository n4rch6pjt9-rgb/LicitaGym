-- Checagem da migration 20261010100400_pipeline_portao_resultado.
-- Etapas padrão sem portão. Recomendação sem score. Resultado só existe no desfecho.

do $$
declare
  r text;
  f text;
begin
  if exists (select 1 from public.pipeline_etapas where padrao and exige_portao) then
    raise exception 'CHECK FALHOU: etapa padrão nasceu com portão ligado';
  end if;
  if exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'decisoes_comerciais' and column_name = 'score'
  ) then
    raise exception 'CHECK FALHOU: decisoes_comerciais tem coluna de score';
  end if;
  if (public.recomendar_participacao(true, false, false, true, true, true)->>'decisao') <> 'no_go' then
    raise exception 'CHECK FALHOU: eliminatório não gerou NO-GO';
  end if;
  if (public.recomendar_participacao(false, false, true, true, true, true)->>'decisao') <> 'no_go' then
    raise exception 'CHECK FALHOU: margem não gerou NO-GO';
  end if;
  if (public.recomendar_participacao(false, true, false, true, true, true)->>'decisao') <> 'go_condicionado' then
    raise exception 'CHECK FALHOU: lacuna eliminatória não ficou condicionada';
  end if;
  if (public.recomendar_participacao(false, false, false, true, true, false)->>'decisao') <> 'monitorar' then
    raise exception 'CHECK FALHOU: sem edital aberto não ficou MONITORAR';
  end if;
  if jsonb_exists(public.recomendar_participacao(false, false, false, true, true, true), 'score') then
    raise exception 'CHECK FALHOU: recomendação devolveu score';
  end if;

  begin
    perform public.pipeline_registrar_resultado(-1, -1, null, null, null, '00000000-0000-0000-0000-000000000001'::uuid);
    raise exception 'CHECK FALHOU: resultado sem card deveria falhar';
  exception
    when sqlstate 'P0002' then null;
  end;

  foreach r in array array['anon', 'authenticated'] loop
    if has_table_privilege(r, 'public.decisoes_comerciais'::regclass, 'SELECT') then
      raise exception 'CHECK FALHOU: % lê decisoes_comerciais', r;
    end if;
    foreach f in array array[
      'public.recomendar_participacao(boolean,boolean,boolean,boolean,boolean,boolean)',
      'public.pipeline_registrar_resultado(bigint,bigint,bigint,bigint,text,uuid)'
    ] loop
      if has_function_privilege(r, f::regprocedure, 'EXECUTE') then
        raise exception 'CHECK FALHOU: % executa %', r, f;
      end if;
    end loop;
  end loop;

  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'pipeline_oportunidades'
       and column_name = 'preco_ofertado_centavos'
  ) then
    raise exception 'CHECK FALHOU: preço ofertado ausente no pipeline';
  end if;

  raise notice 'SUCESSO: pipeline portao e resultado';
end $$;

-- Comportamento (dados fictícios, desfeitos ao fim do bloco): o resultado só aceita produto do próprio tenant ou sem
-- tenant (catálogo compartilhado).
do $$
declare
  v_t1 bigint;
  v_t2 bigint;
  v_lic bigint;
  v_venc bigint;
  v_prod_outro bigint;
  v_prod_meu bigint;
  v_prod_comum bigint;
  v_u uuid := '00000000-0000-0000-0000-0000000000b1';
  v_ok boolean;
begin
  begin
    insert into public.tenants (slug, nome) values ('check-resultado-1', 'Check resultado 1') returning id into v_t1;
    insert into public.tenants (slug, nome) values ('check-resultado-2', 'Check resultado 2') returning id into v_t2;
    select id into v_venc from public.pipeline_etapas where tenant_id = v_t1 and desfecho = 'vencida';
    insert into public.licitacoes_externas (fonte) values ('pncp') returning id into v_lic;
    perform public.pipeline_mover(v_t1, array[v_lic], v_venc, null, v_u);
    insert into public.catalogo_produtos (marca, url, tenant_id) values ('CHK', 'https://chk.test/r-outro', v_t2)
      returning id into v_prod_outro;
    insert into public.catalogo_produtos (marca, url, tenant_id) values ('CHK', 'https://chk.test/r-meu', v_t1)
      returning id into v_prod_meu;
    insert into public.catalogo_produtos (marca, url, tenant_id) values ('CHK', 'https://chk.test/r-comum', null)
      returning id into v_prod_comum;

    v_ok := false;
    begin
      perform public.pipeline_registrar_resultado(v_t1, v_lic, v_prod_outro, 100000, null, v_u);
    exception when insufficient_privilege then v_ok := true;
    end;
    if not v_ok then raise exception 'CHECK FALHOU: resultado aceitou produto de outro tenant'; end if;

    perform public.pipeline_registrar_resultado(v_t1, v_lic, v_prod_meu, 100000, null, v_u);
    perform public.pipeline_registrar_resultado(v_t1, v_lic, v_prod_comum, 100000, null, v_u);
    if (select produto_id from public.pipeline_oportunidades where tenant_id = v_t1 and licitacao_id = v_lic)
       <> v_prod_comum then
      raise exception 'CHECK FALHOU: produto do próprio tenant ou compartilhado não foi gravado';
    end if;

    raise exception 'DESFAZER' using errcode = 'P0099';
  exception when sqlstate 'P0099' then null;
  end;
  raise notice 'SUCESSO: pipeline resultado (produto do tenant)';
end $$;
