-- Verificação da migration 20261009210000_licitacoes_externas_normalizacoes (09/10/2026).
-- Confere: coluna normalizacoes jsonb + constraint de objeto; view prioridade_efetiva lê o prazo normalizado
-- (leads com normalizado vencido sai monitorar, mesmo com raw.data_fim_vigencia implausível); ACL da view.
-- A parte de regra usa uma linha de teste dentro de um savepoint desfeito (nada fica gravado).
do $$
declare
  v_id bigint;
  v_prio text;
begin
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'licitacoes_externas'
                    and column_name = 'normalizacoes' and data_type = 'jsonb') then
    raise exception 'ACL CHECK FALHOU: licitacoes_externas.normalizacoes (jsonb) ausente';
  end if;
  if not exists (select 1 from pg_constraint where conname = 'licext_normalizacoes_objeto_chk'
                    and conrelid = 'public.licitacoes_externas'::regclass and convalidated) then
    raise exception 'ACL CHECK FALHOU: constraint licext_normalizacoes_objeto_chk ausente ou não validada';
  end if;
  if has_table_privilege('anon', 'public.licitacoes_externas_prioridade_efetiva', 'SELECT')
     or has_table_privilege('authenticated', 'public.licitacoes_externas_prioridade_efetiva', 'SELECT')
     or not has_table_privilege('service_role', 'public.licitacoes_externas_prioridade_efetiva', 'SELECT')
     or has_table_privilege('service_role', 'public.licitacoes_externas_prioridade_efetiva', 'INSERT') then
    raise exception 'ACL CHECK FALHOU: grants de licitacoes_externas_prioridade_efetiva';
  end if;
  if not exists (select 1 from pg_class where oid = 'public.licitacoes_externas_prioridade_efetiva'::regclass
                    and coalesce(reloptions, '{}') @> array['security_invoker=true']) then
    raise exception 'ACL CHECK FALHOU: licitacoes_externas_prioridade_efetiva sem security_invoker';
  end if;

  begin
    insert into public.licitacoes_externas (fonte, codigo_externo, prioridade, raw, normalizacoes)
    values ('pncp', 'check-normalizacoes-00000000000000-1-000001/2099', 'leads',
            '{"data_fim_vigencia": "2604-04-16T08:30:00"}'::jsonb,
            '{"data_fim": {"campo": "data_fim", "original": "2604-04-16T08:30:00",
              "normalizado": "2024-04-16T08:30:00-03:00", "regra": "ano_da_abertura", "origem": "inferido"}}'::jsonb)
    returning id into v_id;
    select prioridade into v_prio from public.licitacoes_externas_prioridade_efetiva where id = v_id;
    if v_prio is distinct from 'monitorar' then
      raise exception 'ACL CHECK FALHOU: leads com prazo normalizado vencido saiu % (esperado monitorar)', v_prio;
    end if;
    begin
      update public.licitacoes_externas set normalizacoes = '[]'::jsonb where id = v_id;
      raise exception 'ACL CHECK FALHOU: normalizacoes aceitou array';
    exception when check_violation then null;
    end;
    raise exception 'desfazer' using errcode = 'P0001', detail = 'rollback do savepoint';
  exception when sqlstate 'P0001' then
    if sqlerrm like 'ACL CHECK FALHOU%' then raise; end if;
  end;

  raise notice 'SUCESSO: licitacoes_externas_normalizacoes_check';
end
$$;
