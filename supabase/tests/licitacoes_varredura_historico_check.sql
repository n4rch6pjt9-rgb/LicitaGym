-- LicitaGym: Verificação da varredura de certames para histórico.
-- Dados fictícios em begin/rollback.

begin;

do $$
declare
  v_qtd int;
begin
  select count(*) into v_qtd from public.licitacoes_externas;
  if v_qtd > 100 then
    raise exception 'TRAVA DE SEGURANCA: licitacoes_externas contem % linhas (> 100). Abortando.', v_qtd;
  end if;
end $$;

insert into public.fontes_externas (slug, entidade, plataforma, base_url, modo_coleta)
values ('pncp', 'PNCP', 'pncp', 'https://pncp.gov.br', 'automatico')
on conflict (slug) do nothing;

create temporary table _p_varredura (rotulo text primary key, id bigint) on commit drop;

do $$
declare
  v_id bigint;
  v_prio text;
  v_motivo text;
  v_rebaixados bigint;
  falhas text[] := array[]::text[];
begin
  -- Caso 1: fase = 'Homologada' (sem data_homologacao) -> deve virar 'historico' via fase_terminal
  insert into public.licitacoes_externas
    (fonte, modulo, id_externo, codigo_externo, fase, situacao, data_fim, prioridade, raw)
  values
    ('pncp', 1, 900201, '00000000000201-1-000201/2026', 'Homologada', 'Divulgada no PNCP',
     now() - interval '5 days', 'leads', '{}'::jsonb)
  returning id into v_id;
  insert into _p_varredura values ('1', v_id);

  -- Caso 2: fase = 'Encerrada' -> deve virar 'historico' via fase_terminal
  insert into public.licitacoes_externas
    (fonte, modulo, id_externo, codigo_externo, fase, situacao, data_fim, prioridade, raw)
  values
    ('pncp', 1, 900202, '00000000000202-1-000202/2026', 'Encerrada', 'Em andamento',
     now() - interval '2 days', 'monitorar', '{}'::jsonb)
  returning id into v_id;
  insert into _p_varredura values ('2', v_id);

  -- Caso 3: data_fim no passado há mais de 35 dias (> 30 dias) -> deve virar 'historico' via prazo_expirado_sessao
  insert into public.licitacoes_externas
    (fonte, modulo, id_externo, codigo_externo, fase, situacao, data_fim, prioridade, raw)
  values
    ('pncp', 1, 900203, '00000000000203-1-000203/2026', 'Recebendo propostas', 'Divulgada no PNCP',
     now() - interval '35 days', 'monitorar', '{}'::jsonb)
  returning id into v_id;
  insert into _p_varredura values ('3', v_id);

  -- Caso 4: data_fim no passado há apenas 5 dias (< 30 dias) -> deve continuar 'monitorar'
  insert into public.licitacoes_externas
    (fonte, modulo, id_externo, codigo_externo, fase, situacao, data_fim, prioridade, raw)
  values
    ('pncp', 1, 900204, '00000000000204-1-000204/2026', 'Recebendo propostas', 'Divulgada no PNCP',
     now() - interval '5 days', 'leads', '{}'::jsonb)
  returning id into v_id;
  insert into _p_varredura values ('4', v_id);

  -- Verificação da View:
  -- Caso 1
  select prioridade, prioridade_motivo into v_prio, v_motivo
  from public.licitacoes_externas_prioridade_efetiva where id = (select id from _p_varredura where rotulo = '1');
  if v_prio <> 'historico' or v_motivo <> 'fase_terminal' then
    falhas := array_append(falhas, format('Caso 1 esperado historico/fase_terminal, obtido %s/%s', v_prio, v_motivo));
  end if;

  -- Caso 2
  select prioridade, prioridade_motivo into v_prio, v_motivo
  from public.licitacoes_externas_prioridade_efetiva where id = (select id from _p_varredura where rotulo = '2');
  if v_prio <> 'historico' or v_motivo <> 'fase_terminal' then
    falhas := array_append(falhas, format('Caso 2 esperado historico/fase_terminal, obtido %s/%s', v_prio, v_motivo));
  end if;

  -- Caso 3
  select prioridade, prioridade_motivo into v_prio, v_motivo
  from public.licitacoes_externas_prioridade_efetiva where id = (select id from _p_varredura where rotulo = '3');
  if v_prio <> 'historico' or v_motivo <> 'prazo_expirado_sessao' then
    falhas := array_append(falhas, format('Caso 3 esperado historico/prazo_expirado_sessao, obtido %s/%s', v_prio, v_motivo));
  end if;

  -- Caso 4
  select prioridade into v_prio
  from public.licitacoes_externas_prioridade_efetiva where id = (select id from _p_varredura where rotulo = '4');
  if v_prio <> 'monitorar' then
    falhas := array_append(falhas, format('Caso 4 esperado monitorar, obtido %s', v_prio));
  end if;

  -- Teste da procedure de sincronização física:
  select total_rebaixados into v_rebaixados from private.varredura_transicao_historico();
  if v_rebaixados < 3 then
    falhas := array_append(falhas, format('Esperado rebaixar pelo menos 3 linhas, rebaixadas %s', v_rebaixados));
  end if;

  -- Confere se a tabela base agora tem prioridade = 'historico' para o caso 1
  select prioridade into v_prio from public.licitacoes_externas where id = (select id from _p_varredura where rotulo = '1');
  if v_prio <> 'historico' then
    falhas := array_append(falhas, format('Tabela base licitacoes_externas nao atualizou prioridade para historico no Caso 1: %s', v_prio));
  end if;

  if array_length(falhas, 1) > 0 then
    raise exception 'FALHAS NO TESTE: %', array_to_string(falhas, E'\n');
  end if;

  raise notice 'Sucesso: licitacoes_varredura_historico_check passou com louvor.';
end $$;

rollback;
