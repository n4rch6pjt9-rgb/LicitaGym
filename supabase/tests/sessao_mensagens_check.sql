-- Checagem da spec 0039, etapa 1 (migration 20261108120000_sessao_mensagens_global.sql).
-- Falha com EXCEPTION se:
--   CA-1  anon ou authenticated (inclui PUBLIC) tiverem qualquer privilégio em public.sessao_mensagens ou em
--         private.integra_compras_run, se a RLS estiver desligada, se houver policy, ou se service_role perder acesso;
--   K-1   public.disputa_mensagens ainda existir, ou chave_mensagem repetida entrar duas vezes;
--   K-1   chave_compra fora de 17 dígitos, tipo fora de ('mensagem','diligencia') ou fonte desconhecida entrar,
--         ou categoria/tipo_remetente nulos (ausentes na fonte) forem recusados;
--   K-2   origem fora de ('cron','usuario') entrar.
-- Fixtures com a compra de demonstração do Serpro (99998803000012026); tudo termina em rollback.

begin;

do $chk$
declare
  v_falhas text[] := array[]::text[];
  v_r record;
  v_tab text;
  v_n int;
begin
  if to_regclass('public.sessao_mensagens') is null then
    raise exception 'sessao_mensagens_check: tabela public.sessao_mensagens não existe';
  end if;
  if to_regclass('private.integra_compras_run') is null then
    raise exception 'sessao_mensagens_check: tabela private.integra_compras_run não existe';
  end if;
  if to_regclass('public.disputa_mensagens') is not null then
    v_falhas := v_falhas || 'public.disputa_mensagens ainda existe'::text;
  end if;

  foreach v_tab in array array['public.sessao_mensagens', 'private.integra_compras_run'] loop
    if not (select relrowsecurity from pg_class where oid = v_tab::regclass) then
      v_falhas := v_falhas || format('RLS desligada em %s', v_tab);
    end if;
    select count(*) into v_n from pg_policy where polrelid = v_tab::regclass;
    if v_n > 0 then
      v_falhas := v_falhas || format('%s tem %s policy(s); o acesso é só pela Edge Function', v_tab, v_n);
    end if;
    for v_r in
      select papel, priv from unnest(array['anon', 'authenticated']) papel
       cross join unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) priv
       where has_table_privilege(papel, v_tab, priv)
    loop
      v_falhas := v_falhas || format('%s tem %s em %s', v_r.papel, v_r.priv, v_tab);
    end loop;
    if not has_table_privilege('service_role', v_tab, 'SELECT')
       or not has_table_privilege('service_role', v_tab, 'INSERT')
       or not has_table_privilege('service_role', v_tab, 'UPDATE') then
      v_falhas := v_falhas || format('service_role sem SELECT/INSERT/UPDATE em %s', v_tab);
    end if;
  end loop;

  -- Idempotência por chave_mensagem (a mesma mensagem lida duas vezes não duplica).
  insert into public.sessao_mensagens
    (chave_compra, identificador_item, chave_mensagem, tipo, categoria, tipo_remetente, texto, data_hora, data_hora_fonte)
  values
    ('99998803000012026', null, '3e6a53fa-6470-4626-ab8a-dfc29c221328', 'mensagem', '11', '0', 'A sessão pública está aberta.',
     '2026-02-05T19:15:00.144Z', '2026-02-05 16:15:00.144')
  on conflict (chave_mensagem) do nothing;
  insert into public.sessao_mensagens
    (chave_compra, identificador_item, chave_mensagem, tipo, categoria, tipo_remetente, texto, data_hora, data_hora_fonte)
  values
    ('99998803000012026', null, '3e6a53fa-6470-4626-ab8a-dfc29c221328', 'mensagem', '11', '0', 'A sessão pública está aberta.',
     '2026-02-05T19:15:00.144Z', '2026-02-05 16:15:00.144')
  on conflict (chave_mensagem) do nothing;
  select count(*) into v_n from public.sessao_mensagens where chave_mensagem = '3e6a53fa-6470-4626-ab8a-dfc29c221328';
  if v_n <> 1 then
    v_falhas := v_falhas || format('chave_mensagem repetida gerou %s linhas', v_n);
  end if;

  begin
    insert into public.sessao_mensagens
      (chave_compra, chave_mensagem, tipo, categoria, tipo_remetente, texto, data_hora, data_hora_fonte)
    values ('123', gen_random_uuid(), 'mensagem', '2', '0', 'x', now(), 'x');
    v_falhas := v_falhas || 'chave_compra com menos de 17 dígitos entrou'::text;
  exception when check_violation then null;
  end;

  begin
    insert into public.sessao_mensagens
      (chave_compra, chave_mensagem, tipo, categoria, tipo_remetente, texto, data_hora, data_hora_fonte)
    values ('99998803000012026', gen_random_uuid(), 'aviso', '2', '0', 'x', now(), 'x');
    v_falhas := v_falhas || 'tipo fora de mensagem/diligencia entrou'::text;
  exception when check_violation then null;
  end;

  begin
    insert into public.sessao_mensagens
      (chave_compra, chave_mensagem, tipo, categoria, tipo_remetente, texto, data_hora, data_hora_fonte, fonte)
    values ('99998803000012026', gen_random_uuid(), 'mensagem', '2', '0', 'x', now(), 'x', 'outra');
    v_falhas := v_falhas || 'fonte fora de integra_compras/extensao entrou'::text;
  exception when check_violation then null;
  end;

  -- Ausência na fonte fica nula (não vira '').
  insert into public.sessao_mensagens
    (chave_compra, chave_mensagem, tipo, categoria, tipo_remetente, texto, data_hora, data_hora_fonte)
  values ('99998803000012026', gen_random_uuid(), 'mensagem', null, null, 'x', now(), 'x');

  begin
    insert into private.integra_compras_run (chave_compra, origem) values ('99998803000012026', 'manual');
    v_falhas := v_falhas || 'origem fora de cron/usuario entrou'::text;
  exception when check_violation then null;
  end;

  if array_length(v_falhas, 1) > 0 then
    raise exception 'ACL CHECK FALHOU (sessao_mensagens): %', array_to_string(v_falhas, '; ');
  end if;
  raise notice 'SUCESSO: sessao_mensagens_check';
end
$chk$;

rollback;
