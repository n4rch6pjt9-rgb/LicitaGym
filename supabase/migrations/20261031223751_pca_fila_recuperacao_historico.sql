-- Recuperacao explicitamente solicitada e auditoria atomica de inativacoes PCA.
begin;
set local lock_timeout = '10s';

create or replace function private.pca_fila_reabrir_esgotados(
  p_ids text[], p_ano integer, p_sync_run_id uuid
) returns integer language plpgsql security invoker set search_path = ''
as $fn$
declare n integer; h jsonb := coalesce(nullif(current_setting('request.headers',true),''),'{}')::jsonb;
begin
  if p_ids is null or cardinality(p_ids) not between 1 and 100 or p_ano is null
     or array_position(p_ids,null) is not null
     or exists(select 1 from unnest(p_ids) id where id !~ '^[0-9]{14}-[0-9]+-[0-9]{1,6}/[0-9]{4}$') then
    raise exception 'IDs de recuperacao PCA invalidos' using errcode='22023';
  end if;
  if h ? 'x-pca-run-id' and h->>'x-pca-run-id' is distinct from p_sync_run_id::text then
    raise exception 'Execucao de recuperacao diverge do header' using errcode='40001';
  end if;
  -- Assim como a aquisicao de execucao, esta RPC exige service_role e run ativo.
  perform 1 from private.pncp_sync_run
    where id=p_sync_run_id and resource_type='pca' and status='executando'
      and lock_key='pca-fila:'||p_ano for share;
  if not found then raise exception 'Execucao de recuperacao nao esta ativa' using errcode='40001'; end if;
  update private.pca_plano_fila set
    status='pendente', tentativas=0, erro=null, disponivel_em=null,
    reserva_token=null, atualizado_em=now(), chain_id=p_sync_run_id
    where ano=p_ano and id_pca_pncp=any(p_ids) and tentativas>=5
      and (status='erro' or (status='processando' and atualizado_em<now()-interval '15 minutes'));
  get diagnostics n = row_count;
  return n;
end;
$fn$;
revoke all on function private.pca_fila_reabrir_esgotados(text[],integer,uuid) from public, anon, authenticated;
grant execute on function private.pca_fila_reabrir_esgotados(text[],integer,uuid) to service_role;

create or replace function private.pca_registrar_inativacao()
returns trigger language plpgsql security invoker set search_path=''
as $fn$
declare plano uuid; item uuid; h jsonb := coalesce(nullif(current_setting('request.headers',true),''),'{}')::jsonb;
begin
  if tg_table_name='pca_planos' then plano:=new.id;
  else plano:=new.pca_plano_id; item:=new.id; end if;
  insert into public.pca_alteracoes(
    pca_plano_id,pca_item_id,tipo_operacao,dados_anteriores,dados_novos,
    payload_hash_anterior,payload_hash_novo,sync_run_id
  ) values (
    plano,item,'inativacao',to_jsonb(old),to_jsonb(new),
    old.payload_hash,new.payload_hash,nullif(h->>'x-pca-run-id','')::uuid
  );
  return new;
end;
$fn$;
revoke all on function private.pca_registrar_inativacao() from public, anon, authenticated;
grant execute on function private.pca_registrar_inativacao() to service_role;
-- Somente true->false: reativacao/insert/update de conteudo ja sao auditados pela RPC.
create or replace trigger pca_itens_historico_inativacao
  after update of ativo on public.pca_itens
  for each row when (old.ativo is distinct from new.ativo and new.ativo=false)
  execute function private.pca_registrar_inativacao();
create or replace trigger pca_planos_historico_inativacao
  after update of ativo on public.pca_planos
  for each row when (old.ativo is distinct from new.ativo and new.ativo=false)
  execute function private.pca_registrar_inativacao();
commit;
