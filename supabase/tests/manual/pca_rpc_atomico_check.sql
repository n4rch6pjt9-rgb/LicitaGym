\set ON_ERROR_STOP on
-- TX02: check manual da RPC. NAO executar em producao.
-- Pre-requisitos: migrations desta branch ja aplicadas em Postgres descartavel;
-- banco EXATAMENTE licitagym_pca_tx_test, PCA vazio, sessao de administrador
-- capaz de SET ROLE service_role e PGOPTIONS com -c licitagym.harness=isolated-local.
-- Executar com psql -X -v ON_ERROR_STOP=1 -d licitagym_pca_tx_test -f este_arquivo.
-- NAO usar --single-transaction: a fase 2 verifica COMMITs reais.
-- Se falhar depois do primeiro COMMIT da fase 2, DESCARTAR o banco exclusivo.
-- Este arquivo nao instala migrations nem usa dados externos.

do $guard$
begin
  if current_database() <> 'licitagym_pca_tx_test'
     or current_setting('licitagym.harness', true) is distinct from 'isolated-local' then
    raise exception 'TRAVA: requer licitagym_pca_tx_test e licitagym.harness=isolated-local';
  end if;
  if current_user <> session_user then
    raise exception 'TRAVA: iniciar sem SET ROLE';
  end if;
  if to_regprocedure('private.pca_persistir_lote_atomico(jsonb,uuid)') is null
     or to_regprocedure('private.pca_persistir_unidade_atomica(text,jsonb,jsonb,uuid)') is null then
    raise exception 'Pre-requisito ausente: RPCs TX02 desta branch';
  end if;
  if exists (select 1 from public.pca_planos)
     or exists (select 1 from public.pca_itens)
     or exists (select 1 from public.pca_alteracoes)
     or exists (select 1 from private.pca_plano_fila)
     or exists (select 1 from private.pncp_sync_run where resource_type = 'pca') then
    raise exception 'TRAVA: requer banco exclusivo sem dados PCA; nao limpa dados preexistentes';
  end if;
end;
$guard$;

-- Objetos temporarios da sessao; nenhum helper SECURITY DEFINER.
create temporary table tx02_context (
  singleton boolean primary key default true check (singleton),
  run_id uuid,
  plano_id uuid,
  token uuid,
  fila_id bigint,
  oficial text not null default 'HARNESS-TX02-CHECK/2096'
) on commit preserve rows;
insert into tx02_context(singleton) values (true);
grant select, update on pg_temp.tx02_context to service_role;

create function pg_temp.tx02_assert(ok boolean, mensagem text)
returns void language plpgsql security invoker as $f$
begin
  if ok is distinct from true then raise exception 'TX02: %', mensagem; end if;
end;
$f$;

create function pg_temp.tx02_item(plano uuid, numero integer, hash text, valor numeric)
returns jsonb language sql immutable security invoker as $f$
  select jsonb_build_object(
    'tabela', 'pca_itens',
    'chave', jsonb_build_object('pca_plano_id', plano, 'numero_item', numero),
    'linha', jsonb_build_object(
      'pca_plano_id', plano, 'numero_item', numero,
      'descricao', 'fixture TX02', 'payload_hash', hash,
      'valor_unitario_estimado', valor
    )
  )
$f$;

-- A excecao sentinela do proprio check fica FORA do bloco que captura erros.
-- Uma falha diferente da esperada nunca e convertida em aprovacao.
create function pg_temp.tx02_expect_error(unidades jsonb, execucao uuid, esperado text)
returns void language plpgsql security invoker as $f$
declare falhou boolean := false;
begin
  begin
    perform private.pca_persistir_lote_atomico(unidades, execucao);
  exception when others then
    if sqlstate <> esperado then raise; end if;
    falhou := true;
  end;
  perform pg_temp.tx02_assert(falhou, 'RPC deveria falhar com SQLSTATE ' || esperado);
end;
$f$;

create function pg_temp.tx02_rejeitar_historico()
returns trigger language plpgsql security invoker as $f$
begin
  if new.payload_hash_novo like 'tx02-falha-%' then
    raise exception 'TX02: falha injetada no historico' using errcode = 'P0199';
  end if;
  return new;
end;
$f$;

-- Permissoes dos helpers explicitadas, sem depender de privilegios padrao.
do $temp_acl$
begin
  execute format('grant usage on schema %I to service_role',
    (select nspname from pg_catalog.pg_namespace where oid = pg_my_temp_schema()));
end;
$temp_acl$;
grant execute on function pg_temp.tx02_assert(boolean,text) to service_role;
grant execute on function pg_temp.tx02_item(uuid,integer,text,numeric) to service_role;
grant execute on function pg_temp.tx02_expect_error(jsonb,uuid,text) to service_role;
grant execute on function pg_temp.tx02_rejeitar_historico() to service_role;

-- FASE 1: fixtures, trigger e alteracoes desta fase sao revertidos.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';
set local request.headers = '{}';

-- Instalar como administrador; chamadas da RPC abaixo usam service_role.
create trigger zz_tx02_check_rejeitar_historico
before insert on public.pca_alteracoes
for each row execute function pg_temp.tx02_rejeitar_historico();
set local role service_role;

do $check$
declare
  c record;
  adquirido jsonb;
  resposta jsonb;
  unidade jsonb;
  plano_unidade jsonb;
  antes jsonb;
  depois jsonb;
  historico_antes jsonb;
  historico_depois jsonb;
  n bigint;
  novo_token uuid;
  assinatura text;
begin
  -- ACL das duas entradas: anon/authenticated nao podem executar.
  foreach assinatura in array array[
    'private.pca_persistir_unidade_atomica(text,jsonb,jsonb,uuid)',
    'private.pca_persistir_lote_atomico(jsonb,uuid)'
  ] loop
    perform pg_temp.tx02_assert(
      not has_function_privilege('anon', assinatura, 'execute')
      and not has_function_privilege('authenticated', assinatura, 'execute')
      and has_function_privilege('service_role', assinatura, 'execute'),
      'ACL incorreta: ' || assinatura
    );
  end loop;

  adquirido := private.pca_adquirir_execucao('pca-fila:2096', 'pca', '{"ano":2096}', 2096);
  perform pg_temp.tx02_assert(adquirido->>'already_running' = 'false', 'execucao nao adquirida');
  update pg_temp.tx02_context set run_id = (adquirido->>'run_id')::uuid;
  select * into strict c from pg_temp.tx02_context;
  perform set_config('request.headers', jsonb_build_object('x-pca-run-id', c.run_id)::text, true);

  plano_unidade := jsonb_build_object(
    'tabela', 'pca_planos',
    'chave', jsonb_build_object('id_pca_pncp', c.oficial),
    'linha', jsonb_build_object('id_pca_pncp', c.oficial,
      'ano_exercicio', 2096, 'orgao_cnpj', '99000001000101', 'payload_hash', 'tx02-plano-v1')
  );
  resposta := private.pca_persistir_lote_atomico(jsonb_build_array(plano_unidade), c.run_id);
  update pg_temp.tx02_context set plano_id = (resposta->0->>'id')::uuid;
  select * into strict c from pg_temp.tx02_context;
  perform pg_temp.tx02_assert(resposta->0->>'resultado' = 'novo', 'INSERT do plano');
  unidade := pg_temp.tx02_item(c.plano_id, 1, 'tx02-item-v1', 100);
  resposta := private.pca_persistir_lote_atomico(jsonb_build_array(unidade), c.run_id);
  perform pg_temp.tx02_assert(resposta->0->>'resultado' = 'novo', 'INSERT do item');
  perform pg_temp.tx02_assert(
    (select count(*) from public.pca_alteracoes where pca_plano_id = c.plano_id) = 2,
    'INSERT deve gerar exatamente um evento por entidade'
  );

  update public.pca_itens set ativo = false where pca_plano_id = c.plano_id and numero_item = 1;
  select to_jsonb(i) into strict antes from public.pca_itens i
    where pca_plano_id = c.plano_id and numero_item = 1;

  insert into private.pca_plano_fila(id_pca_pncp, orgao_cnpj, ano, sequencial, motivo)
    values (c.oficial, '99000001000101', 2096, 1, 'alterado');
  update pg_temp.tx02_context set
    (token, fila_id) = (select reserva_token, id from private.pca_fila_reservar(1,5,2096));
  select * into strict c from pg_temp.tx02_context;
  perform pg_temp.tx02_assert(c.token is not null, 'reserva sem token');
  perform set_config('request.headers', jsonb_build_object(
    'x-pca-run-id', c.run_id, 'x-pca-reserva', c.token)::text, true);

  select coalesce(jsonb_agg(to_jsonb(a) order by a.id), '[]'::jsonb)
    into historico_antes from public.pca_alteracoes a where pca_plano_id = c.plano_id;

  -- CA-8: UPDATE de conteudo + reativacao ocorre, mas INSERT do historico falha.
  perform pg_temp.tx02_expect_error(jsonb_build_array(
    pg_temp.tx02_item(c.plano_id, 1, 'tx02-falha-reativacao', 999)), c.run_id, 'P0199');
  select to_jsonb(i) into strict depois from public.pca_itens i
    where pca_plano_id = c.plano_id and numero_item = 1;
  perform pg_temp.tx02_assert(
    depois->'ativo' = 'false'::jsonb
    and depois->'valor_unitario_estimado' = '100'::jsonb
    and depois->'payload_hash' = antes->'payload_hash' and depois = antes,
    'CA-8: rollback deve preservar ativo=false, valor=100, hash e snapshot completo'
  );

  -- Falha na segunda unidade reverte tambem a primeira, inclusive seu historico.
  perform pg_temp.tx02_expect_error(jsonb_build_array(
    pg_temp.tx02_item(c.plano_id, 1, 'tx02-item-v2', 999),
    pg_temp.tx02_item(c.plano_id, 2, 'tx02-falha-segunda', 200)), c.run_id, 'P0199');
  perform pg_temp.tx02_assert(
    (select to_jsonb(i) from public.pca_itens i
      where pca_plano_id = c.plano_id and numero_item = 1) = antes
    and not exists (select 1 from public.pca_itens where pca_plano_id = c.plano_id and numero_item = 2),
    'lote com falha na segunda unidade deixou escrita parcial'
  );

  -- Plano existente tambem deve reverter quando seu historico falha.
  select to_jsonb(p) into strict antes from public.pca_planos p where id = c.plano_id;
  perform pg_temp.tx02_expect_error(jsonb_build_array(jsonb_set(
    plano_unidade, '{linha,payload_hash}', '"tx02-falha-plano"'::jsonb)), c.run_id, 'P0199');
  perform pg_temp.tx02_assert(
    (select to_jsonb(p) from public.pca_planos p where id = c.plano_id) = antes,
    'falha de historico nao reverteu plano'
  );
  select coalesce(jsonb_agg(to_jsonb(a) order by a.id), '[]'::jsonb)
    into historico_depois from public.pca_alteracoes a where pca_plano_id = c.plano_id;
  perform pg_temp.tx02_assert(historico_depois = historico_antes, 'historico de operacao revertida persistiu');

  -- Sucesso: reativacao alterada, valores e snapshots reais.
  select to_jsonb(i) into strict antes from public.pca_itens i
    where pca_plano_id = c.plano_id and numero_item = 1;
  unidade := pg_temp.tx02_item(c.plano_id, 1, 'tx02-item-v2', 999);
  resposta := private.pca_persistir_lote_atomico(jsonb_build_array(unidade), c.run_id);
  select to_jsonb(i) into strict depois from public.pca_itens i
    where pca_plano_id = c.plano_id and numero_item = 1;
  perform pg_temp.tx02_assert(
    resposta->0->>'resultado' = 'alterado'
    and depois->'ativo' = 'true'::jsonb
    and depois->'valor_unitario_estimado' = '999'::jsonb
    and depois->>'payload_hash' = 'tx02-item-v2', 'reativacao com sucesso incorreta'
  );
  perform pg_temp.tx02_assert(
    (select count(*) from public.pca_alteracoes
      where pca_item_id = (depois->>'id')::uuid and tipo_operacao = 'reativacao'
        and dados_anteriores = antes and dados_novos = depois
        and payload_hash_anterior = antes->>'payload_hash'
        and payload_hash_novo = 'tx02-item-v2' and sync_run_id = c.run_id) = 1,
    'snapshot ou evento da reativacao incorreto'
  );
  select count(*) into n from public.pca_alteracoes where pca_plano_id = c.plano_id;
  resposta := private.pca_persistir_lote_atomico(jsonb_build_array(unidade), c.run_id);
  perform pg_temp.tx02_assert(
    resposta->0->>'resultado' = 'inalterado'
    and (select count(*) from public.pca_alteracoes where pca_plano_id = c.plano_id) = n,
    'repeticao identica gerou historico ou classificacao incorreta'
  );

  -- Reativacao sem mudar hash percorre outro ramo da RPC.
  update public.pca_itens set ativo = false where pca_plano_id = c.plano_id and numero_item = 1;
  select count(*) into n from public.pca_alteracoes where pca_plano_id = c.plano_id;
  resposta := private.pca_persistir_lote_atomico(jsonb_build_array(unidade), c.run_id);
  perform pg_temp.tx02_assert(
    resposta->0->>'resultado' = 'alterado'
    and (select ativo from public.pca_itens where pca_plano_id = c.plano_id and numero_item = 1)
    and (select count(*) from public.pca_alteracoes where pca_plano_id = c.plano_id) = n + 1,
    'reativacao sem mudanca de hash falhou'
  );

  select to_jsonb(i) into strict antes from public.pca_itens i
    where pca_plano_id = c.plano_id and numero_item = 1;
  select coalesce(jsonb_agg(to_jsonb(a) order by a.id), '[]'::jsonb)
    into historico_antes from public.pca_alteracoes a where pca_plano_id = c.plano_id;
  unidade := pg_temp.tx02_item(c.plano_id, 1, 'tx02-nao-autorizado', 1234);

  -- Header ausente/divergente, run encerrado, token antigo e token ausente.
  perform set_config('request.headers', '{}', true);
  perform pg_temp.tx02_expect_error(jsonb_build_array(unidade), c.run_id, '40001');
  perform set_config('request.headers', jsonb_build_object(
    'x-pca-run-id', gen_random_uuid(), 'x-pca-reserva', c.token)::text, true);
  perform pg_temp.tx02_expect_error(jsonb_build_array(unidade), c.run_id, '40001');
  perform set_config('request.headers', jsonb_build_object(
    'x-pca-run-id', c.run_id, 'x-pca-reserva', c.token)::text, true);
  update private.pncp_sync_run set status = 'falhou' where id = c.run_id;
  perform pg_temp.tx02_expect_error(jsonb_build_array(unidade), c.run_id, '40001');
  update private.pncp_sync_run set status = 'executando' where id = c.run_id;
  update private.pca_plano_fila set atualizado_em = now() - interval '16 minutes' where id = c.fila_id;
  select reserva_token into strict novo_token from private.pca_fila_reservar(1,5,2096);
  perform pg_temp.tx02_assert(novo_token is not null and novo_token <> c.token, 'recuperacao nao trocou token');
  perform pg_temp.tx02_expect_error(jsonb_build_array(unidade), c.run_id, '40001');
  perform set_config('request.headers', jsonb_build_object('x-pca-run-id', c.run_id)::text, true);
  perform pg_temp.tx02_expect_error(jsonb_build_array(unidade), c.run_id, '40001');

  perform pg_temp.tx02_assert(
    (select to_jsonb(i) from public.pca_itens i
      where pca_plano_id = c.plano_id and numero_item = 1) = antes,
    'tentativa nao autorizada alterou item'
  );
  select coalesce(jsonb_agg(to_jsonb(a) order by a.id), '[]'::jsonb)
    into historico_depois from public.pca_alteracoes a where pca_plano_id = c.plano_id;
  perform pg_temp.tx02_assert(historico_depois = historico_antes, 'tentativa nao autorizada alterou historico');
  raise notice 'TX02 fase 1: rollback, lote, reativacao, repeticao e autorizacao verificados';
end;
$check$;
rollback;

-- FASE 2: primeiro bloco CONFIRMADO; falha da chamada seguinte nao o desfaz.
-- O trigger da fase 1 foi revertido. Aqui ele persiste ate a limpeza final.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';
create trigger zz_tx02_check_rejeitar_historico
before insert on public.pca_alteracoes
for each row execute function pg_temp.tx02_rejeitar_historico();
set local role service_role;
set local request.headers = '{}';
do $first$
declare c record; r jsonb; unidades jsonb;
begin
  r := private.pca_adquirir_execucao('pca-fila:2096', 'pca', '{"ano":2096}', 2096);
  perform pg_temp.tx02_assert(r->>'already_running' = 'false', 'fase 2: execucao nao adquirida');
  update pg_temp.tx02_context set run_id = (r->>'run_id')::uuid;
  select * into strict c from pg_temp.tx02_context;
  perform set_config('request.headers', jsonb_build_object('x-pca-run-id', c.run_id)::text, true);
  r := private.pca_persistir_lote_atomico(jsonb_build_array(jsonb_build_object(
    'tabela', 'pca_planos', 'chave', jsonb_build_object('id_pca_pncp', c.oficial),
    'linha', jsonb_build_object('id_pca_pncp', c.oficial, 'ano_exercicio', 2096,
      'orgao_cnpj', '99000001000101', 'payload_hash', 'tx02-plano-confirmado')
  )), c.run_id);
  update pg_temp.tx02_context set plano_id = (r->0->>'id')::uuid;
  select * into strict c from pg_temp.tx02_context;
  select jsonb_agg(pg_temp.tx02_item(c.plano_id, g, 'tx02-confirmado-' || g, g) order by g)
    into unidades from generate_series(1,100) g;
  r := private.pca_persistir_lote_atomico(unidades, c.run_id);
  perform pg_temp.tx02_assert(jsonb_array_length(r) = 100, 'bloco de 100 incompleto');
end;
$first$;
commit;

begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';
set local role service_role;
do $second$
declare c record; antes jsonb; depois jsonb; eventos jsonb; eventos_depois jsonb; unidades jsonb;
begin
  select * into strict c from pg_temp.tx02_context;
  perform set_config('request.headers', jsonb_build_object('x-pca-run-id', c.run_id)::text, true);
  select jsonb_agg(to_jsonb(i) order by i.numero_item) into antes
    from public.pca_itens i where pca_plano_id = c.plano_id;
  select jsonb_agg(to_jsonb(a) order by a.id) into eventos
    from public.pca_alteracoes a where pca_plano_id = c.plano_id;
  perform pg_temp.tx02_assert(jsonb_array_length(antes) = 100
    and jsonb_array_length(eventos) = 101, 'COMMIT anterior nao preservou 100 itens e 101 eventos');

  -- A segunda chamada tenta alterar um item confirmado e inserir o 101; ambos devem reverter.
  perform pg_temp.tx02_expect_error(jsonb_build_array(
    pg_temp.tx02_item(c.plano_id, 1, 'tx02-nao-confirmado', 999),
    pg_temp.tx02_item(c.plano_id, 101, 'tx02-falha-bloco-seguinte', 101)
  ), c.run_id, 'P0199');
  select jsonb_agg(to_jsonb(i) order by i.numero_item) into depois
    from public.pca_itens i where pca_plano_id = c.plano_id;
  select jsonb_agg(to_jsonb(a) order by a.id) into eventos_depois
    from public.pca_alteracoes a where pca_plano_id = c.plano_id;
  perform pg_temp.tx02_assert(depois = antes and eventos_depois = eventos,
    'falha posterior mudou bloco ja confirmado ou deixou escrita parcial');

  -- Fronteiras do contrato da RPC: 0 e 101 unidades sao rejeitadas.
  perform pg_temp.tx02_expect_error('[]'::jsonb, c.run_id, '22023');
  select jsonb_agg(pg_temp.tx02_item(c.plano_id, g, 'tx02-limite-' || g, g) order by g)
    into unidades from generate_series(1,101) g;
  perform pg_temp.tx02_expect_error(unidades, c.run_id, '22023');
  select jsonb_agg(to_jsonb(i) order by i.numero_item) into depois
    from public.pca_itens i where pca_plano_id = c.plano_id;
  select jsonb_agg(to_jsonb(a) order by a.id) into eventos_depois
    from public.pca_alteracoes a where pca_plano_id = c.plano_id;
  perform pg_temp.tx02_assert(depois = antes and eventos_depois = eventos,
    'rejeicao por tamanho deixou escrita parcial');
  raise notice 'TX02 fase 2: COMMIT anterior preservado; limites 0/100/101 verificados';
end;
$second$;
commit;

-- Limpeza apenas das fixtures criadas, como administrador da sessao.
-- Nao e executada automaticamente se ON_ERROR_STOP interromper: descartar o banco nesse caso.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';
set local request.headers = '{}';
drop trigger zz_tx02_check_rejeitar_historico on public.pca_alteracoes;
delete from private.pca_plano_fila where id_pca_pncp = (select oficial from pg_temp.tx02_context);
delete from public.pca_planos where id = (select plano_id from pg_temp.tx02_context);
delete from private.pncp_sync_run where id = (select run_id from pg_temp.tx02_context);
do $cleanup$
begin
  perform pg_temp.tx02_assert(
    not exists (select 1 from public.pca_planos)
    and not exists (select 1 from public.pca_itens)
    and not exists (select 1 from public.pca_alteracoes)
    and not exists (select 1 from private.pca_plano_fila)
    and not exists (select 1 from private.pncp_sync_run where resource_type = 'pca'),
    'limpeza incompleta'
  );
end;
$cleanup$;
commit;
do $success$ begin raise notice 'SUCESSO TX02: todas as fases e limpeza concluidas'; end; $success$;
