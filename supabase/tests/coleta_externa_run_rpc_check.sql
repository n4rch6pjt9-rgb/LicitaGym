-- Verificação das RPCs de registro do coletor do Sistema S (migration 20261108170000_coleta_externa_run_rpc).
--   1. ACL: EXECUTE só service_role; security definer com search_path fixo;
--   2. iniciar abre 'executando'; finalizar fecha com status e contagens e devolve true;
--   3. finalizar de novo a mesma execução devolve false e não sobrescreve;
--   4. status final inválido é recusado;
--   5. modo/fonte inválidos recusados; contagem negativa vira 0; execução órfã vira incompleta;
--   6. a saúde (coleta_externa_dias_sem_sucesso) passa a ter dado depois de uma execução concluída;
--   7. spec 0063: CA-1 (órfão > 6 h de qualquer fonte fecha) e CA-2 (execução viva de outra fonte não fecha).
-- Fixtures revertidas ao final.
begin;

do $$
declare
  f_ini regprocedure := to_regprocedure('public.coleta_externa_iniciar(text, text, text[])');
  f_fim regprocedure := to_regprocedure(
    'public.coleta_externa_finalizar(bigint, text, integer, integer, integer, integer, integer, jsonb)');
  v_id bigint;
  v_ok boolean;
  r record;
  v_valor numeric;
  rejeitou boolean := false;
begin
  if f_ini is null or f_fim is null then
    raise exception 'COLETA RUN CHECK FALHOU: RPCs ausentes';
  end if;
  if has_function_privilege('anon', f_ini, 'EXECUTE') or has_function_privilege('authenticated', f_ini, 'EXECUTE')
     or has_function_privilege('anon', f_fim, 'EXECUTE') or has_function_privilege('authenticated', f_fim, 'EXECUTE') then
    raise exception 'COLETA RUN CHECK FALHOU: anon/authenticated executam as RPCs';
  end if;
  if not has_function_privilege('service_role', f_ini, 'EXECUTE')
     or not has_function_privilege('service_role', f_fim, 'EXECUTE') then
    raise exception 'COLETA RUN CHECK FALHOU: service_role sem EXECUTE';
  end if;
  if exists (select 1 from pg_proc p where p.oid in (f_ini, f_fim)
              and not (p.prosecdef and exists (select 1 from unnest(p.proconfig) c where c like 'search_path=%'))) then
    raise exception 'COLETA RUN CHECK FALHOU: RPC sem security definer ou sem search_path fixo';
  end if;

  v_id := public.coleta_externa_iniciar('fiesc', 'leads', array['academia']);
  select * into r from private.coleta_externa_run where id = v_id;
  if r.status <> 'executando' or r.fonte <> 'fiesc' or r.modo <> 'leads' or r.finished_at is not null then
    raise exception 'COLETA RUN CHECK FALHOU: abertura incorreta: %', row_to_json(r);
  end if;

  v_ok := public.coleta_externa_finalizar(v_id, 'concluida', 10, 4, 2, 7, 0, null);
  select * into r from private.coleta_externa_run where id = v_id;
  if not v_ok or r.status <> 'concluida' or r.listados <> 10 or r.processos <> 4 or r.no_escopo <> 2
     or r.itens_escopo <> 7 or r.erros <> 0 or r.finished_at is null then
    raise exception 'COLETA RUN CHECK FALHOU: fechamento incorreto: %', row_to_json(r);
  end if;

  v_ok := public.coleta_externa_finalizar(v_id, 'falhou', 0, 0, 0, 0, 1, '{"erro":"x"}'::jsonb);
  select * into r from private.coleta_externa_run where id = v_id;
  if v_ok or r.status <> 'concluida' then
    raise exception 'COLETA RUN CHECK FALHOU: fechou de novo uma execução já encerrada';
  end if;

  v_id := public.coleta_externa_iniciar('fiesc', 'leads', null);
  begin
    perform public.coleta_externa_finalizar(v_id, 'executando');
  exception when invalid_parameter_value then
    rejeitou := true;
  end;
  if not rejeitou then
    raise exception 'COLETA RUN CHECK FALHOU: status final inválido aceito';
  end if;

  -- modo e fonte inválidos: recusados pela CHECK e pela FK da tabela
  rejeitou := false;
  begin
    perform public.coleta_externa_iniciar('fiesc', 'qualquer', null);
  exception when check_violation then
    rejeitou := true;
  end;
  if not rejeitou then
    raise exception 'COLETA RUN CHECK FALHOU: modo inválido aceito';
  end if;
  rejeitou := false;
  begin
    perform public.coleta_externa_iniciar('fonte_que_nao_existe', 'leads', null);
  exception when foreign_key_violation then
    rejeitou := true;
  end;
  if not rejeitou then
    raise exception 'COLETA RUN CHECK FALHOU: fonte inexistente aceita';
  end if;

  -- contagem negativa vira 0; execução órfã (> 6 h em executando) vira incompleta ao abrir outra da mesma fonte
  v_id := public.coleta_externa_iniciar('fiesc', 'leads', null);
  perform public.coleta_externa_finalizar(v_id, 'concluida_com_erros', -5, 1, 0, 0, -1, null);
  select * into r from private.coleta_externa_run where id = v_id;
  if r.listados <> 0 or r.erros <> 0 then
    raise exception 'COLETA RUN CHECK FALHOU: contagem negativa gravada: %', row_to_json(r);
  end if;
  v_id := public.coleta_externa_iniciar('fiesc', 'leads', null);
  update private.coleta_externa_run set started_at = now() - interval '7 hours' where id = v_id;
  perform public.coleta_externa_iniciar('fiesc', 'leads', null);
  select * into r from private.coleta_externa_run where id = v_id;
  if r.status <> 'incompleta' or r.finished_at is null then
    raise exception 'COLETA RUN CHECK FALHOU: execução órfã não foi encerrada: %', row_to_json(r);
  end if;

  -- Spec 0063, CA-1: órfão (> 6 h em executando) de OUTRA fonte também fecha quando qualquer fonte abre execução.
  v_id := public.coleta_externa_iniciar('fiesc', 'leads', null);
  update private.coleta_externa_run set started_at = now() - interval '7 hours' where id = v_id;
  perform public.coleta_externa_iniciar('firjan', 'leads', null);
  select * into r from private.coleta_externa_run where id = v_id;
  if r.status <> 'incompleta' or r.finished_at is null
     or r.detalhe_erros ->> 'erro' is distinct from 'execução não fechada em 6 h (processo interrompido)' then
    raise exception 'COLETA RUN CHECK FALHOU: CA-1: órfão de outra fonte não foi encerrado: %', row_to_json(r);
  end if;

  -- Spec 0063, CA-2: execução viva (1 h) de outra fonte continua executando.
  v_id := public.coleta_externa_iniciar('fiesc', 'leads', null);
  update private.coleta_externa_run set started_at = now() - interval '1 hour' where id = v_id;
  perform public.coleta_externa_iniciar('firjan', 'leads', null);
  select * into r from private.coleta_externa_run where id = v_id;
  if r.status <> 'executando' or r.finished_at is not null then
    raise exception 'COLETA RUN CHECK FALHOU: CA-2: execução viva foi fechada: %', row_to_json(r);
  end if;

  -- Spec 0063 (K-7): a métrica cobra toda fonte ativa; aqui só a fiesc fica ativa, e ela já concluiu.
  update public.fontes_externas set ativo = false where slug <> 'fiesc';
  select s.valor into v_valor from private.saude_operacional_resumo() s
   where s.verificacao = 'coleta_externa_dias_sem_sucesso';
  if v_valor is null then
    raise exception 'COLETA RUN CHECK FALHOU: saúde continua sem dado após execução concluída';
  end if;

  raise notice 'SUCESSO: coleta_externa_run registrada pelas RPCs (ACL, abertura, fechamento único, saúde)';
end $$;

rollback;
