-- Regressão: v_bi_pca_radar multiplicava cada item pelo número de linhas de public.orgaos com o mesmo CNPJ
-- (orgaos tem uma linha por unidade/UASG; 250 CNPJs repetidos, até 9x, em 09/10/2026). Em produção, os itens de 2026
-- a partir de outubro apareciam 2.120 vezes para 1.524 itens reais (+39%) e o valor somava R$ 118,9 mi para R$ 89,3 mi.
-- Falha com EXCEPTION se um item do PNCP ou do PGC aparecer mais de uma vez quando o órgão tem várias linhas em orgaos,
-- ou se o nome do órgão deixar de vir de orgaos quando o plano não tem título.
-- Fixtures fictícias (grupo 99, PDM 999901, CNPJ 99000001000101, ano 2099); termina em rollback.

begin;

do $chk$
declare
  v_pncp int;
  v_pgc int;
  v_nome text;
  v_plano uuid;
begin
  insert into public.catmat_grupos (codigo_grupo, nome, status, payload_hash) values (99, 'CHK GRUPO', true, 'chk');
  insert into public.catmat_classes (codigo_grupo, codigo_classe, nome, status, payload_hash) values (99, 9901, 'CHK CLASSE', true, 'chk');
  insert into public.catmat_pdms (codigo_pdm, codigo_grupo, codigo_classe, nome_pdm, status, payload_hash)
    values (999901, 99, 9901, 'CHK PDM', true, 'chk');
  insert into public.catalogo_empresa_catmat (nivel, codigo_grupo, codigo_classe, codigo_pdm, nome_snapshot)
    values ('pdm', 99, 9901, 999901, 'CHK PDM');

  -- Três linhas em orgaos para o mesmo CNPJ (como as unidades de um órgão federal); só uma tem nome
  insert into public.orgaos (codigo_orgao, compras_raw, compras_payload_hash, cnpj, nome_orgao) values
    (999990011, '{}'::jsonb, 'chk', '99000001000101', null),
    (999990012, '{}'::jsonb, 'chk', '99000001000101', 'CHK ORGAO COM NOME'),
    (999990013, '{}'::jsonb, 'chk', '99000001000101', null);

  insert into public.pca_planos (id_pca_pncp, ano_exercicio, orgao_cnpj, unidade_codigo, titulo, payload_hash, ativo)
    values ('CHK-RADAR-DUP', 2099, '99000001000101', '999999', null, 'chk', true)
    returning id into v_plano;
  insert into public.pca_itens (pca_plano_id, numero_item, pdm_codigo_origem, valor_total_estimado,
                                data_prevista_contratacao, payload_hash, ativo)
    values (v_plano, 1, '999901', 125000, '2099-10-01', 'chk', true);
  insert into public.pca_pgc_itens (codigo_uasg, orgao_cnpj, ano_pca_projeto_compra, codigo_pdm_material, valor_total_item)
    values ('888888', '99000001000101', 2099, '999901', 5000);

  select count(*) filter (where fonte = 'pncp'), count(*) filter (where fonte = 'pgc'),
         max(orgao_nome) filter (where fonte = 'pncp')
    into v_pncp, v_pgc, v_nome
    from public.v_bi_pca_radar
   where ano_pca = 2099 and orgao_cnpj = '99000001000101';

  if v_pncp <> 1 or v_pgc <> 1 then
    raise exception 'pca_radar_orgaos_duplicado_check: item repetido pelo join com orgaos (pncp=%, pgc=%, esperado 1 e 1)',
      v_pncp, v_pgc;
  end if;
  if v_nome is distinct from 'CHK ORGAO COM NOME' then
    raise exception 'pca_radar_orgaos_duplicado_check: nome do órgão esperado de orgaos, veio %', coalesce(v_nome, 'NULL');
  end if;
  raise notice 'SUCESSO: pca_radar_orgaos_duplicado_check: um item por linha mesmo com várias linhas em orgaos';
end $chk$;

rollback;
