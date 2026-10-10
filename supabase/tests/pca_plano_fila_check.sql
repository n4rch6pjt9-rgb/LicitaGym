-- Checagem da fila de planos do PCA (spec specs/0012-pca-sync-cpu-pagina.md, PR 2).
-- Falha com EXCEPTION se:
--   ACL  private.pca_plano_fila ou as funções ficarem acessíveis a anon/authenticated, RLS desligada, ou service_role
--        sem acesso;
--   ENF  reenfileirar o mesmo plano duplicar a linha aberta, uma linha 'processando' recente voltar para 'pendente',
--        uma linha em erro ou 'processando' abandonada (>= 15 min) reenfileirada não recomeçar as tentativas, ou o
--        motivo 'ausente' trocar o motivo de linha aberta com cabeçalho;
--   RES  pca_fila_reservar devolver mais que o limite, pegar plano 'feito', erro com tentativas esgotadas ou erro
--        de menos de 10 minutos (recuo entre tentativas); ou se processando abandonado não contar tentativa;
--   DESC pca_marcar_descoberta não zerar a chave do escopo no plano visto, não somar no ausente com item da classe,
--        somar no plano sem item da classe, ou mexer na ausência de outro escopo; pca_zerar_ausencia tirar mais que a
--        chave do escopo;
--   REPROC pca_planos.reprocessar não existir como boolean not null default false;
--   LOCK private.acquire_sync_lock não preservar (e herdar) a execução da fila que parou sem heartbeat com a
--        continuation que o sync-pncp-pca grava (pending com rótulo, rotina, classes, descoberta);
--   CRON (só com pg_cron) os três jobs novos não existirem, ou o comando não usar "rotina".
-- Fixtures com ids fictícios ('CHK-FILA-…') e ano 2099; tudo termina em rollback.
-- Feito para o banco descartável (scripts/validar-migrations.sh). Em produção, com a fila real em uso, a parte RES
-- reserva linhas reais mais antigas que as do teste (falso negativo) e as trava até o rollback: não rodar lá fora do
-- bloco ACL.

begin;

do $chk$
declare
  v_falhas text[] := array[]::text[];
  v_r record;
  v_n int;
  v_id_proc bigint;
  v_p1 uuid;
  v_stale uuid;
  v_lock jsonb;
begin
  -- ACL
  if to_regclass('private.pca_plano_fila') is null then
    raise exception 'pca_plano_fila_check: tabela private.pca_plano_fila não existe';
  end if;
  if not (select relrowsecurity from pg_class where oid = 'private.pca_plano_fila'::regclass) then
    v_falhas := v_falhas || 'RLS desligada em private.pca_plano_fila'::text;
  end if;
  for v_r in
    select papel, priv from unnest(array['anon', 'authenticated']) papel
     cross join unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN']) priv
     where has_table_privilege(papel, 'private.pca_plano_fila', priv)
  loop
    v_falhas := v_falhas || format('%s tem %s em private.pca_plano_fila', v_r.papel, v_r.priv);
  end loop;
  for v_r in
    select papel, fn from unnest(array['anon', 'authenticated']) papel
     cross join unnest(array[
       'private.pca_fila_enfileirar(jsonb)',
       'private.pca_fila_reservar(integer,integer,integer)',
       'private.pca_marcar_descoberta(integer,text[],text[])',
       'private.pca_zerar_ausencia(uuid,text[])',
       'private.pca_escopo_ausencia(text[])']) fn
     where has_function_privilege(papel, fn, 'EXECUTE')
  loop
    v_falhas := v_falhas || format('%s executa %s', v_r.papel, v_r.fn);
  end loop;
  if not has_table_privilege('service_role', 'private.pca_plano_fila', 'SELECT')
     or not has_table_privilege('service_role', 'private.pca_plano_fila', 'INSERT')
     or not has_table_privilege('service_role', 'private.pca_plano_fila', 'UPDATE')
     or not has_function_privilege('service_role', 'private.pca_fila_enfileirar(jsonb)', 'EXECUTE')
     or not has_function_privilege('service_role', 'private.pca_fila_reservar(integer,integer,integer)', 'EXECUTE')
     or not has_function_privilege('service_role', 'private.pca_marcar_descoberta(integer,text[],text[])', 'EXECUTE')
     or not has_function_privilege('service_role', 'private.pca_zerar_ausencia(uuid,text[])', 'EXECUTE')
     or not has_function_privilege('service_role', 'private.pca_escopo_ausencia(text[])', 'EXECUTE') then
    v_falhas := v_falhas || 'service_role sem acesso à fila ou às funções'::text;
  end if;

  -- REPROC: marca separada dos campos da fonte, desligada por padrão
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'pca_planos' and column_name = 'reprocessar'
                    and data_type = 'boolean' and is_nullable = 'NO' and column_default = 'false') then
    v_falhas := v_falhas || 'pca_planos.reprocessar ausente ou sem boolean not null default false'::text;
  end if;

  -- ENF
  perform private.pca_fila_enfileirar(jsonb_build_array(
    jsonb_build_object('id_pca_pncp', 'CHK-FILA-A', 'orgao_cnpj', '99000001000101', 'ano', 2099, 'sequencial', 1,
                       'motivo', 'novo', 'plano', '{"x":1}'::jsonb, 'data_atualizacao_fonte', '2099-01-01T00:00:00Z'),
    jsonb_build_object('id_pca_pncp', 'CHK-FILA-B', 'orgao_cnpj', '99000001000101', 'ano', 2099, 'sequencial', 2,
                       'motivo', 'novo')));
  perform private.pca_fila_enfileirar(jsonb_build_array(
    jsonb_build_object('id_pca_pncp', 'CHK-FILA-A', 'orgao_cnpj', '99000001000101', 'ano', 2099, 'sequencial', 1,
                       'motivo', 'alterado', 'data_atualizacao_fonte', '2099-02-01T00:00:00Z')));
  select count(*) into v_n from private.pca_plano_fila where id_pca_pncp = 'CHK-FILA-A';
  if v_n <> 1 then
    v_falhas := v_falhas || format('reenfileirar duplicou: %s linhas abertas de CHK-FILA-A', v_n);
  end if;
  if (select motivo || '|' || (plano is not null)::text from private.pca_plano_fila where id_pca_pncp = 'CHK-FILA-A')
     <> 'alterado|true' then
    v_falhas := v_falhas || 'reenfileirar não atualizou o motivo ou perdeu o cabeçalho do plano'::text;
  end if;

  -- RES
  insert into private.pca_plano_fila (id_pca_pncp, orgao_cnpj, ano, sequencial, motivo, status, tentativas)
    values ('CHK-FILA-FEITO', '99000001000101', 2099, 3, 'novo', 'feito', 0),
           ('CHK-FILA-ESGOTADO', '99000001000101', 2099, 4, 'novo', 'erro', 5),
           ('CHK-FILA-ERRO-RECENTE', '99000001000101', 2099, 5, 'novo', 'erro', 1);
  select count(*) into v_n from private.pca_fila_reservar(1, 5) r where r.id_pca_pncp like 'CHK-FILA-%';
  if v_n > 1 then
    v_falhas := v_falhas || format('reservar com limite 1 devolveu %s linhas', v_n);
  end if;
  select count(*) into v_n from private.pca_fila_reservar(100, 5) r
   where r.id_pca_pncp in ('CHK-FILA-FEITO', 'CHK-FILA-ESGOTADO', 'CHK-FILA-ERRO-RECENTE');
  if v_n <> 0 then
    v_falhas := v_falhas || 'reservar pegou plano feito, erro esgotado ou erro de menos de 10 min'::text;
  end if;
  -- processando abandonado (> 15 min) volta e conta tentativa; com tentativas esgotadas, não volta
  insert into private.pca_plano_fila (id_pca_pncp, orgao_cnpj, ano, sequencial, motivo, status, tentativas, atualizado_em)
    values ('CHK-FILA-ABANDONADO', '99000001000101', 2099, 6, 'novo', 'processando', 4, now() - interval '1 hour'),
           ('CHK-FILA-ABANDONADO-ESGOTADO', '99000001000101', 2099, 7, 'novo', 'processando', 5, now() - interval '1 hour');
  select count(*) into v_n from private.pca_fila_reservar(100, 5) r where r.id_pca_pncp = 'CHK-FILA-ABANDONADO-ESGOTADO';
  if v_n <> 0 then
    v_falhas := v_falhas || 'reservar pegou processando abandonado com tentativas esgotadas'::text;
  end if;
  if (select tentativas from private.pca_plano_fila where id_pca_pncp = 'CHK-FILA-ABANDONADO') <> 5 then
    v_falhas := v_falhas || 'processando abandonado não contou tentativa ao ser reservado de novo'::text;
  end if;

  select id into v_id_proc from private.pca_plano_fila where id_pca_pncp = 'CHK-FILA-A';
  if (select status from private.pca_plano_fila where id = v_id_proc) <> 'processando' then
    v_falhas := v_falhas || 'reservar não marcou o plano como processando'::text;
  end if;
  perform private.pca_fila_enfileirar(jsonb_build_array(
    jsonb_build_object('id_pca_pncp', 'CHK-FILA-A', 'orgao_cnpj', '99000001000101', 'ano', 2099, 'sequencial', 1,
                       'motivo', 'alterado')));
  if (select status from private.pca_plano_fila where id = v_id_proc) <> 'processando' then
    v_falhas := v_falhas || 'reenfileirar tirou o plano de processando'::text;
  end if;
  -- linha em erro com tentativas esgotadas que recebe trabalho novo recomeça (status, tentativas e erro)
  update private.pca_plano_fila set erro = 'falha antiga' where id_pca_pncp = 'CHK-FILA-ESGOTADO';
  perform private.pca_fila_enfileirar(jsonb_build_array(
    jsonb_build_object('id_pca_pncp', 'CHK-FILA-ESGOTADO', 'orgao_cnpj', '99000001000101', 'ano', 2099, 'sequencial', 4,
                       'motivo', 'alterado')));
  if (select status || '|' || tentativas || '|' || coalesce(erro, '-') from private.pca_plano_fila
       where id_pca_pncp = 'CHK-FILA-ESGOTADO') <> 'pendente|0|-' then
    v_falhas := v_falhas || 'reenfileirar linha em erro não zerou tentativas e erro'::text;
  end if;
  -- processando abandonado com tentativas esgotadas (a reserva não pega mais) que recebe trabalho novo recomeça
  update private.pca_plano_fila set erro = 'worker morreu' where id_pca_pncp = 'CHK-FILA-ABANDONADO-ESGOTADO';
  perform private.pca_fila_enfileirar(jsonb_build_array(
    jsonb_build_object('id_pca_pncp', 'CHK-FILA-ABANDONADO-ESGOTADO', 'orgao_cnpj', '99000001000101', 'ano', 2099,
                       'sequencial', 7, 'motivo', 'alterado')));
  if (select status || '|' || tentativas || '|' || coalesce(erro, '-') from private.pca_plano_fila
       where id_pca_pncp = 'CHK-FILA-ABANDONADO-ESGOTADO') <> 'pendente|0|-' then
    v_falhas := v_falhas || 'reenfileirar processando abandonado com tentativas esgotadas não voltou a pendente|0'::text;
  end if;
  -- motivo 'ausente' (sem cabeçalho) não troca o motivo de linha aberta com cabeçalho; sem cabeçalho, troca
  perform private.pca_fila_enfileirar(jsonb_build_array(
    jsonb_build_object('id_pca_pncp', 'CHK-FILA-M', 'orgao_cnpj', '99000001000101', 'ano', 2099, 'sequencial', 8,
                       'motivo', 'alterado', 'plano', '{"x":1}'::jsonb)));
  perform private.pca_fila_enfileirar(jsonb_build_array(
    jsonb_build_object('id_pca_pncp', 'CHK-FILA-M', 'orgao_cnpj', '99000001000101', 'ano', 2099, 'sequencial', 8,
                       'motivo', 'ausente'),
    jsonb_build_object('id_pca_pncp', 'CHK-FILA-B', 'orgao_cnpj', '99000001000101', 'ano', 2099, 'sequencial', 2,
                       'motivo', 'ausente')));
  if (select motivo || '|' || (plano is not null)::text from private.pca_plano_fila
       where id_pca_pncp = 'CHK-FILA-M' and status in ('pendente', 'processando', 'erro')) <> 'alterado|true' then
    v_falhas := v_falhas || 'motivo ausente sobrescreveu o motivo de linha aberta com cabeçalho'::text;
  end if;
  if (select motivo from private.pca_plano_fila
       where id_pca_pncp = 'CHK-FILA-B' and status in ('pendente', 'processando', 'erro')) <> 'ausente' then
    v_falhas := v_falhas || 'motivo ausente não entrou na linha aberta sem cabeçalho'::text;
  end if;

  -- DESC: um contador por escopo de classes, em descoberta_ausente (chave "7220,7830")
  insert into public.pca_planos (id_pca_pncp, ano_exercicio, orgao_cnpj, titulo, payload_hash, ativo, descoberta_ausente)
    values ('CHK-FILA-P-VISTO', 2099, '99000001000101', 'chk', 'chk', true, '{"7830": 3, "7220": 1}'),
           ('CHK-FILA-P-AUSENTE', 2099, '99000001000101', 'chk', 'chk', true, '{"7830": 1}'),
           ('CHK-FILA-P-OUTRA-CLASSE', 2099, '99000001000101', 'chk', 'chk', true, '{}'),
           ('CHK-FILA-P-MISTO', 2099, '99000001000101', 'chk', 'chk', true, '{"7220": 1}');
  select id into v_p1 from public.pca_planos where id_pca_pncp = 'CHK-FILA-P-AUSENTE';
  insert into public.pca_itens (pca_plano_id, numero_item, classe_material_servico, payload_hash, ativo)
    values (v_p1, 1, '7830', 'chk', true),
           ((select id from public.pca_planos where id_pca_pncp = 'CHK-FILA-P-OUTRA-CLASSE'), 1, '7220', 'chk', true),
           ((select id from public.pca_planos where id_pca_pncp = 'CHK-FILA-P-MISTO'), 1, '7830', 'chk', true),
           ((select id from public.pca_planos where id_pca_pncp = 'CHK-FILA-P-MISTO'), 2, '7220', 'chk', true);
  -- descoberta da 7830: só P-VISTO apareceu
  v_n := private.pca_marcar_descoberta(2099, array['CHK-FILA-P-VISTO'], array['7830']);
  if (select descoberta_ausente from public.pca_planos where id_pca_pncp = 'CHK-FILA-P-VISTO') <> '{"7220": 1}' then
    v_falhas := v_falhas || 'plano visto na 7830 não zerou a chave 7830 ou perdeu a ausência da 7220'::text;
  end if;
  if (select descoberta_ausente from public.pca_planos where id_pca_pncp = 'CHK-FILA-P-AUSENTE') <> '{"7830": 2}' then
    v_falhas := v_falhas || 'plano ausente com item 7830 não somou 1 na chave 7830'::text;
  end if;
  if (select descoberta_ausente from public.pca_planos where id_pca_pncp = 'CHK-FILA-P-OUTRA-CLASSE') <> '{}' then
    v_falhas := v_falhas || 'plano só com item de outra classe somou ausência'::text;
  end if;
  if (select descoberta_ausente from public.pca_planos where id_pca_pncp = 'CHK-FILA-P-MISTO')
     <> '{"7220": 1, "7830": 1}' then
    v_falhas := v_falhas || 'descoberta da 7830 mexeu na ausência medida na 7220'::text;
  end if;
  if v_n <> 1 then -- só P-AUSENTE chega a 2 na 7830 (planos reais de 2099 não existem no banco descartável)
    v_falhas := v_falhas || format('marcar_descoberta 7830 devolveu %s ausentes com 2 ou mais (esperado 1)', v_n);
  end if;
  -- descoberta da 7220 sem nenhum plano visto: soma só na chave 7220
  v_n := private.pca_marcar_descoberta(2099, array[]::text[], array['7220']);
  if (select descoberta_ausente from public.pca_planos where id_pca_pncp = 'CHK-FILA-P-MISTO')
     <> '{"7220": 2, "7830": 1}' then
    v_falhas := v_falhas || 'descoberta da 7220 não somou na chave 7220 ou mexeu na 7830'::text;
  end if;
  if v_n <> 1 then -- P-MISTO (7220: 2); P-OUTRA-CLASSE fica em 1
    v_falhas := v_falhas || format('marcar_descoberta 7220 devolveu %s ausentes com 2 ou mais (esperado 1)', v_n);
  end if;
  -- escopo com mais de uma classe: chave ordenada, sem repetição
  if private.pca_escopo_ausencia(array['7830', '7220', '7830']) <> '7220,7830' then
    v_falhas := v_falhas || 'pca_escopo_ausencia não ordenou ou não tirou repetição'::text;
  end if;
  -- zerar a ausência de um escopo não mexe nos outros
  perform private.pca_zerar_ausencia((select id from public.pca_planos where id_pca_pncp = 'CHK-FILA-P-MISTO'),
                                     array['7830']);
  if (select descoberta_ausente from public.pca_planos where id_pca_pncp = 'CHK-FILA-P-MISTO') <> '{"7220": 2}' then
    v_falhas := v_falhas || 'pca_zerar_ausencia não tirou só a chave 7830'::text;
  end if;

  -- LOCK: worker morto (sem heartbeat há 10 min) no meio da descoberta, com a continuation no formato da fila
  insert into private.pncp_sync_run (resource_type, lock_key, status, parametros, iniciada_em, last_heartbeat_at)
  values ('pca', 'pca-fila:2099', 'executando',
          jsonb_build_object('rotina', 'incremental', 'ano', 2099, 'continuation', jsonb_build_object(
            'pending', jsonb_build_array('descoberta', 'fila'), 'rotina', 'incremental',
            'classes', jsonb_build_array('7830'), 'descoberta', jsonb_build_object('classe_idx', 0, 'pagina', 3))),
          now() - interval '20 minutes', now() - interval '10 minutes')
  returning id into v_stale;
  v_lock := private.acquire_sync_lock('pca-fila:2099', 'pca',
    '{"rotina":"incremental","somente_retomada":true,"ano":2099}'::jsonb);
  if coalesce((v_lock->>'already_running')::boolean, true)
     or v_lock->'continuation'->'descoberta'->>'pagina' is distinct from '3'
     or v_lock->'continuation'->>'rotina' is distinct from 'incremental' then
    v_falhas := v_falhas || format('acquire_sync_lock não herdou a continuation da fila: %s', v_lock);
  end if;
  if (select status from private.pncp_sync_run where id = v_stale) <> 'retomada' then
    v_falhas := v_falhas || 'execução stale da fila com pending não virou retomada'::text;
  end if;

  -- CRON (só onde o pg_cron existe)
  if to_regclass('cron.job') is not null then
    select count(*) into v_n from cron.job
     where jobname in ('licitagym-sync-pncp-pca-fila', 'licitagym-sync-pncp-pca-fila-continuacao',
                       'licitagym-sync-pncp-pca-reconciliacao')
       and command like '%"rotina"%';
    if v_n <> 3 then
      v_falhas := v_falhas || format('jobs da fila do PCA: %s de 3 com "rotina"', v_n);
    end if;
  else
    raise notice 'pca_plano_fila_check: sem pg_cron, checagem dos jobs pulada';
  end if;

  if array_length(v_falhas, 1) > 0 then
    raise exception 'ACL CHECK FALHOU (pca_plano_fila): %', array_to_string(v_falhas, '; ');
  end if;
  raise notice 'SUCESSO: pca_plano_fila_check';
end
$chk$;

rollback;
