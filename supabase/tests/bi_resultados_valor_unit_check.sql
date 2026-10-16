-- =============================================================================
-- Casos sintéticos da migration 20261016230000_bi_resultados_valor_unit (banco LOCAL de teste).
--
-- Dados 100% fictícios (CNPJs 00000000000xxx, órgãos "ÓRGÃO FICTÍCIO ..."). Tudo dentro de begin; ... rollback;
-- e com trava: aborta se licitacoes_externas tiver mais de 100 linhas (produção).
--
-- Casos:
--   P  resultado PNCP (valor_proposta nulo, homologado 1234,56) -> valor_unit = 1234,56; desconto sobre ele
--   Z  resultado PNCP com homologado 0                          -> valor_unit ausente (null), sem desconto
--   L  lance do Paradigma (valor_proposta 800, sem homologado)  -> valor_unit = 800, como antes
--   V  vencedor do Paradigma (lance 700 e homologado 750)       -> valor_unit = 700 (o lance tem precedência)
-- Saída esperada: NOTICE por caso e "SUCESSO: bi_resultados_valor_unit_check".
-- =============================================================================

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

insert into public.fontes_externas (slug, entidade, plataforma, base_url, modo_coleta) values
  ('pncp', 'PNCP', 'pncp', 'https://pncp.gov.br', 'automatico'),
  ('sestsenat', 'SEST SENAT', 'paradigma', 'https://compras.sestsenat.org.br', 'automatico')
  on conflict (slug) do nothing;

create temporary table _vu (rotulo text primary key, id bigint) on commit drop;

do $$
declare
  r record;
  v_id bigint;
begin
  for r in
    select * from (values
      ('P', 'pncp', '00000000000301-1-000001/2026', '00000000000301'),
      ('Z', 'pncp', '00000000000302-1-000001/2026', '00000000000302'),
      ('L', 'sestsenat', null, '00000000000303'),
      ('V', 'sestsenat', null, '00000000000304')
    ) v(rotulo, fonte, codigo, cnpj)
  loop
    insert into public.licitacoes_externas (fonte, codigo_externo, orgao_cnpj, orgao_nome, numero_processo,
        numero_edital, objeto, data_fim, data_publicacao, prioridade, data_homologacao, raw)
    values (r.fonte, r.codigo, r.cnpj, 'ÓRGÃO FICTÍCIO ' || r.rotulo, '03' || r.rotulo || '/2026', 'PE 3' || r.rotulo || '/2026',
        'Aquisição fictícia de teste ' || r.rotulo, '2026-08-10 09:00-03', '2026-07-20 08:00-03', 'historico',
        '2026-09-01 00:00-03', '{}'::jsonb)
    returning id into v_id;
    insert into _vu values (r.rotulo, v_id);
  end loop;
end $$;

insert into public.licitacao_itens (licitacao_id, numero_item, descricao, quantidade, valor_unitario_estimado, valor_total_estimado)
select id, 1, 'ITEM FICTICIO', 2, 1500, 3000 from _vu;

insert into public.licitacao_resultados (licitacao_id, numero_item, sequencial_resultado, fornecedor_cnpj, fornecedor_nome,
    vencedor, valor_proposta, quantidade_homologada, valor_unitario_homologado, valor_total_homologado, data_resultado)
select id, 1, 1, '00000000000399', 'FORNECEDOR FICTICIO DE TESTE LTDA', null,
       case rotulo when 'L' then 800 when 'V' then 700 end,
       case rotulo when 'L' then null else 2 end,
       case rotulo when 'P' then 1234.56 when 'Z' then 0 when 'V' then 750 end,
       case rotulo when 'P' then 2469.12 when 'Z' then 0 when 'V' then 1500 end,
       '2026-09-01'::timestamptz
from _vu;

do $$
declare
  falhas text[] := '{}';
  v record;
begin
  -- P: resultado do PNCP
  select b.valor_unit, b.desconto_vs_referencia, b.valor_unitario_homologado into v
    from public.v_bi_resultados_itens b where b.licitacao_id = (select id from _vu where rotulo = 'P');
  raise notice 'CASO P: valor_unit %, desconto %, homologado %', v.valor_unit, v.desconto_vs_referencia, v.valor_unitario_homologado;
  if v.valor_unit is distinct from 1234.56 then falhas := falhas || format('P valor_unit %s (esperado 1234.56)', v.valor_unit); end if;
  if v.desconto_vs_referencia is distinct from round(1 - 1234.56 / 1500, 4) then
    falhas := falhas || format('P desconto %s (esperado %s)', v.desconto_vs_referencia, round(1 - 1234.56 / 1500, 4));
  end if;
  if v.valor_unitario_homologado is distinct from 1234.56 then falhas := falhas || format('P homologado %s', v.valor_unitario_homologado); end if;

  -- Z: homologado zero não é preço
  select b.valor_unit, b.desconto_vs_referencia, b.valor_unitario_homologado into v
    from public.v_bi_resultados_itens b where b.licitacao_id = (select id from _vu where rotulo = 'Z');
  raise notice 'CASO Z: valor_unit %, desconto %, homologado %', v.valor_unit, v.desconto_vs_referencia, v.valor_unitario_homologado;
  if v.valor_unit is not null then falhas := falhas || format('Z valor_unit %s (esperado null)', v.valor_unit); end if;
  if v.desconto_vs_referencia is not null then falhas := falhas || format('Z desconto %s (esperado null)', v.desconto_vs_referencia); end if;
  if v.valor_unitario_homologado is distinct from 0 then falhas := falhas || format('Z homologado %s (esperado 0, como veio)', v.valor_unitario_homologado); end if;

  -- L: lance do Paradigma continua como antes
  select b.valor_unit, b.valor_unitario_homologado into v
    from public.v_bi_resultados_itens b where b.licitacao_id = (select id from _vu where rotulo = 'L');
  raise notice 'CASO L: valor_unit %, homologado %', v.valor_unit, v.valor_unitario_homologado;
  if v.valor_unit is distinct from 800 then falhas := falhas || format('L valor_unit %s (esperado 800)', v.valor_unit); end if;
  if v.valor_unitario_homologado is not null then falhas := falhas || format('L homologado %s (esperado null)', v.valor_unitario_homologado); end if;

  -- V: lance e homologado juntos, o lance tem precedência (comportamento de antes para o Paradigma)
  select b.valor_unit, b.valor_unitario_homologado into v
    from public.v_bi_resultados_itens b where b.licitacao_id = (select id from _vu where rotulo = 'V');
  raise notice 'CASO V: valor_unit %, homologado %', v.valor_unit, v.valor_unitario_homologado;
  if v.valor_unit is distinct from 700 then falhas := falhas || format('V valor_unit %s (esperado 700)', v.valor_unit); end if;
  if v.valor_unitario_homologado is distinct from 750 then falhas := falhas || format('V homologado %s (esperado 750)', v.valor_unitario_homologado); end if;

  -- ACL inalterada
  if not has_table_privilege('authenticated', 'public.v_bi_resultados_itens', 'SELECT') then
    falhas := falhas || 'authenticated perdeu SELECT (a revogação é a #178, fora desta migration)'::text;
  end if;
  if has_table_privilege('anon', 'public.v_bi_resultados_itens', 'SELECT') then
    falhas := falhas || 'anon tem SELECT em v_bi_resultados_itens'::text;
  end if;
  if has_table_privilege('authenticated', 'public.v_bi_resultados_itens', 'INSERT,UPDATE,DELETE') then
    falhas := falhas || 'authenticated tem escrita em v_bi_resultados_itens'::text;
  end if;
  if not has_table_privilege('service_role', 'public.v_bi_resultados_itens', 'SELECT') then
    falhas := falhas || 'service_role perdeu SELECT em v_bi_resultados_itens'::text;
  end if;

  if array_length(falhas, 1) > 0 then
    raise exception 'bi_resultados_valor_unit_check FALHOU: %', array_to_string(falhas, ' | ');
  end if;
  raise notice 'SUCESSO: bi_resultados_valor_unit_check';
end $$;

rollback;
