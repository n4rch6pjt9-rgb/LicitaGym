-- Verificação da saúde operacional (migration 20261001100000_saude_operacional).
-- Executar após aplicar as migrations (scripts/validar-migrations.sh roda todos os *_check.sql):
--   1. private.saude_limiares: RLS ligado, anon/authenticated sem privilégio, service_role com escrita
--   2. private.saude_operacional_resumo(): security definer, search_path fixo, EXECUTE só service_role
--   3. a função responde sem erro, com status válidos, e cobre as verificações que não dependem de pg_cron
-- Só leitura. Falha com EXCEPTION na primeira regra violada.

do $$
declare
  v_fn regprocedure := to_regprocedure('private.saude_operacional_resumo()');
  v_priv text;
  v_n bigint;
  v_faltando text;
begin
  if to_regclass('private.saude_limiares') is null then
    raise exception 'SAUDE CHECK FALHOU: private.saude_limiares não existe';
  end if;
  if not (select relrowsecurity from pg_class where oid = 'private.saude_limiares'::regclass) then
    raise exception 'SAUDE CHECK FALHOU: RLS desligado em private.saude_limiares';
  end if;
  foreach v_priv in array array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE'] loop
    if has_table_privilege('anon', 'private.saude_limiares', v_priv)
       or has_table_privilege('authenticated', 'private.saude_limiares', v_priv) then
      raise exception 'SAUDE CHECK FALHOU: anon/authenticated possui % em private.saude_limiares', v_priv;
    end if;
  end loop;
  if not has_table_privilege('service_role', 'private.saude_limiares', 'UPDATE') then
    raise exception 'SAUDE CHECK FALHOU: service_role sem UPDATE em private.saude_limiares';
  end if;

  if v_fn is null then
    raise exception 'SAUDE CHECK FALHOU: private.saude_operacional_resumo() não existe';
  end if;
  if has_function_privilege('anon', v_fn, 'EXECUTE') or has_function_privilege('authenticated', v_fn, 'EXECUTE') then
    raise exception 'SAUDE CHECK FALHOU: anon/authenticated executa saude_operacional_resumo()';
  end if;
  if not has_function_privilege('service_role', v_fn, 'EXECUTE') then
    raise exception 'SAUDE CHECK FALHOU: service_role não executa saude_operacional_resumo()';
  end if;
  if not exists (select 1 from pg_proc where oid = v_fn and prosecdef
                  and exists (select 1 from unnest(proconfig) c where c like 'search_path=%')) then
    raise exception 'SAUDE CHECK FALHOU: saude_operacional_resumo() precisa ser security definer com search_path fixo';
  end if;

  select count(*) into v_n from private.saude_operacional_resumo() r where r.status not in ('ok', 'atencao', 'critico');
  if v_n > 0 then
    raise exception 'SAUDE CHECK FALHOU: % verificação(ões) com status inválido', v_n;
  end if;
  select string_agg(e, ', ') into v_faltando
    from unnest(array['pncp_sync_heartbeat_parado', 'pncp_sync_falhas_24h', 'pncp_sync_dias_sem_sucesso',
                      'licitacoes_horas_sem_novas', 'itens_sem_taxonomia_pct', 'precos_dias_sem_coleta']) e
   where e not in (select r.verificacao from private.saude_operacional_resumo() r);
  if v_faltando is not null then
    raise exception 'SAUDE CHECK FALHOU: verificações ausentes no resumo: %', v_faltando;
  end if;

  raise notice 'SUCESSO: saúde operacional conferida';
end $$;
