-- Checagem da migration 20261011130000_pipeline_etapa_tarefas_salvar (spec 0018, PR 3).
--   ACL; salvar a lista completa (upsert e desligar, nunca apagar); chave imutável; recusas (CA-10) sem gravar nada.
-- Tudo o que grava é desfeito ao final (exceção proposital).

do $$
declare
  r      text;
  v_t    bigint;
  v_t2   bigint;
  v_tri  bigint;
  v_ana  bigint;
  v_ana2 bigint;
  v_u    uuid := '00000000-0000-0000-0000-0000000000e1';
  v_ids  bigint[];
  v_ok   boolean;
  v_n    integer;
  v_chave text;
begin
  foreach r in array array['anon', 'authenticated'] loop
    if has_function_privilege(r, 'public.pipeline_etapa_tarefas_salvar(bigint,bigint,jsonb,uuid)'::regprocedure, 'EXECUTE') then
      raise exception 'CHECK FALHOU: % executa pipeline_etapa_tarefas_salvar', r;
    end if;
  end loop;
  if not has_function_privilege('service_role', 'public.pipeline_etapa_tarefas_salvar(bigint,bigint,jsonb,uuid)'::regprocedure, 'EXECUTE') then
    raise exception 'CHECK FALHOU: service_role não executa pipeline_etapa_tarefas_salvar';
  end if;

  begin
    insert into public.tenants (slug, nome) values ('check-salvar-1', 'Check salvar 1') returning id into v_t;
    insert into public.tenants (slug, nome) values ('check-salvar-2', 'Check salvar 2') returning id into v_t2;
    select id into v_tri  from public.pipeline_etapas where tenant_id = v_t and nome = 'Triagem';
    select id into v_ana  from public.pipeline_etapas where tenant_id = v_t and nome = 'Em análise';
    select id into v_ana2 from public.pipeline_etapas where tenant_id = v_t2 and nome = 'Em análise';
    select array_agg(id order by id) into v_ids from public.pipeline_etapa_tarefas where etapa_id = v_tri;

    -- salvar: mantém a aderência (mesma chave, título novo), tira as restrições, acrescenta uma do catálogo e uma
    -- da empresa sem chave
    v_n := public.pipeline_etapa_tarefas_salvar(v_t, v_tri, jsonb_build_array(
      jsonb_build_object('origem', 'empresa', 'chave', 'triagem-aderencia', 'titulo', 'Aderência (renomeada)'),
      jsonb_build_object('origem', 'catalogo', 'tarefa_codigo', '14133-F01-T01'),
      jsonb_build_object('origem', 'empresa', 'titulo', 'Pedir cotação ao fabricante', 'prazo_horas', 48)
    ), v_u);
    if v_n <> 3 then
      raise exception 'CHECK FALHOU: salvar devolveu % (esperado 3)', v_n;
    end if;
    if (select titulo from public.pipeline_etapa_tarefas where tenant_id = v_t and chave = 'triagem-aderencia') <> 'Aderência (renomeada)'
       or (select id from public.pipeline_etapa_tarefas where tenant_id = v_t and chave = 'triagem-aderencia') <> v_ids[1]
       and (select id from public.pipeline_etapa_tarefas where tenant_id = v_t and chave = 'triagem-aderencia') <> v_ids[2] then
      raise exception 'CHECK FALHOU: renomear mudou o id ou não salvou o título';
    end if;
    if (select ativo from public.pipeline_etapa_tarefas where tenant_id = v_t and chave = 'triagem-restricoes-lote') then
      raise exception 'CHECK FALHOU: tarefa que saiu da lista não foi desligada';
    end if;
    select chave into v_chave from public.pipeline_etapa_tarefas
     where tenant_id = v_t and etapa_id = v_tri and titulo = 'Pedir cotação ao fabricante';
    if v_chave !~ '^emp-[0-9a-f]{8}$'
       or (select prazo_horas from public.pipeline_etapa_tarefas where tenant_id = v_t and chave = v_chave) <> 48 then
      raise exception 'CHECK FALHOU: tarefa nova da empresa sem chave emp-xxxxxxxx ou sem prazo (%)', v_chave;
    end if;
    if (select count(*) from public.pipeline_etapa_tarefas where etapa_id = v_tri) <> 4 then
      raise exception 'CHECK FALHOU: salvar apagou ou duplicou modelo';
    end if;

    -- religar o que estava desligado volta o mesmo modelo (mesmo id)
    perform public.pipeline_etapa_tarefas_salvar(v_t, v_tri, jsonb_build_array(
      jsonb_build_object('origem', 'empresa', 'chave', 'triagem-restricoes-lote', 'titulo', 'Restrições por lote')
    ), v_u);
    if not (select ativo from public.pipeline_etapa_tarefas where tenant_id = v_t and chave = 'triagem-restricoes-lote')
       or (select count(*) from public.pipeline_etapa_tarefas where etapa_id = v_tri) <> 4 then
      raise exception 'CHECK FALHOU: religar criou outro modelo';
    end if;

    -- CA-10: recusas, nada gravado
    foreach r in array array[
      '[{"origem": "catalogo", "tarefa_codigo": "14133-F99-T99"}]',
      '[{"origem": "empresa"}]',
      '[{"origem": "outro"}]',
      '[{"origem": "empresa", "chave": "analise-dossie", "titulo": "Roubar de outra etapa"}]',
      '[{"origem": "catalogo", "tarefa_codigo": "14133-F01-T01"}, {"origem": "catalogo", "tarefa_codigo": "14133-F01-T01"}]',
      '[{"origem": "empresa", "titulo": "x", "prazo_horas": "48"}]'
    ] loop
      v_ok := false;
      begin
        perform public.pipeline_etapa_tarefas_salvar(v_t, v_tri, r::jsonb, v_u);
      exception when sqlstate '22023' then v_ok := true;
      end;
      if not v_ok then
        raise exception 'CHECK FALHOU: salvar aceitou %', r;
      end if;
    end loop;
    -- etapa de outra empresa: não encontrada
    v_ok := false;
    begin
      perform public.pipeline_etapa_tarefas_salvar(v_t, v_ana2, '[]'::jsonb, v_u);
    exception when sqlstate 'P0002' then v_ok := true;
    end;
    if not v_ok then
      raise exception 'CHECK FALHOU: salvar aceitou etapa de outra empresa';
    end if;
    if (select count(*) from public.pipeline_etapa_tarefas where etapa_id = v_ana2 and not ativo) <> 0 then
      raise exception 'CHECK FALHOU: salvar mexeu no modelo de outra empresa';
    end if;

    raise exception 'ROLLBACK_PROPOSITAL';
  exception when others then
    if sqlerrm <> 'ROLLBACK_PROPOSITAL' then
      raise;
    end if;
  end;
  raise notice 'SUCESSO: pipeline_etapa_tarefas_salvar ok (desfeito)';
end
$$;
