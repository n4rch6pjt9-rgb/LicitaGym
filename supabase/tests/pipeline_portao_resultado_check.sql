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
