-- Checagem do histórico do PCA (migration 20261010100000).
-- Falha com EXCEPTION se:
--   ACL   public.pca_historico_orgao_ano(text[],int,int) ou private.catalogo_classes_efetivas() ficarem executáveis por
--         anon/authenticated/PUBLIC, ou service_role perder o EXECUTE; ou se a view antiga ainda existir;
--   CLS   catalogo_classes_efetivas deixar de trazer a classe herdada do grupo ou a do PDM reincluído em classe
--         excluída, ou trouxer classe só por item avulso ou classe excluída sem PDM incluído;
--   HIST  o plano com itens em duas classes pedidas contar duas vezes, ou item de classe não pedida entrar;
--   CMP   republicação do PNCP contar duas vezes, ou categoria fora do escopo contar como compra;
--   EXE   execução confirmada (pca_plano_id + pca_link_evidencia) contar por classe em vez de por plano, ou o prazo
--         (lag_medio_dias, lag_soma_dias, lag_n) sair diferente do esperado (data da publicação em Brasília);
--   FUSO  publicação de 31/12 às 23h30 em Brasília (já 1º/1 em UTC) cair no ano seguinte;
--   UF    uf vazia do órgão vencer a uf preenchida do mesmo CNPJ.
-- Fixtures fictícias (CNPJs 99000002000101 e 99000003000101, anos 2025/2026/2099, códigos CATMAT 99xx); tudo termina
-- em rollback.

begin;

do $chk$
declare
  v_falhas text[] := array[]::text[];
  v_r record;
  v_classes text[];
  v_plano uuid;
  v_plano_fuso uuid;
begin
  -- ACL
  if to_regclass('public.pca_historico_orgao_ano') is not null then
    v_falhas := v_falhas || 'a view public.pca_historico_orgao_ano ainda existe (virou função)'::text;
  end if;
  for v_r in
    select papel, fn from unnest(array['anon', 'authenticated', 'public']) papel
     cross join unnest(array[
       'public.pca_historico_orgao_ano(text[],integer,integer)',
       'private.catalogo_classes_efetivas()']) fn
     where has_function_privilege(papel, fn, 'EXECUTE')
  loop
    v_falhas := v_falhas || format('%s executa %s', v_r.papel, v_r.fn);
  end loop;
  if not has_function_privilege('service_role', 'public.pca_historico_orgao_ano(text[],integer,integer)', 'EXECUTE')
     or not has_function_privilege('service_role', 'private.catalogo_classes_efetivas()', 'EXECUTE') then
    v_falhas := v_falhas || 'service_role sem EXECUTE no histórico ou nas classes do catálogo'::text;
  end if;

  -- CLS: grupo 99 incluído com a classe 9910 excluída, mas um PDM dela incluído de volta; classe 9920 herda o grupo
  -- (sem regra própria nem PDM); classe 9930 só tem um item avulso incluído (grupo 98 sem regra); classe 9940
  -- excluída sem nada incluído.
  insert into public.catmat_grupos (codigo_grupo, nome, payload_hash) values (99, 'CHK GRUPO', 'chk'), (98, 'CHK GRUPO 98', 'chk')
    on conflict (codigo_grupo) do nothing;
  insert into public.catmat_classes (codigo_grupo, codigo_classe, nome, payload_hash)
    values (99, 9910, 'CHK 9910', 'chk'), (99, 9920, 'CHK 9920', 'chk'), (99, 9940, 'CHK 9940', 'chk'),
           (98, 9930, 'CHK 9930', 'chk')
    on conflict (codigo_grupo, codigo_classe) do nothing;
  insert into public.catmat_pdms (codigo_pdm, codigo_grupo, codigo_classe, nome_pdm, payload_hash)
    values (99101, 99, 9910, 'CHK PDM 9910 A', 'chk'), (99102, 99, 9910, 'CHK PDM 9910 B', 'chk'),
           (99401, 99, 9940, 'CHK PDM 9940', 'chk'), (99301, 98, 9930, 'CHK PDM 9930', 'chk')
    on conflict (codigo_pdm) do nothing;
  insert into public.catalogo_empresa_catmat (nivel, codigo_grupo, codigo_classe, codigo_pdm, codigo_item, nome_snapshot, incluido)
    values ('grupo', 99, null, null, null, 'CHK GRUPO', true),
           ('classe', 99, 9910, null, null, 'CHK 9910', false),
           ('pdm', 99, 9910, 99101, null, 'CHK PDM 9910 A', true),
           ('classe', 99, 9940, null, null, 'CHK 9940', false),
           ('item', 98, 9930, 99301, 9930001, 'CHK ITEM 9930', true)
    on conflict do nothing;
  v_classes := private.catalogo_classes_efetivas();
  if not ('9910' = any(v_classes)) then
    v_falhas := v_falhas || format('PDM reincluído na classe excluída 9910 não trouxe a classe: %s', v_classes);
  end if;
  if not ('9920' = any(v_classes)) then
    v_falhas := v_falhas || format('classe 9920 herdada do grupo ficou de fora: %s', v_classes);
  end if;
  if '9930' = any(v_classes) then
    v_falhas := v_falhas || 'classe 9930 entrou só por item avulso (item casa só por código, não expande)'::text;
  end if;
  if '9940' = any(v_classes) then
    v_falhas := v_falhas || 'classe 9940 excluída sem PDM incluído entrou nas classes efetivas'::text;
  end if;

  -- UF: o mesmo CNPJ com uf vazia e uf preenchida; a preenchida vence.
  insert into public.orgaos (codigo_orgao, compras_raw, compras_payload_hash, cnpj, nome_orgao, uf, ativo) values
    (999990101, '{}'::jsonb, 'chk', '99000002000101', 'CHK ORGAO HIST', '', true),
    (999990102, '{}'::jsonb, 'chk', '99.000.002/0001-01', 'CHK ORGAO HIST', 'SP', true);

  -- HIST: um plano com itens 9910 e 9920 (prevista 01/03/2099), um item 9940 (não pedido) e um inativo
  insert into public.pca_planos (id_pca_pncp, ano_exercicio, orgao_cnpj, titulo, payload_hash, ativo, unidade_codigo)
    values ('CHK-HIST-1', 2099, '99000002000101', 'chk', 'chk', true, '999002')
    returning id into v_plano;
  insert into public.pca_itens (pca_plano_id, numero_item, classe_material_servico, payload_hash, ativo, valor_total_estimado,
                                data_prevista_contratacao)
    values (v_plano, 1, '9910', 'chk', true, 100, '2099-03-01'), (v_plano, 2, '9920', 'chk', true, 50, '2099-03-01'),
           (v_plano, 3, '9940', 'chk', true, 1000, '2099-03-01'), (v_plano, 4, '9910', 'chk', false, 7, '2099-03-01');

  -- CMP: a mesma compra publicada duas vezes no PNCP (mesmo CNPJ, processo e edital), no escopo; outra fora do escopo.
  -- EXE: compra fora do escopo ligada ao plano com evidência, publicada em 11/03/2099 às 23h30 em Brasília (já 12/03
  -- em UTC): 10 dias depois da prevista. A outra evidência do plano é posterior e não entra no prazo.
  insert into public.licitacoes_externas (fonte, codigo_externo, orgao_cnpj, orgao_nome, numero_processo, numero_edital,
      objeto, data_fim, data_publicacao, valor_total, prioridade, raw, pca_plano_id, pca_link_evidencia)
  values
    ('pncp', 'CHK-HIST-C1', '99000002000101', 'CHK ORGAO HIST', '0001/2099', 'PE 1/2099',
     'Aquisição de equipamentos de musculação', '2099-05-20 09:00-03', '2099-05-10 09:00-03', 1000, 'leads', '{}'::jsonb, null, null),
    ('pncp', 'CHK-HIST-C2', '99000002000101', 'CHK ORGAO HIST', '0001/2099', 'PE 1/2099',
     'Aquisição de equipamentos de musculação', '2099-05-20 09:00-03', '2099-05-12 09:00-03', 1000, 'leads', '{}'::jsonb, null, null),
    ('pncp', 'CHK-HIST-FORA', '99000002000101', 'CHK ORGAO HIST', '0002/2099', 'PE 2/2099',
     'Aquisição de material de escritório', '2099-06-20 09:00-03', '2099-06-10 09:00-03', 999, 'leads', '{}'::jsonb, null, null),
    ('pncp', 'CHK-HIST-EXE', '99000002000101', 'CHK ORGAO HIST', '0003/2099', 'PE 3/2099',
     'Aquisição de material de escritório', '2099-03-20 09:00-03', '2099-03-11 23:30-03', 500, 'leads', '{}'::jsonb,
     v_plano, 'codigo_item:chk'),
    ('pncp', 'CHK-HIST-EXE2', '99000002000101', 'CHK ORGAO HIST', '0004/2099', 'PE 4/2099',
     'Aquisição de material de escritório', '2099-04-20 09:00-03', '2099-04-11 09:00-03', 500, 'leads', '{}'::jsonb,
     v_plano, 'codigo_item:chk');

  select * into v_r from public.pca_historico_orgao_ano(array['9910', '9920'], 2099, 2099)
   where orgao_cnpj = '99000002000101';
  if v_r is null then
    v_falhas := v_falhas || 'histórico não devolveu o CNPJ de teste'::text;
  else
    if v_r.planos <> 1 then
      v_falhas := v_falhas || format('plano com duas classes contou %s vezes', v_r.planos);
    end if;
    if v_r.itens <> 2 or v_r.valor_planejado <> 150 then
      v_falhas := v_falhas || format('itens/valor errados: %s itens, %s (esperado 2 e 150)', v_r.itens, v_r.valor_planejado);
    end if;
    if v_r.classes_presentes <> array['9910', '9920'] then
      v_falhas := v_falhas || format('classes_presentes %s (esperado {9910,9920})', v_r.classes_presentes);
    end if;
    if v_r.unidades <> array['999002'] then
      v_falhas := v_falhas || format('unidades %s (esperado {999002})', v_r.unidades);
    end if;
    if v_r.compras_escopo_observadas <> 1 or v_r.valor_escopo_observado is distinct from 1000::numeric then
      v_falhas := v_falhas || format('compras no escopo %s / %s (esperado 1 / 1000: republicação conta uma vez, fora do escopo não conta)',
        v_r.compras_escopo_observadas, v_r.valor_escopo_observado);
    end if;
    if v_r.execucoes_confirmadas <> 1 then
      v_falhas := v_falhas || format('execucoes_confirmadas %s (esperado 1 com itens em duas classes)', v_r.execucoes_confirmadas);
    end if;
    if v_r.lag_medio_dias is distinct from 10::numeric or v_r.lag_soma_dias is distinct from 20::numeric or v_r.lag_n <> 2 then
      v_falhas := v_falhas || format('prazo %s / %s / %s (esperado média 10, soma 20, 2 itens)',
        v_r.lag_medio_dias, v_r.lag_soma_dias, v_r.lag_n);
    end if;
    if v_r.uf <> 'SP' then
      v_falhas := v_falhas || format('uf %s (esperado SP: uf vazia não vence a preenchida)', v_r.uf);
    end if;
  end if;
  if exists (select 1 from public.pca_historico_orgao_ano(array['9930'], 2099, 2099) where orgao_cnpj = '99000002000101') then
    v_falhas := v_falhas || 'histórico devolveu órgão sem item da classe pedida'::text;
  end if;

  -- FUSO: planos em 2025 e 2026; compra no escopo publicada em 31/12/2025 23h30 em Brasília (01/01/2026 02h30 UTC).
  insert into public.pca_planos (id_pca_pncp, ano_exercicio, orgao_cnpj, titulo, payload_hash, ativo)
    values ('CHK-HIST-FUSO-25', 2025, '99000003000101', 'chk', 'chk', true)
    returning id into v_plano_fuso;
  insert into public.pca_itens (pca_plano_id, numero_item, classe_material_servico, payload_hash, ativo, valor_total_estimado)
    values (v_plano_fuso, 1, '9910', 'chk', true, 10);
  insert into public.pca_planos (id_pca_pncp, ano_exercicio, orgao_cnpj, titulo, payload_hash, ativo)
    values ('CHK-HIST-FUSO-26', 2026, '99000003000101', 'chk', 'chk', true)
    returning id into v_plano_fuso;
  insert into public.pca_itens (pca_plano_id, numero_item, classe_material_servico, payload_hash, ativo, valor_total_estimado)
    values (v_plano_fuso, 1, '9910', 'chk', true, 10);
  insert into public.licitacoes_externas (fonte, codigo_externo, orgao_cnpj, orgao_nome, numero_processo, numero_edital,
      objeto, data_fim, data_publicacao, valor_total, prioridade, raw)
  values ('pncp', 'CHK-HIST-FUSO', '99000003000101', 'CHK ORGAO FUSO', '0001/2025', 'PE 1/2025',
          'Aquisição de equipamentos de musculação', '2026-01-20 09:00-03', '2025-12-31T23:30:00-03:00', 10, 'leads', '{}'::jsonb);
  if (select count(*) from public.pca_historico_orgao_ano(array['9910'], 2025, 2026) where orgao_cnpj = '99000003000101') <> 2 then
    v_falhas := v_falhas || 'histórico do caso de fuso não devolveu 2025 e 2026'::text;
  end if;
  for v_r in
    select ano_exercicio, compras_escopo_observadas
      from public.pca_historico_orgao_ano(array['9910'], 2025, 2026)
     where orgao_cnpj = '99000003000101'
  loop
    if v_r.ano_exercicio = 2025 and v_r.compras_escopo_observadas <> 1 then
      v_falhas := v_falhas || format('compra de 31/12/2025 23h30 (Brasília) não contou em 2025 (%s)', v_r.compras_escopo_observadas);
    end if;
    if v_r.ano_exercicio = 2026 and v_r.compras_escopo_observadas <> 0 then
      v_falhas := v_falhas || format('compra de 31/12/2025 23h30 (Brasília) contou em 2026 (%s)', v_r.compras_escopo_observadas);
    end if;
  end loop;

  if array_length(v_falhas, 1) > 0 then
    raise exception 'pca_historico_orgao_ano_check FALHOU: %', array_to_string(v_falhas, '; ');
  end if;
  raise notice 'SUCESSO: pca_historico_orgao_ano_check';
end
$chk$;

rollback;
