-- =============================================================================
-- Checagem da migration 20261021150000_precos_itens_contratacao (spec 0031, fase A).
--
-- 1. ACL (CA-10): precos_compras_contratacao e precos_itens_contratacao com RLS ligada, sem SELECT para anon e
--    authenticated, com SELECT para service_role; as funções novas com EXECUTE só para service_role, security
--    invoker e search_path fixo.
-- 2. Casos sintéticos (banco LOCAL de teste; PDMs fictícios 999101..999102; tudo dentro de begin; ... rollback;):
--    F1 (CA-7)  UASG por código exato e por texto no nome (sem acento)
--    F2 (CA-7b) cidade pelo nome inteiro, sem acento e sem diferenciar maiúsculas
--    F3 (CA-7c) busca livre com duas palavras (todas presentes) e filtro de objeto
--    I  (CA-8)  itens do PDM: só itens com preço, com n e a descrição do preço mais recente
--    R  (CA-9)  resumo sem filtro não exclui o preço acima de 2,5× a mediana
--    K          KPIs: item com mais amostras (sem o filtro de item), n_com_estimado e mediana da diferença (%)
--    A  (CA-6)  amostras: estimado oficial, nº PNCP, link e total; estimado 0 vira null; compra não consultada
--    P          compras pendentes: sem consulta, ou com atualização mais nova na fonte
-- Trava: aborta se precos_praticados_itens tiver mais de 100 linhas (produção).
-- Saída esperada: "SUCESSO: precos_itens_contratacao_check".
-- =============================================================================

begin;

do $$
declare
  v_tab text;
  v_fn regprocedure;
  v_qtd bigint;
begin
  foreach v_tab in array array['public.precos_compras_contratacao', 'public.precos_itens_contratacao'] loop
    if to_regclass(v_tab) is null then raise exception 'CHECK FALHOU: % não existe', v_tab; end if;
    if not (select relrowsecurity from pg_class where oid = to_regclass(v_tab)) then
      raise exception 'CHECK FALHOU: % sem RLS', v_tab;
    end if;
    if has_table_privilege('anon', v_tab, 'SELECT') or has_table_privilege('authenticated', v_tab, 'SELECT') then
      raise exception 'CHECK FALHOU (CA-10): anon/authenticated lê %', v_tab;
    end if;
    if has_table_privilege('anon', v_tab, 'INSERT') or has_table_privilege('authenticated', v_tab, 'INSERT') then
      raise exception 'CHECK FALHOU (CA-10): anon/authenticated grava %', v_tab;
    end if;
    if not has_table_privilege('service_role', v_tab, 'SELECT') then
      raise exception 'CHECK FALHOU: service_role não lê %', v_tab;
    end if;
  end loop;

  foreach v_fn in array array[
    to_regprocedure('public.precos_compras_pendentes_contratacao(date, integer)'),
    to_regprocedure('public.precos_texto_tem_todas(text, text)'),
    to_regprocedure('public.precos_praticados_recorte(integer, date, date, integer, text, text, text, text, text, text)'),
    to_regprocedure('public.precos_praticados_amostras(integer, date, date, integer, text, text, text, text, text, text, integer, integer)'),
    to_regprocedure('public.precos_praticados_itens_pdm(integer, date, date, text, text, text, text, text, text)'),
    to_regprocedure('public.precos_praticados_municipios(integer, date, date, integer, text, text, text, text, text)'),
    to_regprocedure('public.precos_praticados_resumo(integer, date, date, integer, text, text, text, text, text, text)')
  ] loop
    if v_fn is null then raise exception 'CHECK FALHOU: função nova da spec 0031 não existe'; end if;
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

  if to_regprocedure('public.precos_praticados_resumo(integer, date, date, integer, text, text)') is not null then
    raise exception 'CHECK FALHOU: assinatura antiga de 6 parâmetros do resumo ainda existe (chamada ambígua)';
  end if;

  select count(*) into v_qtd from public.precos_praticados_itens;
  if v_qtd > 100 then
    raise exception 'TRAVA DE SEGURANCA: precos_praticados_itens contem % linhas (> 100). Abortando.', v_qtd;
  end if;
end $$;

-- PDM 999101: item 111 (5 preços), item 222 (2 preços). PDM 999102: outro PDM.
insert into public.precos_praticados_itens
  (id_compra, id_item_compra, numero_item_compra, codigo_pdm, codigo_item_catalogo, data_resultado, preco_unitario,
   estado, municipio, codigo_uasg, nome_uasg, nome_orgao, objeto_compra, descricao_item, marca, nome_fornecedor,
   sigla_unidade_fornecimento, esfera, poder, data_hora_atualizacao_compra)
values
  ('16021805900022026', 1, 66, '999101', 111, '2026-08-05', 2229, 'PA', 'BELÉM', '160218', 'COLÉGIO MILITAR DE BELÉM',
   'COMANDO DO EXERCITO', 'Aquisição de material esportivo', 'MESA TÊNIS DE MESA, ANTIGA', 'PROCOPIO', 'SEBASTIAO Q. FERREIRA',
   'UN', 'F', 'E', '2026-08-06 01:10:04+00'),
  ('16021805900022026', 2, 67, '999101', 111, '2026-08-06', 3500, 'PA', 'Belem', '160218', 'COLÉGIO MILITAR DE BELÉM',
   'COMANDO DO EXERCITO', 'Aquisição de material esportivo', 'MESA TÊNIS DE MESA, RECENTE', 'HOBBY TT', 'BR MIX',
   'UN', 'F', 'E', '2026-08-06 01:10:04+00'),
  ('98756505900352026', 1, 1, '999101', 111, '2026-07-01', 2000, 'SP', 'SÃO PAULO', '987565', 'PREFEITURA DE SÃO PAULO',
   'MUNICIPIO DE SAO PAULO', 'Registro de preço de mobiliário', 'MESA TÊNIS DE MESA, ANTIGA', 'KLOPF', 'MESA E CIA',
   'UN', 'M', 'E', '2026-07-02 00:00:00+00'),
  ('98756505900352026', 2, 2, '999101', 111, '2026-07-01', 2100, 'SP', 'SÃO PAULO', '987565', 'PREFEITURA DE SÃO PAULO',
   'MUNICIPIO DE SAO PAULO', 'Registro de preço de mobiliário', 'MESA TÊNIS DE MESA, ANTIGA', 'Klopf', 'MESA E CIA',
   'UN', 'M', 'E', '2026-07-02 00:00:00+00'),
  -- preço acima de 2,5× a mediana: continua no recorte (CA-9)
  ('98756505900352026', 3, 3, '999101', 111, '2026-07-01', 37293.40, 'SP', 'SÃO PAULO', '987565', 'PREFEITURA DE SÃO PAULO',
   'MUNICIPIO DE SAO PAULO', 'Registro de preço de mobiliário', 'MESA TÊNIS DE MESA, ANTIGA', 'KLOPF', 'MESA E CIA',
   'UN', 'M', 'E', '2026-07-02 00:00:00+00'),
  ('15316705900112026', 1, 1, '999101', 222, '2026-06-01', 1000, 'RJ', 'RIO DE JANEIRO', '153167', 'COLEGIO PEDRO II',
   'COLEGIO PEDRO II', 'Aquisição de materiais esportivos', 'MESA FUTMESA', 'Mesa', 'GUIDONI', 'UN', 'F', 'E', null),
  ('15316705900112026', 2, 2, '999101', 222, '2026-06-02', 1200, 'RJ', 'RIO DE JANEIRO', '153167', 'COLEGIO PEDRO II',
   'COLEGIO PEDRO II', 'Aquisição de materiais esportivos', 'MESA FUTMESA', 'Mesa', 'GUIDONI', 'UN', 'F', 'E', null),
  ('99999999999999999', 1, 1, '999102', 333, '2026-06-01', 50, 'RJ', 'RIO DE JANEIRO', '153167', 'COLEGIO PEDRO II',
   'COLEGIO PEDRO II', 'Outro PDM', 'OUTRO', 'X', 'Y', 'UN', 'F', 'E', null);

-- Compras consultadas: Belém encontrada com link; São Paulo encontrada sem link (dispensa) e consultada antes de
-- uma atualização mais nova na fonte; Pedro II não consultada.
insert into public.precos_compras_contratacao
  (id_compra, encontrada, numero_controle_pncp, orgao_entidade_cnpj, ano_compra_pncp, sequencial_compra_pncp,
   link_sistema_origem, data_hora_atualizacao_compra)
values
  ('16021805900022026', true, '00394452000103-1-010524/2026', '00394452000103', 2026, 10524,
   'https://cnetmobile.estaleiro.serpro.gov.br/comprasnet-web/public/landing?destino=acompanhamento-compra&compra=16021805900022026',
   '2026-08-06 01:10:04+00'),
  ('98756505900352026', true, '46395000000139-1-000035/2026', '46395000000139', 2026, 35, null,
   '2026-07-01 00:00:00+00');

-- Estimados: Belém 66 = 3156.67 (−29,39%), 67 = 4000 (−12,50%); São Paulo 1 = 2500 (−20,00%), 2 = 0 (ausente),
-- 3 = 20000 (+86,467%).
insert into public.precos_itens_contratacao
  (id_compra, numero_item_compra, valor_unitario_estimado, valor_unitario_resultado, situacao_item, tem_resultado,
   numero_controle_pncp)
values
  ('16021805900022026', 66, 3156.67, 2229, 'Homologado', true, '00394452000103-1-010524/2026'),
  ('16021805900022026', 67, 4000, 3500, 'Homologado', true, '00394452000103-1-010524/2026'),
  ('98756505900352026', 1, 2500, 2000, 'Homologado', true, '46395000000139-1-000035/2026'),
  ('98756505900352026', 2, 0, 2100, 'Homologado', true, '46395000000139-1-000035/2026'),
  ('98756505900352026', 3, 20000, 37293.40, 'Homologado', true, '46395000000139-1-000035/2026');

set local role service_role;

do $$
declare
  r record;
  v_n bigint;
begin
  -- F1 (CA-7): UASG por código e por texto
  select count(*) into v_n from public.precos_praticados_recorte(999101, '2025-10-22', '2026-10-21', p_uasg => '160218');
  if v_n <> 2 then raise exception 'CHECK FALHOU (F1): uasg=160218 n=% (esperado 2)', v_n; end if;
  select count(*) into v_n from public.precos_praticados_recorte(999101, '2025-10-22', '2026-10-21', p_uasg => 'belem');
  if v_n <> 2 then raise exception 'CHECK FALHOU (F1): uasg=belem n=% (esperado 2)', v_n; end if;
  select count(*) into v_n from public.precos_praticados_recorte(999101, '2025-10-22', '2026-10-21', p_uasg => '16021');
  if v_n <> 0 then raise exception 'CHECK FALHOU (F1): código parcial deveria não casar (n=%)', v_n; end if;

  -- F2 (CA-7b): cidade sem acento e sem diferenciar maiúsculas ("BELÉM" e "Belem")
  select count(*) into v_n from public.precos_praticados_recorte(999101, '2025-10-22', '2026-10-21',
                                                                 p_uf => 'PA', p_municipio => 'belém');
  if v_n <> 2 then raise exception 'CHECK FALHOU (F2): municipio=belém n=% (esperado 2)', v_n; end if;
  select count(*) into v_n from public.precos_praticados_recorte(999101, '2025-10-22', '2026-10-21',
                                                                 p_uf => 'PA', p_municipio => 'bel');
  if v_n <> 0 then raise exception 'CHECK FALHOU (F2): cidade compara o nome inteiro (n=%)', v_n; end if;

  -- F3 (CA-7c): busca livre, todas as palavras; objeto
  select count(*) into v_n from public.precos_praticados_recorte(999101, '2025-10-22', '2026-10-21', p_q => 'klopf mesa');
  if v_n <> 3 then raise exception 'CHECK FALHOU (F3): q=klopf mesa n=% (esperado 3)', v_n; end if;
  select count(*) into v_n from public.precos_praticados_recorte(999101, '2025-10-22', '2026-10-21', p_q => 'klopf belem');
  if v_n <> 0 then raise exception 'CHECK FALHOU (F3): q com palavra ausente deveria dar 0 (n=%)', v_n; end if;
  -- LGPD: fornecedor pessoa física (CPF) não é encontrado pelo nome
  reset role;
  update public.precos_praticados_itens set ni_fornecedor = '12345678901', nome_fornecedor = 'FULANO DE TAL'
   where id_compra = '15316705900112026' and id_item_compra = 1;
  -- NI com espaço em volta também é CPF (mesma regra da exibição, que apara)
  update public.precos_praticados_itens set ni_fornecedor = ' 98765432100 ', nome_fornecedor = 'BELTRANO SILVA'
   where id_compra = '15316705900112026' and id_item_compra = 2;
  set local role service_role;
  select count(*) into v_n from public.precos_praticados_recorte(999101, '2025-10-22', '2026-10-21', p_q => 'fulano');
  if v_n <> 0 then raise exception 'CHECK FALHOU (F3): nome de pessoa física buscável (n=%)', v_n; end if;
  select count(*) into v_n from public.precos_praticados_recorte(999101, '2025-10-22', '2026-10-21', p_q => 'beltrano');
  if v_n <> 0 then raise exception 'CHECK FALHOU (F3): CPF com espaço deixou o nome buscável (n=%)', v_n; end if;
  select count(*) into v_n from public.precos_praticados_recorte(999101, '2025-10-22', '2026-10-21', p_objeto => 'ESPORTIVO');
  if v_n <> 4 then raise exception 'CHECK FALHOU (F3): objeto=ESPORTIVO n=% (esperado 4)', v_n; end if;
  raise notice 'CASO F ok';

  -- I (CA-8): itens com n, ordem fica para a api-precos; descrição do preço mais recente
  if (select count(*) from public.precos_praticados_itens_pdm(999101, '2025-10-22', '2026-10-21')) <> 2 then
    raise exception 'CHECK FALHOU (I): esperado 2 itens';
  end if;
  select * into r from public.precos_praticados_itens_pdm(999101, '2025-10-22', '2026-10-21') where codigo_item_catalogo = 111;
  if r.n is distinct from 5 or r.descricao is distinct from 'MESA TÊNIS DE MESA, RECENTE' then
    raise exception 'CHECK FALHOU (I): item 111 n=% descricao=%', r.n, r.descricao;
  end if;
  if exists (select 1 from public.precos_praticados_itens_pdm(999101, '2025-10-22', '2026-10-21') where n <= 0) then
    raise exception 'CHECK FALHOU (I): item com n = 0';
  end if;
  raise notice 'CASO I ok';

  -- M (spec 0031, Proposta 7): cidades do recorte, sem o filtro de cidade; "BELÉM" e "Belem" são a mesma cidade
  if (select count(*) from public.precos_praticados_municipios(999101, '2025-10-22', '2026-10-21')) <> 3 then
    raise exception 'CHECK FALHOU (M): esperado 3 cidades (Belém, São Paulo, Rio de Janeiro), veio %',
      (select count(*) from public.precos_praticados_municipios(999101, '2025-10-22', '2026-10-21'));
  end if;
  select * into r from public.precos_praticados_municipios(999101, '2025-10-22', '2026-10-21', p_uf => 'SP');
  if r.uf is distinct from 'SP' or r.municipio is distinct from 'SÃO PAULO' or r.n is distinct from 3 then
    raise exception 'CHECK FALHOU (M): SP % % %', r.uf, r.municipio, r.n;
  end if;
  select * into r from public.precos_praticados_municipios(999101, '2025-10-22', '2026-10-21', p_uf => 'PA');
  if r.n is distinct from 2 or r.municipio not in ('BELÉM', 'Belem') then
    raise exception 'CHECK FALHOU (M): PA % % (esperado Belém com 2)', r.municipio, r.n;
  end if;
  raise notice 'CASO M ok';

  -- R (CA-9) e K: resumo do item 111 sem filtro inclui o 37.293,40
  select * into r from public.precos_praticados_resumo(999101, '2025-10-22', '2026-10-21', 111);
  if r.n is distinct from 5 or r.preco_max is distinct from 37293.40 then
    raise exception 'CHECK FALHOU (R): n=% max=% (esperado 5 e 37293.40)', r.n, r.preco_max;
  end if;
  -- K: item com mais amostras ignora o filtro de item
  if r.item_mais_codigo is distinct from 111 or r.item_mais_n is distinct from 5 then
    raise exception 'CHECK FALHOU (K): item_mais=% n=%', r.item_mais_codigo, r.item_mais_n;
  end if;
  -- K: 4 linhas com estimado > 0: −29,3893..., −12,5, −20, +86,467 -> mediana (−20 + −12,5)/2 = −16,25
  if r.n_com_estimado is distinct from 4 then
    raise exception 'CHECK FALHOU (K): n_com_estimado=% (esperado 4)', r.n_com_estimado;
  end if;
  if r.diferenca_mediana_percentual is distinct from -16.25 then
    raise exception 'CHECK FALHOU (K): diferenca_mediana_percentual=% (esperado -16.25)', r.diferenca_mediana_percentual;
  end if;
  -- K: menos de 3 com estimado -> sem mediana da diferença
  select * into r from public.precos_praticados_resumo(999101, '2025-10-22', '2026-10-21', p_uasg => '160218');
  if r.n_com_estimado is distinct from 2 or r.diferenca_mediana_percentual is not null then
    raise exception 'CHECK FALHOU (K): n_com_estimado=% dif=% (esperado 2 e null)', r.n_com_estimado, r.diferenca_mediana_percentual;
  end if;
  raise notice 'CASO R/K ok';

  -- A (CA-6): amostras com estimado, PNCP e total
  select * into r from public.precos_praticados_amostras(999101, '2025-10-22', '2026-10-21', 111, p_limit => 2);
  if r.total is distinct from 5::bigint then raise exception 'CHECK FALHOU (A): total=% (esperado 5)', r.total; end if;
  if r.id_compra is distinct from '16021805900022026' or r.numero_item_compra is distinct from 67 then
    raise exception 'CHECK FALHOU (A): primeira linha % % (esperado a mais recente, item 67)', r.id_compra, r.numero_item_compra;
  end if;
  select * into r from public.precos_praticados_amostras(999101, '2025-10-22', '2026-10-21', 111)
   where numero_item_compra = 66;
  if r.valor_unitario_estimado is distinct from 3156.67 or r.numero_controle_pncp is distinct from '00394452000103-1-010524/2026'
     or r.sequencial_compra_pncp is distinct from 10524 or r.link_sistema_origem is null
     or r.compra_consultada is distinct from true or r.esfera is distinct from 'F' or r.poder is distinct from 'E' then
    raise exception 'CHECK FALHOU (A): item 66 estimado=% ncp=% seq=% link=% consultada=% esfera=% poder=%',
      r.valor_unitario_estimado, r.numero_controle_pncp, r.sequencial_compra_pncp, r.link_sistema_origem,
      r.compra_consultada, r.esfera, r.poder;
  end if;
  select * into r from public.precos_praticados_amostras(999101, '2025-10-22', '2026-10-21', 111)
   where id_compra = '98756505900352026' and numero_item_compra = 2;
  if r.valor_unitario_estimado is not null or r.link_sistema_origem is not null or r.compra_encontrada is distinct from true then
    raise exception 'CHECK FALHOU (A): estimado 0 deveria ser null (%), sem link (%)', r.valor_unitario_estimado, r.link_sistema_origem;
  end if;
  select * into r from public.precos_praticados_amostras(999101, '2025-10-22', '2026-10-21', 222) limit 1;
  if r.compra_consultada is distinct from false or r.compra_encontrada is not null then
    raise exception 'CHECK FALHOU (A): compra não consultada consultada=% encontrada=%', r.compra_consultada, r.compra_encontrada;
  end if;
  -- estimado de compra que passou a vir vazia (encontrada=false) não vale, mesmo com o item antigo gravado
  reset role;
  update public.precos_compras_contratacao set encontrada = false where id_compra = '98756505900352026';
  set local role service_role;
  select * into r from public.precos_praticados_amostras(999101, '2025-10-22', '2026-10-21', 111)
   where id_compra = '98756505900352026' and numero_item_compra = 1;
  if r.valor_unitario_estimado is not null then
    raise exception 'CHECK FALHOU (A): estimado de compra não encontrada deveria ser null (%)', r.valor_unitario_estimado;
  end if;
  select * into r from public.precos_praticados_resumo(999101, '2025-10-22', '2026-10-21', 111);
  if r.n_com_estimado is distinct from 2 then
    raise exception 'CHECK FALHOU (A): n_com_estimado sem a compra não encontrada=% (esperado 2)', r.n_com_estimado;
  end if;
  reset role;
  update public.precos_compras_contratacao set encontrada = true where id_compra = '98756505900352026';
  set local role service_role;
  if exists (select 1 from public.precos_praticados_amostras(999101, '2025-10-22', '2026-10-21', 111, p_offset => 5)) then
    raise exception 'CHECK FALHOU (A): offset além do total deveria vir vazio';
  end if;
  raise notice 'CASO A ok';

  -- P: pendentes = Pedro II (nunca consultada) e São Paulo (fonte atualizada depois da consulta); Belém em dia
  select count(*) into v_n from public.precos_compras_pendentes_contratacao('2025-10-22', 100);
  if v_n <> 3 then
    -- 99999999999999999 (outro PDM) também é compra do recorte de datas e nunca foi consultada
    raise exception 'CHECK FALHOU (P): pendentes=% (esperado 3)', v_n;
  end if;
  if exists (select 1 from public.precos_compras_pendentes_contratacao('2025-10-22', 100) where id_compra = '16021805900022026') then
    raise exception 'CHECK FALHOU (P): compra em dia não deveria estar pendente';
  end if;
  if not exists (select 1 from public.precos_compras_pendentes_contratacao('2025-10-22', 100) where id_compra = '98756505900352026') then
    raise exception 'CHECK FALHOU (P): compra com fonte mais nova deveria estar pendente';
  end if;
  -- não encontrada há mais de 30 dias volta a ser pendente; há menos, não
  reset role;
  insert into public.precos_compras_contratacao (id_compra, encontrada, consultado_em)
  values ('99999999999999999', false, now() - interval '31 days'),
         ('15316705900112026', false, now() - interval '1 day');
  set local role service_role;
  if not exists (select 1 from public.precos_compras_pendentes_contratacao('2025-10-22', 100) where id_compra = '99999999999999999')
     or exists (select 1 from public.precos_compras_pendentes_contratacao('2025-10-22', 100) where id_compra = '15316705900112026') then
    raise exception 'CHECK FALHOU (P): reconsulta de não encontrada deveria valer só depois de 30 dias';
  end if;
  -- encontrada, consultada há mais de 7 dias, com item de preço sem resultado: volta a ser pendente
  reset role;
  update public.precos_compras_contratacao
     set consultado_em = now() - interval '8 days', data_hora_atualizacao_compra = '2026-08-06 01:10:04+00'
   where id_compra = '16021805900022026';
  update public.precos_itens_contratacao set tem_resultado = null
   where id_compra = '16021805900022026' and numero_item_compra = 67;
  set local role service_role;
  if not exists (select 1 from public.precos_compras_pendentes_contratacao('2025-10-22', 100) where id_compra = '16021805900022026') then
    raise exception 'CHECK FALHOU (P): item sem resultado há mais de 7 dias deveria reabrir a compra';
  end if;
  reset role;
  update public.precos_itens_contratacao set tem_resultado = true
   where id_compra = '16021805900022026' and numero_item_compra = 67;
  set local role service_role;
  if exists (select 1 from public.precos_compras_pendentes_contratacao('2025-10-22', 100) where id_compra = '16021805900022026') then
    raise exception 'CHECK FALHOU (P): compra com todos os itens com resultado não deveria reabrir';
  end if;
  if (select count(*) from public.precos_compras_pendentes_contratacao('2026-12-01', 100)) <> 0 then
    raise exception 'CHECK FALHOU (P): p_desde no futuro deveria dar 0';
  end if;
  raise notice 'CASO P ok';

  raise notice 'SUCESSO: precos_itens_contratacao_check';
end $$;

reset role;

rollback;
