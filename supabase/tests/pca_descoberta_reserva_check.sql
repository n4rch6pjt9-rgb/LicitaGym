-- P1: descoberta em reserva abandonada, sem liberar conteudo ou escritor antigo.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '30s';
set local request.headers = '{}';
set local role service_role;
do $check$
declare
  plano uuid; fila bigint; token uuid := gen_random_uuid();
  antes jsonb; depois jsonb; comando text; rejeitou boolean; n integer;
begin
  insert into public.pca_planos(id_pca_pncp,ano_exercicio,orgao_cnpj,payload_hash,descoberta_ausente)
    values ('CHK-DESCOBERTA-POSSE/2096',2096,'99000001000101','antes','{"7830":1}')
    returning id into plano;
  insert into public.pca_itens(pca_plano_id,numero_item,classe_material_servico,payload_hash)
    values (plano,1,'7830','item-antes');
  insert into private.pca_plano_fila(id_pca_pncp,orgao_cnpj,ano,sequencial,motivo,status,reserva_token)
    values ('CHK-DESCOBERTA-POSSE/2096','99000001000101',2096,1,'alterado','processando',token)
    returning id into fila;
  -- Reserva viva continua protegida, mesmo para metadados.
  rejeitou := false;
  begin
    perform private.pca_marcar_descoberta(2096,array['CHK-DESCOBERTA-POSSE/2096'],array['7830']);
  exception when serialization_failure then rejeitou := true;
  end;
  if not rejeitou then raise exception 'descoberta interferiu em reserva viva'; end if;

  update private.pca_plano_fila set atualizado_em=now()-interval '16 minutes' where id=fila;
  select to_jsonb(p) into antes from public.pca_planos p where id=plano;
  -- Sem token, alterar conteudo ou ativo continua proibido, mesmo junto com metadados.
  foreach comando in array array[
    'update public.pca_planos set payload_hash=''intruso'' where id=$1',
    'update public.pca_planos set ativo=false where id=$1',
    'update public.pca_planos set titulo=''intruso'',descoberta_ausente=''{}''::jsonb where id=$1',
    'update public.pca_itens set ativo=false where pca_plano_id=$1',
    'update public.pca_itens set payload_hash=''intruso'' where pca_plano_id=$1'
  ] loop
    rejeitou := false;
    begin
      execute comando using plano;
    exception when serialization_failure then rejeitou := true;
    end;
    if not rejeitou then raise exception 'reserva abandonada liberou escrita: %',comando; end if;
  end loop;
  select to_jsonb(p) into depois from public.pca_planos p where id=plano;
  if depois is distinct from antes then raise exception 'escrita rejeitada alterou plano'; end if;
  if not exists (select 1 from public.pca_itens where pca_plano_id=plano and ativo and payload_hash='item-antes')
    then raise exception 'escrita rejeitada alterou item'; end if;

  -- Um token incorreto nunca usa a excecao de descoberta.
  perform set_config('request.headers',jsonb_build_object('x-pca-reserva',gen_random_uuid())::text,true);
  rejeitou := false;
  begin
    perform private.pca_marcar_descoberta(2096,array['CHK-DESCOBERTA-POSSE/2096'],array['7830']);
  exception when serialization_failure then rejeitou := true;
  end;
  if not rejeitou then raise exception 'token incorreto alterou metadados'; end if;

  perform set_config('request.headers','{}',true);
  perform private.pca_marcar_descoberta(2096,array['CHK-DESCOBERTA-POSSE/2096'],array['7830']);
  select to_jsonb(p) into depois from public.pca_planos p where id=plano;
  if depois->'descoberta_ausente' is distinct from '{}'::jsonb
    or (depois-'descoberta_ausente') is distinct from (antes-'descoberta_ausente')
    then raise exception 'descoberta do visto alterou conteudo ou nao zerou contador'; end if;
  perform private.pca_marcar_descoberta(2096,array[]::text[],array['7830']);
  select to_jsonb(p) into depois from public.pca_planos p where id=plano;
  if depois->'descoberta_ausente' is distinct from '{"7830":1}'::jsonb
    or (depois-'descoberta_ausente') is distinct from (antes-'descoberta_ausente')
    then raise exception 'descoberta do ausente alterou conteudo ou nao contou ausencia'; end if;

  -- A reserva abandonada continua recuperavel e o token antigo perde a posse.
  select reserva_token into token from private.pca_fila_reservar(1,5,2096);
  if token is null then raise exception 'reserva nao recuperada'; end if;
  perform set_config('request.headers',jsonb_build_object('x-pca-reserva',token)::text,true);
  update public.pca_itens set payload_hash='escritor-atual' where pca_plano_id=plano;
  get diagnostics n = row_count;
  if n<>1 then raise exception 'escritor atual nao escreveu'; end if;
  raise notice 'SUCESSO P1: metadados recuperados; conteudo, itens, reserva viva e token incorreto protegidos';
end;
$check$;
rollback;
