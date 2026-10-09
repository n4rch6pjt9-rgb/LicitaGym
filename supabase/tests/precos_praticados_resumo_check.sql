-- =============================================================================
-- Checagem da migration 20261009180000_precos_praticados_resumo (spec 0009, CA-2).
--
-- 1. ACL: public.precos_praticados_resumo e public.precos_percentil_linear com EXECUTE só para service_role,
--    security invoker e search_path fixo.
-- 2. Casos sintéticos (banco LOCAL de teste; PDMs fictícios 999001..999003; tudo dentro de begin; ... rollback;):
--    A  (executado como service_role) n, média, mín, p25, mediana, p75 e máx do período; percentil por
--       interpolação linear (= percentile_cont) em numeric exato; arredondamento de 2 casas meio para longe do zero
--       (15,005 -> 15,01)
--    B  preço nulo ou zero não entra; linha fora do período não entra; datas das pontas entram
--    C  filtro de UF e de item
--    D  n < 3: média e quartis null com motivo; mín e máx continuam
--    E  recorte vazio: n = 0, tudo null, motivo, unidades = []
--    F  unidade predominante com a contagem
--    G  média 1,005 -> 1,01 (meio para longe do zero)
--    U  unidades: predominante agrupa só pela sigla (nome = o mais frequente dentro da sigla), empate pela sigla,
--       sigla nula nunca é predominante mas aparece em `unidades`; filtro p_unidade
-- Trava: aborta se precos_praticados_itens tiver mais de 100 linhas (produção).
-- Saída esperada: "SUCESSO: precos_praticados_resumo_check".
-- =============================================================================

begin;

do $$
declare
  v_fn regprocedure := to_regprocedure('public.precos_praticados_resumo(integer, date, date, integer, text, text)');
  v_pct regprocedure := to_regprocedure('public.precos_percentil_linear(numeric[], numeric)');
  v_qtd bigint;
begin
  if v_fn is null then
    raise exception 'CHECK FALHOU: public.precos_praticados_resumo(integer, date, date, integer, text, text) não existe';
  end if;
  if v_pct is null then
    raise exception 'CHECK FALHOU: public.precos_percentil_linear(numeric[], numeric) não existe';
  end if;
  foreach v_fn in array array[v_fn, v_pct] loop
    if has_function_privilege('anon', v_fn, 'EXECUTE') or has_function_privilege('authenticated', v_fn, 'EXECUTE') then
      raise exception 'CHECK FALHOU: anon/authenticated executa %', v_fn;
    end if;
    if not has_function_privilege('service_role', v_fn, 'EXECUTE') then
      raise exception 'CHECK FALHOU: service_role não executa %', v_fn;
    end if;
    if exists (select 1 from pg_proc where oid = v_fn and prosecdef) then
      raise exception 'CHECK FALHOU: % deveria ser security invoker', v_fn;
    end if;
    if not exists (select 1 from pg_proc where oid = v_fn
                    and exists (select 1 from unnest(proconfig) c where c like 'search_path=%')) then
      raise exception 'CHECK FALHOU: % sem search_path fixo', v_fn;
    end if;
  end loop;

  select count(*) into v_qtd from public.precos_praticados_itens;
  if v_qtd > 100 then
    raise exception 'TRAVA DE SEGURANCA: precos_praticados_itens contem % linhas (> 100). Abortando.', v_qtd;
  end if;
end $$;

-- Linhas fictícias: (id_compra, item, pdm, item catálogo, data_resultado, preço, UF, unidade)
insert into public.precos_praticados_itens
  (id_compra, id_item_compra, codigo_pdm, codigo_item_catalogo, data_resultado, preco_unitario, estado,
   sigla_unidade_fornecimento, nome_unidade_fornecimento, last_synced_at)
values
  ('00000000000000001', 1, '999001', 111, '2026-01-10', 10.0000, 'PR', 'UN', 'UNIDADE', '2026-10-03 02:00:00+00'),
  ('00000000000000001', 2, '999001', 111, '2026-06-01', 20.0100, 'PR', 'UN', 'UNIDADE', '2026-10-03 02:00:00+00'),
  ('00000000000000002', 1, '999001', 222, '2025-10-10', 30.0000, 'SP', 'KIT', 'KIT',   '2026-10-03 03:00:00+00'),
  -- nulo/zero não entram
  ('00000000000000003', 1, '999001', 111, '2026-02-01', null,    'PR', 'UN', 'UNIDADE', '2026-10-03 02:00:00+00'),
  ('00000000000000003', 2, '999001', 111, '2026-02-01', 0,       'PR', 'UN', 'UNIDADE', '2026-10-03 02:00:00+00'),
  -- fora do período (um dia antes do início e um dia depois do fim)
  ('00000000000000004', 1, '999001', 111, '2025-10-09', 99999,   'PR', 'UN', 'UNIDADE', '2026-10-03 02:00:00+00'),
  ('00000000000000004', 2, '999001', 111, '2026-10-10', 99999,   'PR', 'UN', 'UNIDADE', '2026-10-03 02:00:00+00'),
  -- outro PDM
  ('00000000000000005', 1, '999002', 333, '2026-05-01', 1.0050,  'RJ', 'UN', 'UNIDADE', '2026-10-03 02:00:00+00'),
  ('00000000000000005', 2, '999002', 333, '2026-05-02', 1.0050,  'RJ', 'UN', 'UNIDADE', '2026-10-03 02:00:00+00'),
  ('00000000000000005', 3, '999002', 333, '2026-05-03', 1.0050,  'RJ', 'UN', 'UNIDADE', '2026-10-03 02:00:00+00'),
  -- U: P (3 linhas, nomes PAR x1 e PARES x2), UN (3 linhas), sigla nula (4 linhas)
  ('00000000000000006', 1, '999003', 444, '2026-03-01', 50,      'MG', 'P',  'PAR',     '2026-10-03 02:00:00+00'),
  ('00000000000000006', 2, '999003', 444, '2026-03-01', 60,      'MG', 'P',  'PARES',   '2026-10-03 02:00:00+00'),
  ('00000000000000006', 3, '999003', 444, '2026-03-01', 70,      'MG', 'P',  'PARES',   '2026-10-03 02:00:00+00'),
  ('00000000000000006', 4, '999003', 444, '2026-03-01', 10,      'MG', 'UN', 'UNIDADE', '2026-10-03 02:00:00+00'),
  ('00000000000000006', 5, '999003', 444, '2026-03-01', 20,      'MG', 'UN', 'UNIDADE', '2026-10-03 02:00:00+00'),
  ('00000000000000006', 6, '999003', 444, '2026-03-01', 30,      'MG', 'UN', 'UNIDADE', '2026-10-03 02:00:00+00'),
  ('00000000000000006', 7, '999003', 444, '2026-03-01', 1,       'MG', null, null,      '2026-10-03 02:00:00+00'),
  ('00000000000000006', 8, '999003', 444, '2026-03-01', 2,       'MG', null, null,      '2026-10-03 02:00:00+00'),
  ('00000000000000006', 9, '999003', 444, '2026-03-01', 3,       'MG', null, null,      '2026-10-03 02:00:00+00'),
  ('00000000000000006', 10, '999003', 444, '2026-03-01', 4,      'MG', null, null,      '2026-10-03 02:00:00+00'),
  ('00000000000000007', 1, '999004', 555, '2026-03-01', 5,       'MG', null, null,      '2026-10-03 02:00:00+00');

-- Caso A como service_role (o papel com que a api-precos chama a função)
set local role service_role;

do $$
declare
  r record;
begin
  -- A/B: período 2025-10-10..2026-10-09, preços 10.00, 20.01, 30.00
  select * into r from public.precos_praticados_resumo(999001, '2025-10-10', '2026-10-09', null, null);
  if r.n is distinct from 3 then raise exception 'CHECK FALHOU (A): n=% (esperado 3)', r.n; end if;
  if r.media is distinct from 20.00 then raise exception 'CHECK FALHOU (A): media=% (esperado 20.00)', r.media; end if;
  if r.preco_min is distinct from 10.0000 or r.preco_max is distinct from 30.0000 then
    raise exception 'CHECK FALHOU (A): min=% max=%', r.preco_min, r.preco_max;
  end if;
  -- p25: posição 1,5 -> 10 + 0,5*(20,01-10) = 15,005 -> 15,01 (meio para longe do zero; float daria 15,00)
  if r.p25 is distinct from 15.01 then raise exception 'CHECK FALHOU (A): p25=% (esperado 15.01)', r.p25; end if;
  if r.mediana is distinct from 20.01 then raise exception 'CHECK FALHOU (A): mediana=% (esperado 20.01)', r.mediana; end if;
  -- p75: posição 2,5 -> 20,01 + 0,5*(30-20,01) = 25,005 -> 25,01
  if r.p75 is distinct from 25.01 then raise exception 'CHECK FALHOU (A): p75=% (esperado 25.01)', r.p75; end if;
  if r.motivo is not null then raise exception 'CHECK FALHOU (A): motivo=% (esperado null)', r.motivo; end if;
  if r.ultima_data_resultado is distinct from '2026-06-01'::date then
    raise exception 'CHECK FALHOU (A): ultima_data_resultado=%', r.ultima_data_resultado;
  end if;
  if r.atualizado_em is distinct from '2026-10-03 03:00:00+00'::timestamptz then
    raise exception 'CHECK FALHOU (A): atualizado_em=%', r.atualizado_em;
  end if;
  -- F: unidade predominante UN (2 de 3); unidades lista as duas
  if r.unidade_sigla is distinct from 'UN' or r.unidade_nome is distinct from 'UNIDADE' or r.unidade_n is distinct from 2 then
    raise exception 'CHECK FALHOU (F): unidade=% % %', r.unidade_sigla, r.unidade_nome, r.unidade_n;
  end if;
  if r.unidades is distinct from
     '[{"sigla": "UN", "nome": "UNIDADE", "n": 2}, {"sigla": "KIT", "nome": "KIT", "n": 1}]'::jsonb then
    raise exception 'CHECK FALHOU (F): unidades=%', r.unidades;
  end if;
  raise notice 'CASO A/B/F ok (service_role)';
end $$;

reset role;

do $$
declare
  r record;
begin
  -- A: igual a percentile_cont (arredondado) nos mesmos dados
  if (select round(percentile_cont(0.25) within group (order by preco_unitario)::numeric, 2)
        from public.precos_praticados_itens
       where codigo_pdm = '999001' and preco_unitario > 0 and data_resultado between '2025-10-10' and '2026-10-09')
     not in (15.00, 15.01) then
    raise exception 'CHECK FALHOU (A): definição de percentil diverge de percentile_cont';
  end if;

  -- C: UF e item
  select * into r from public.precos_praticados_resumo(999001, '2025-10-10', '2026-10-09', null, 'SP');
  if r.n is distinct from 1 then raise exception 'CHECK FALHOU (C): n por UF=% (esperado 1)', r.n; end if;
  select * into r from public.precos_praticados_resumo(999001, '2025-10-10', '2026-10-09', 111, null);
  if r.n is distinct from 2 then raise exception 'CHECK FALHOU (C): n por item=% (esperado 2)', r.n; end if;

  -- D: n < 3
  if r.media is not null or r.p25 is not null or r.mediana is not null or r.p75 is not null then
    raise exception 'CHECK FALHOU (D): n<3 com média/quartis (% % % %)', r.media, r.p25, r.mediana, r.p75;
  end if;
  if r.preco_min is distinct from 10.0000 or r.preco_max is distinct from 20.0100 then
    raise exception 'CHECK FALHOU (D): n<3 sem mín/máx (% %)', r.preco_min, r.preco_max;
  end if;
  if coalesce(r.motivo, '') = '' then raise exception 'CHECK FALHOU (D): n<3 sem motivo'; end if;
  raise notice 'CASO C/D ok';

  -- E: vazio
  select * into r from public.precos_praticados_resumo(999001, '2020-01-01', '2020-12-31', null, null);
  if r.n is distinct from 0 or r.media is not null or r.preco_min is not null or r.unidade_sigla is not null
     or coalesce(r.motivo, '') = '' or r.unidades is distinct from '[]'::jsonb then
    raise exception 'CHECK FALHOU (E): recorte vazio n=% media=% min=% unidade=% motivo=% unidades=%',
      r.n, r.media, r.preco_min, r.unidade_sigla, r.motivo, r.unidades;
  end if;
  if (select count(*) from public.precos_praticados_resumo(999001, '2020-01-01', '2020-12-31', null, null)) <> 1 then
    raise exception 'CHECK FALHOU (E): resumo deve ter exatamente uma linha';
  end if;
  raise notice 'CASO E ok';

  -- G: 1,005 -> 1,01
  select * into r from public.precos_praticados_resumo(999002, '2026-01-01', '2026-12-31', null, null);
  if r.media is distinct from 1.01 or r.mediana is distinct from 1.01 then
    raise exception 'CHECK FALHOU (G): media=% mediana=% (esperado 1.01)', r.media, r.mediana;
  end if;
  raise notice 'CASO G ok';

  -- U: empate P x UN (3 x 3) -> P pela sigla; nome mais frequente dentro de P = PARES; sigla nula (4) não vence
  select * into r from public.precos_praticados_resumo(999003, '2026-01-01', '2026-12-31', null, null);
  if r.n is distinct from 10 then raise exception 'CHECK FALHOU (U): n=% (esperado 10)', r.n; end if;
  if r.unidade_sigla is distinct from 'P' or r.unidade_nome is distinct from 'PARES' or r.unidade_n is distinct from 3 then
    raise exception 'CHECK FALHOU (U): predominante=% % % (esperado P PARES 3)', r.unidade_sigla, r.unidade_nome, r.unidade_n;
  end if;
  if r.unidades is distinct from
     '[{"sigla": null, "nome": null, "n": 4}, {"sigla": "P", "nome": "PARES", "n": 3},
       {"sigla": "UN", "nome": "UNIDADE", "n": 3}]'::jsonb then
    raise exception 'CHECK FALHOU (U): unidades=%', r.unidades;
  end if;
  -- U: filtro p_unidade
  select * into r from public.precos_praticados_resumo(999003, '2026-01-01', '2026-12-31', null, null, 'UN');
  if r.n is distinct from 3 or r.media is distinct from 20.00 or r.unidade_sigla is distinct from 'UN'
     or r.unidades is distinct from '[{"sigla": "UN", "nome": "UNIDADE", "n": 3}]'::jsonb then
    raise exception 'CHECK FALHOU (U): filtro UN n=% media=% unidade=% unidades=%', r.n, r.media, r.unidade_sigla, r.unidades;
  end if;
  -- U: só sigla nula no recorte -> sem predominante
  select * into r from public.precos_praticados_resumo(999004, '2026-01-01', '2026-12-31', null, null);
  if r.n is distinct from 1 or r.unidade_sigla is not null or r.unidade_nome is not null or r.unidade_n is not null
     or r.unidades is distinct from '[{"sigla": null, "nome": null, "n": 1}]'::jsonb then
    raise exception 'CHECK FALHOU (U): só sigla nula n=% predominante=% % % unidades=%',
      r.n, r.unidade_sigla, r.unidade_nome, r.unidade_n, r.unidades;
  end if;
  raise notice 'CASO U ok';

  -- percentil: casos de borda
  if public.precos_percentil_linear(array[]::numeric[], 0.5) is not null then
    raise exception 'CHECK FALHOU: percentil de lista vazia deveria ser null';
  end if;
  if public.precos_percentil_linear(array[7.5]::numeric[], 0.25) is distinct from 7.5 then
    raise exception 'CHECK FALHOU: percentil de um valor deveria ser o próprio valor';
  end if;

  raise notice 'SUCESSO: precos_praticados_resumo_check';
end $$;

rollback;
