-- Obra nunca vira lead (regra de negócio; caso real: oportunidade 57149, Sesc DN 4387, reforma de quadra com grama
-- sintética, gravada como leads/obra_piso em 11/11/2026; em 12/11 eram 56 obras do PNCP em leads).
-- Dados fictícios. Tudo em begin/rollback. Aborta se licitacoes_externas tiver mais de 100 linhas.
--
-- Casos (todos com prazo aberto):
--   A  obra_piso gravada como leads (Sistema S)  -> monitorar, motivo obra_nao_e_lead
--   B  obra_piso gravada como leads (PNCP)       -> monitorar, motivo obra_nao_e_lead
--   C  piso (compra de material) gravado leads   -> continua leads
--   D  obra_piso já em historico com resultado   -> continua historico (encerramento vence)
--   E  obra_piso com prioridade NULL             -> continua NULL (a view só rebaixa, não promove)

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
values ('pncp', 'PNCP', 'pncp', 'https://pncp.gov.br', 'automatico'),
       ('sescdn', 'Sesc DN', 'paradigma', 'https://egov-br.paradigmabs.com.br/sescdn/portal', 'automatico')
on conflict (slug) do nothing;

create temporary table _obra (rotulo text primary key, id bigint) on commit drop;

do $$
declare
  v_id bigint;
  v_prio text;
  v_motivo text;
  falhas text[] := array[]::text[];
  v_aberto text := to_char((now() at time zone 'America/Sao_Paulo') + interval '10 days', 'YYYY-MM-DD"T"HH24:MI:SS');
begin
  insert into public.licitacoes_externas (fonte, modulo, id_externo, codigo_externo, data_fim, prioridade, categoria_escopo, raw)
  values ('sescdn', 59, 904387, 'sescdn-904387', now() + interval '10 days', 'leads', 'obra_piso',
          jsonb_build_object('data_fim_vigencia', v_aberto))
  returning id into v_id;
  insert into _obra values ('A', v_id);

  insert into public.licitacoes_externas (fonte, modulo, id_externo, codigo_externo, data_fim, prioridade, categoria_escopo, raw)
  values ('pncp', 1, 904388, '00000000000388-1-004388/2026', now() + interval '10 days', 'leads', 'obra_piso',
          jsonb_build_object('data_fim_vigencia', v_aberto))
  returning id into v_id;
  insert into _obra values ('B', v_id);

  insert into public.licitacoes_externas (fonte, modulo, id_externo, codigo_externo, data_fim, prioridade, categoria_escopo, raw)
  values ('pncp', 1, 904389, '00000000000389-1-004389/2026', now() + interval '10 days', 'leads', 'piso',
          jsonb_build_object('data_fim_vigencia', v_aberto))
  returning id into v_id;
  insert into _obra values ('C', v_id);

  insert into public.licitacoes_externas (fonte, modulo, id_externo, codigo_externo, data_fim, prioridade, categoria_escopo,
                                          data_homologacao, raw)
  values ('pncp', 1, 904390, '00000000000390-1-004390/2026', now() + interval '10 days', 'historico', 'obra_piso',
          now() - interval '1 day', jsonb_build_object('data_fim_vigencia', v_aberto))
  returning id into v_id;
  insert into _obra values ('D', v_id);

  insert into public.licitacoes_externas (fonte, modulo, id_externo, codigo_externo, data_fim, prioridade, categoria_escopo, raw)
  values ('pncp', 1, 904391, '00000000000391-1-004391/2026', now() + interval '10 days', null, 'obra_piso',
          jsonb_build_object('data_fim_vigencia', v_aberto))
  returning id into v_id;
  insert into _obra values ('E', v_id);

  select v.prioridade, v.prioridade_motivo into v_prio, v_motivo
    from public.licitacoes_externas_prioridade_efetiva v where v.id = (select id from _obra where rotulo = 'A');
  if v_prio is distinct from 'monitorar' or v_motivo is distinct from 'obra_nao_e_lead' then
    falhas := falhas || format('A: esperado monitorar/obra_nao_e_lead, veio %s/%s', v_prio, v_motivo);
  end if;

  select v.prioridade, v.prioridade_motivo into v_prio, v_motivo
    from public.licitacoes_externas_prioridade_efetiva v where v.id = (select id from _obra where rotulo = 'B');
  if v_prio is distinct from 'monitorar' or v_motivo is distinct from 'obra_nao_e_lead' then
    falhas := falhas || format('B: esperado monitorar/obra_nao_e_lead, veio %s/%s', v_prio, v_motivo);
  end if;

  select v.prioridade into v_prio
    from public.licitacoes_externas_prioridade_efetiva v where v.id = (select id from _obra where rotulo = 'C');
  if v_prio is distinct from 'leads' then
    falhas := falhas || format('C: compra de piso devia continuar leads, veio %s', v_prio);
  end if;

  select v.prioridade into v_prio
    from public.licitacoes_externas_prioridade_efetiva v where v.id = (select id from _obra where rotulo = 'D');
  if v_prio is distinct from 'historico' then
    falhas := falhas || format('D: obra homologada devia ficar historico, veio %s', v_prio);
  end if;

  select v.prioridade into v_prio
    from public.licitacoes_externas_prioridade_efetiva v where v.id = (select id from _obra where rotulo = 'E');
  if v_prio is not null then
    falhas := falhas || format('E: prioridade NULL não pode ser promovida, veio %s', v_prio);
  end if;

  if cardinality(falhas) > 0 then
    raise exception 'CHECK FALHOU (obra nunca vira lead): %', array_to_string(falhas, ' | ');
  end if;
  raise notice 'SUCESSO: obra_nao_e_lead_check aprovado (obra em leads vira monitorar; piso e encerramento intactos)';
end $$;

rollback;
