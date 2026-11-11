-- Checagem da migration 20261111190000_licitacao_itens_escopo_valor_idx.
-- Falha com EXCEPTION se:
--   A) o índice licitacao_itens_escopo_valor_idx não existir em public.licitacao_itens;
--   B) não for parcial com o mesmo predicado do CTE valor_itens de dashboard_resumo_executivo
--      (as 6 categorias de escopo e valor_total_estimado não nulo) ou não incluir valor_total_estimado;
--   C) a função dashboard_resumo_executivo não usar mais exatamente essas 6 categorias (o índice ficaria inútil);
--   D) com o índice, o planner não o considerar para a leitura do CTE (set enable_seqscan off, só para o plano).
-- Banco LOCAL de teste; termina em rollback. Saída esperada: "SUCESSO: licitacao_itens_escopo_valor_idx_check".

begin;

do $chk$
declare
  v_def text;
  v_fn text;
  v_plano text := '';
  r record;
begin
  select indexdef into v_def from pg_indexes
   where schemaname = 'public' and tablename = 'licitacao_itens' and indexname = 'licitacao_itens_escopo_valor_idx';
  if v_def is null then
    raise exception 'licitacao_itens_escopo_valor_idx_check A: índice ausente';
  end if;

  if v_def !~* 'INCLUDE \(valor_total_estimado\)'
     or v_def !~* 'valor_total_estimado IS NOT NULL'
     or v_def !~* '''forte''' or v_def !~* '''catmat''' or v_def !~* '''borracha'''
     or v_def !~* '''piso''' or v_def !~* '''obra_piso''' or v_def !~* '''manutencao''' then
    raise exception 'licitacao_itens_escopo_valor_idx_check B: definição inesperada: %', v_def;
  end if;

  select pg_get_functiondef(p.oid) into v_fn
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'dashboard_resumo_executivo';
  if v_fn is null
     or v_fn !~ $re$categoria_escopo in \('forte', 'catmat', 'borracha', 'piso', 'obra_piso', 'manutencao'\)$re$ then
    raise exception 'licitacao_itens_escopo_valor_idx_check C: filtro de escopo da função mudou; revisar o índice';
  end if;

  set local enable_seqscan = off;
  for r in execute
    'explain select i.licitacao_id, sum(i.valor_total_estimado) from public.licitacao_itens i
      where i.licitacao_id = any (array[1,2,3]::bigint[])
        and i.categoria_escopo in (''forte'', ''catmat'', ''borracha'', ''piso'', ''obra_piso'', ''manutencao'')
        and i.valor_total_estimado is not null
      group by i.licitacao_id'
  loop
    v_plano := v_plano || r."QUERY PLAN" || E'\n';
  end loop;
  if v_plano !~ 'licitacao_itens_escopo_valor_idx' then
    raise exception 'licitacao_itens_escopo_valor_idx_check D: planner não usa o índice: %', v_plano;
  end if;

  raise notice 'SUCESSO: licitacao_itens_escopo_valor_idx_check';
end
$chk$;

rollback;
