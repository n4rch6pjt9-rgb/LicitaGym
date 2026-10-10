-- Checagem do histórico do PCA (migration 20261010100000).
-- Falha com EXCEPTION se:
--   ACL   public.pca_historico_orgao_ano(text[],int,int) ou private.catalogo_classes_efetivas() ficarem executáveis por
--         anon/authenticated/PUBLIC, ou service_role perder o EXECUTE; ou se a view antiga ainda existir;
--   CLS   catalogo_classes_efetivas não juntar as classes dos PDMs efetivos e dos itens incluídos, ou deixar entrar
--         classe excluída sem nada incluído;
--   HIST  o plano com itens em duas classes pedidas contar duas vezes, ou item de classe não pedida entrar.
-- Fixtures fictícias (CNPJ 99000002000101, ano 2099, códigos CATMAT 99xx); tudo termina em rollback.

begin;

do $chk$
declare
  v_falhas text[] := array[]::text[];
  v_r record;
  v_classes text[];
  v_plano uuid;
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

  -- CLS: grupo 99 incluído com a classe 9910 excluída, mas um PDM dela incluído de volta; classe 9920 herda o grupo;
  -- classe 9930 só entra por um item incluído; classe 9940 excluída sem nada incluído.
  insert into public.catmat_grupos (codigo_grupo, nome, payload_hash) values (99, 'CHK GRUPO', 'chk')
    on conflict (codigo_grupo) do nothing;
  insert into public.catmat_classes (codigo_grupo, codigo_classe, nome, payload_hash)
    values (99, 9910, 'CHK 9910', 'chk'), (99, 9920, 'CHK 9920', 'chk'), (99, 9940, 'CHK 9940', 'chk')
    on conflict (codigo_grupo, codigo_classe) do nothing;
  insert into public.catmat_pdms (codigo_pdm, codigo_grupo, codigo_classe, nome_pdm, payload_hash)
    values (99101, 99, 9910, 'CHK PDM 9910 A', 'chk'), (99102, 99, 9910, 'CHK PDM 9910 B', 'chk'),
           (99201, 99, 9920, 'CHK PDM 9920', 'chk'), (99401, 99, 9940, 'CHK PDM 9940', 'chk')
    on conflict (codigo_pdm) do nothing;
  insert into public.catalogo_empresa_catmat (nivel, codigo_grupo, codigo_classe, codigo_pdm, codigo_item, nome_snapshot, incluido)
    values ('grupo', 99, null, null, null, 'CHK GRUPO', true),
           ('classe', 99, 9910, null, null, 'CHK 9910', false),
           ('pdm', 99, 9910, 99101, null, 'CHK PDM 9910 A', true),
           ('classe', 99, 9940, null, null, 'CHK 9940', false),
           ('item', 98, 9930, 99301, 9930001, 'CHK ITEM 9930', true)
    on conflict do nothing;
  v_classes := private.catalogo_classes_efetivas();
  if not (v_classes @> array['9910', '9920', '9930']) then
    v_falhas := v_falhas || format('classes efetivas sem 9910/9920/9930: %s', v_classes);
  end if;
  if '9940' = any(v_classes) then
    v_falhas := v_falhas || 'classe 9940 excluída sem nada incluído entrou nas classes efetivas'::text;
  end if;

  -- HIST: um plano com itens 9910 e 9920 e um item 9940 (não pedido)
  insert into public.pca_planos (id_pca_pncp, ano_exercicio, orgao_cnpj, titulo, payload_hash, ativo, unidade_codigo)
    values ('CHK-HIST-1', 2099, '99000002000101', 'chk', 'chk', true, '999002')
    returning id into v_plano;
  insert into public.pca_itens (pca_plano_id, numero_item, classe_material_servico, payload_hash, ativo, valor_total_estimado)
    values (v_plano, 1, '9910', 'chk', true, 100), (v_plano, 2, '9920', 'chk', true, 50),
           (v_plano, 3, '9940', 'chk', true, 1000), (v_plano, 4, '9910', 'chk', false, 7);
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
  end if;
  if exists (select 1 from public.pca_historico_orgao_ano(array['9930'], 2099, 2099) where orgao_cnpj = '99000002000101') then
    v_falhas := v_falhas || 'histórico devolveu órgão sem item da classe pedida'::text;
  end if;

  if array_length(v_falhas, 1) > 0 then
    raise exception 'pca_historico_orgao_ano_check FALHOU: %', array_to_string(v_falhas, '; ');
  end if;
  raise notice 'SUCESSO: pca_historico_orgao_ano_check';
end
$chk$;

rollback;
