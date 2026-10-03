-- =============================================================================
-- Casos sintéticos da migration 20261003010000_licitacoes_pncp_canonica (banco LOCAL de teste).
--
-- Dados 100% fictícios (CNPJs 00000000000xxx, órgãos "ÓRGÃO FICTÍCIO ..."). Tudo dentro de
-- begin; ... rollback; e com trava: aborta se licitacoes_externas tiver mais de 100 linhas (produção).
--
-- Casos:
--   A  republicação com prazo novo              -> canônica = maior data_fim (A2), mesmo sendo a 2ª
--   B  mesmo prazo; a mais recente sem valores  -> canônica = a com itens valorados (B1)
--   C  empate até valor_total                   -> canônica = data_publicacao mais recente (C2)
--   D  grupo de 3, uma sem valor_total          -> canônica = valor_total preenchido + mais recente (D2); n_publicacoes = 3
--   E  mais resultados                          -> canônica = E2 (2 resultados) apesar de E1 mais recente
--   F  empate absoluto                          -> canônica = menor id
--   N  processo/edital NULL                     -> nunca agrupa (as duas canônicas)
--   S  fonte não PNCP com a mesma chave         -> nunca agrupa
--   H  compra homologada republicada (BI)       -> v_bi_resultados_itens, v_bi_orgaos_match, v_bi_fornecedor_historico
--                                                  e oportunidades_borracha contam uma vez; a ponte Compras.gov da
--                                                  linha NÃO canônica aponta para o número de controle da canônica
--   O  Oportunidades: a view de prioridade expõe eh_canonica igual à da view canônica
-- Saída esperada: NOTICE "CASO ..." por caso e "SUCESSO: licitacoes_pncp_canonica_fixtures_check".
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

-- Catálogo mínimo para o recorte do BI (PDM 2640 / item 480144), fontes e fornecedor fictício.
insert into public.catmat_grupos (codigo_grupo, nome, payload_hash) values (78, 'EQUIPAMENTO PARA GINÁSTICA', 'hash_g78')
  on conflict (codigo_grupo) do nothing;
insert into public.catmat_classes (codigo_grupo, codigo_classe, nome, payload_hash) values (78, 7830, 'EQUIPAMENTO GINÁSTICA', 'hash_c7830')
  on conflict (codigo_grupo, codigo_classe) do nothing;
insert into public.catmat_pdms (codigo_pdm, codigo_grupo, codigo_classe, nome_pdm, payload_hash)
  values (2640, 78, 7830, 'APARELHO CONDICIONAMENTO FISICO', 'hash_pdm2640') on conflict (codigo_pdm) do nothing;
insert into public.catalogo_empresa_catmat (nivel, codigo_grupo, codigo_classe, codigo_pdm, nome_snapshot, incluido)
  values ('pdm', 78, 7830, 2640, 'APARELHO CONDICIONAMENTO FISICO', true) on conflict do nothing;
insert into public.catmat_itens (codigo_item, codigo_pdm, descricao_item) values (480144, '2640', 'APARELHO MUSCULACAO CROSS OVER')
  on conflict (codigo_item) do nothing;
insert into public.fontes_externas (slug, entidade, plataforma, base_url, modo_coleta) values
  ('pncp', 'PNCP', 'pncp', 'https://pncp.gov.br', 'automatico'),
  ('sestsenat', 'SEST SENAT', 'paradigma', 'https://compras.sestsenat.org.br', 'automatico')
  on conflict (slug) do nothing;
insert into public.fornecedores (cnpj, cnpj_raiz, razao_social, cnae_principal, consulta_status)
  values ('00000000000272', '00000000', 'FORNECEDOR FICTICIO DE TESTE LTDA', 4763602, 'ok') on conflict (cnpj) do nothing;

-- Linhas sintéticas (processo_norm é coluna gerada a partir de numero_processo): (rotulo, fonte, codigo, cnpj, processo, edital, data_fim, data_publicacao, valor_total, prioridade, homologacao)
create temporary table _fx (rotulo text primary key, id bigint) on commit drop;

do $$
declare
  r record;
  v_id bigint;
begin
  for r in
    select * from (values
      ('A1','pncp','00000000000101-1-000001/2026','00000000000101','0001/2026','PE 1/2026','2026-10-05 08:59-03'::timestamptz,'2026-09-17 07:33-03'::timestamptz,1000.00,'leads',null::timestamptz),
      ('A2','pncp','00000000000101-1-000002/2026','00000000000101','0001/2026','PE 1/2026','2026-10-14 12:59-03','2026-10-01 13:08-03',1000.00,'leads',null),
      ('B1','pncp','00000000000102-1-000001/2026','00000000000102','0002/2026','PE 2/2026','2026-09-10 09:00-03','2026-08-28 07:28-03',2000.00,'leads',null),
      ('B2','pncp','00000000000102-1-000002/2026','00000000000102','0002/2026','PE 2/2026','2026-09-10 09:00-03','2026-09-03 16:26-03',2000.00,'leads',null),
      ('C1','pncp','00000000000103-1-000001/2026','00000000000103','0003/2026','PE 3/2026','2026-10-08 08:29-03','2026-09-24 06:56-03',3000.00,'leads',null),
      ('C2','pncp','00000000000103-1-000002/2026','00000000000103','0003/2026','PE 3/2026','2026-10-08 08:29-03','2026-09-24 10:16-03',3000.00,'leads',null),
      ('D1','pncp','00000000000104-1-000001/2026','00000000000104','0004/2026','PE 4/2026','2026-10-08 09:00-03','2026-09-25 05:00-03',4000.00,'leads',null),
      ('D2','pncp','00000000000104-1-000002/2026','00000000000104','0004/2026','PE 4/2026','2026-10-08 09:00-03','2026-09-25 06:00-03',4000.00,'leads',null),
      ('D3','pncp','00000000000104-1-000003/2026','00000000000104','0004/2026','PE 4/2026','2026-10-08 09:00-03','2026-09-25 07:00-03',null,'leads',null),
      ('E1','pncp','00000000000105-1-000001/2026','00000000000105','0005/2026','PE 5/2026','2026-07-28 08:30-03','2026-07-15 08:29-03',5000.00,'historico','2026-09-18 00:00-03'),
      ('E2','pncp','00000000000105-1-000002/2026','00000000000105','0005/2026','PE 5/2026','2026-07-28 08:30-03','2026-07-15 08:02-03',5000.00,'historico','2026-09-18 00:00-03'),
      ('F1','pncp','00000000000106-1-000001/2026','00000000000106','0006/2026','PE 6/2026','2026-10-06 07:00-03','2026-09-23 06:37-03',null,'leads',null),
      ('F2','pncp','00000000000106-1-000002/2026','00000000000106','0006/2026','PE 6/2026','2026-10-06 07:00-03','2026-09-23 06:37-03',null,'leads',null),
      ('N1','pncp','00000000000107-1-000001/2026','00000000000107',null,null,'2026-10-06 07:00-03','2026-09-23 06:00-03',null,'leads',null),
      ('N2','pncp','00000000000107-1-000002/2026','00000000000107',null,null,'2026-10-06 07:00-03','2026-09-23 07:00-03',null,'leads',null),
      ('S1','sestsenat',null,'00000000000108','0008/2026','PE 8/2026','2026-10-06 07:00-03','2026-09-23 06:00-03',null,'leads',null),
      ('S2','sestsenat',null,'00000000000108','0008/2026','PE 8/2026','2026-10-06 07:00-03','2026-09-23 07:00-03',null,'leads',null),
      ('H1','pncp','00000000000109-1-000001/2026','00000000000109','0009/2026','PE 9/2026','2026-08-10 09:00-03','2026-07-20 08:00-03',18000.00,'historico','2026-09-01 00:00-03'),
      ('H2','pncp','00000000000109-1-000002/2026','00000000000109','0009/2026','PE 9/2026','2026-08-10 09:00-03','2026-07-20 09:00-03',18000.00,'historico','2026-09-01 00:00-03')
    ) v(rotulo, fonte, codigo, cnpj, processo, edital, data_fim, data_pub, valor, prioridade, homolog)
  loop
    insert into public.licitacoes_externas (fonte, codigo_externo, orgao_cnpj, orgao_nome, numero_processo,
        numero_edital, objeto, data_fim, data_publicacao, valor_total, prioridade, data_homologacao, interesse_borracha, raw)
    values (r.fonte, r.codigo, r.cnpj, 'ÓRGÃO FICTÍCIO ' || r.rotulo, r.processo, r.edital,
        'Aquisição fictícia de teste ' || left(r.rotulo, 1), r.data_fim, r.data_pub, r.valor, r.prioridade, r.homolog,
        left(r.rotulo, 1) = 'H',
        case when r.rotulo = 'H1' then jsonb_build_object('link_sistema_origem',
          'https://cnetmobile.estaleiro.serpro.gov.br/comprasnet-web/public/compras/acompanhamento-compra?compra=00000000900012026')
          else '{}'::jsonb end)
    returning id into v_id;
    insert into _fx values (r.rotulo, v_id);
  end loop;
end $$;

-- Itens: todos com 1 item valorado, exceto B2 (sem valor) e os do caso H (item do catálogo, material)
insert into public.licitacao_itens (licitacao_id, numero_item, descricao, quantidade, valor_unitario_estimado, valor_total_estimado)
select id, 1, 'ITEM FICTICIO', 10, case when rotulo = 'B2' then 0 else 100 end, case when rotulo = 'B2' then 0 else 1000 end
from _fx where left(rotulo, 1) <> 'H';
insert into public.licitacao_itens (licitacao_id, numero_item, descricao, catalogo_codigo_item, material_ou_servico, quantidade,
    valor_unitario_estimado, valor_total_estimado, interesse_borracha)
select id, 1, 'APARELHO CROSS OVER FICTICIO', '480144', 'M', 2, 9500, 19000, true from _fx where left(rotulo, 1) = 'H';

-- Resultados: E1 tem 1, E2 tem 2; H1 e H2 o mesmo resultado (a republicação repete a homologação)
insert into public.licitacao_resultados (licitacao_id, numero_item, sequencial_resultado, fornecedor_cnpj, fornecedor_nome,
    vencedor, quantidade_homologada, valor_unitario_homologado, valor_total_homologado, data_resultado)
select f.id, 1, s, '00000000000272', 'FORNECEDOR FICTICIO DE TESTE LTDA', s = 1, 10, 90, 900, '2026-09-18'::timestamptz
from _fx f cross join generate_series(1, 2) s
where f.rotulo = 'E2' or (f.rotulo = 'E1' and s = 1);
insert into public.licitacao_resultados (licitacao_id, numero_item, sequencial_resultado, fornecedor_cnpj, fornecedor_nome,
    vencedor, quantidade_homologada, valor_unitario_homologado, valor_total_homologado, data_resultado)
select id, 1, 1, '00000000000272', 'FORNECEDOR FICTICIO DE TESTE LTDA', true, 2, 9000, 18000, '2026-09-01'::timestamptz
from _fx where rotulo in ('H1', 'H2');

-- Pesquisa de preço Compras.gov ligada à linha NÃO canônica (H1) pelo link_sistema_origem
insert into public.precos_praticados_itens (id_compra, id_item_compra, numero_item_compra, codigo_item_catalogo, codigo_pdm,
    ni_fornecedor, nome_fornecedor, preco_unitario, quantidade, marca, data_resultado, codigo_uasg, nome_uasg)
values ('00000000900012026', 9000001, 1, 480144, '2640', '00000000000272', 'FORNECEDOR FICTICIO DE TESTE LTDA', 9000, 2,
    'MARCA FICTICIA', '2026-09-01'::date, '999002', 'UASG FICTICIA DE TESTE');

do $$
declare
  falhas text[] := '{}';
  v record;
  esperado record;
  v_n int;
  v_valor numeric;
  v_certames int;
  v_vendas int;
  canon_de jsonb;
begin
  select jsonb_object_agg(f.rotulo, (select fc.rotulo from _fx fc where fc.id = c.canonica_id))
    into canon_de
  from _fx f join public.licitacoes_pncp_canonica c on c.id = f.id;

  for esperado in
    select * from (values
      ('A1','A2'),('A2','A2'),('B1','B1'),('B2','B1'),('C1','C2'),('C2','C2'),('D1','D2'),('D2','D2'),('D3','D2'),
      ('E1','E2'),('E2','E2'),('F1','F1'),('F2','F1'),('N1','N1'),('N2','N2'),('S1','S1'),('S2','S2'),('H1','H2'),('H2','H2')
    ) x(rotulo, canonica)
  loop
    if canon_de ->> esperado.rotulo is distinct from esperado.canonica then
      falhas := falhas || format('%s: canônica esperada %s, atual %s', esperado.rotulo, esperado.canonica, canon_de ->> esperado.rotulo);
    end if;
  end loop;
  raise notice 'CASO canônicas: %', canon_de;

  -- D: n_publicacoes = 3; fora de grupo = 1
  select c.n_publicacoes into v_n from _fx f join public.licitacoes_pncp_canonica c on c.id = f.id where f.rotulo = 'D3';
  if v_n is distinct from 3 then falhas := falhas || format('D3 n_publicacoes esperado 3, atual %s', v_n); end if;
  select c.n_publicacoes into v_n from _fx f join public.licitacoes_pncp_canonica c on c.id = f.id where f.rotulo = 'N1';
  if v_n is distinct from 1 then falhas := falhas || format('N1 n_publicacoes esperado 1, atual %s', v_n); end if;

  -- O: a view de Oportunidades expõe o mesmo flag; não perde linha
  select count(*) into v_n from _fx f
    join public.licitacoes_externas_prioridade_efetiva p on p.id = f.id
    join public.licitacoes_pncp_canonica c on c.id = f.id
   where p.canonica_id = c.canonica_id and p.eh_canonica = c.eh_canonica;
  if v_n <> (select count(*) from _fx) then falhas := falhas || format('prioridade_efetiva: %s de %s linhas com o flag igual', v_n, (select count(*) from _fx)); end if;
  select count(*) into v_n from _fx f join public.licitacoes_externas_prioridade_efetiva p on p.id = f.id
   where p.eh_canonica and (p.prioridade is null or p.prioridade <> 'historico');
  raise notice 'CASO Oportunidades: % linhas canônicas fora de historico (esperado 9: A2,B1,C2,D2,F1,N1,N2,S1,S2)', v_n;
  if v_n <> 9 then falhas := falhas || format('Oportunidades: esperado 9 canônicas fora de historico, atual %s', v_n); end if;

  -- H: BI conta uma vez
  select count(*), sum(valor_total_homologado) into v_n, v_valor from public.v_bi_resultados_itens
   where licitacao_id in (select id from _fx where rotulo in ('H1', 'H2'));
  raise notice 'CASO H v_bi_resultados_itens: % linha(s), valor %', v_n, v_valor;
  if v_n <> 1 or v_valor <> 18000 then falhas := falhas || format('v_bi_resultados_itens H: %s linhas / %s', v_n, v_valor); end if;
  if exists (select 1 from public.v_bi_resultados_itens where licitacao_id = (select id from _fx where rotulo = 'H1')) then
    falhas := falhas || 'v_bi_resultados_itens trouxe a não canônica H1'::text;
  end if;
  select count(*) into v_n from public.v_bi_resultados_itens where licitacao_id in (select id from _fx where rotulo in ('E1','E2'));
  if v_n <> 2 then falhas := falhas || format('v_bi_resultados_itens E: esperado 2 (só E2), atual %s', v_n); end if;

  select o.valor_homologado, o.qtd_itens_homologados into v_valor, v_n from public.v_bi_orgaos_match o where o.orgao_cnpj = '00000000000109';
  raise notice 'CASO H v_bi_orgaos_match: valor_homologado %, itens %', v_valor, v_n;
  if v_valor is distinct from 18000 or v_n is distinct from 1 then
    falhas := falhas || format('v_bi_orgaos_match H: valor %s itens %s (esperado 18000 / 1)', v_valor, v_n);
  end if;

  select h.total_vendas_homologadas, h.total_certames into v_vendas, v_certames
    from public.v_bi_fornecedor_historico h where h.cnpj = '00000000000272';
  raise notice 'CASO H v_bi_fornecedor_historico: total_vendas_homologadas = %, total_certames = %', v_vendas, v_certames;
  -- E2 (historico) também tem resultados mas sem item do catálogo: fica fora do recorte do BI
  if v_vendas is distinct from 1 or v_certames is distinct from 1 then
    falhas := falhas || format('v_bi_fornecedor_historico: vendas %s certames %s (esperado 1 / 1: H2 + pesquisa de preço da ponte)', v_vendas, v_certames);
  end if;

  select count(*) into v_n from public.oportunidades_borracha where licitacao_id in (select id from _fx where rotulo in ('H1', 'H2'));
  raise notice 'CASO H oportunidades_borracha: % linha(s)', v_n;
  if v_n <> 1 then falhas := falhas || format('oportunidades_borracha H: esperado 1 linha (H2), atual %s', v_n); end if;

  if array_length(falhas, 1) > 0 then
    raise exception 'licitacoes_pncp_canonica_fixtures_check FALHOU: %', array_to_string(falhas, ' | ');
  end if;
  raise notice 'SUCESSO: licitacoes_pncp_canonica_fixtures_check';
end $$;

rollback;
