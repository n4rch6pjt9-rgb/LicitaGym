-- Spec 0064: fila de processos do coletor do Sistema S (private.coleta_externa_fila) e as RPCs.
--   CA-1 (K-2): enfileirar 3 novos; de novo com 1 listagem alterada -> 1 reaberto, 2 inalterados, sem duplicar;
--         revisita: 'feito' em leads/monitorar processado há mais de 24 h volta a pendente;
--   CA-2 (K-3): reservar com limite 3 duas vezes -> conjuntos disjuntos, 5 no total; a função usa
--         `for update skip locked` (duas sessões reais não cabem num check de uma transação só);
--         'processando' há mais de 2 h volta a pendente;
--   CA-3 (K-3): com 5 falhas, erro de novo fica 'erro'; com 4 falhas, volta a 'pendente'; id inexistente = 22023;
--   CA-4 (K-1..K-3): anon/authenticated sem acesso à tabela nem às RPCs; service_role só EXECUTE nas RPCs.
-- Fixtures revertidas ao final.
begin;

do $$
declare
  f_enf regprocedure := to_regprocedure('public.coleta_externa_fila_enfileirar(text, jsonb)');
  f_res regprocedure := to_regprocedure('public.coleta_externa_fila_reservar(text, integer)');
  f_mar regprocedure := to_regprocedure('public.coleta_externa_fila_marcar(bigint, boolean, text)');
  c jsonb;
  ids1 bigint[];
  ids2 bigint[];
  v_id bigint;
  r record;
  rejeitou boolean := false;
  papel text;
  priv text;
begin
  if to_regclass('private.coleta_externa_fila') is null or f_enf is null or f_res is null or f_mar is null then
    raise exception 'COLETA FILA CHECK FALHOU: tabela ou RPCs ausentes';
  end if;

  -- CA-4 ---------------------------------------------------------------------------------------------------------
  foreach papel in array array['anon', 'authenticated'] loop
    foreach priv in array array['SELECT', 'INSERT', 'UPDATE', 'DELETE'] loop
      if has_table_privilege(papel, 'private.coleta_externa_fila', priv) then
        raise exception 'COLETA FILA CHECK FALHOU: CA-4: % tem % na tabela', papel, priv;
      end if;
    end loop;
    if has_function_privilege(papel, f_enf, 'EXECUTE') or has_function_privilege(papel, f_res, 'EXECUTE')
       or has_function_privilege(papel, f_mar, 'EXECUTE') then
      raise exception 'COLETA FILA CHECK FALHOU: CA-4: % executa as RPCs', papel;
    end if;
  end loop;
  if not (has_function_privilege('service_role', f_enf, 'EXECUTE') and has_function_privilege('service_role', f_res, 'EXECUTE')
          and has_function_privilege('service_role', f_mar, 'EXECUTE')) then
    raise exception 'COLETA FILA CHECK FALHOU: CA-4: service_role sem EXECUTE nas RPCs';
  end if;
  foreach priv in array array['SELECT', 'INSERT', 'UPDATE', 'DELETE'] loop
    if has_table_privilege('service_role', 'private.coleta_externa_fila', priv) then
      raise exception 'COLETA FILA CHECK FALHOU: CA-4: service_role tem % direto na tabela (só via RPC)', priv;
    end if;
  end loop;
  if not (select c2.relrowsecurity from pg_class c2 where c2.oid = 'private.coleta_externa_fila'::regclass) then
    raise exception 'COLETA FILA CHECK FALHOU: CA-4: RLS desligada';
  end if;
  if exists (select 1 from pg_policy p where p.polrelid = 'private.coleta_externa_fila'::regclass) then
    raise exception 'COLETA FILA CHECK FALHOU: CA-4: tabela tem policy (deve ser sem policy)';
  end if;
  if exists (select 1 from pg_proc p where p.oid in (f_enf, f_res, f_mar)
              and not (p.prosecdef and exists (select 1 from unnest(p.proconfig) x where x like 'search_path=%'))) then
    raise exception 'COLETA FILA CHECK FALHOU: CA-4: RPC sem security definer ou sem search_path fixo';
  end if;

  delete from private.coleta_externa_fila;

  -- fonte nula = 22004
  begin
    perform public.coleta_externa_fila_enfileirar(null, '[]'::jsonb);
  exception when null_value_not_allowed then
    rejeitou := true;
  end;
  if not rejeitou then
    raise exception 'COLETA FILA CHECK FALHOU: fonte nula aceita';
  end if;

  -- CA-1 ---------------------------------------------------------------------------------------------------------
  c := public.coleta_externa_fila_enfileirar('fiesc', '[
    {"nCdOrigem": 101, "modulo": 59, "listagem": {"nCdOrigem": 101, "sDsObjeto": "A"}},
    {"nCdOrigem": 102, "modulo": 59, "listagem": {"nCdOrigem": 102, "sDsObjeto": "B"}},
    {"nCdOrigem": 103, "modulo": 18, "listagem": {"nCdOrigem": 103, "sDsObjeto": "C"}}]'::jsonb);
  if c ->> 'novos' <> '3' or c ->> 'reabertos' <> '0' or c ->> 'inalterados' <> '0' then
    raise exception 'COLETA FILA CHECK FALHOU: CA-1: primeira chamada devia ser 3/0/0, veio %', c;
  end if;
  c := public.coleta_externa_fila_enfileirar('fiesc', '[
    {"nCdOrigem": 101, "modulo": 59, "listagem": {"nCdOrigem": 101, "sDsObjeto": "A"}},
    {"nCdOrigem": 102, "modulo": 59, "listagem": {"nCdOrigem": 102, "sDsObjeto": "B alterado"}},
    {"nCdOrigem": 103, "modulo": 18, "listagem": {"nCdOrigem": 103, "sDsObjeto": "C"}}]'::jsonb);
  if c ->> 'novos' <> '0' or c ->> 'reabertos' <> '1' or c ->> 'inalterados' <> '2' then
    raise exception 'COLETA FILA CHECK FALHOU: CA-1: segunda chamada devia ser 0/1/2, veio %', c;
  end if;
  if (select count(*) from private.coleta_externa_fila where fonte = 'fiesc') <> 3 then
    raise exception 'COLETA FILA CHECK FALHOU: CA-1: linha duplicada';
  end if;
  if (select listagem ->> 'sDsObjeto' from private.coleta_externa_fila where fonte = 'fiesc' and n_cd_origem = 102)
     <> 'B alterado' then
    raise exception 'COLETA FILA CHECK FALHOU: CA-1: listagem nova não gravada';
  end if;

  -- CA-1: 'feito' com hash mudado volta a pendente zerando tentativas
  update private.coleta_externa_fila set status = 'feito', tentativas = 3, processado_em = now()
   where fonte = 'fiesc' and n_cd_origem = 101;
  c := public.coleta_externa_fila_enfileirar('fiesc',
    '[{"nCdOrigem": 101, "modulo": 59, "listagem": {"nCdOrigem": 101, "sDsObjeto": "A2"}}]'::jsonb);
  select * into r from private.coleta_externa_fila where fonte = 'fiesc' and n_cd_origem = 101;
  if c ->> 'reabertos' <> '1' or r.status <> 'pendente' or r.tentativas <> 0 then
    raise exception 'COLETA FILA CHECK FALHOU: CA-1: feito com hash novo não reabriu: % %', c, row_to_json(r);
  end if;

  -- CA-1 (revisita): feito, mesmo hash, licitação em leads processada há 25 h -> pendente; há 1 h -> inalterado
  update private.coleta_externa_fila set status = 'feito', processado_em = now() - interval '25 hours'
   where fonte = 'fiesc' and n_cd_origem = 101;
  insert into public.licitacoes_externas (fonte, modulo, id_externo, prioridade, raw)
  values ('fiesc', 59, 9101, 'leads', '{"nCdOrigem": 101}'::jsonb);
  c := public.coleta_externa_fila_enfileirar('fiesc',
    '[{"nCdOrigem": 101, "modulo": 59, "listagem": {"nCdOrigem": 101, "sDsObjeto": "A2"}}]'::jsonb);
  if c ->> 'reabertos' <> '1'
     or (select status from private.coleta_externa_fila where fonte = 'fiesc' and n_cd_origem = 101) <> 'pendente' then
    raise exception 'COLETA FILA CHECK FALHOU: CA-1: revisita de lead após 24 h não reabriu: %', c;
  end if;
  update private.coleta_externa_fila set status = 'feito', processado_em = now() - interval '1 hour'
   where fonte = 'fiesc' and n_cd_origem = 101;
  c := public.coleta_externa_fila_enfileirar('fiesc',
    '[{"nCdOrigem": 101, "modulo": 59, "listagem": {"nCdOrigem": 101, "sDsObjeto": "A2"}}]'::jsonb);
  if c ->> 'inalterados' <> '1' then
    raise exception 'COLETA FILA CHECK FALHOU: CA-1: lead processado há 1 h reabriu: %', c;
  end if;
  -- histórico (não leads/monitorar) processado há 25 h, mesmo hash: inalterado
  update public.licitacoes_externas set prioridade = 'historico' where fonte = 'fiesc' and id_externo = 9101;
  update private.coleta_externa_fila set processado_em = now() - interval '25 hours'
   where fonte = 'fiesc' and n_cd_origem = 101;
  c := public.coleta_externa_fila_enfileirar('fiesc',
    '[{"nCdOrigem": 101, "modulo": 59, "listagem": {"nCdOrigem": 101, "sDsObjeto": "A2"}}]'::jsonb);
  if c ->> 'inalterados' <> '1' then
    raise exception 'COLETA FILA CHECK FALHOU: CA-1: histórico reabriu sem mudança: %', c;
  end if;

  -- CA-2 ---------------------------------------------------------------------------------------------------------
  delete from private.coleta_externa_fila;
  perform public.coleta_externa_fila_enfileirar('fiesc', (
    select jsonb_agg(jsonb_build_object('nCdOrigem', g, 'modulo', 59, 'listagem', jsonb_build_object('n', g)))
      from generate_series(1, 5) g));
  -- item de outra fonte não sai na reserva da fiesc
  perform public.coleta_externa_fila_enfileirar('firjan',
    '[{"nCdOrigem": 1, "modulo": 59, "listagem": {"n": 1}}]'::jsonb);
  select array_agg(x.id) into ids1 from public.coleta_externa_fila_reservar('fiesc', 3) x;
  select array_agg(x.id) into ids2 from public.coleta_externa_fila_reservar('fiesc', 3) x;
  if cardinality(ids1) <> 3 or cardinality(ids2) <> 2 or ids1 && ids2 then
    raise exception 'COLETA FILA CHECK FALHOU: CA-2: reservas % e % não são 3+2 disjuntas', ids1, ids2;
  end if;
  if (select count(*) from private.coleta_externa_fila where fonte = 'fiesc' and status = 'processando') <> 5 then
    raise exception 'COLETA FILA CHECK FALHOU: CA-2: reservados não ficaram processando';
  end if;
  if pg_get_functiondef(f_res) !~* 'for\s+update\s+skip\s+locked' then
    raise exception 'COLETA FILA CHECK FALHOU: CA-2: reservar sem for update skip locked';
  end if;
  -- processando há mais de 2 h volta a pendente e sai de novo
  update private.coleta_externa_fila set atualizado_em = now() - interval '3 hours' where id = ids1[1];
  select array_agg(x.id) into ids2 from public.coleta_externa_fila_reservar('fiesc', 10) x;
  if ids2 is distinct from array[ids1[1]] then
    raise exception 'COLETA FILA CHECK FALHOU: CA-2: processando > 2 h não voltou à fila: %', ids2;
  end if;

  -- CA-3 ---------------------------------------------------------------------------------------------------------
  v_id := ids1[2];
  update private.coleta_externa_fila set tentativas = 4, status = 'processando' where id = v_id;
  perform public.coleta_externa_fila_marcar(v_id, false, 'HTTP 500');
  select * into r from private.coleta_externa_fila where id = v_id;
  if r.status <> 'pendente' or r.tentativas <> 5 or r.erro <> 'HTTP 500' then
    raise exception 'COLETA FILA CHECK FALHOU: CA-3: com 4 falhas devia voltar a pendente: %', row_to_json(r);
  end if;
  update private.coleta_externa_fila set status = 'processando' where id = v_id;
  perform public.coleta_externa_fila_marcar(v_id, false, 'HTTP 500 de novo');
  select * into r from private.coleta_externa_fila where id = v_id;
  if r.status <> 'erro' or r.tentativas <> 6 then
    raise exception 'COLETA FILA CHECK FALHOU: CA-3: com 5 falhas devia ficar erro: %', row_to_json(r);
  end if;
  -- ok -> feito, com processado_em
  perform public.coleta_externa_fila_marcar(ids1[3], true, null);
  select * into r from private.coleta_externa_fila where id = ids1[3];
  if r.status <> 'feito' or r.processado_em is null or r.erro is not null then
    raise exception 'COLETA FILA CHECK FALHOU: CA-3: ok não virou feito: %', row_to_json(r);
  end if;
  rejeitou := false;
  begin
    perform public.coleta_externa_fila_marcar(-1, true, null);
  exception when invalid_parameter_value then
    rejeitou := true;
  end;
  if not rejeitou then
    raise exception 'COLETA FILA CHECK FALHOU: CA-3: id inexistente aceito';
  end if;

  -- Revisão da migration (13/11/2026) ---------------------------------------------------------------------------
  -- (a) ok nulo devolve a pendente sem contar tentativa e mantém o erro anterior
  v_id := ids1[2];
  update private.coleta_externa_fila set status = 'processando', tentativas = 2, erro = 'antes' where id = v_id;
  if not public.coleta_externa_fila_marcar(v_id, null, null) then
    raise exception 'COLETA FILA CHECK FALHOU: devolução (ok nulo) não marcou';
  end if;
  select * into r from private.coleta_externa_fila where id = v_id;
  if r.status <> 'pendente' or r.tentativas <> 2 or r.erro <> 'antes' then
    raise exception 'COLETA FILA CHECK FALHOU: devolução contou tentativa ou perdeu o erro: %', row_to_json(r);
  end if;
  -- (e) item fora de 'processando' (reserva vencida, talvez com outro worker) não é marcado: false
  if public.coleta_externa_fila_marcar(v_id, true, null) then
    raise exception 'COLETA FILA CHECK FALHOU: marcou item que não estava em processando';
  end if;
  if (select status from private.coleta_externa_fila where id = v_id) <> 'pendente' then
    raise exception 'COLETA FILA CHECK FALHOU: item fora de processando mudou de status';
  end if;
  -- (f) reserva abandonada conta tentativa; com 5 falhas, vai para erro em vez de voltar
  update private.coleta_externa_fila set status = 'processando', tentativas = 5, atualizado_em = now() - interval '3 hours'
   where id = v_id;
  perform public.coleta_externa_fila_reservar('fiesc', 1);
  select * into r from private.coleta_externa_fila where id = v_id;
  if r.status <> 'erro' or r.tentativas <> 6 then
    raise exception 'COLETA FILA CHECK FALHOU: reserva abandonada com 5 falhas devia ir a erro: %', row_to_json(r);
  end if;

  -- (b) item em processando com hash novo: inalterado e não mexido
  delete from private.coleta_externa_fila;
  perform public.coleta_externa_fila_enfileirar('fiesc', '[{"nCdOrigem": 201, "modulo": 59, "listagem": {"v": 1}}]'::jsonb);
  update private.coleta_externa_fila set status = 'processando' where n_cd_origem = 201;
  c := public.coleta_externa_fila_enfileirar('fiesc', '[{"nCdOrigem": 201, "modulo": 59, "listagem": {"v": 2}}]'::jsonb);
  select * into r from private.coleta_externa_fila where n_cd_origem = 201;
  if c ->> 'inalterados' <> '1' or r.status <> 'processando' or r.listagem ->> 'v' <> '1' then
    raise exception 'COLETA FILA CHECK FALHOU: item em processando foi alterado: % %', c, row_to_json(r);
  end if;

  -- (c) revisita pelo id_externo quando o raw não traz nCdOrigem
  update private.coleta_externa_fila set status = 'feito', processado_em = now() - interval '25 hours'
   where n_cd_origem = 201;
  insert into public.licitacoes_externas (fonte, modulo, id_externo, prioridade, raw)
  values ('fiesc', 59, 201, 'monitorar', '{}'::jsonb);
  c := public.coleta_externa_fila_enfileirar('fiesc', '[{"nCdOrigem": 201, "modulo": 59, "listagem": {"v": 1}}]'::jsonb);
  if c ->> 'reabertos' <> '1' then
    raise exception 'COLETA FILA CHECK FALHOU: revisita pelo id_externo não reabriu: %', c;
  end if;

  -- (d) o mesmo processo duas vezes no lote: uma linha, contado uma vez
  c := public.coleta_externa_fila_enfileirar('fiesc', '[
    {"nCdOrigem": 301, "modulo": 59, "listagem": {"v": 1}},
    {"nCdOrigem": 301, "modulo": 59, "listagem": {"v": 1}}]'::jsonb);
  if c ->> 'novos' <> '1' or (select count(*) from private.coleta_externa_fila where n_cd_origem = 301) <> 1 then
    raise exception 'COLETA FILA CHECK FALHOU: duplicado no lote: %', c;
  end if;

  raise notice 'SUCESSO: coleta_externa_fila_check (CA-1, CA-2, CA-3, CA-4 e casos da revisão)';
end $$;

rollback;
