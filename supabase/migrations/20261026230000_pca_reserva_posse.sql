-- PCA: posse da reserva e exclusão por ano, preservando as chaves de continuation.
begin;
set local lock_timeout = '10s';
alter table private.pca_plano_fila add column if not exists reserva_token uuid;

create or replace function private.pca_fila_reservar(
  p_limite integer, p_max_tentativas integer default 5, p_ano integer default null
) returns setof private.pca_plano_fila
language sql security invoker set search_path = ''
as $function$
  with reservados as (
    update private.pca_plano_fila f
       set status = 'processando',
           tentativas = f.tentativas + case when f.status = 'processando' then 1 else 0 end,
           atualizado_em = now(), disponivel_em = null, reserva_token = gen_random_uuid()
     where f.id in (
       select g.id from private.pca_plano_fila g
        where (p_ano is null or g.ano = p_ano)
          and g.tentativas < p_max_tentativas
          and (g.disponivel_em is null or g.disponivel_em <= now())
          and (g.status = 'pendente'
            or (g.status = 'erro' and g.atualizado_em < now() - interval '10 minutes')
            or (g.status = 'processando' and g.atualizado_em < now() - interval '15 minutes'))
        order by g.criado_em, g.id limit greatest(p_limite, 0) for update skip locked
     ) returning f.*
  ) select * from reservados order by criado_em, id;
$function$;

create or replace function private.pca_adquirir_execucao(
  p_lock_key text, p_resource_type text, p_parametros jsonb, p_ano integer
) returns jsonb
language plpgsql security invoker set search_path = ''
as $function$
declare r record; v_now timestamptz := clock_timestamp();
begin
  if p_resource_type <> 'pca' or p_ano is null or not (
    p_lock_key = 'pca-fila:' || p_ano
    or p_lock_key like 'pca-sync:' || p_ano || ':%'
    or p_lock_key like 'pca-sync:manual:' || p_ano || ':%'
  ) then raise exception 'chave PCA inválida'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('pca-escrita:' || p_ano));
  for r in
    select * from private.pncp_sync_run
     where status = 'executando' and resource_type = 'pca' and lock_key <> p_lock_key
       and (lock_key = 'pca-fila:' || p_ano
         or lock_key like 'pca-sync:' || p_ano || ':%'
         or lock_key like 'pca-sync:manual:' || p_ano || ':%')
     order by id for update
  loop
    if v_now - coalesce(r.last_heartbeat_at, r.iniciada_em) <= interval '3 minutes' then
      return jsonb_build_object('already_running', true, 'run_id', r.id);
    end if;
    update private.pncp_sync_run set
      status = case when jsonb_typeof(r.parametros->'continuation'->'pending') = 'array'
                     and jsonb_array_length(r.parametros->'continuation'->'pending') > 0
                    then 'incompleta' else 'falhou' end,
      erro_principal = 'lock PCA expirado; outro caminho assumiu o ano',
      finalizada_em = v_now
    where id = r.id;
  end loop;
  return private.acquire_sync_lock(p_lock_key, p_resource_type, p_parametros);
end
$function$;
revoke all on function private.pca_adquirir_execucao(text,text,jsonb,integer) from public, anon, authenticated;
grant execute on function private.pca_adquirir_execucao(text,text,jsonb,integer) to service_role;

-- O bloqueio da linha da fila dura a transação da escrita: a recuperação da reserva precisa esperar.
-- Headers só no cliente service_role do sync; o token é uma identidade, não substitui autenticação/RLS.
create or replace function private.pca_validar_escritor()
returns trigger language plpgsql security invoker set search_path = ''
as $function$
declare
  h jsonb := coalesce(nullif(current_setting('request.headers', true), ''), '{}')::jsonb;
  token text := h->>'x-pca-reserva';
  run_id text := h->>'x-pca-run-id';
  oficial text;
  plano_id uuid;
  f record;
begin
  if run_id is not null then
    perform 1 from private.pncp_sync_run where id::text = run_id and status = 'executando' for share;
    if not found then raise exception 'execução PCA perdeu a posse' using errcode = '40001'; end if;
  end if;
  if tg_table_name = 'pca_planos' then
    if tg_op = 'DELETE' then oficial := old.id_pca_pncp; else oficial := new.id_pca_pncp; end if;
  else
    if tg_op = 'DELETE' then plano_id := old.pca_plano_id; else plano_id := new.pca_plano_id; end if;
    select id_pca_pncp into oficial from public.pca_planos where id = plano_id;
  end if;
  select * into f from private.pca_plano_fila
    where id_pca_pncp = oficial and status = 'processando'
    for update;
  if token is not null then
    if not found or f.reserva_token is null or f.reserva_token::text <> token then
      raise exception 'reserva PCA perdeu a posse' using errcode = '40001';
    end if;
  elsif found then
    raise exception 'plano PCA reservado por outro escritor' using errcode = '40001';
  end if;
  if tg_op = 'DELETE' then return old; else return new; end if;
end
$function$;
revoke all on function private.pca_validar_escritor() from public, anon, authenticated;
grant execute on function private.pca_validar_escritor() to service_role;
create or replace trigger pca_planos_validar_escritor
  before insert or update or delete on public.pca_planos
  for each row execute function private.pca_validar_escritor();
create or replace trigger pca_itens_validar_escritor
  before insert or update or delete on public.pca_itens
  for each row execute function private.pca_validar_escritor();
commit;
