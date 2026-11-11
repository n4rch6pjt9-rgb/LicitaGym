-- Spec specs/0057-pgc-no-radar-pca.md, K-2 (CA-3 e CA-4): índice em orgaos(cnpj) e campos de retorno do PGC no radar.
-- Falha com EXCEPTION se:
--   CA-3 A) anon ou authenticated puderem ler public.v_bi_pca_radar, ou service_role não puder;
--   CA-3 B) não existir índice btree simples em public.orgaos (cnpj);
--   CA-4 C) o item do PGC não sair uma vez só, com titulo_projeto, objeto_dfd, unidade_fornecimento,
--           data_inicio_processo, data_formalizacao_demanda, nome_pdm e status_execucao_codigo como gravados;
--   CA-4 D) o item que está no PNCP e no PGC não sair uma vez só, com fonte 'pgc' (regra atual: o PGC prevalece);
--   CA-4 E) o item só do PNCP não sair com os campos que o PNCP não tem como nulos (nada derivado);
--   CA-4 F) mes_inicio_processo não refletir data_inicio_processo.
-- Fixtures fictícias (grupo 99, PDM 999957, CNPJ 99000057000100, ano 2099); termina em rollback.
-- "Gravado duas vezes com DFDs diferentes" (CA-4) não chega à view: a unicidade vem de uq_pca_pgc_item (mesma chave do
-- upsert) e da deduplicação do coletor (pytest test_compras_pgc.py, CA-1). Aqui basta uma linha por chave.
-- Saída esperada: "SUCESSO: pca_radar_pgc_campos_check".

begin;

do $chk$
declare
  v_plano uuid;
  n int;
  r record;
begin
  -- CA-3 A
  if has_table_privilege('anon', 'public.v_bi_pca_radar', 'select')
     or has_table_privilege('authenticated', 'public.v_bi_pca_radar', 'select') then
    raise exception 'pca_radar_pgc_campos_check CA-3 A: anon/authenticated não podem ler v_bi_pca_radar';
  end if;
  if not has_table_privilege('service_role', 'public.v_bi_pca_radar', 'select') then
    raise exception 'pca_radar_pgc_campos_check CA-3 A: service_role precisa ler v_bi_pca_radar';
  end if;

  -- CA-3 B
  if not exists (
    select 1 from pg_indexes
     where schemaname = 'public' and tablename = 'orgaos'
       and indexdef ~* 'USING btree \(cnpj\)$'
  ) then
    raise exception 'pca_radar_pgc_campos_check CA-3 B: falta índice btree em public.orgaos (cnpj)';
  end if;

  insert into public.catmat_grupos (codigo_grupo, nome, status, payload_hash) values (99, 'CHK GRUPO', true, 'chk');
  insert into public.catmat_classes (codigo_grupo, codigo_classe, nome, status, payload_hash)
    values (99, 9957, 'CHK CLASSE', true, 'chk');
  insert into public.catmat_pdms (codigo_pdm, codigo_grupo, codigo_classe, nome_pdm, status, payload_hash)
    values (999957, 99, 9957, 'CHK PDM CATALOGO', true, 'chk');
  insert into public.catalogo_empresa_catmat (nivel, codigo_grupo, codigo_classe, codigo_pdm, nome_snapshot)
    values ('pdm', 99, 9957, 999957, 'CHK PDM');

  -- Item só do PGC (numero 10) e item que está nos dois (numero 11)
  insert into public.pca_pgc_itens (codigo_uasg, nome_uasg, orgao_cnpj, ano_pca_projeto_compra, numero_item_pncp,
      codigo_item_catalogo, descricao_item_catalogo, codigo_pdm_material, nome_pdm_material, codigo_classe_material,
      nome_classe_material, sigla_unidade_fornecimento, quantidade_item, valor_unitario_item, valor_total_item,
      titulo_projeto_compra, descricao_projeto_compra, descricao_objeto_dfd, descricao_artefato,
      data_prevista_formalizacao_demanda, data_inicio_processo_compra, data_fim_processo_compra,
      duracao_processo_compra, status_contratacao_execucao, data_hora_atualizacao_item, payload_hash)
  values
    ('999957', 'CHK UASG', '99000057000100', 2099, 10, 999957001, 'CHK PISO', '999957', 'CHK PDM PGC', 9957,
     'CHK CLASSE PGC', 'M2', 20, 41, 820, 'Aquisição de Piso Sintético', 'Compra de piso', 'Piso sintético (DFD)',
     '25/2099', '2099-04-30', '2099-11-18', '2099-12-16', 28, '11', '2099-05-09 10:08:00', 'chk'),
    ('999957', 'CHK UASG', '99000057000100', 2099, 11, 999957002, 'CHK PISO 2', '999957', 'CHK PDM PGC', 9957,
     'CHK CLASSE PGC', 'UN', 1, 100, 100, 'Projeto 2', null, 'DFD 2', '25/2099', '2099-05-01', null, null, null,
     null, '2099-05-09 10:08:00', 'chk');

  insert into public.pca_planos (id_pca_pncp, ano_exercicio, orgao_cnpj, unidade_codigo, titulo, payload_hash, ativo)
    values ('CHK-0057', 2099, '99000057000100', '999957', 'CHK PLANO', 'chk', true)
    returning id into v_plano;
  insert into public.pca_itens (pca_plano_id, numero_item, pdm_codigo_origem, unidade_medida, quantidade,
                                valor_total_estimado, data_prevista_contratacao, payload_hash, ativo)
    values (v_plano, 11, '999957', 'Unidade', 1, 100, '2099-06-01', 'chk', true),
           (v_plano, 12, '999957', 'Unidade', 2, 300, '2099-07-01', 'chk', true);

  -- CA-4 C
  select count(*) into n from public.v_bi_pca_radar where orgao_cnpj = '99000057000100' and numero_item_pncp = 10;
  if n <> 1 then
    raise exception 'pca_radar_pgc_campos_check CA-4 C: item do PGC deveria sair 1 vez (saiu %)', n;
  end if;
  select * into r from public.v_bi_pca_radar where orgao_cnpj = '99000057000100' and numero_item_pncp = 10;
  if r.fonte <> 'pgc' or r.titulo_projeto is distinct from 'Aquisição de Piso Sintético'
     or r.objeto_dfd is distinct from 'Piso sintético (DFD)' or r.unidade_fornecimento is distinct from 'M2'
     or r.data_inicio_processo is distinct from date '2099-11-18'
     or r.data_fim_processo is distinct from date '2099-12-16' or r.duracao_processo_dias is distinct from 28
     or r.data_formalizacao_demanda is distinct from date '2099-04-30'
     or r.nome_pdm is distinct from 'CHK PDM PGC' or r.nome_classe is distinct from 'CHK CLASSE PGC'
     or r.descricao_projeto is distinct from 'Compra de piso' or r.artefato is distinct from '25/2099'
     or r.status_execucao_codigo is distinct from '11' or r.atualizado_na_fonte_em is null then
    raise exception 'pca_radar_pgc_campos_check CA-4 C: campos do PGC divergentes: %', to_jsonb(r);
  end if;

  -- CA-4 F
  if r.mes_inicio_processo is distinct from '2099-11' then
    raise exception 'pca_radar_pgc_campos_check CA-4 F: mes_inicio_processo deveria ser 2099-11 (veio %)',
      r.mes_inicio_processo;
  end if;

  -- CA-4 D
  select count(*) into n from public.v_bi_pca_radar where orgao_cnpj = '99000057000100' and numero_item_pncp = 11;
  if n <> 1 then
    raise exception 'pca_radar_pgc_campos_check CA-4 D: item nos dois deveria sair 1 vez (saiu %)', n;
  end if;
  select * into r from public.v_bi_pca_radar where orgao_cnpj = '99000057000100' and numero_item_pncp = 11;
  if r.fonte <> 'pgc' then
    raise exception 'pca_radar_pgc_campos_check CA-4 D: o PGC prevalece (veio fonte %)', r.fonte;
  end if;

  -- CA-4 E
  select * into r from public.v_bi_pca_radar where orgao_cnpj = '99000057000100' and numero_item_pncp = 12;
  if r.fonte <> 'pncp' or r.unidade_fornecimento is distinct from 'Unidade'
     or r.nome_pdm is distinct from 'CHK PDM CATALOGO'
     or r.titulo_projeto is not null or r.objeto_dfd is not null or r.data_inicio_processo is not null
     or r.data_formalizacao_demanda is not null or r.status_execucao_codigo is not null
     or r.mes_inicio_processo is not null then
    raise exception 'pca_radar_pgc_campos_check CA-4 E: item do PNCP com campo derivado ou ausente: %', to_jsonb(r);
  end if;

  raise notice 'SUCESSO: pca_radar_pgc_campos_check';
end
$chk$;

rollback;
