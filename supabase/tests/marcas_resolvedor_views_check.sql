-- =============================================================================
-- Verificação comportamental das views da 20261003200000_marcas_resolvedor_fornecedor (review do PR #148)
-- Dados fictícios (CNPJ 11222333000181 e 99888777000166, CPF 12345678909, marcas "ZZQ ..."). begin ... rollback:
-- nada persiste. Trava contra produção (precos_praticados_itens com mais de 100 linhas).
--   A. v_marca_ocorrencias: 1 linha por venda com data_resultado (sem data fica fora); ni_tipo; metodo; entra_ranking
--   B. aliases: exato e grafia somam na mesma marca; nao_marca e código/medida -> marca NULL, fora do ranking;
--      empate de regex: alias manual (revisao_manual) vence a semente
--   C. CPF fora do ranking (ni_tipo = cpf, entra_ranking = false)
--   D. ranking: mínimo de 2 itens; ordem qtd_itens desc, valor desc, data desc, marca; qtd_marcas
--   E. v_fornecedor_marcas: marca_1..3 e colunas de cada posição; 4ª marca não aparece
--   F. v_marca_aliases_pendentes: só metodo = bruta (com e sem mínimo de 2), contagem por fornecedor
--   G. marca que começa com dígito seguida de palavra ("3 SECONDS FITNESS") conta; código puro ("1130PC", "X44V7") não
--   H. alias com padrão vazio ('' / só espaços / regex que casa com vazio) é recusado; o resolvedor ignora padrão vazio
-- Resultado esperado: NOTICE "SUCESSO: marcas_resolvedor_views_check ok".
-- Cada falha sai em NOTICE ("FALHA ...") e o script termina com UMA exceção que lista todas. Sem a migration aplicada
-- (objetos ausentes), o script lista os objetos que faltam como FALHA e não executa os casos que dependem deles:
-- em PL/pgSQL cada comando só é analisado quando executa, então os casos ficam atrás da checagem de existência;
-- a trava usa SQL dinâmico.
-- =============================================================================
begin;

do $$
declare
  v_mais_de_100 boolean := false;
begin
  -- trava: mais de 100 linhas = base real. EXISTS ... OFFSET 100 para não contar a tabela inteira.
  if to_regclass('public.precos_praticados_itens') is not null then
    execute 'select exists (select 1 from public.precos_praticados_itens offset 100)' into v_mais_de_100;
  end if;
  if v_mais_de_100 then
    raise exception 'TRAVA DE SEGURANCA: precos_praticados_itens tem mais de 100 linhas. Abortando para proteger producao.';
  end if;
end $$;

do $$
declare
  c_a   constant text := '11222333000181';
  c_b   constant text := '99888777000166';
  c_cpf constant text := '12345678909';
  v_n   bigint;
  v_txt text;
  v_rec record;
  v_ok  boolean;
  v_falhas  text[] := '{}';
  v_faltam  text[];
  v_tem_constraints boolean;
begin
  -- ------------------------------------------------------------------ 0. existência (antes de qualquer caso)
  select array_agg(e.obj order by e.obj) into v_faltam
    from (values ('public.precos_praticados_itens'), ('public.marca_aliases'), ('public.v_marca_ocorrencias'),
                 ('public.v_fornecedor_marcas_ranking'), ('public.v_fornecedor_marcas'), ('public.v_marca_aliases_pendentes'))
         as e(obj)
   where to_regclass(e.obj) is null;
  if to_regprocedure('private.marca_resolver(text,text)') is null then
    v_faltam := coalesce(v_faltam, '{}') || 'private.marca_resolver(text,text)'::text;
  end if;
  if to_regprocedure('private.marca_normalizar(text)') is null then
    v_faltam := coalesce(v_faltam, '{}') || 'private.marca_normalizar(text)'::text;
  end if;
  if v_faltam is not null then
    raise exception 'VIEWS CHECK FALHOU: marcas_resolvedor_views_check: % objeto(s) ausente(s), casos A-H não executados:%',
      array_length(v_faltam, 1), E'\n  - ausente: ' || array_to_string(v_faltam, E'\n  - ausente: ');
  end if;
  select count(*) = 2 into v_tem_constraints
    from pg_constraint
   where conrelid = 'public.marca_aliases'::regclass
     and conname in ('marca_aliases_valor_vazio_check', 'marca_aliases_valor_check');

  -- ------------------------------------------------------------------ fixtures
  insert into public.marca_aliases (valor_norm, modo, cnpj_escopo, marca, tipo, origem, evidencia, revisao_manual) values
    ('ZZQ ALFA',     'exato', null, 'ZZQ ALFA',    'marca',     'curadoria', 'teste', true),
    ('ZZQ ALFA FIT', 'exato', null, 'ZZQ ALFA',    'grafia',    'curadoria', 'teste', true),
    ('ZZQ LIXO',     'exato', null, null,          'nao_marca', 'curadoria', 'teste', true),
    -- mesmo modo e mesmo tamanho de padrão (9): o desempate é revisao_manual
    ('^ZZQ GAMA',    'regex', null, 'ZZQ ERRADA',  'marca',     'dados',     'teste semente', false),
    ('^ZZQ GAM.',    'regex', null, 'ZZQ GAMA',    'marca',     'curadoria', 'teste manual', true);

  insert into public.precos_praticados_itens (id_compra, id_item_compra, ni_fornecedor, marca, quantidade, preco_unitario, data_resultado)
  select 'ZZTESTE', g.n, g.ni, g.marca, 1, g.preco, g.data
    from (values
      -- CNPJ A
      ( 1, c_a, 'ZZQ Alfa',          100, date '2026-09-01'),
      ( 2, c_a, 'zzq alfa',          100, date '2026-09-02'),
      ( 3, c_a, 'ZZQ ALFA.',         100, date '2026-09-03'),
      ( 4, c_a, 'ZZQ Alfa Fit',      100, date '2026-09-04'),  -- grafia -> ZZQ ALFA (4 itens)
      ( 5, c_a, 'ZZQ Alfa',          999, null),               -- sem data_resultado: fora
      ( 6, c_a, 'ZZQ GAMA X',        500, date '2026-09-05'),
      ( 7, c_a, 'ZZQ GAMA Y',        500, date '2026-09-06'),  -- regex manual -> ZZQ GAMA (2, valor 1000)
      ( 8, c_a, 'ZZQ DELTA',         300, date '2026-09-07'),
      ( 9, c_a, 'ZZQ DELTA',         300, date '2026-09-08'),  -- bruta (2, valor 600)
      (10, c_a, '3 SECONDS FITNESS', 200, date '2026-09-09'),
      (11, c_a, '3 Seconds Fitness', 200, date '2026-09-10'),  -- bruta (2, valor 400): 4ª marca
      (12, c_a, 'ZZQ EPS',           50,  date '2026-09-11'),  -- bruta com 1 item: fora do ranking, na fila
      (13, c_a, 'ZZQ LIXO',          50,  date '2026-09-12'),
      (14, c_a, 'ZZQ LIXO',          50,  date '2026-09-13'),  -- nao_marca
      (15, c_a, '1130PC',            50,  date '2026-09-14'),
      (16, c_a, '1130PC',            50,  date '2026-09-15'),  -- código: NULL
      -- CPF: mesma marca, nunca no ranking
      (17, c_cpf, 'ZZQ ALFA',        100, date '2026-09-01'),
      (18, c_cpf, 'ZZQ ALFA',        100, date '2026-09-02'),
      (19, c_cpf, 'ZZQ ALFA',        100, date '2026-09-03'),
      -- CNPJ B: empate total entre KAPA e OMEGA (desempate pela marca); DELTA com 1 item
      (20, c_b, 'ZZQ OMEGA',         100, date '2026-09-20'),
      (21, c_b, 'ZZQ OMEGA',         100, date '2026-09-20'),
      (22, c_b, 'ZZQ KAPA',          100, date '2026-09-20'),
      (23, c_b, 'ZZQ KAPA',          100, date '2026-09-20'),
      (24, c_b, 'ZZQ DELTA',         300, date '2026-09-21')
    ) as g(n, ni, marca, preco, data);

  -- ------------------------------------------------------------------ A
  select count(*) into v_n from public.v_marca_ocorrencias where ref_item like 'ZZTESTE:%';
  if v_n <> 23 then v_falhas := v_falhas || format('CASO A FALHOU: esperado 23 ocorrências (24 vendas, 1 sem data), obtido %s', v_n); end if;
  if exists (select 1 from public.v_marca_ocorrencias where ref_item = 'ZZTESTE:5') then
    v_falhas := v_falhas || 'CASO A FALHOU: venda sem data_resultado entrou em v_marca_ocorrencias'::text;
  end if;
  select ni_tipo || '/' || metodo || '/' || coalesce(marca, '-') || '/' || curada::text || '/' || entra_ranking::text into v_txt
    from public.v_marca_ocorrencias where ref_item = 'ZZTESTE:1';
  if v_txt is distinct from 'cnpj/alias_exato/ZZQ ALFA/true/true' then
    v_falhas := v_falhas || format('CASO A FALHOU: ZZTESTE:1 esperado cnpj/alias_exato/ZZQ ALFA/true/true, obtido %s', v_txt);
  end if;

  -- ------------------------------------------------------------------ B
  select marca || '/' || metodo into v_txt from public.v_marca_ocorrencias where ref_item = 'ZZTESTE:4';
  if v_txt is distinct from 'ZZQ ALFA/alias_exato' then v_falhas := v_falhas || format('CASO B FALHOU: grafia esperada ZZQ ALFA, obtido %s', v_txt); end if;
  select marca into v_txt from public.v_marca_ocorrencias where ref_item = 'ZZTESTE:6';
  if v_txt is distinct from 'ZZQ GAMA' then v_falhas := v_falhas || format('CASO B FALHOU: alias manual deveria vencer a semente, obtido %s', v_txt); end if;
  select bool_and(marca is null and metodo = 'nao_marca' and not entra_ranking) into v_ok
    from public.v_marca_ocorrencias where ref_item in ('ZZTESTE:13', 'ZZTESTE:14');
  if v_ok is distinct from true then v_falhas := v_falhas || 'CASO B FALHOU: nao_marca deveria ter marca NULL e ficar fora do ranking'::text; end if;
  select bool_and(marca is null and metodo = 'codigo_ou_medida' and not entra_ranking) into v_ok
    from public.v_marca_ocorrencias where ref_item in ('ZZTESTE:15', 'ZZTESTE:16');
  if v_ok is distinct from true then v_falhas := v_falhas || 'CASO B FALHOU: 1130PC deveria ser codigo_ou_medida com marca NULL'::text; end if;
  if exists (select 1 from public.v_fornecedor_marcas_ranking where cnpj = c_a and marca in ('ZZQ LIXO', '1130PC', 'ZZQ ERRADA')) then
    v_falhas := v_falhas || 'CASO B FALHOU: nao_marca, código ou alias da semente vencido entrou no ranking'::text;
  end if;

  -- ------------------------------------------------------------------ C
  select bool_and(ni_tipo = 'cpf' and not entra_ranking) into v_ok from public.v_marca_ocorrencias where ni = c_cpf;
  if v_ok is distinct from true then v_falhas := v_falhas || 'CASO C FALHOU: CPF deveria ter ni_tipo cpf e entra_ranking false'::text; end if;
  if exists (select 1 from public.v_fornecedor_marcas_ranking where cnpj = c_cpf)
     or exists (select 1 from public.v_fornecedor_marcas where cnpj = c_cpf) then
    v_falhas := v_falhas || 'CASO C FALHOU: CPF apareceu no ranking ou em v_fornecedor_marcas'::text;
  end if;

  -- ------------------------------------------------------------------ D
  select string_agg(marca || ':' || qtd_itens || ':' || valor_total::numeric(12,2) || ':' || posicao || ':' || qtd_marcas, ' | ' order by posicao)
    into v_txt from public.v_fornecedor_marcas_ranking where cnpj = c_a;
  if v_txt is distinct from
     'ZZQ ALFA:4:400.00:1:4 | ZZQ GAMA:2:1000.00:2:4 | ZZQ DELTA:2:600.00:3:4 | 3 SECONDS FITNESS:2:400.00:4:4' then
    v_falhas := v_falhas || format('CASO D FALHOU: ranking do CNPJ A inesperado: %s', v_txt);
  end if;
  if exists (select 1 from public.v_fornecedor_marcas_ranking where marca = 'ZZQ EPS') then
    v_falhas := v_falhas || 'CASO D FALHOU: marca com 1 item entrou no ranking (mínimo é 2)'::text;
  end if;
  select string_agg(marca || ':' || posicao, ' | ' order by posicao) into v_txt
    from public.v_fornecedor_marcas_ranking where cnpj = c_b;
  if v_txt is distinct from 'ZZQ KAPA:1 | ZZQ OMEGA:2' then
    v_falhas := v_falhas || format('CASO D FALHOU: empate deveria ser desfeito pela marca (KAPA, OMEGA), obtido %s', v_txt);
  end if;

  -- ------------------------------------------------------------------ E
  select * into v_rec from public.v_fornecedor_marcas where cnpj = c_a;
  if v_rec.qtd_marcas is distinct from 4::bigint
     or v_rec.marca_1 is distinct from 'ZZQ ALFA' or v_rec.marca_1_qtd_itens is distinct from 4::bigint
     or v_rec.marca_1_valor_total is distinct from 400::numeric or v_rec.marca_1_ultima_data is distinct from date '2026-09-04'
     or v_rec.marca_1_curada is distinct from true
     or v_rec.marca_2 is distinct from 'ZZQ GAMA' or v_rec.marca_2_curada is distinct from true
     or v_rec.marca_3 is distinct from 'ZZQ DELTA' or v_rec.marca_3_curada is distinct from false
     or v_rec.marca_3_qtd_itens is distinct from 2::bigint or v_rec.marca_3_ultima_data is distinct from date '2026-09-08' then
    v_falhas := v_falhas || format('CASO E FALHOU: v_fornecedor_marcas do CNPJ A inesperada: %s', row_to_json(v_rec));
  end if;
  select count(*) into v_n from public.v_fornecedor_marcas where cnpj in (c_a, c_b);
  if v_n <> 2 then v_falhas := v_falhas || format('CASO E FALHOU: esperado 1 linha por CNPJ (2), obtido %s', v_n); end if;

  -- ------------------------------------------------------------------ F
  select string_agg(marca_norm || ':' || ocorrencias || ':' || qtd_fornecedores, ' | ' order by marca_norm) into v_txt
    from public.v_marca_aliases_pendentes where marca_norm like 'ZZQ %';
  if v_txt is distinct from 'ZZQ DELTA:3:2 | ZZQ EPS:1:1 | ZZQ KAPA:2:1 | ZZQ OMEGA:2:1' then
    v_falhas := v_falhas || format('CASO F FALHOU: fila de pendentes inesperada: %s', v_txt);
  end if;

  -- ------------------------------------------------------------------ G
  select marca || '/' || metodo into v_txt from public.v_marca_ocorrencias where ref_item = 'ZZTESTE:10';
  if v_txt is distinct from '3 SECONDS FITNESS/bruta' then
    v_falhas := v_falhas || format('CASO G FALHOU: 3 SECONDS FITNESS deveria contar como marca bruta, obtido %s', v_txt);
  end if;
  select string_agg(coalesce(r.marca, 'NULL') || '=' || r.metodo, ' | ' order by t.ord) into v_txt
    from (values (1, '3G FITNESS'), (2, 'D1FITNESS'), (3, '1130PC'), (4, 'X44V7'), (5, '10KG'), (6, '2 KG'), (7, 'LLM014'), (8, '75CM BOMBA'))
         as t(ord, v)
   cross join lateral private.marca_resolver(t.v, c_a) r;
  if v_txt is distinct from '3G FITNESS=bruta | D1FITNESS=bruta | NULL=codigo_ou_medida | NULL=codigo_ou_medida | '
                            'NULL=codigo_ou_medida | NULL=codigo_ou_medida | NULL=codigo_ou_medida | NULL=codigo_ou_medida' then
    v_falhas := v_falhas || format('CASO G FALHOU: dígito + palavra x código/medida inesperado: %s', v_txt);
  end if;

  -- ------------------------------------------------------------------ H
  if not v_tem_constraints then
    v_falhas := v_falhas || 'CASO H FALHOU: constraints marca_aliases_valor_vazio_check/marca_aliases_valor_check ausentes; caso pulado'::text;
  else
  begin
    insert into public.marca_aliases (valor_norm, modo, marca, tipo, origem, evidencia) values ('', 'regex', 'ZZQ TUDO', 'marca', 'curadoria', 'teste');
    v_falhas := v_falhas || 'CASO H FALHOU: aceitou regex vazia'::text;
  exception when check_violation then null;
  end;
  begin
    insert into public.marca_aliases (valor_norm, modo, marca, tipo, origem, evidencia) values ('.*', 'regex', 'ZZQ TUDO', 'marca', 'curadoria', 'teste');
    v_falhas := v_falhas || 'CASO H FALHOU: aceitou regex que casa com a string vazia'::text;
  exception when check_violation then null;
  end;
  begin
    insert into public.marca_aliases (valor_norm, modo, marca, tipo, origem, evidencia) values ('  ', 'exato', 'ZZQ TUDO', 'marca', 'curadoria', 'teste');
    v_falhas := v_falhas || 'CASO H FALHOU: aceitou valor exato só com espaços'::text;
  exception when check_violation then null;
  end;
  begin
    insert into public.marca_aliases (valor_norm, modo, marca, tipo, origem, evidencia) values ('', 'prefixo', 'ZZQ TUDO', 'marca', 'curadoria', 'teste');
    v_falhas := v_falhas || 'CASO H FALHOU: aceitou prefixo vazio'::text;
  exception when check_violation then null;
  end;
  -- defesa no resolvedor: sem as constraints (só nesta transação), um padrão vazio continua sem casar
  alter table public.marca_aliases drop constraint marca_aliases_valor_vazio_check, drop constraint marca_aliases_valor_check;
  insert into public.marca_aliases (valor_norm, modo, marca, tipo, origem, evidencia, revisao_manual)
  values ('', 'regex', 'ZZQ TUDO', 'marca', 'curadoria', 'teste', true), ('', 'prefixo', 'ZZQ TUDO', 'marca', 'curadoria', 'teste', true);
  select r.marca || '/' || r.metodo into v_txt from private.marca_resolver('ZZQ DELTA', c_a) r;
  if v_txt is distinct from 'ZZQ DELTA/bruta' then
    v_falhas := v_falhas || format('CASO H FALHOU: resolvedor usou padrão vazio, obtido %s', v_txt);
  end if;
  end if;

  -- ------------------------------------------------------------------ resultado: uma exceção com a lista
  if coalesce(array_length(v_falhas, 1), 0) > 0 then
    for i in 1 .. array_length(v_falhas, 1) loop
      raise notice 'FALHA %', v_falhas[i];
    end loop;
    raise exception 'VIEWS CHECK FALHOU: marcas_resolvedor_views_check: % falha(s):%',
      array_length(v_falhas, 1), E'\n  - ' || array_to_string(v_falhas, E'\n  - ');
  end if;
  raise notice 'SUCESSO: marcas_resolvedor_views_check ok';
end $$;

rollback;
