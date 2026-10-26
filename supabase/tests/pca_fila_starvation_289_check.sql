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
  v_data timestamptz;
  v_versao timestamptz;
  v_estado text;
  v_n integer;
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

  -- Adiamento vencido volta à reserva e é limpo (o outro plano continua no recuo do erro).
  update private.pca_plano_fila set disponivel_em = now() - interval '1 second' where id = v_first;
  select id into v_next from private.pca_fila_reservar(1, 5, 2099);
  if v_next is distinct from v_first or
     (select disponivel_em is not null from private.pca_plano_fila where id = v_first) then
    raise exception 'Adiamento vencido não voltou ou não foi limpo';
  end if;

  -- Mesmo estado com 4/5/6 tentativas: só quatro é reservável. Pendente não contorna o teto.
  insert into private.pca_plano_fila
    (id_pca_pncp, orgao_cnpj, ano, sequencial, motivo, status, tentativas)
  values ('regressao-289-cap4', '00000000000001', 2098, 1, 'novo', 'pendente', 4),
         ('regressao-289-cap5', '00000000000001', 2098, 2, 'novo', 'pendente', 5),
         ('regressao-289-cap6', '00000000000001', 2098, 3, 'novo', 'pendente', 6);
  select count(*) into v_n from private.pca_fila_reservar(10, 5, 2098);
  if v_n <> 1 or not exists (select 1 from private.pca_plano_fila
                            where id_pca_pncp = 'regressao-289-cap4' and status = 'processando') then
    raise exception 'Limite de tentativas não vale para pendentes';
  end if;

  -- Mesmo conteúdo, data ausente ou mais antiga não reabrem erro nem renovam recuo/abandono.
  insert into private.pca_plano_fila
    (id_pca_pncp, orgao_cnpj, ano, sequencial, motivo, plano, status, tentativas, erro,
     data_atualizacao_fonte, atualizado_em, disponivel_em)
  values ('regressao-289-versao', '00000000000001', 2097, 1, 'alterado', '{"v":1}', 'erro', 5, 'falha real',
          '2097-01-01T00:00:00Z', now() - interval '11 minutes', now() + interval '20 minutes');
  for v_data in select x from unnest(array['2097-01-01T00:00:00Z'::timestamptz, null,
                                         '2096-01-01T00:00:00Z'::timestamptz]) x loop
    perform private.pca_fila_enfileirar(jsonb_build_array(jsonb_build_object(
      'id_pca_pncp', 'regressao-289-versao', 'orgao_cnpj', '00000000000001', 'ano', 2097, 'sequencial', 1,
      'motivo', 'alterado', 'plano', '{"v":0}'::jsonb, 'data_atualizacao_fonte', v_data)));
    if not exists (select 1 from private.pca_plano_fila where id_pca_pncp = 'regressao-289-versao'
                    and status = 'erro' and tentativas = 5 and erro = 'falha real'
                    and atualizado_em = now() - interval '11 minutes'
                    and data_atualizacao_fonte = '2097-01-01T00:00:00Z'
                    and disponivel_em = now() + interval '20 minutes') then
      raise exception 'Redescoberta reabriu erro, apagou adiamento ou renovou relógio';
    end if;
  end loop;
  -- Nova versão comprovada reabre o ciclo, mas não antecipa o adiamento.
  perform private.pca_fila_enfileirar(jsonb_build_array(jsonb_build_object(
    'id_pca_pncp', 'regressao-289-versao', 'orgao_cnpj', '00000000000001', 'ano', 2097, 'sequencial', 1,
    'motivo', 'alterado', 'plano', '{"v":2}'::jsonb, 'data_atualizacao_fonte', '2097-02-01T00:00:00Z')));
  if not exists (select 1 from private.pca_plano_fila where id_pca_pncp = 'regressao-289-versao'
                  and status = 'pendente' and tentativas = 0 and erro is null and plano = '{"v":2}'::jsonb
                  and disponivel_em = now() + interval '20 minutes') then
    raise exception 'Nova versão não iniciou ciclo ou apagou adiamento';
  end if;
  select count(*) into v_n from private.pca_fila_reservar(10, 5, 2097);
  if v_n <> 0 then raise exception 'Nova versão foi reservada antes do fim do adiamento'; end if;

  -- Worker vivo mantém sua versão e relógio, mesmo ao receber uma versão maior.
  update private.pca_plano_fila set status = 'processando', tentativas = 4, atualizado_em = now(),
    disponivel_em = null where id_pca_pncp = 'regressao-289-versao';
  perform private.pca_fila_enfileirar(jsonb_build_array(jsonb_build_object(
    'id_pca_pncp', 'regressao-289-versao', 'orgao_cnpj', '00000000000001', 'ano', 2097, 'sequencial', 1,
    'motivo', 'alterado', 'plano', '{"v":3}'::jsonb, 'data_atualizacao_fonte', '2097-03-01T00:00:00Z')));
  select data_atualizacao_fonte, status into v_versao, v_estado from private.pca_plano_fila
   where id_pca_pncp = 'regressao-289-versao';
  if v_versao is distinct from '2097-02-01T00:00:00Z'::timestamptz or v_estado <> 'processando' then
    raise exception 'Redescoberta promoveu versão em uso por worker vivo';
  end if;
  -- Abandono da mesma versão não ganha relógio novo e sua recuperação conta tentativa.
  update private.pca_plano_fila set atualizado_em = now() - interval '16 minutes'
   where id_pca_pncp = 'regressao-289-versao';
  perform private.pca_fila_enfileirar(jsonb_build_array(jsonb_build_object(
    'id_pca_pncp', 'regressao-289-versao', 'orgao_cnpj', '00000000000001', 'ano', 2097, 'sequencial', 1,
    'motivo', 'alterado', 'data_atualizacao_fonte', '2097-02-01T00:00:00Z')));
  select tentativas into v_attempts from private.pca_fila_reservar(1, 5, 2097);
  if v_attempts is distinct from 5 then raise exception 'Abandono não contou tentativa'; end if;

  -- Recuo de erro também sobrevive à redescoberta, sem depender do limite de tentativas.
  update private.pca_plano_fila set status = 'erro', tentativas = 4, erro = 'falha', atualizado_em = now()
   where id_pca_pncp = 'regressao-289-versao';
  perform private.pca_fila_enfileirar(jsonb_build_array(jsonb_build_object(
    'id_pca_pncp', 'regressao-289-versao', 'orgao_cnpj', '00000000000001', 'ano', 2097, 'sequencial', 1,
    'motivo', 'alterado', 'data_atualizacao_fonte', '2097-02-01T00:00:00Z')));
  select count(*) into v_n from private.pca_fila_reservar(1, 5, 2097);
  if v_n <> 0 then raise exception 'Redescoberta eliminou recuo de erro recente'; end if;
  update private.pca_plano_fila set atualizado_em = now() - interval '11 minutes'
   where id_pca_pncp = 'regressao-289-versao';
  perform private.pca_fila_enfileirar(jsonb_build_array(jsonb_build_object(
    'id_pca_pncp', 'regressao-289-versao', 'orgao_cnpj', '00000000000001', 'ano', 2097, 'sequencial', 1,
    'motivo', 'alterado', 'data_atualizacao_fonte', '2097-02-01T00:00:00Z')));
  select tentativas into v_attempts from private.pca_fila_reservar(1, 5, 2097);
  if v_attempts is distinct from 4 then raise exception 'Redescoberta renovou recuo de erro antigo'; end if;

  -- Sem data anterior conhecida, receber uma data não prova que houve uma versão maior.
  insert into private.pca_plano_fila
    (id_pca_pncp, orgao_cnpj, ano, sequencial, motivo, status, tentativas, erro)
  values ('regressao-289-sem-data', '00000000000001', 2096, 1, 'novo', 'erro', 5, 'sem data');
  perform private.pca_fila_enfileirar(jsonb_build_array(jsonb_build_object(
    'id_pca_pncp', 'regressao-289-sem-data', 'orgao_cnpj', '00000000000001', 'ano', 2096, 'sequencial', 1,
    'motivo', 'alterado', 'data_atualizacao_fonte', '2096-02-01T00:00:00Z')));
  if not exists (select 1 from private.pca_plano_fila where id_pca_pncp = 'regressao-289-sem-data'
                  and status = 'erro' and tentativas = 5 and erro = 'sem data') then
    raise exception 'Data anteriormente desconhecida reiniciou tentativas sem prova';
  end if;
  -- Abandonado esgotado também pode iniciar um ciclo quando a versão maior está comprovada.
  update private.pca_plano_fila set status = 'processando', atualizado_em = now() - interval '16 minutes'
   where id_pca_pncp = 'regressao-289-sem-data';
  perform private.pca_fila_enfileirar(jsonb_build_array(jsonb_build_object(
    'id_pca_pncp', 'regressao-289-sem-data', 'orgao_cnpj', '00000000000001', 'ano', 2096, 'sequencial', 1,
    'motivo', 'alterado', 'data_atualizacao_fonte', '2096-03-01T00:00:00Z')));
  if not exists (select 1 from private.pca_plano_fila where id_pca_pncp = 'regressao-289-sem-data'
                  and status = 'pendente' and tentativas = 0 and erro is null) then
    raise exception 'Versão maior não reabriu abandono esgotado';
  end if;

  raise notice 'PASS #289: FIFO, adiamento, expiração, redescoberta, limite, versão e recuo';
end
$test$;
rollback;
