-- Fixtures isoladas e revertidas ao final.
begin;

do $check$
declare
  j jsonb;
  run_ok uuid := '99000000-0000-4000-8000-000000000001';
  run_parcial uuid := '99000000-0000-4000-8000-000000000002';
  run_erro uuid := '99000000-0000-4000-8000-000000000003';
  run_ativo uuid := '99000000-0000-4000-8000-000000000004';
  rejeitou boolean := false;
begin
  if has_function_privilege('anon',
       'public.pca_estado_operacional(integer)', 'execute')
     or has_function_privilege('authenticated',
       'public.pca_estado_operacional(integer)', 'execute')
     or not has_function_privilege('service_role',
       'public.pca_estado_operacional(integer)', 'execute') then
    raise exception 'Permissoes da RPC incorretas';
  end if;

  if exists (
    select 1 from pg_proc
    where oid='public.pca_estado_operacional(integer)'::regprocedure
      and (prosecdef or provolatile <> 's')
  ) then
    raise exception 'RPC deve ser SECURITY INVOKER e STABLE';
  end if;

  if exists(select 1 from private.pca_plano_fila where ano=2093)
     or exists(select 1 from private.pncp_sync_run
       where parametros->>'ano'='2093' or lock_key='pca-fila:2093') then
    raise exception 'Ano de fixture ocupado; check interrompido';
  end if;

  j := public.pca_estado_operacional(2093);
  if (j#>>'{fila,total}')::integer <> 0
     or j->'ultima_execucao' <> 'null'::jsonb
     or j->'ultimo_lote_sem_erros' <> 'null'::jsonb then
    raise exception 'Estado vazio incorreto';
  end if;

  begin
    perform public.pca_estado_operacional(null);
  exception when invalid_parameter_value then
    rejeitou := true;
  end;
  if not rejeitou then
    raise exception 'Ano nulo foi aceito';
  end if;

  insert into private.pca_plano_fila
    (id_pca_pncp,orgao_cnpj,ano,sequencial,motivo,
     status,tentativas,atualizado_em)
  values
    ('99000001000101-0-900001/2093','99000001000101',2093,900001,
     'backfill','pendente',0,now()),
    ('99000001000101-0-900002/2093','99000001000101',2093,900002,
     'backfill','erro',2,now()),
    ('99000001000101-0-900003/2093','99000001000101',2093,900003,
     'backfill','erro',5,now()),
    ('99000001000101-0-900004/2093','99000001000101',2093,900004,
     'backfill','processando',0,now()),
    ('99000001000101-0-900005/2093','99000001000101',2093,900005,
     'backfill','processando',1,now()-interval '20 minutes'),
    ('99000001000101-0-900006/2093','99000001000101',2093,900006,
     'backfill','feito',0,now()),
    ('99000001000101-0-900007/2093','99000001000101',2093,900007,
     'backfill','pendente',5,now());

  j := public.pca_estado_operacional(2093);
  if j->'fila' <> '{
    "total":7,"pendentes":1,"processando":2,
    "erros_nao_esgotados":1,"esgotados":2,"feitos":1,
    "abertos":4,"reservas_expiradas":1
  }'::jsonb then
    raise exception 'Contagens divergentes: %',j->'fila';
  end if;

  insert into private.pncp_sync_run
    (id,resource_type,modo,status,lock_key,parametros,
     iniciada_em,finalizada_em,total_erros)
  values
    (run_ok,'pca','incremental','concluida','pca-fila:2093',
     '{"ano":2093,"resumo":{"rotina":"backfill","carga":{
       "erros":0,"planos_feitos":1}}}'::jsonb,
     now()-interval '2 hours',now()-interval '119 minutes',0),
    (run_parcial,'pca','incremental','incompleta','pca-fila:2093',
     '{"ano":2093,"resumo":{"rotina":"reconciliacao","carga":{
       "erros":0,"planos_feitos":10}}}'::jsonb,
     now()-interval '10 minutes',now()-interval '9 minutes',0);

  j := public.pca_estado_operacional(2093);
  if j#>>'{ultima_execucao,sync_id}' <> run_parcial::text
     or j#>>'{ultimo_lote_sem_erros,sync_id}' <> run_parcial::text
     or j#>>'{ultima_execucao,rotina}' <> 'reconciliacao' then
    raise exception 'Lote parcial sem erros nao foi identificado';
  end if;

  insert into private.pncp_sync_run
    (id,resource_type,modo,status,lock_key,parametros,
     iniciada_em,finalizada_em,total_erros,erro_principal)
  values
    (run_erro,'pca','incremental','incompleta','pca-fila:2093',
     '{"ano":2093,"token":"NAO_EXPOR",
       "resumo":{"carga":{"erros":1,"planos_feitos":0}}}'::jsonb,
     now()-interval '3 minutes',now()-interval '2 minutes',
     1,'NAO_EXPOR');

  j := public.pca_estado_operacional(2093);
  if j#>>'{ultima_execucao,sync_id}' <> run_erro::text
     or j#>>'{ultimo_lote_sem_erros,sync_id}' <> run_parcial::text
     or not (j#>>'{ultima_execucao,tem_erro}')::boolean
     or position('NAO_EXPOR' in j::text)>0 then
    raise exception 'Falha recente mascarada ou detalhe privado exposto';
  end if;

  insert into private.pncp_sync_run
    (id,resource_type,modo,status,lock_key,parametros,
     iniciada_em,last_heartbeat_at)
  values
    (run_ativo,'pca','incremental','executando','pca-fila:2093',
     '{"ano":2093}'::jsonb,now(),now());

  j := public.pca_estado_operacional(2093);
  if (j->>'execucoes_ativas')::integer <> 1
     or (j->>'execucoes_sem_heartbeat')::integer <> 0 then
    raise exception 'Execucao ativa nao identificada';
  end if;

  update private.pncp_sync_run
    set iniciada_em=now()-interval '21 minutes',
        last_heartbeat_at=now()-interval '20 minutes'
    where id=run_ativo;

  j := public.pca_estado_operacional(2093);
  if (j->>'execucoes_ativas')::integer <> 0
     or (j->>'execucoes_sem_heartbeat')::integer <> 1 then
    raise exception 'Heartbeat vencido apresentado como atividade';
  end if;

  j := public.pca_estado_operacional(2092);
  if (j#>>'{fila,total}')::integer <> 0
     or j->'ultima_execucao' <> 'null'::jsonb then
    raise exception 'Consulta misturou anos';
  end if;

  if (select count(*) from private.pca_plano_fila where ano=2093) <> 7 then
    raise exception 'Consulta alterou a fila';
  end if;

  raise notice 'SUCESSO: contagens, isolamento por ano, lotes, heartbeat e sigilo';
end;
$check$;

-- Também exige acesso real pelo papel usado no servidor.
set local role service_role;
select public.pca_estado_operacional(2093);
reset role;

rollback;
