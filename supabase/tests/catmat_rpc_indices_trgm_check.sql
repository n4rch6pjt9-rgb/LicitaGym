-- Verificação da migration 20261002140000_catmat_rpc_indices_trgm.
-- Executar após aplicar as migrations (ex.: psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/catmat_rpc_indices_trgm_check.sql):
--   1. lg_normalizar segue IMMUTABLE (condição para o índice de expressão);
--   2. os 4 índices existem com as expressões usadas na RPC;
--   3. lg_regex_ramos divide só no '|' de topo e não divide quando não é seguro;
--   4. texto ~ padrão equivale a "algum ramo casa", para os padrões cadastrados e casos de borda;
--   5. lg_regex_ramos executável só por service_role.
-- Falha com EXCEPTION na primeira regra violada.

do $$
declare
  v_def text;
  v_idx text;
  v_caso record;
  v_n int;
begin
  -- 1
  if (select provolatile from pg_proc where oid = 'public.lg_normalizar(text)'::regprocedure) <> 'i' then
    raise exception 'lg_normalizar deixou de ser IMMUTABLE';
  end if;

  -- 2
  foreach v_idx in array array['licitacao_itens_descricao_norm_trgm_idx', 'licitacoes_externas_objeto_norm_trgm_idx',
                               'licitacao_itens_catalogo_codigo_item_num_idx', 'licitacao_itens_no_taxonomia_efetiva_idx'] loop
    -- sem quebras de linha e sem qualificação de schema (depende do search_path da sessão)
    select replace(replace(regexp_replace(pg_get_indexdef(c.oid), '\s+', ' ', 'g'), 'extensions.', ''), 'public.', '') into v_def from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relname = v_idx;
    if v_def is null then raise exception 'índice % ausente', v_idx; end if;
    if v_idx like '%trgm%' and strpos(v_def, 'USING gin (lg_normalizar(' || case when v_idx like 'licitacao_itens%' then 'descricao' else 'objeto' end || ') gin_trgm_ops)') = 0 then
      raise exception 'índice % com definição inesperada: %', v_idx, v_def;
    end if;
    if v_idx = 'licitacao_itens_catalogo_codigo_item_num_idx'
       and strpos(v_def, 'CASE WHEN (catalogo_codigo_item ~ ''^\d{1,15}$''::text) THEN (catalogo_codigo_item)::bigint ELSE NULL::bigint END') = 0 then
      raise exception 'índice % com definição inesperada: %', v_idx, v_def;
    end if;
    if v_idx = 'licitacao_itens_no_taxonomia_efetiva_idx'
       and strpos(v_def, 'USING btree (COALESCE(no_taxonomia, (taxonomia ->> ''no_taxonomia''::text)))') = 0 then
      raise exception 'índice % com definição inesperada: %', v_idx, v_def;
    end if;
  end loop;

  -- 3
  for v_caso in
    select * from (values
      ('a|b', array['a', 'b']),
      ('a(b|c)|d', array['a(b|c)', 'd']),
      ('[x|y]|z', array['[x|y]', 'z']),
      ('[]|]|q', array['[]|]', 'q']),
      ('[^]|]|q', array['[^]|]', 'q']),
      ('[[:alpha:]|]|w', array['[[:alpha:]|]', 'w']),
      ('a\|b|c', array['a\|b', 'c']),
      ('a|', array['a', '']),
      ('abc', array['abc']),
      ('(?i)a|b', array['(?i)a|b']),
      ('***=a|b', array['***=a|b']),
      ('(a)|\1', array['(a)|\1']),
      ('(a|b', array['(a|b']),
      ('a)|b', array['a)|b']),
      ('[a|b', array['[a|b'])
    ) v(p, esperado)
  loop
    if public.lg_regex_ramos(v_caso.p) is distinct from v_caso.esperado then
      raise exception 'lg_regex_ramos(%) = %, esperado %', v_caso.p, public.lg_regex_ramos(v_caso.p), v_caso.esperado;
    end if;
  end loop;

  -- 4
  with padroes as (
    select padrao from public.catmat_pdm_palavras
    union select padrao from public.catmat_pdm_exclusoes
    union select unnest(array['a|b(c|d)|[x|y]', '\mtoto\M|pebolim', '^(?!.*borracha).*\mfutsal\M|quadra', 'x|', '[]|]|q'])
  ),
  textos as (
    select public.lg_normalizar(t) as s from unnest(array[
      'Pebolim TOTO profissional', 'Mesa de tênis de mesa', 'Piso modular de polipropileno para quadra', 'futsal sem borracha',
      'piso de borracha para futsal', 'b d', 'x|y', ']', 'q', '', 'Halteres e anilhas', 'Grama sintética 20mm', 'colchonete'
    ]) t
  )
  select count(*) into v_n
    from padroes p cross join textos t
   where (t.s ~ p.padrao) is distinct from (select bool_or(t.s ~ r) from unnest(public.lg_regex_ramos(p.padrao)) r);
  if v_n > 0 then
    raise exception 'lg_regex_ramos: % par(es) texto x padrão em que os ramos não equivalem ao padrão inteiro', v_n;
  end if;

  -- 5
  if has_function_privilege('anon', 'public.lg_regex_ramos(text)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.lg_regex_ramos(text)', 'EXECUTE')
     or not has_function_privilege('service_role', 'public.lg_regex_ramos(text)', 'EXECUTE') then
    raise exception 'lg_regex_ramos: EXECUTE deveria ser só de service_role';
  end if;

  raise notice 'SUCESSO: catmat_rpc_indices_trgm_check';
end
$$;
