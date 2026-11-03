-- Check transacional dos P2; executar somente em PostgreSQL local descartavel.
begin;
set local request.headers='{}';
set local role service_role;
do $check$
declare
  run uuid; r jsonb; ids text[] := array[
    '99000001000101-0-000001/2094','99000001000101-0-000002/2094','99000001000101-0-000003/2094'];
  n integer; rejeitou boolean; plano uuid; item uuid; antes jsonb; novo jsonb;
begin
  if has_function_privilege('anon','private.pca_fila_reabrir_esgotados(text[],integer,uuid)','execute')
    or has_function_privilege('authenticated','private.pca_fila_reabrir_esgotados(text[],integer,uuid)','execute')
    then raise exception 'ACL de recuperacao incorreta'; end if;
  r:=private.pca_adquirir_execucao('pca-fila:2094','pca','{}',2094);
  run:=(r->>'run_id')::uuid;
  insert into private.pca_plano_fila(id_pca_pncp,orgao_cnpj,ano,sequencial,motivo,
    status,tentativas,erro,data_atualizacao_fonte,reserva_token)
  select ids[i],'99000001000101',2094,i,'alterado',
    case when i=3 then 'processando' else 'erro' end,5,'falha anterior','2026-10-01',gen_random_uuid()
  from generate_series(1,3) i;
  perform private.pca_fila_enfileirar(jsonb_build_array(jsonb_build_object(
    'id_pca_pncp',ids[1],'orgao_cnpj','99000001000101','ano',2094,'sequencial',1,
    'motivo','alterado','data_atualizacao_fonte','2026-10-01')));
  if exists(select 1 from private.pca_fila_reservar(10,5,2094)) then
    raise exception 'Redescoberta reabriu fila esgotada'; end if;
  rejeitou:=false;
  begin perform private.pca_fila_reabrir_esgotados(ids,2094,gen_random_uuid());
    exception when serialization_failure then rejeitou:=true; end;
  if not rejeitou then raise exception 'Recuperacao aceitou execucao inexistente'; end if;
  n:=private.pca_fila_reabrir_esgotados(array[ids[1],ids[3]],2094,run);
  if n<>1 then raise exception 'Reabriu fila nao selecionada ou reserva viva'; end if;
  if not exists(select 1 from private.pca_plano_fila where id_pca_pncp=ids[1]
    and status='pendente' and tentativas=0 and erro is null and reserva_token is null
    and data_atualizacao_fonte='2026-10-01'::timestamptz) then
    raise exception 'Recuperacao alterou fonte ou nao reiniciou ciclo'; end if;
  if exists(select 1 from private.pca_plano_fila where id_pca_pncp=any(ids[2:3]) and tentativas<>5) then
    raise exception 'Recuperacao interferiu em outra fila'; end if;
  select count(*) into n from private.pca_fila_reservar(10,5,2094);
  if n<>1 then raise exception 'Fila recuperada nao foi reservada'; end if;

  -- Outro plano sem reserva para validar o trigger em si.
  insert into public.pca_planos(id_pca_pncp,ano_exercicio,orgao_cnpj,payload_hash)
    values ('CHK-INATIVACAO/2094',2094,'99000001000101','plano-v1') returning id into plano;
  insert into public.pca_itens(pca_plano_id,numero_item,payload_hash,valor_unitario_estimado)
    values(plano,1,'item-v1',100) returning id into item;
  perform set_config('request.headers',jsonb_build_object('x-pca-run-id',run)::text,true);
  select to_jsonb(i) into antes from public.pca_itens i where id=item;
  update public.pca_itens set ativo=false where id=item;
  select to_jsonb(i) into novo from public.pca_itens i where id=item;
  if (select count(*) from public.pca_alteracoes where pca_item_id=item
    and tipo_operacao='inativacao' and dados_anteriores=antes and dados_novos=novo
    and payload_hash_anterior='item-v1' and payload_hash_novo='item-v1' and sync_run_id=run)<>1
    then raise exception 'Inativacao de item sem snapshot atomico'; end if;
  update public.pca_itens set ativo=false where id=item;
  if (select count(*) from public.pca_alteracoes where pca_item_id=item)<>1
    then raise exception 'Repeticao duplicou evento'; end if;
  select to_jsonb(p) into antes from public.pca_planos p where id=plano;
  update public.pca_planos set ativo=false where id=plano;
  select to_jsonb(p) into novo from public.pca_planos p where id=plano;
  if (select count(*) from public.pca_alteracoes where pca_plano_id=plano
    and pca_item_id is null and tipo_operacao='inativacao'
    and dados_anteriores=antes and dados_novos=novo and sync_run_id=run)<>1
    then raise exception 'Inativacao de plano sem snapshot atomico'; end if;
  raise notice 'SUCESSO P2: recuperacao explicita, limite preservado e historico de inativacao';
end;
$check$;
rollback;
