-- Checagem da migration 20261004150000_pipeline_oportunidades (Dashboard #29).
--   (a) ACL e RLS: as 3 tabelas com RLS e sem nenhum privilégio para anon/authenticated/PUBLIC; funções só service_role.
--   (b) Semente: todo tenant ativo tem as 13 etapas padrão, na ordem do Kanban, com "Descartada" exigindo motivo.
--   (c) Regras: mover/adicionar/remover em lote com histórico, motivo obrigatório, etapa de outro tenant recusada,
--       excluir etapa com oportunidades exige destino, não exclui a última etapa. Feito num sub-bloco que termina com
--       uma exceção proposital: tudo o que (c) grava é desfeito (pode rodar contra produção com um papel que escreva).
-- Falha com RAISE EXCEPTION 'CHECK FALHOU: ...'; sucesso termina com NOTICE 'SUCESSO: ...'.

do $$
declare
  t   text;
  r   text;
  p   text;
  f   text;
begin
  -- (a) ACL e RLS
  foreach t in array array['pipeline_etapas', 'pipeline_oportunidades', 'pipeline_historico'] loop
    if not (select relrowsecurity from pg_class where oid = ('public.' || t)::regclass) then
      raise exception 'CHECK FALHOU: RLS desligada em public.%', t;
    end if;
    foreach r in array array['anon', 'authenticated'] loop
      foreach p in array array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'] loop
        if has_table_privilege(r, ('public.' || t)::regclass, p) then
          raise exception 'CHECK FALHOU: % tem % em public.%', r, p, t;
        end if;
      end loop;
    end loop;
    if not has_table_privilege('service_role', ('public.' || t)::regclass, 'SELECT,INSERT,UPDATE,DELETE') then
      raise exception 'CHECK FALHOU: service_role sem escrita em public.%', t;
    end if;
  end loop;

  foreach f in array array[
    'public.pipeline_mover(bigint,bigint[],bigint,text,uuid,boolean)',
    'public.pipeline_etapa_excluir(bigint,bigint,bigint,uuid)',
    'public.pipeline_contagem(bigint)',
    'public.pipeline_semear_etapas(bigint)'
  ] loop
    foreach r in array array['anon', 'authenticated'] loop
      if has_function_privilege(r, f::regprocedure, 'EXECUTE') then
        raise exception 'CHECK FALHOU: % pode executar %', r, f;
      end if;
    end loop;
    if not has_function_privilege('service_role', f::regprocedure, 'EXECUTE') then
      raise exception 'CHECK FALHOU: service_role não executa %', f;
    end if;
    if not exists (select 1 from pg_proc where oid = f::regprocedure and 'search_path=public, pg_temp' = any (proconfig)) then
      raise exception 'CHECK FALHOU: % sem search_path fixo', f;
    end if;
  end loop;

  -- (b) Semente das 13 etapas em todo tenant ativo
  if exists (
    select 1 from public.tenants tn
     where tn.ativo
       and (select count(*) from public.pipeline_etapas e where e.tenant_id = tn.id and e.padrao) < 13
  ) then
    raise exception 'CHECK FALHOU: tenant ativo sem as 13 etapas padrão';
  end if;

  raise notice 'SUCESSO: pipeline_oportunidades ACL/RLS e semente ok';
end
$$;

-- (c) Regras de negócio, desfeitas ao final
do $$
declare
  v_t1   bigint;
  v_t2   bigint;
  v_lic1 bigint;
  v_lic2 bigint;
  v_nova bigint;
  v_tri  bigint;
  v_desc bigint;
  v_out  bigint;
  v_u    uuid := '00000000-0000-0000-0000-0000000000a1';
  v_n    integer;
  v_ok   boolean;
begin
  begin
    insert into public.tenants (slug, nome) values ('check-pipeline-1', 'Check pipeline 1') returning id into v_t1;
    insert into public.tenants (slug, nome) values ('check-pipeline-2', 'Check pipeline 2') returning id into v_t2;
    -- tenant novo ganha as 13 etapas pelo gatilho
    if (select count(*) from public.pipeline_etapas where tenant_id = v_t1 and padrao) <> 13 then
      raise exception 'CHECK FALHOU: gatilho não semeou as 13 etapas no tenant novo';
    end if;
    select id into v_nova from public.pipeline_etapas where tenant_id = v_t1 and nome = 'Nova';
    select id into v_tri  from public.pipeline_etapas where tenant_id = v_t1 and nome = 'Triagem';
    select id into v_desc from public.pipeline_etapas where tenant_id = v_t1 and nome = 'Descartada';
    -- tenant 2 fica só com uma etapa, para testar "não exclui a última"
    delete from public.pipeline_etapas where tenant_id = v_t2 and nome <> 'Nova';
    select id into v_out from public.pipeline_etapas where tenant_id = v_t2 and nome = 'Nova';
    insert into public.licitacoes_externas (fonte) values ('pncp') returning id into v_lic1;
    insert into public.licitacoes_externas (fonte) values ('pncp') returning id into v_lic2;

    -- adicionar em lote
    v_n := public.pipeline_mover(v_t1, array[v_lic1, v_lic2], v_nova, null, v_u);
    if v_n <> 2 or (select count(*) from public.pipeline_oportunidades where tenant_id = v_t1) <> 2 then
      raise exception 'CHECK FALHOU: adicionar em lote (n=%)', v_n;
    end if;
    -- mover para a mesma etapa não conta nem gera histórico
    if public.pipeline_mover(v_t1, array[v_lic1], v_nova, null, v_u) <> 0 then
      raise exception 'CHECK FALHOU: mover para a mesma etapa contou como mudança';
    end if;
    -- só novos: quem já está não volta para a etapa pedida
    v_n := public.pipeline_mover(v_t1, array[v_lic1], v_tri, null, v_u, true);
    if v_n <> 0 or (select etapa_id from public.pipeline_oportunidades where tenant_id = v_t1 and licitacao_id = v_lic1) <> v_nova then
      raise exception 'CHECK FALHOU: p_so_novos moveu quem já estava no pipeline';
    end if;
    -- contagem por etapa
    if (select total from public.pipeline_contagem(v_t1) where etapa_id = v_nova) <> 2 then
      raise exception 'CHECK FALHOU: pipeline_contagem';
    end if;
    -- mover direto para outra etapa ("Mover para…")
    perform public.pipeline_mover(v_t1, array[v_lic1], v_tri, null, v_u);
    if (select etapa_id from public.pipeline_oportunidades where tenant_id = v_t1 and licitacao_id = v_lic1) <> v_tri then
      raise exception 'CHECK FALHOU: mover não trocou a etapa';
    end if;
    -- etapa que exige motivo recusa sem motivo
    v_ok := false;
    begin
      perform public.pipeline_mover(v_t1, array[v_lic1], v_desc, '  ', v_u);
    exception when invalid_parameter_value then v_ok := true;
    end;
    if not v_ok then raise exception 'CHECK FALHOU: Descartada aceitou mover sem motivo'; end if;
    perform public.pipeline_mover(v_t1, array[v_lic1], v_desc, 'Preço', v_u);
    if (select motivo from public.pipeline_oportunidades where tenant_id = v_t1 and licitacao_id = v_lic1) <> 'Preço' then
      raise exception 'CHECK FALHOU: motivo do descarte não gravado';
    end if;
    -- etapa de outro tenant é recusada
    v_ok := false;
    begin
      perform public.pipeline_mover(v_t1, array[v_lic2], v_out, null, v_u);
    exception when no_data_found then v_ok := true;
    end;
    if not v_ok then raise exception 'CHECK FALHOU: aceitou etapa de outro tenant'; end if;
    -- histórico: entrada (2) + Triagem + Descartada = 4 linhas, com o nome da etapa na hora
    if (select count(*) from public.pipeline_historico where tenant_id = v_t1) <> 4
       or not exists (select 1 from public.pipeline_historico
                       where tenant_id = v_t1 and licitacao_id = v_lic1 and nome_de = 'Triagem' and nome_para = 'Descartada' and motivo = 'Preço') then
      raise exception 'CHECK FALHOU: histórico incompleto';
    end if;

    -- excluir etapa com oportunidade exige destino
    v_ok := false;
    begin
      perform public.pipeline_etapa_excluir(v_t1, v_nova, null, v_u);
    exception when invalid_parameter_value then v_ok := true;
    end;
    if not v_ok then raise exception 'CHECK FALHOU: excluiu etapa com oportunidade sem destino'; end if;
    v_n := public.pipeline_etapa_excluir(v_t1, v_nova, v_tri, v_u);
    if v_n <> 1 then
      raise exception 'CHECK FALHOU: excluir etapa devolveu % movida(s), esperado 1', v_n;
    end if;
    if exists (select 1 from public.pipeline_etapas where id = v_nova) then
      raise exception 'CHECK FALHOU: etapa excluída continua existindo';
    end if;
    if (select etapa_id from public.pipeline_oportunidades where tenant_id = v_t1 and licitacao_id = v_lic2) <> v_tri then
      raise exception 'CHECK FALHOU: oportunidade da etapa excluída não foi para o destino';
    end if;

    -- remover em lote
    -- (resultado da função guardado antes de olhar a tabela: o "or" do SQL não garante ordem de avaliação)
    v_n := public.pipeline_mover(v_t1, array[v_lic1, v_lic2], null, null, v_u);
    if v_n <> 2 or exists (select 1 from public.pipeline_oportunidades where tenant_id = v_t1) then
      raise exception 'CHECK FALHOU: remover em lote (n=%)', v_n;
    end if;

    -- não exclui a última etapa do tenant
    v_ok := false;
    begin
      perform public.pipeline_etapa_excluir(v_t2, v_out, null, v_u);
    exception when invalid_parameter_value then v_ok := true;
    end;
    if not v_ok then raise exception 'CHECK FALHOU: excluiu a última etapa do tenant'; end if;

    raise exception 'DESFAZER_CHECK_PIPELINE';
  exception when raise_exception then
    if sqlerrm <> 'DESFAZER_CHECK_PIPELINE' then
      raise;
    end if;
  end;
  raise notice 'SUCESSO: pipeline_oportunidades regras ok (gravações do teste desfeitas)';
end
$$;
