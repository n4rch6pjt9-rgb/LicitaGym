-- Integração entre continuation do legado e a RPC de lock real, sem executar o endpoint.
begin;
set local role service_role;
do $check$
declare a jsonb; b jsonb; primeiro uuid; c jsonb;
begin
  c := '{"formato":"pca-legado-v1","pending":["7830"],"pending_codigos_classificacao":["7830"],
    "classes":["7830"],"pagina_por_codigo_pendente":{"7830":2},"pagina_inicial":2,
    "tamanho_pagina":100,"inicio_completo":true,"periodo":null,"probe_metadata":{}}'::jsonb;
  a := private.pca_adquirir_execucao('pca-sync:2094:7830','pca','{"ano":2094,"forcar":true}',2094);
  primeiro := (a->>'run_id')::uuid;
  c := c || jsonb_build_object('chain_id',primeiro);
  update private.pncp_sync_run set
    modo = 'manual',
    parametros = parametros || jsonb_build_object('continuation',c),
    last_heartbeat_at = now() - interval '5 minutes'
  where id = primeiro;
  b := private.pca_adquirir_execucao('pca-sync:2094:7830','pca','{"ano":2094}',2094);
  if b->>'already_running' <> 'false' or b->'continuation' <> c then
    raise exception 'continuation do legado não foi herdada integralmente';
  end if;
  if not exists(select 1 from private.pncp_sync_run where id=primeiro and status='retomada'
    and retomada_por_id=(b->>'run_id')::uuid) then
    raise exception 'run stale legado não ficou ligado à retomada';
  end if;
  if (select parametros->'continuation' from private.pncp_sync_run where id=(b->>'run_id')::uuid) <> c then
    raise exception 'novo run não nasceu com o checkpoint';
  end if;
end $check$;
rollback;
