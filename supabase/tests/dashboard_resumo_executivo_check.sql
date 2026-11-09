-- Verificação da migration 20261109040000_dashboard_resumo_executivo (spec 0048, K-1).
-- CA-1: conta só leads + monitorar canônicas; histórico e não canônica ficam fora; soma só das ativas com valor.
-- CA-2: sem valor nenhum -> valor_potencial_total null (nunca 0); janela "amanhã" vai até 23:59:59 de amanhã
--       em Brasília (00:00 do dia seguinte já não entra).
-- CA-3: EXECUTE só para service_role (anon e authenticated recebem erro de permissão); security invoker;
--       search_path fixo.
-- As linhas de teste ficam num bloco desfeito no fim (nada fica gravado). Prazos em 2099 para a view não rebaixar
-- os leads pelo relógio real; a janela de prazo da função usa p_agora.
do $$
declare
  v_fn regprocedure := to_regprocedure('public.dashboard_resumo_executivo(bigint[],timestamp with time zone)');
  v_agora constant timestamptz := '2099-03-10 12:00:00-03';
  v_l1 bigint; v_l2 bigint; v_l3 bigint; v_m1 bigint; v_h1 bigint; v_n1 bigint;
  r record;
begin
  if v_fn is null then
    raise exception 'ACL CHECK FALHOU: public.dashboard_resumo_executivo(bigint[], timestamptz) ausente';
  end if;

  -- CA-3: ACL e atributos -------------------------------------------------------------------------------------------
  if has_function_privilege('anon', v_fn, 'EXECUTE')
     or has_function_privilege('authenticated', v_fn, 'EXECUTE')
     or has_function_privilege('public', v_fn, 'EXECUTE') then
    raise exception 'CA-3 FALHOU: anon/authenticated/public podem executar dashboard_resumo_executivo';
  end if;
  if not has_function_privilege('service_role', v_fn, 'EXECUTE') then
    raise exception 'CA-3 FALHOU: service_role não executa dashboard_resumo_executivo';
  end if;
  if exists (select 1 from pg_proc where oid = v_fn and prosecdef) then
    raise exception 'CA-3 FALHOU: dashboard_resumo_executivo deve ser security invoker';
  end if;
  if not exists (select 1 from pg_proc where oid = v_fn
                    and exists (select 1 from unnest(coalesce(proconfig, '{}')) c where c like 'search_path=%')) then
    raise exception 'CA-3 FALHOU: dashboard_resumo_executivo sem search_path fixo';
  end if;

  begin
    insert into public.fontes_externas (slug, entidade, plataforma, base_url, modo_coleta)
    values ('pncp', 'PNCP', 'pncp', 'https://pncp.gov.br', 'automatico')
    on conflict (slug) do nothing;

    -- L1: lead canônico com valor, prazo 23:59 de amanhã (BRT). N1: mesma compra republicada, prazo menor -> não canônica.
    insert into public.licitacoes_externas (fonte, codigo_externo, orgao_cnpj, numero_processo, numero_edital, data_fim,
                                            valor_total, prioridade)
    values ('pncp', 'check-resumo-00000000000901-1-000001/2099', '00000000000901', '0901/2099', 'PE 901/2099',
            '2099-03-11 23:59:00-03', 1000.00, 'leads')
    returning id into v_l1;
    insert into public.licitacoes_externas (fonte, codigo_externo, orgao_cnpj, numero_processo, numero_edital, data_fim,
                                            valor_total, prioridade)
    values ('pncp', 'check-resumo-00000000000901-1-000002/2099', '00000000000901', '0901/2099', 'PE 901/2099',
            '2099-03-11 10:00:00-03', 500000.00, 'leads')
    returning id into v_n1;
    -- L2: lead com valor, prazo 00:00 do dia depois de amanhã (fora de "amanhã", dentro de 7 dias).
    insert into public.licitacoes_externas (fonte, codigo_externo, orgao_cnpj, numero_processo, numero_edital, data_fim,
                                            valor_total, prioridade)
    values ('pncp', 'check-resumo-00000000000902-1-000001/2099', '00000000000902', '0902/2099', 'PE 902/2099',
            '2099-03-12 00:00:00-03', 2000.50, 'leads')
    returning id into v_l2;
    -- L3: lead sem valor, prazo fora das janelas.
    insert into public.licitacoes_externas (fonte, codigo_externo, orgao_cnpj, numero_processo, numero_edital, data_fim,
                                            valor_total, prioridade)
    values ('pncp', 'check-resumo-00000000000903-1-000001/2099', '00000000000903', '0903/2099', 'PE 903/2099',
            '2099-04-01 10:00:00-03', null, 'leads')
    returning id into v_l3;
    -- M1: monitorar com valor, prazo dentro de 7 dias.
    insert into public.licitacoes_externas (fonte, codigo_externo, orgao_cnpj, numero_processo, numero_edital, data_fim,
                                            valor_total, prioridade)
    values ('pncp', 'check-resumo-00000000000904-1-000001/2099', '00000000000904', '0904/2099', 'PE 904/2099',
            '2099-03-15 10:00:00-03', 300.00, 'monitorar')
    returning id into v_m1;
    -- H1: lead gravado, mas homologado -> histórico efetivo.
    insert into public.licitacoes_externas (fonte, codigo_externo, orgao_cnpj, numero_processo, numero_edital, data_fim,
                                            valor_total, prioridade, data_homologacao)
    values ('pncp', 'check-resumo-00000000000905-1-000001/2099', '00000000000905', '0905/2099', 'PE 905/2099',
            '2099-03-11 09:00:00-03', 9999.00, 'leads', '2099-03-01 10:00:00-03')
    returning id into v_h1;

    -- Pré-condição dos fixtures na view.
    if (select count(*) from public.licitacoes_externas_prioridade_efetiva
         where id in (v_l1, v_l2, v_l3) and prioridade = 'leads' and eh_canonica) <> 3
       or (select prioridade from public.licitacoes_externas_prioridade_efetiva where id = v_m1) is distinct from 'monitorar'
       or (select prioridade from public.licitacoes_externas_prioridade_efetiva where id = v_h1) is distinct from 'historico'
       or (select eh_canonica from public.licitacoes_externas_prioridade_efetiva where id = v_n1) is distinct from false then
      raise exception 'CA-1 FALHOU: fixtures não ficaram como esperado na view de prioridade efetiva';
    end if;

    -- CA-1 --------------------------------------------------------------------------------------------------------
    select * into r from public.dashboard_resumo_executivo(array[v_l1, v_l2, v_l3, v_m1, v_h1, v_n1], v_agora);
    if r.leads_total is distinct from 3::bigint or r.monitoradas_total is distinct from 4::bigint then
      raise exception 'CA-1 FALHOU: leads_total=% monitoradas_total=% (esperado 3 e 4)', r.leads_total, r.monitoradas_total;
    end if;
    if r.com_valor_total is distinct from 3::bigint or r.valor_potencial_total is distinct from 3300.50::numeric then
      raise exception 'CA-1 FALHOU: com_valor_total=% valor_potencial_total=% (esperado 3 e 3300.50)',
        r.com_valor_total, r.valor_potencial_total;
    end if;
    -- CA-2 (janelas): amanhã = só L1 (23:59 de amanhã); 7 dias = L1, L2 e M1. H1 e N1 nunca entram.
    if r.prazo_amanha_total is distinct from 1::bigint or r.prazo_amanha_valor is distinct from 1000.00::numeric then
      raise exception 'CA-2 FALHOU: prazo_amanha_total=% prazo_amanha_valor=% (esperado 1 e 1000.00)',
        r.prazo_amanha_total, r.prazo_amanha_valor;
    end if;
    if r.prazo_7_dias_total is distinct from 3::bigint or r.prazo_7_dias_valor is distinct from 3300.50::numeric then
      raise exception 'CA-2 FALHOU: prazo_7_dias_total=% prazo_7_dias_valor=% (esperado 3 e 3300.50)',
        r.prazo_7_dias_total, r.prazo_7_dias_valor;
    end if;
    if r.calculado_em is distinct from v_agora then
      raise exception 'CA-1 FALHOU: calculado_em=% (esperado p_agora)', r.calculado_em;
    end if;

    -- CA-2: ativas sem nenhum valor -> soma null, nunca 0.
    select * into r from public.dashboard_resumo_executivo(array[v_l3], v_agora);
    if r.leads_total is distinct from 1::bigint or r.com_valor_total is distinct from 0::bigint
       or r.valor_potencial_total is not null or r.prazo_amanha_valor is not null or r.prazo_7_dias_valor is not null then
      raise exception 'CA-2 FALHOU: sem valor deveria dar soma null (veio %, com_valor %)',
        r.valor_potencial_total, r.com_valor_total;
    end if;

    -- Recorte vazio: nenhuma linha (nunca "todas").
    select * into r from public.dashboard_resumo_executivo(array[]::bigint[], v_agora);
    if r.leads_total is distinct from 0::bigint or r.monitoradas_total is distinct from 0::bigint
       or r.valor_potencial_total is not null then
      raise exception 'CA-2 FALHOU: recorte vazio contou % leads', r.leads_total;
    end if;

    -- CA-3: execução real por papel.
    begin
      perform set_config('role', 'service_role', true);
      select * into r from public.dashboard_resumo_executivo(array[v_l1], v_agora);
      if r.leads_total is distinct from 1::bigint then
        raise exception 'CA-3 FALHOU: service_role não leu o lead de teste (leads_total=%)', r.leads_total;
      end if;
      perform set_config('role', 'none', true);
    end;
    begin
      perform set_config('role', 'anon', true);
      perform public.dashboard_resumo_executivo(null, v_agora);
      raise exception 'CA-3 FALHOU: anon executou dashboard_resumo_executivo';
    exception when insufficient_privilege then null;
    end;
    begin
      perform set_config('role', 'authenticated', true);
      perform public.dashboard_resumo_executivo(null, v_agora);
      raise exception 'CA-3 FALHOU: authenticated executou dashboard_resumo_executivo';
    exception when insufficient_privilege then null;
    end;

    raise exception 'desfazer' using errcode = 'P0001', detail = 'rollback do savepoint';
  exception when sqlstate 'P0001' then
    if sqlerrm like 'CA-%' or sqlerrm like 'ACL CHECK FALHOU%' then raise; end if;
  end;

  raise notice 'SUCESSO: dashboard_resumo_executivo_check';
end
$$;
