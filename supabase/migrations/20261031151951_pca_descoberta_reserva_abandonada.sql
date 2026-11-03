-- PCA P1: recuperar metadados de descoberta sem liberar escrita de conteúdo.
begin;
set local lock_timeout = '10s';
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
    -- Reserva abandonada: descoberta pode alterar apenas seu contador de ausência.
    -- O bloqueio da fila continua adquirido; conteúdo, itens e reservas vivas
    -- permanecem protegidos. Token fornecido, mesmo antigo, nunca usa esta exceção.
    if tg_table_name = 'pca_planos' and tg_op = 'UPDATE'
       and f.atualizado_em < now() - interval '15 minutes'
       and (to_jsonb(new) - 'descoberta_ausente') is not distinct from
           (to_jsonb(old) - 'descoberta_ausente') then
      return new;
    end if;
    raise exception 'plano PCA reservado por outro escritor' using errcode = '40001';
  end if;
  if tg_op = 'DELETE' then return old; else return new; end if;
end
$function$;
revoke all on function private.pca_validar_escritor() from public, anon, authenticated;
grant execute on function private.pca_validar_escritor() to service_role;

commit;
