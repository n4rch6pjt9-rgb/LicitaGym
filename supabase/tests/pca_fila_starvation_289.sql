-- Regressão #289: executar em banco de testes descartável após aplicar as migrations.
-- Executar em transação para não persistir alterações.
begin;
do $test$
declare
  v_first bigint;
  v_second bigint;
  v_deferred bigint;
  v_next bigint;
  v_attempts integer;
  v_old text;
begin
  -- Não interfere com registros reais: o teste exige banco isolado.
  if exists (select 1 from private.pca_plano_fila) then
    raise exception 'Teste exige private.pca_plano_fila vazia em banco isolado';
  end if;

  insert into private.pca_plano_fila
    (id_pca_pncp, orgao_cnpj, ano, sequencial, motivo, plano, classes, chain_id, status, tentativas)
  values
    ('regressao-289-1', '00000000000001', 2099, 1, 'novo', '{}'::jsonb, array['7830'], gen_random_uuid(), 'pendente', 0),
    ('regressao-289-2', '00000000000002', 2099, 2, 'novo', '{}'::jsonb, array['7830'], gen_random_uuid(), 'pendente', 0);

  select min(id), max(id) into v_first, v_second
  from private.pca_plano_fila where ano = 2099;

  select id into v_deferred
  from private.pca_fila_reservar(1, 5, 2099);
  if v_deferred is distinct from v_first then
    raise exception 'FIFO: esperado primeiro plano %, recebido %', v_first, v_deferred;
  end if;

  update private.pca_plano_fila
     set status = 'pendente', disponivel_em = now() + interval '20 minutes'
   where id = v_deferred;

  select id into v_next
  from private.pca_fila_reservar(1, 5, 2099);
  if v_next is distinct from v_second then
    raise exception 'Starvation: plano seguinte não avançou (% vs %)', v_next, v_second;
  end if;

  update private.pca_plano_fila set status = 'pendente' where id = v_second;

  -- Simula redescoberta do primeiro plano e garante que o adiamento não é apagado.
  perform private.pca_fila_enfileirar(jsonb_build_array(jsonb_build_object(
    'id_pca_pncp', 'regressao-289-1', 'orgao_cnpj', '00000000000001',
    'ano', 2099, 'sequencial', 1, 'motivo', 'alterado',
    'classes', jsonb_build_array('7830'), 'chain_id', gen_random_uuid()::text
  )));

  if not exists (select 1 from private.pca_plano_fila
                 where id = v_first and status = 'pendente'
                   and disponivel_em > now()) then
    raise exception 'Redescoberta eliminou o adiamento';
  end if;

  -- Erros reais não perdem contagem quando redescobertos.
  update private.pca_plano_fila set status = 'erro', tentativas = 4 where id = v_second;
  perform private.pca_fila_enfileirar(jsonb_build_array(jsonb_build_object(
    'id_pca_pncp', 'regressao-289-2', 'orgao_cnpj', '00000000000002',
    'ano', 2099, 'sequencial', 2, 'motivo', 'alterado',
    'classes', jsonb_build_array('7830'), 'chain_id', gen_random_uuid()::text
  )));
  select tentativas into v_attempts from private.pca_plano_fila where id = v_second;
  if v_attempts <> 4 then
    raise exception 'Tentativas reiniciadas: esperado 4, recebido %', v_attempts;
  end if;

  raise notice 'PASS #289: FIFO, adiamento, redescoberta e tentativas';
end
$test$;
rollback;
