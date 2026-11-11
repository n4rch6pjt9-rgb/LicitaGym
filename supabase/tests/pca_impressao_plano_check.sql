-- Checagem da spec 0056 (PCA em camadas), contrato K-1 e a regra de eventos do K-4. Falha com EXCEPTION se:
--   ACL   private.pca_impressao_plano ou private.pca_impressao_orgao ficarem sem RLS, legíveis ou graváveis por
--         anon/authenticated, ou sem leitura e escrita para service_role (CA-1);
--   COL   faltar coluna nova em pca_alteracoes (evento, detectado_em, data_fonte, campos_alterados) ou em pca_itens
--         (grupo_contratacao_codigo, grupo_contratacao_nome, data_atualizacao_origem); o check de evento aceitar valor
--         fora da lista; a fila não aceitar o motivo 'impressao';
--   EVT   a classificação de pca_alteracoes não der: insert de item → item_detectado; update de valor →
--         item_atualizado com campos_alterados = {valor_total_estimado} e data_fonte = data da fonte do item; update só
--         de grupo/data → evento nulo; inativação com a classe trocada → saiu_escopo; inativação → item_removido;
--         reativação com a classe trocada → entrou_escopo; insert de plano → pca_novo; evento explícito (aviso
--         'pca_removido') preservado;
--   CRON  (só com pg_cron) os jobs de impressão e descoberta não existirem ativos, o incremental pela consulta
--         (licitagym-sync-pncp-pca-fila) ou a reconciliação continuarem ativos, ou a continuação não cobrir 06–08 UTC.
--   EVT   também: update com troca de classe entre classes do escopo → item_atualizado (não entrou_escopo).
-- Fixtures fictícias (ano 2093, CNPJ 99000001000101); tudo termina em rollback. Rodar no banco descartável.
begin;

do $acl$
declare
  t text;
  v_falhas text[] := array[]::text[];
begin
  foreach t in array array['private.pca_impressao_plano', 'private.pca_impressao_orgao'] loop
    if to_regclass(t) is null then
      raise exception 'pca_impressao_plano_check: tabela % não existe', t;
    end if;
    if not (select relrowsecurity from pg_class where oid = t::regclass) then
      v_falhas := v_falhas || format('RLS desligada em %s', t);
    end if;
    if has_table_privilege('anon', t, 'select') or has_table_privilege('authenticated', t, 'select')
      or has_table_privilege('anon', t, 'insert') or has_table_privilege('authenticated', t, 'insert')
      or has_table_privilege('anon', t, 'update') or has_table_privilege('authenticated', t, 'update')
      or has_table_privilege('anon', t, 'delete') or has_table_privilege('authenticated', t, 'delete') then
      v_falhas := v_falhas || format('anon/authenticated com acesso a %s', t);
    end if;
    if not (has_table_privilege('service_role', t, 'select') and has_table_privilege('service_role', t, 'insert')
      and has_table_privilege('service_role', t, 'update')) then
      v_falhas := v_falhas || format('service_role sem leitura/escrita em %s', t);
    end if;
  end loop;

  if (select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'pca_alteracoes'
      and column_name in ('evento', 'detectado_em', 'data_fonte', 'campos_alterados')) <> 4 then
    v_falhas := v_falhas || 'pca_alteracoes sem as colunas novas'::text;
  end if;
  if (select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'pca_itens'
      and column_name in ('grupo_contratacao_codigo', 'grupo_contratacao_nome', 'data_atualizacao_origem')) <> 3 then
    v_falhas := v_falhas || 'pca_itens sem as colunas novas'::text;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'pca_plano_fila_motivo_check'
      and pg_get_constraintdef(oid) like '%impressao%') then
    v_falhas := v_falhas || 'fila não aceita o motivo impressao'::text;
  end if;

  if cardinality(v_falhas) > 0 then
    raise exception 'pca_impressao_plano_check (ACL/COL): %', array_to_string(v_falhas, '; ');
  end if;
end;
$acl$;

set local request.headers = '{}';
set local role service_role;

do $evt$
declare
  v_plano uuid;
  v_item uuid;
  v_rejeitou boolean := false;
  v_r record;
begin
  insert into private.pca_impressao_plano (orgao_cnpj, ano, sequencial, quantidade, valor_total, data_atualizacao)
    values ('99000001000101', 2093, 1, 10, 1000, '2093-01-01');
  insert into private.pca_impressao_orgao (orgao_cnpj, ano, lido_em) values ('99000001000101', 2093, now());

  insert into public.pca_planos (id_pca_pncp, ano_exercicio, orgao_cnpj, payload_hash)
    values ('99000001000101-0-000001/2093', 2093, '99000001000101', 'p1') returning id into v_plano;
  insert into public.pca_itens (pca_plano_id, numero_item, payload_hash, classe_material_servico, valor_total_estimado,
      data_atualizacao_origem)
    values (v_plano, 7, 'i1', '7830', 1000, '2093-01-01') returning id into v_item;

  -- Linhas como a RPC as escreve (tipo_operacao + snapshots); o trigger classifica.
  insert into public.pca_alteracoes (pca_plano_id, tipo_operacao, dados_anteriores, dados_novos)
    values (v_plano, 'insert', null, jsonb_build_object('id_pca_pncp', 'x'));
  insert into public.pca_alteracoes (pca_plano_id, pca_item_id, tipo_operacao, dados_anteriores, dados_novos)
    values (v_plano, v_item, 'insert', null, jsonb_build_object('numero_item', 7, 'classe_material_servico', '7830'));
  insert into public.pca_alteracoes (pca_plano_id, pca_item_id, tipo_operacao, dados_anteriores, dados_novos)
    values (v_plano, v_item, 'update',
      jsonb_build_object('numero_item', 7, 'classe_material_servico', '7830', 'valor_total_estimado', 1000,
        'payload_hash', 'i1', 'data_atualizacao_origem', '2093-01-01'),
      jsonb_build_object('numero_item', 7, 'classe_material_servico', '7830', 'valor_total_estimado', 1200,
        'payload_hash', 'i2', 'data_atualizacao_origem', '2093-02-01T09:00:00'));
  insert into public.pca_alteracoes (pca_plano_id, pca_item_id, tipo_operacao, dados_anteriores, dados_novos)
    values (v_plano, v_item, 'update',
      jsonb_build_object('numero_item', 7, 'grupo_contratacao_codigo', null, 'payload_hash', 'i2'),
      jsonb_build_object('numero_item', 7, 'grupo_contratacao_codigo', '158141-5/2093', 'payload_hash', 'i3'));
  insert into public.pca_alteracoes (pca_plano_id, pca_item_id, tipo_operacao, dados_anteriores, dados_novos)
    values (v_plano, v_item, 'reativacao',
      jsonb_build_object('numero_item', 7, 'classe_material_servico', '7520', 'ativo', false),
      jsonb_build_object('numero_item', 7, 'classe_material_servico', '7830', 'ativo', true));
  insert into public.pca_alteracoes (pca_plano_id, tipo_operacao, evento, dados_novos)
    values (v_plano, 'aviso', 'pca_removido', jsonb_build_object('situacao', 'a_confirmar'));
  insert into public.pca_alteracoes (pca_plano_id, pca_item_id, tipo_operacao, dados_anteriores, dados_novos)
    values (v_plano, v_item, 'update',
      jsonb_build_object('numero_item', 7, 'classe_material_servico', '7830', 'ativo', true),
      jsonb_build_object('numero_item', 7, 'classe_material_servico', '7220', 'ativo', true));

  -- Inativação pelo trigger da tabela: com a classe trocada (saiu do escopo) e sem troca (removido).
  update public.pca_itens set ativo = false, classe_material_servico = '7520' where id = v_item;
  update public.pca_itens set ativo = true, classe_material_servico = '7830' where id = v_item;
  update public.pca_itens set ativo = false where id = v_item;

  for v_r in
    select row_number() over (order by a.ctid) as n, a.evento, a.campos_alterados, a.data_fonte, a.detectado_em
    from public.pca_alteracoes a where a.pca_plano_id = v_plano
  loop
    if v_r.detectado_em is null then raise exception 'EVT: detectado_em nulo na linha %', v_r.n; end if;
    if (v_r.n = 1 and v_r.evento is distinct from 'pca_novo')
      or (v_r.n = 2 and v_r.evento is distinct from 'item_detectado')
      or (v_r.n = 3 and (v_r.evento is distinct from 'item_atualizado'
        or v_r.campos_alterados is distinct from array['valor_total_estimado']::text[]
        or v_r.data_fonte is distinct from '2093-02-01T09:00:00'::timestamptz))
      or (v_r.n = 4 and v_r.evento is not null)
      or (v_r.n = 5 and v_r.evento is distinct from 'entrou_escopo')
      or (v_r.n = 6 and v_r.evento is distinct from 'pca_removido')
      or (v_r.n = 7 and (v_r.evento is distinct from 'item_atualizado'
        or v_r.campos_alterados is distinct from array['classe_material_servico']::text[]))
      or (v_r.n = 8 and v_r.evento is distinct from 'saiu_escopo')
      or (v_r.n = 9 and v_r.evento is distinct from 'item_removido') then
      raise exception 'EVT: linha % com evento % (campos %, data_fonte %)', v_r.n, v_r.evento, v_r.campos_alterados,
        v_r.data_fonte;
    end if;
  end loop;
  if (select count(*) from public.pca_alteracoes where pca_plano_id = v_plano) <> 9 then
    raise exception 'EVT: esperava 9 linhas de alteração';
  end if;

  begin
    insert into public.pca_alteracoes (pca_plano_id, tipo_operacao, evento) values (v_plano, 'aviso', 'qualquer');
  exception when check_violation then v_rejeitou := true;
  end;
  if not v_rejeitou then raise exception 'COL: check de evento aceitou valor fora da lista'; end if;

  raise notice 'SUCESSO pca_impressao_plano_check: ACL, colunas e classificação de eventos';
end;
$evt$;

reset role;

do $cron$
begin
  if to_regclass('cron.job') is null then
    raise notice 'pca_impressao_plano_check: pg_cron ausente, parte CRON pulada';
    return;
  end if;
  if (select count(*) from cron.job where active and jobname in ('licitagym-sync-pncp-pca-impressao',
      'licitagym-sync-pncp-pca-descoberta')) <> 2 then
    raise exception 'CRON: jobs de impressão/descoberta ausentes ou inativos';
  end if;
  if exists (select 1 from cron.job where active and jobname in ('licitagym-sync-pncp-pca-fila',
      'licitagym-sync-pncp-pca-reconciliacao')) then
    raise exception 'CRON: incremental pela consulta ou reconciliação continua ativo';
  end if;
  if exists (select 1 from cron.job where jobname = 'licitagym-sync-pncp-pca-fila-continuacao'
      and schedule <> '*/10 6-8 * * *') then
    raise exception 'CRON: continuação da carga fora da janela 06–08 UTC';
  end if;
end;
$cron$;

rollback;
