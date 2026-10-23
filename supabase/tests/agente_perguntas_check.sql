-- Checagem da migration 20261022130000_agente_perguntas (spec 0038: K-1, K-5, K-11; CA-7).
--   ACL da tabela e da RPC (anon e authenticated sem acesso; service_role lê, grava e executa); RLS ligada sem policy;
--   constraints (resposta xor motivo, motivo e agente fechados, pergunta de 1 a 500, envio só com licitação e com
--   quem enviou); a busca traz só chunks da licitação pedida, em ordem de similaridade, com página, sem outra seção nem
--   parte interessada, e k limitado a 20; cota do dia (CA-12): reserva até o limite e depois null, outro dia e outra
--   empresa à parte, devolver nunca passa de 0; funções SECURITY DEFINER com search_path fixo e só service_role.
--   Tudo o que grava é desfeito ao final.

do $$
declare
  r      text;
  p      text;
  v_t    bigint;
  v_l1   bigint;
  v_l2   bigint;
  v_d1   bigint;
  v_d2   bigint;
  v_c1   bigint;
  v_c2   bigint;
  v_u    uuid := '00000000-0000-0000-0000-0000000038c1';
  v_um   vector := array_fill(1::real, array[768])::vector;
  v_meio vector := (array_fill(1::real, array[384]) || array_fill(0::real, array[384]))::vector;
  v_ok   boolean;
  v_ids  bigint[];
  v_n    integer;
  v_t2   bigint;
  v_fn   text;
begin
  if not (select relrowsecurity from pg_class where oid = 'public.agente_perguntas'::regclass) then
    raise exception 'CHECK FALHOU: RLS desligada em public.agente_perguntas';
  end if;
  if exists (select 1 from pg_policy where polrelid = 'public.agente_perguntas'::regclass) then
    raise exception 'CHECK FALHOU: policy em public.agente_perguntas';
  end if;
  foreach r in array array['anon', 'authenticated'] loop
    foreach p in array array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE'] loop
      if has_table_privilege(r, 'public.agente_perguntas'::regclass, p) then
        raise exception 'CHECK FALHOU: % tem % em public.agente_perguntas', r, p;
      end if;
    end loop;
    if has_function_privilege(r, 'public.agente_chunks_licitacao(bigint,vector,integer)'::regprocedure, 'EXECUTE') then
      raise exception 'CHECK FALHOU: % executa agente_chunks_licitacao', r;
    end if;
  end loop;
  if not has_table_privilege('service_role', 'public.agente_perguntas'::regclass, 'SELECT')
     or not has_table_privilege('service_role', 'public.agente_perguntas'::regclass, 'INSERT')
     or not has_table_privilege('service_role', 'public.agente_perguntas'::regclass, 'UPDATE') then
    raise exception 'CHECK FALHOU: service_role sem select/insert/update em public.agente_perguntas';
  end if;
  if not has_function_privilege('service_role', 'public.agente_chunks_licitacao(bigint,vector,integer)'::regprocedure, 'EXECUTE') then
    raise exception 'CHECK FALHOU: service_role não executa agente_chunks_licitacao';
  end if;

  -- cota do dia: tabela fechada e funções só para service_role, SECURITY DEFINER com search_path fixo
  if not (select relrowsecurity from pg_class where oid = 'public.agente_cota_dia'::regclass)
     or exists (select 1 from pg_policy where polrelid = 'public.agente_cota_dia'::regclass) then
    raise exception 'CHECK FALHOU: RLS desligada ou policy em public.agente_cota_dia';
  end if;
  foreach r in array array['anon', 'authenticated'] loop
    foreach p in array array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE'] loop
      if has_table_privilege(r, 'public.agente_cota_dia'::regclass, p) then
        raise exception 'CHECK FALHOU: % tem % em public.agente_cota_dia', r, p;
      end if;
    end loop;
  end loop;
  foreach v_fn in array array['public.agente_cota_reservar(bigint,date,integer)', 'public.agente_cota_devolver(bigint,date)'] loop
    foreach r in array array['anon', 'authenticated'] loop
      if has_function_privilege(r, v_fn::regprocedure, 'EXECUTE') then
        raise exception 'CHECK FALHOU: % executa %', r, v_fn;
      end if;
    end loop;
    if not has_function_privilege('service_role', v_fn::regprocedure, 'EXECUTE') then
      raise exception 'CHECK FALHOU: service_role não executa %', v_fn;
    end if;
    if not (select p2.prosecdef and coalesce(array_to_string(p2.proconfig, ','), '') like 'search_path=%'
              from pg_proc p2 where p2.oid = v_fn::regprocedure) then
      raise exception 'CHECK FALHOU: % sem SECURITY DEFINER ou sem search_path fixo', v_fn;
    end if;
  end loop;

  begin
    insert into public.tenants (slug, nome) values ('check-perguntas-1', 'Check perguntas 1') returning id into v_t;
    insert into public.tenants (slug, nome) values ('check-perguntas-2', 'Check perguntas 2') returning id into v_t2;
    insert into public.licitacoes_externas (fonte, objeto) values ('pncp', 'Esteiras') returning id into v_l1;

    -- CA-12: limite 2 → 1, 2, null (cheia, sem passar do limite); outra empresa e outro dia à parte
    if public.agente_cota_reservar(v_t, date '2026-10-22', 2) is distinct from 1
       or public.agente_cota_reservar(v_t, date '2026-10-22', 2) is distinct from 2
       or public.agente_cota_reservar(v_t, date '2026-10-22', 2) is not null
       or (select usadas from public.agente_cota_dia where tenant_id = v_t and dia = date '2026-10-22') <> 2 then
      raise exception 'CHECK FALHOU: agente_cota_reservar não parou no limite';
    end if;
    if public.agente_cota_reservar(v_t2, date '2026-10-22', 2) is distinct from 1
       or public.agente_cota_reservar(v_t, date '2026-10-23', 2) is distinct from 1 then
      raise exception 'CHECK FALHOU: cota de outra empresa ou de outro dia misturada';
    end if;
    -- devolver: 2 → 1 → 0 → 0 (nunca negativo); dia sem linha: null; depois de devolver, reserva de novo
    if public.agente_cota_devolver(v_t, date '2026-10-22') is distinct from 1
       or public.agente_cota_devolver(v_t, date '2026-10-22') is distinct from 0
       or public.agente_cota_devolver(v_t, date '2026-10-22') is distinct from 0
       or public.agente_cota_devolver(v_t, date '2026-01-01') is not null
       or public.agente_cota_reservar(v_t, date '2026-10-22', 2) is distinct from 1 then
      raise exception 'CHECK FALHOU: agente_cota_devolver';
    end if;
    -- limite 0 (ou nulo): nenhuma vaga
    if public.agente_cota_reservar(v_t2, date '2026-10-24', 0) is not null
       or public.agente_cota_reservar(v_t2, date '2026-10-24', null) is not null then
      raise exception 'CHECK FALHOU: limite 0 reservou vaga';
    end if;

    insert into public.licitacoes_externas (fonte, objeto) values ('pncp', 'Outra licitação') returning id into v_l2;

    -- resposta com citação e motivo nulo: aceita
    insert into public.agente_perguntas (tenant_id, agente, licitacao_id, pergunta, resposta, citacoes, perguntado_por)
    values (v_t, 'edital', v_l1, 'Há exigência de amostra?', 'Sim [1].', '[{"n":1}]', v_u);
    -- sem resposta, com motivo: aceita
    insert into public.agente_perguntas (tenant_id, agente, licitacao_id, pergunta, motivo_sem_resposta, perguntado_por)
    values (v_t, 'edital', v_l1, 'Qual o prazo?', 'sem_documentos', v_u);
    -- jurídico avulso (sem licitação): aceita
    insert into public.agente_perguntas (tenant_id, agente, pergunta, motivo_sem_resposta, perguntado_por)
    values (v_t, 'juridico', 'Amostra pode ser exigida?', 'nao_encontrado', v_u);

    -- cada uma destas tem de ser recusada por constraint (23514)
    foreach p in array array[
      -- resposta e motivo juntos
      format($q$insert into public.agente_perguntas (tenant_id, agente, licitacao_id, pergunta, resposta, motivo_sem_resposta, perguntado_por)
                values (%s, 'edital', %s, 'p', 'r', 'nao_encontrado', %L)$q$, v_t, v_l1, v_u),
      -- nem resposta nem motivo
      format($q$insert into public.agente_perguntas (tenant_id, agente, licitacao_id, pergunta, perguntado_por)
                values (%s, 'edital', %s, 'p', %L)$q$, v_t, v_l1, v_u),
      -- motivo fora da lista
      format($q$insert into public.agente_perguntas (tenant_id, agente, licitacao_id, pergunta, motivo_sem_resposta, perguntado_por)
                values (%s, 'edital', %s, 'p', 'erro', %L)$q$, v_t, v_l1, v_u),
      -- agente fora da lista
      format($q$insert into public.agente_perguntas (tenant_id, agente, licitacao_id, pergunta, motivo_sem_resposta, perguntado_por)
                values (%s, 'aderencia', %s, 'p', 'nao_encontrado', %L)$q$, v_t, v_l1, v_u),
      -- pergunta vazia e pergunta com 501 caracteres
      format($q$insert into public.agente_perguntas (tenant_id, agente, licitacao_id, pergunta, motivo_sem_resposta, perguntado_por)
                values (%s, 'edital', %s, '   ', 'nao_encontrado', %L)$q$, v_t, v_l1, v_u),
      format($q$insert into public.agente_perguntas (tenant_id, agente, licitacao_id, pergunta, motivo_sem_resposta, perguntado_por)
                values (%s, 'edital', %s, repeat('x', 501), 'nao_encontrado', %L)$q$, v_t, v_l1, v_u),
      -- citações que não são lista
      format($q$insert into public.agente_perguntas (tenant_id, agente, licitacao_id, pergunta, resposta, citacoes, perguntado_por)
                values (%s, 'edital', %s, 'p', 'r', '{}', %L)$q$, v_t, v_l1, v_u),
      -- K-11: enviada sem licitação (jurídico avulso) e enviada sem quem enviou
      format($q$update public.agente_perguntas set enviada_em = now(), enviada_por = %L
                 where tenant_id = %s and licitacao_id is null$q$, v_u, v_t),
      format($q$update public.agente_perguntas set enviada_em = now() where tenant_id = %s and licitacao_id = %s$q$, v_t, v_l1)
    ] loop
      v_ok := false;
      begin
        execute p;
      exception when check_violation then v_ok := true;
      end;
      if not v_ok then
        raise exception 'CHECK FALHOU: constraint não recusou: %', p;
      end if;
    end loop;
    -- 500 caracteres ainda cabe; envio com licitação e quem enviou passa
    insert into public.agente_perguntas (tenant_id, agente, licitacao_id, pergunta, motivo_sem_resposta, perguntado_por)
    values (v_t, 'edital', v_l1, repeat('x', 500), 'nao_encontrado', v_u);
    update public.agente_perguntas set enviada_em = now(), enviada_por = v_u
     where tenant_id = v_t and licitacao_id = v_l1 and resposta is not null;
    get diagnostics v_n = row_count;
    if v_n <> 1 then
      raise exception 'CHECK FALHOU: envio da pergunta com licitação não gravou (%)', v_n;
    end if;

    -- busca por licitação (K-1)
    insert into public.licitacao_documentos (licitacao_id, secao, nome_original, arquivo_origem, status_processamento)
    values (v_l1, 'processo', 'Edital.pdf', 'edital.pdf', 'indexado') returning id into v_d1;
    insert into public.licitacao_documentos (licitacao_id, secao, nome_original, arquivo_origem, status_processamento)
    values (v_l2, 'processo', 'Outro.pdf', 'outro.pdf', 'indexado') returning id into v_d2;
    insert into public.licitacao_chunks (licitacao_id, documento_id, ordem, pagina, texto, secao, embedding)
    values (v_l1, v_d1, 1, 11, '8.4.2 Amostra obrigatória.', 'processo', v_um) returning id into v_c1;
    insert into public.licitacao_chunks (licitacao_id, documento_id, ordem, pagina, texto, secao, embedding)
    values (v_l1, v_d1, 2, 15, 'Prazo de entrega de 30 dias.', 'processo', v_meio) returning id into v_c2;
    -- sem embedding, outra seção e parte interessada: nunca voltam
    insert into public.licitacao_chunks (licitacao_id, documento_id, ordem, pagina, texto, secao)
    values (v_l1, v_d1, 3, 16, 'sem vetor', 'processo');
    insert into public.licitacao_chunks (licitacao_id, documento_id, ordem, pagina, texto, secao, embedding)
    values (v_l1, v_d1, 4, 17, 'habilitação', 'habilitacao', v_um);
    insert into public.licitacao_chunks (licitacao_id, documento_id, ordem, pagina, texto, secao, embedding)
    values (v_l1, v_d1, 5, 18, 'recurso de fornecedor', 'processo', v_um);
    update public.licitacao_chunks set nivel_confianca = 'parte_interessada' where documento_id = v_d1 and ordem = 5;
    -- outra licitação, vetor idêntico ao da pergunta: não pode aparecer
    insert into public.licitacao_chunks (licitacao_id, documento_id, ordem, pagina, texto, secao, embedding)
    values (v_l2, v_d2, 1, 1, 'Amostra da outra.', 'processo', v_um);

    select array_agg(b.id order by b.similaridade desc, b.id) into v_ids
      from public.agente_chunks_licitacao(v_l1, v_um, 8) b;
    if v_ids is distinct from array[v_c1, v_c2] then
      raise exception 'CHECK FALHOU: busca da licitação trouxe % (esperado % e %)', v_ids, v_c1, v_c2;
    end if;
    if (select b.pagina from public.agente_chunks_licitacao(v_l1, v_um, 1) b) is distinct from 11 then
      raise exception 'CHECK FALHOU: busca não devolveu a página do chunk mais próximo';
    end if;
    -- k acima de 20 é limitado a 20; k nulo ou zero vira ao menos 1
    insert into public.licitacao_chunks (licitacao_id, documento_id, ordem, pagina, texto, secao, embedding)
    select v_l1, v_d1, 100 + g, g, 'trecho ' || g, 'processo', v_meio from generate_series(1, 25) g;
    select count(*) into v_n from public.agente_chunks_licitacao(v_l1, v_um, 500);
    if v_n <> 20 then
      raise exception 'CHECK FALHOU: k não foi limitado a 20 (%)', v_n;
    end if;
    select count(*) into v_n from public.agente_chunks_licitacao(v_l1, v_um, 0);
    if v_n <> 1 then
      raise exception 'CHECK FALHOU: k = 0 devolveu % linhas (esperado 1)', v_n;
    end if;

    raise exception 'ROLLBACK_PROPOSITAL';
  exception when others then
    if sqlerrm <> 'ROLLBACK_PROPOSITAL' then
      raise;
    end if;
  end;
  raise notice 'SUCESSO: agente_perguntas ok (desfeito)';
end
$$;
