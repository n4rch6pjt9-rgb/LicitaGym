-- Regressão do api-saude HTTP 500 (statement timeout, 08/11/2026): a verificação itens_sem_taxonomia_pct de
-- private.saude_operacional_resumo() não pode voltar a varrer public.licitacao_itens inteira
-- (migration 20261108150000_saude_itens_taxonomia_sem_varredura).
--   1. o corpo da função usa a estimativa (reltuples) e não tem mais o count(*) filter sobre a tabela inteira;
--   2. o detalhe traz itens, sem_taxonomia, com_taxonomia e total_estimado, coerentes entre si;
--   3. o valor é % sem taxonomia (0 a 100) ou nulo quando não há itens;
--   4. o predicado de "com taxonomia" bate com o índice de expressão licitacao_itens_no_taxonomia_efetiva_idx
--      (se o índice existir no banco).
-- Só leitura (o analyze só atualiza estatística). Falha com EXCEPTION na primeira regra violada.

do $$
declare
  v_src text;
  v_valor numeric;
  v_det jsonb;
  v_idx text;
begin
  select p.prosrc into v_src from pg_proc p where p.oid = to_regprocedure('private.saude_operacional_resumo()');
  if v_src is null then
    raise exception 'SAUDE TAXONOMIA CHECK FALHOU: private.saude_operacional_resumo() não existe';
  end if;
  if v_src not like '%reltuples%' then
    raise exception 'SAUDE TAXONOMIA CHECK FALHOU: total de itens não usa a estimativa (pg_class.reltuples)';
  end if;
  if v_src ~* 'count\(\*\)\s+filter\s*\(\s*where\s+coalesce\(i\.no_taxonomia' then
    raise exception 'SAUDE TAXONOMIA CHECK FALHOU: voltou o count(*) filter que varre licitacao_itens inteira';
  end if;

  -- Volta 1: estado em que o banco estiver (sem estatística, conta exato; se o autovacuum já analisou, estimativa).
  -- Volta 2: depois do analyze, sempre estimativa (conferido abaixo por total_estimado).
  for i in 1..2 loop
    if i = 2 then
      analyze public.licitacao_itens;
    end if;
    select r.valor, r.detalhe into v_valor, v_det
      from private.saude_operacional_resumo() r where r.verificacao = 'itens_sem_taxonomia_pct';
    if v_det is null then
      raise exception 'SAUDE TAXONOMIA CHECK FALHOU: itens_sem_taxonomia_pct ausente do resumo';
    end if;
    if not (v_det ?& array['itens', 'sem_taxonomia', 'com_taxonomia', 'total_estimado']) then
      raise exception 'SAUDE TAXONOMIA CHECK FALHOU: detalhe incompleto: %', v_det;
    end if;
    if (v_det ->> 'itens')::bigint <> (v_det ->> 'sem_taxonomia')::bigint + (v_det ->> 'com_taxonomia')::bigint
       or (v_det ->> 'sem_taxonomia')::bigint < 0 then
      raise exception 'SAUDE TAXONOMIA CHECK FALHOU: detalhe incoerente: %', v_det;
    end if;
    if v_valor is not null and (v_valor < 0 or v_valor > 100) then
      raise exception 'SAUDE TAXONOMIA CHECK FALHOU: valor fora de 0..100: %', v_valor;
    end if;
    if (v_det ->> 'itens')::bigint = 0 and v_valor is not null then
      raise exception 'SAUDE TAXONOMIA CHECK FALHOU: sem itens o valor deve ser nulo (sem dado), veio %', v_valor;
    end if;
  end loop;
  if (v_det ->> 'total_estimado')::boolean is not true then
    raise exception 'SAUDE TAXONOMIA CHECK FALHOU: depois do analyze o total devia vir da estimativa: %', v_det;
  end if;

  select pg_get_indexdef(i.indexrelid) into v_idx
    from pg_index i where i.indexrelid = to_regclass('public.licitacao_itens_no_taxonomia_efetiva_idx');
  if v_idx is not null and v_idx not like '%COALESCE(no_taxonomia, (taxonomia ->> ''no_taxonomia''::text))%' then
    raise exception 'SAUDE TAXONOMIA CHECK FALHOU: índice de expressão mudou e não casa com o predicado: %', v_idx;
  end if;

  raise notice 'SUCESSO: itens_sem_taxonomia_pct sem varredura completa (estimativa + índice)';
end $$;
