begin;
set local role service_role;
do $check$
declare
  a jsonb; b jsonb; r1 uuid; plan_id uuid; t1 uuid; t2 uuid; fila_id bigint; n integer;
begin
  if has_function_privilege('anon', 'private.pca_adquirir_execucao(text,text,jsonb,integer)', 'execute')
     or has_function_privilege('authenticated', 'private.pca_adquirir_execucao(text,text,jsonb,integer)', 'execute')
     or not has_function_privilege('service_role', 'private.pca_adquirir_execucao(text,text,jsonb,integer)', 'execute')
  then raise exception 'ACL PCA incorreta'; end if;
  a := private.pca_adquirir_execucao('pca-fila:2098', 'pca', '{"ano":2098}', 2098);
  r1 := (a->>'run_id')::uuid;
  b := private.pca_adquirir_execucao('pca-sync:manual:2098:7830', 'pca', '{}', 2098);
  if b->>'already_running' <> 'true' or b->>'run_id' <> r1::text then
    raise exception 'legado concorreu com fila';
  end if;
  b := private.pca_adquirir_execucao('pca-sync:2097:7830', 'pca', '{}', 2097);
  if b->>'already_running' <> 'false' then raise exception 'outro ano bloqueado'; end if;
  a := private.pca_adquirir_execucao('pca-fila:2097', 'pca', '{}', 2097);
  if a->>'already_running' <> 'true' then raise exception 'fila concorreu com legado'; end if;
  update private.pncp_sync_run set last_heartbeat_at=now()-interval '5 minutes' where id=(b->>'run_id')::uuid;
  a := private.pca_adquirir_execucao('pca-fila:2097', 'pca', '{}', 2097);
  if a->>'already_running' <> 'false' then raise exception 'legado stale bloqueou fila'; end if;

  insert into public.pca_planos(id_pca_pncp,ano_exercicio,orgao_cnpj,payload_hash)
    values ('CHK-POSSE',2098,'99000001000101','antes') returning id into plan_id;
  insert into public.pca_itens(pca_plano_id,numero_item,payload_hash) values (plan_id,1,'antes');
  insert into private.pca_plano_fila(id_pca_pncp,orgao_cnpj,ano,sequencial,motivo)
    values ('CHK-POSSE','99000001000101',2098,1,'novo') returning id into fila_id;
  select reserva_token into t1 from private.pca_fila_reservar(1,5,2098);
  if t1 is null then raise exception 'reserva sem token'; end if;
  update private.pca_plano_fila set atualizado_em = now() - interval '16 minutes' where id = fila_id;
  select reserva_token into t2 from private.pca_fila_reservar(1,5,2098);
  if t2 is null or t2 = t1 then raise exception 'recuperação não trocou token'; end if;
  update private.pca_plano_fila set status = 'feito' where id=fila_id and reserva_token=t1;
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'worker velho finalizou reserva nova'; end if;

  perform set_config('request.headers',jsonb_build_object('x-pca-reserva',t1,'x-pca-run-id',r1)::text,true);
  begin
    update public.pca_planos set payload_hash='velho' where id=plan_id;
    raise exception 'worker velho escreveu plano';
  exception when serialization_failure then null; end;
  begin
    update public.pca_itens set ativo=false where pca_plano_id=plan_id;
    raise exception 'worker velho inativou item';
  exception when serialization_failure then null; end;
  perform set_config('request.headers','{}',true);
  begin
    update public.pca_itens set ativo=false where pca_plano_id=plan_id;
    raise exception 'escritor sem token interferiu na reserva';
  exception when serialization_failure then null; end;
  perform set_config('request.headers',jsonb_build_object('x-pca-reserva',t2,'x-pca-run-id',r1)::text,true);
  update public.pca_planos set payload_hash='novo' where id=plan_id;
  update public.pca_itens set payload_hash='novo' where pca_plano_id=plan_id;
  update private.pncp_sync_run set status='falhou' where id=r1;
  begin
    update public.pca_itens set ativo=false where pca_plano_id=plan_id;
    raise exception 'execução encerrada escreveu';
  exception when serialization_failure then null; end;
  if exists(select 1 from public.pca_itens where pca_plano_id=plan_id and not ativo)
  then raise exception 'itens inativados por escritor inválido'; end if;
end
$check$;
rollback;
