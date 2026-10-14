-- Checagem da spec 0023 (#363): proveniência por linha em licitacoes_externas.
--   CA-1 colunas ingestao_origem (cron|manual|nulo), ingestao_em, payload_hash; view prioridade_efetiva as expõe
--   CA-3 regravação (upsert pelos dois alvos reais: fonte,modulo,id_externo e fonte,codigo_externo) troca origem/hora
--        e não toca created_at/first_seen_at (o determinismo do hash é provado no pytest, não aqui)
--   CA-6 job do pg_cron de sync-portal-compras manda origem "cron" (só onde pg_cron existe)
--   CA-7 anon e authenticated sem SELECT direto na tabela (ACL atual preservada)
-- Fixtures em begin/rollback; trava de 100 linhas em licitacoes_externas (nunca em produção).

begin;

do $$
declare
  v_qtd int;
  v_id bigint;
  v_created timestamptz;
  v_first timestamptz;
  v_hash text := repeat('a', 64);
  v_r record;
  v_cmd text;
  f int := 0;
  n int := 0;
begin
  -- CA-1 --------------------------------------------------------------------------------------------------------
  n := n + 4;
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'licitacoes_externas'
                  and column_name = 'ingestao_origem' and data_type = 'text') then
    f := f + 1; raise notice 'FALHA CA-1: coluna ingestao_origem ausente'; end if;
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'licitacoes_externas'
                  and column_name = 'ingestao_em' and data_type = 'timestamp with time zone') then
    f := f + 1; raise notice 'FALHA CA-1: coluna ingestao_em ausente'; end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.licitacoes_externas'::regclass and contype = 'c'
                  and pg_get_constraintdef(oid) ilike '%ingestao_origem%cron%manual%') then
    f := f + 1; raise notice 'FALHA CA-1: check de ingestao_origem (cron|manual) ausente'; end if;
  if (select count(*) from information_schema.columns where table_schema = 'public'
        and table_name = 'licitacoes_externas_prioridade_efetiva'
        and column_name in ('ingestao_origem', 'ingestao_em', 'payload_hash')) <> 3 then
    f := f + 1; raise notice 'FALHA CA-1: view licitacoes_externas_prioridade_efetiva sem as 3 colunas de proveniência'; end if;

  -- CA-7 --------------------------------------------------------------------------------------------------------
  n := n + 1;
  if has_table_privilege('anon', 'public.licitacoes_externas', 'SELECT')
     or has_table_privilege('authenticated', 'public.licitacoes_externas', 'SELECT') then
    f := f + 1; raise notice 'FALHA CA-7: anon ou authenticated com SELECT direto em licitacoes_externas'; end if;

  -- CA-3 (só se as colunas existem; senão já falhou acima) -------------------------------------------------------
  select count(*) into v_qtd from public.licitacoes_externas;
  if v_qtd > 100 then
    raise exception 'TRAVA DE SEGURANCA: licitacoes_externas tem % linhas (> 100). Abortando para proteger producao.', v_qtd;
  end if;
  if f = 0 then
    n := n + 4;
    insert into public.fontes_externas (slug, entidade, plataforma, base_url, modo_coleta)
    values ('pncp', 'PNCP', 'pncp', 'https://pncp.gov.br', 'automatico') on conflict (slug) do nothing;
    insert into public.licitacoes_externas (fonte, modulo, id_externo, codigo_externo, raw, payload_hash, ingestao_origem, ingestao_em)
    values ('pncp', 1, 23001, 'chk-0023', '{"a": 1}'::jsonb, v_hash, 'manual', timestamptz '2026-10-14 09:00+00')
    returning id, created_at, first_seen_at into v_id, v_created, v_first;
    -- segunda passagem (o coletor faz upsert merge-duplicates: só as colunas enviadas mudam)
    insert into public.licitacoes_externas (fonte, modulo, id_externo, codigo_externo, raw, payload_hash, ingestao_origem, ingestao_em)
    values ('pncp', 1, 23001, 'chk-0023', '{"a": 1}'::jsonb, v_hash, 'cron', timestamptz '2026-10-14 15:30+00')
    on conflict (fonte, modulo, id_externo) do update
      set raw = excluded.raw, payload_hash = excluded.payload_hash,
          ingestao_origem = excluded.ingestao_origem, ingestao_em = excluded.ingestao_em;
    select * into v_r from public.licitacoes_externas where id = v_id;
    if v_r.payload_hash <> v_hash then f := f + 1; raise notice 'FALHA CA-3: hash mudou com raw igual'; end if;
    if v_r.ingestao_origem <> 'cron' or v_r.ingestao_em <> timestamptz '2026-10-14 15:30+00' then
      f := f + 1; raise notice 'FALHA CA-3: origem/hora nao sao da passagem nova (% %)', v_r.ingestao_origem, v_r.ingestao_em; end if;
    if v_r.created_at <> v_created or v_r.first_seen_at <> v_first then
      f := f + 1; raise notice 'FALHA CA-3: created_at/first_seen_at mudaram na regravacao'; end if;
    -- terceira passagem pelo alvo do coletor PNCP (pncp.py: on_conflict=fonte,codigo_externo)
    n := n + 1;
    insert into public.licitacoes_externas (fonte, codigo_externo, raw, payload_hash, ingestao_origem, ingestao_em)
    values ('pncp', 'chk-0023', '{"a": 2}'::jsonb, repeat('b', 64), 'manual', timestamptz '2026-10-14 18:00+00')
    on conflict (fonte, codigo_externo) do update
      set raw = excluded.raw, payload_hash = excluded.payload_hash,
          ingestao_origem = excluded.ingestao_origem, ingestao_em = excluded.ingestao_em;
    select * into v_r from public.licitacoes_externas where id = v_id;
    if v_r.payload_hash <> repeat('b', 64) or v_r.ingestao_origem <> 'manual'
       or v_r.ingestao_em <> timestamptz '2026-10-14 18:00+00' or v_r.created_at <> v_created then
      f := f + 1; raise notice 'FALHA CA-3: regravacao pelo alvo fonte,codigo_externo nao atualizou a proveniencia'; end if;
    -- nulo permitido (linha anterior à spec)
    n := n + 1;
    update public.licitacoes_externas set ingestao_origem = null, ingestao_em = null where id = v_id;
    if (select ingestao_origem from public.licitacoes_externas where id = v_id) is not null then
      f := f + 1; raise notice 'FALHA CA-1: ingestao_origem nao aceita nulo'; end if;
    begin
      update public.licitacoes_externas set ingestao_origem = 'robo' where id = v_id;
      f := f + 1; raise notice 'FALHA CA-1: ingestao_origem aceitou valor fora de cron|manual';
    exception when check_violation then null;
    end;
  end if;

  -- CA-6 --------------------------------------------------------------------------------------------------------
  n := n + 1;
  if to_regclass('cron.job') is null then
    raise notice 'CA-6: cron.job ausente neste Postgres; corpo do job só é conferido onde pg_cron existe.';
  else
    select command into v_cmd from cron.job where jobname = 'licitagym-sync-portal-compras';
    if v_cmd is null or v_cmd not ilike '%"origem"%cron%' then
      f := f + 1; raise notice 'FALHA CA-6: job licitagym-sync-portal-compras sem origem cron no corpo: %', v_cmd; end if;
  end if;

  if f > 0 then
    raise exception 'CHECK FALHOU: proveniencia_oportunidades % checagens, % falhas', n, f;
  end if;
  raise notice 'SUCESSO: proveniencia_oportunidades % checagens, 0 falhas (CA-1, CA-3, CA-6, CA-7 da spec 0023)', n;
end
$$;

rollback;
