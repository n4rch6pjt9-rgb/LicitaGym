-- Regressão da #319 (licitação 185 e os 116 leads com data_fim vencido).
-- Dados fictícios. Tudo em begin/rollback. Aborta se licitacoes_externas tiver mais de 100 linhas.
--
-- Casos:
--   A  forma da 185: texto do PNCP e data_fim no passado, fase "Recebendo propostas", sem resultado
--      -> monitorar, motivo prazo_encerrado, fase lida "Propostas encerradas, aguardando resultado"
--   B  texto em Brasília ainda aberto, data_fim 2 h no passado (relógio gravado 3 h adiantado, #332)
--      -> continua leads; a fase não muda
--   C  sem texto, data_fim no passado -> monitorar
--   D  texto 2604 sem normalização -> monitorar (não é lead)
--   E  homologada com prazo vencido -> historico, fase gravada intacta
--   F  prioridade NULL com prazo vencido -> continua NULL (não vira lead)
--   G  prazo aberto -> leads

begin;

do $$
declare
  v_qtd int;
begin
  select count(*) into v_qtd from public.licitacoes_externas;
  if v_qtd > 100 then
    raise exception 'TRAVA DE SEGURANCA: licitacoes_externas contem % linhas (> 100). Abortando para proteger producao.', v_qtd;
  end if;
end $$;

insert into public.fontes_externas (slug, entidade, plataforma, base_url, modo_coleta)
values ('pncp', 'PNCP', 'pncp', 'https://pncp.gov.br', 'automatico')
on conflict (slug) do nothing;

create temporary table _p319 (rotulo text primary key, id bigint) on commit drop;

do $$
declare
  v_id bigint;
  v_prio text;
  v_fase text;
  v_motivo text;
  v_sit text;
  falhas text[] := array[]::text[];
  v_aberto text := to_char((now() at time zone 'America/Sao_Paulo') + interval '10 days', 'YYYY-MM-DD"T"HH24:MI:SS');
begin
  insert into public.licitacoes_externas
    (fonte, modulo, id_externo, codigo_externo, fase, situacao, data_fim, prioridade, raw)
  values
    ('pncp', 1, 900185, '00000000000185-1-000185/2026', 'Recebendo propostas', 'Divulgada no PNCP',
     now() - interval '3 days', 'leads', '{"data_fim_vigencia":"2020-01-08T10:00:00"}'::jsonb)
  returning id into v_id;
  insert into _p319 values ('A', v_id);

  insert into public.licitacoes_externas
    (fonte, modulo, id_externo, codigo_externo, fase, situacao, data_fim, prioridade, raw)
  values
    ('pncp', 1, 900186, '00000000000186-1-000186/2026', 'Recebendo propostas', 'Divulgada no PNCP',
     now() - interval '2 hours', 'leads', jsonb_build_object('data_fim_vigencia', v_aberto))
  returning id into v_id;
  insert into _p319 values ('B', v_id);

  insert into public.licitacoes_externas
    (fonte, modulo, id_externo, codigo_externo, fase, situacao, data_fim, prioridade, raw)
  values
    ('pncp', 1, 900187, '00000000000187-1-000187/2026', 'Recebendo propostas', 'Divulgada no PNCP',
     now() - interval '1 day', 'leads', '{}'::jsonb)
  returning id into v_id;
  insert into _p319 values ('C', v_id);

  insert into public.licitacoes_externas
    (fonte, modulo, id_externo, codigo_externo, fase, situacao, data_fim, prioridade, raw)
  values
    ('pncp', 1, 900188, '00000000000188-1-000188/2026', 'Recebendo propostas', 'Divulgada no PNCP',
     null, 'leads', '{"data_fim_vigencia":"2604-04-16T08:30:00"}'::jsonb)
  returning id into v_id;
  insert into _p319 values ('D', v_id);

  insert into public.licitacoes_externas
    (fonte, modulo, id_externo, codigo_externo, fase, situacao, data_fim, data_homologacao, prioridade, raw)
  values
    ('pncp', 1, 900189, '00000000000189-1-000189/2026', 'Recebendo propostas', 'Divulgada no PNCP',
     now() - interval '3 days', now() - interval '1 day', 'leads', '{"data_fim_vigencia":"2020-01-08T10:00:00"}'::jsonb)
  returning id into v_id;
  insert into _p319 values ('E', v_id);

  insert into public.licitacoes_externas
    (fonte, modulo, id_externo, codigo_externo, fase, situacao, data_fim, prioridade, raw)
  values
    ('pncp', 1, 900190, '00000000000190-1-000190/2026', 'Recebendo propostas', 'Divulgada no PNCP',
     now() - interval '3 days', null, '{"data_fim_vigencia":"2020-01-08T10:00:00"}'::jsonb)
  returning id into v_id;
  insert into _p319 values ('F', v_id);

  insert into public.licitacoes_externas
    (fonte, modulo, id_externo, codigo_externo, fase, situacao, data_fim, prioridade, raw)
  values
    ('pncp', 1, 900191, '00000000000191-1-000191/2026', 'Recebendo propostas', 'Divulgada no PNCP',
     now() + interval '10 days', 'leads', jsonb_build_object('data_fim_vigencia', v_aberto))
  returning id into v_id;
  insert into _p319 values ('G', v_id);

  select p.prioridade, p.fase, p.prioridade_motivo, p.situacao
    into v_prio, v_fase, v_motivo, v_sit
    from public.licitacoes_externas_prioridade_efetiva p
    join _p319 x on x.id = p.id and x.rotulo = 'A';
  if v_prio is distinct from 'monitorar' or v_motivo is distinct from 'prazo_encerrado'
     or v_fase is distinct from 'Propostas encerradas, aguardando resultado'
     or v_sit is distinct from 'Divulgada no PNCP' then
    falhas := falhas || format('A 185: prioridade=%s fase=%s motivo=%s situacao=%s', v_prio, v_fase, v_motivo, v_sit);
  end if;

  select p.prioridade, p.fase into v_prio, v_fase
    from public.licitacoes_externas_prioridade_efetiva p
    join _p319 x on x.id = p.id and x.rotulo = 'B';
  if v_prio is distinct from 'leads' or v_fase is distinct from 'Recebendo propostas' then
    falhas := falhas || format('B texto aberto: prioridade=%s fase=%s', v_prio, v_fase);
  end if;

  select p.prioridade, p.fase into v_prio, v_fase
    from public.licitacoes_externas_prioridade_efetiva p
    join _p319 x on x.id = p.id and x.rotulo = 'C';
  if v_prio is distinct from 'monitorar' or v_fase is distinct from 'Propostas encerradas, aguardando resultado' then
    falhas := falhas || format('C sem texto: prioridade=%s fase=%s', v_prio, v_fase);
  end if;

  select p.prioridade into v_prio
    from public.licitacoes_externas_prioridade_efetiva p
    join _p319 x on x.id = p.id and x.rotulo = 'D';
  if v_prio is distinct from 'monitorar' then
    falhas := falhas || format('D 2604: prioridade=%s', v_prio);
  end if;

  select p.prioridade, p.fase, p.prioridade_motivo into v_prio, v_fase, v_motivo
    from public.licitacoes_externas_prioridade_efetiva p
    join _p319 x on x.id = p.id and x.rotulo = 'E';
  if v_prio is distinct from 'historico' or v_motivo is distinct from 'data_homologacao'
     or v_fase is distinct from 'Recebendo propostas' then
    falhas := falhas || format('E homologada: prioridade=%s fase=%s motivo=%s', v_prio, v_fase, v_motivo);
  end if;

  select p.prioridade into v_prio
    from public.licitacoes_externas_prioridade_efetiva p
    join _p319 x on x.id = p.id and x.rotulo = 'F';
  if v_prio is not null then
    falhas := falhas || format('F NULL virou %s', v_prio);
  end if;

  select p.prioridade, p.fase into v_prio, v_fase
    from public.licitacoes_externas_prioridade_efetiva p
    join _p319 x on x.id = p.id and x.rotulo = 'G';
  if v_prio is distinct from 'leads' or v_fase is distinct from 'Recebendo propostas' then
    falhas := falhas || format('G aberto: prioridade=%s fase=%s', v_prio, v_fase);
  end if;

  if array_length(falhas, 1) > 0 then
    raise exception 'licitacoes_prioridade_prazo_encerrado_check FALHOU: %', array_to_string(falhas, ' | ');
  end if;
  raise notice 'SUCESSO: licitacoes_prioridade_prazo_encerrado_check';
end $$;

rollback;
