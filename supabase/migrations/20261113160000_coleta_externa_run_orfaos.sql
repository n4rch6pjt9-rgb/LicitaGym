-- LicitaGym, spec 0063: execução órfã do coletor do Sistema S e o sesc_senac_rs fora do limite do runner.
--
-- Contexto (medido em 13/11/2026): uma linha do sesc_senac_rs em private.coleta_externa_run ficou 'executando' desde
-- 12/11 18:18 UTC. O job do GitHub foi cancelado no limite de tempo antes do coleta_externa_finalizar, e
-- coleta_externa_iniciar (20261108170000) só fecha órfã da mesma fonte, que saiu do lote agendado em 12/11. A saúde
-- não via: nenhuma métrica olha execução presa, e coleta_externa_dias_sem_sucesso só considerava fontes que já
-- tinham concluído alguma vez.
--
-- O que muda:
--   K-1 public.coleta_externa_iniciar fecha como 'incompleta' toda execução 'executando' há mais de 6 h, de qualquer
--       fonte, antes de abrir a nova (chama a função do K-2: a regra fica num lugar só). Assinatura, retorno e ACL
--       inalterados (EXECUTE só service_role).
--   K-2 private.coleta_externa_fechar_orfaos() -> integer (linhas fechadas). Sem EXECUTE para anon, authenticated
--       nem service_role: roda pelo job licitagym-coleta-externa-orfaos (pg_cron, minuto 23 de toda hora) e por
--       dentro do coleta_externa_iniciar (security definer, dono postgres).
--   K-3 verificação coleta_externa_executando_horas (atenção 2 h, crítico 7 h; decisão do Marcelo de 13/11/2026).
--   K-7 coleta_externa_dias_sem_sucesso cobra toda fonte ativa do coletor Paradigma (ativo, plataforma paradigma,
--       modo_coleta <> 'bloqueado'); fonte ativa sem conclusão = sem dado (crítico). fiergs, fiemt e sesc_senac_rs
--       passam a ativo = false (decisão de 13/11/2026). Nenhum código de coleta lê ativo: a coleta não muda.
--   K-6 (disparo agendado do sesc_senac_rs) saiu da spec 0063 e foi para a spec 0064 (coleta do Sistema S por
--       portal e em camadas; decisão do Marcelo de 13/11/2026).
--   private.saude_operacional_resumo() é recriada a partir da definição de produção (20261111120000), mudando só o
--   bloco da coleta externa.
--
-- Escreve: private.coleta_externa_run (fechamento de órfãs, inclusive uma vez no próprio deploy; índice parcial
-- coleta_externa_run_executando_idx), private.saude_limiares (1 linha nova, sem sobrescrever
-- limiar editado), public.fontes_externas.ativo (3 linhas). Lê: saúde operacional (só service_role, api-saude).
-- Verificação: supabase/tests/coleta_externa_run_rpc_check.sql, coleta_externa_orfaos_check.sql e
-- saude_coleta_externa_executando_check.sql. Contagem antes/depois em produção (no PR):
--   select count(*) from private.coleta_externa_run where status = 'executando' and started_at < now() - interval '6 hours';
--
-- Idempotente: create or replace, insert ... on conflict do nothing, update só onde ainda está ativo, job por
-- cron.alter_job quando já existe.
--
-- ROLLBACK (não executado):
--   select cron.unschedule(jobid) from cron.job where jobname = 'licitagym-coleta-externa-orfaos';
--   reaplicar public.coleta_externa_iniciar de 20261108170000 e private.saude_operacional_resumo de 20261111120000;
--   drop function if exists private.coleta_externa_fechar_orfaos();
--   drop index if exists private.coleta_externa_run_executando_idx;
--   delete from private.saude_limiares where verificacao = 'coleta_externa_executando_horas';
--   update public.fontes_externas set ativo = true where slug in ('fiergs', 'fiemt', 'sesc_senac_rs');

begin;

set local lock_timeout = '10s';

-- K-2 ------------------------------------------------------------------------------------------------------------
create or replace function private.coleta_externa_fechar_orfaos()
returns integer
language plpgsql
volatile
security invoker
set search_path = pg_catalog, pg_temp
as $fn$
declare
  v_n integer;
begin
  update private.coleta_externa_run r
     set status = 'incompleta', finished_at = now(),
         detalhe_erros = coalesce(r.detalhe_erros, '{}'::jsonb)
                         || jsonb_build_object('erro', 'execução não fechada em 6 h (processo interrompido)')
   where r.status = 'executando' and r.started_at < now() - interval '6 hours';
  get diagnostics v_n = row_count;
  return v_n;
end
$fn$;

comment on function private.coleta_externa_fechar_orfaos() is
  'Spec 0063 K-2. Fecha como incompleta toda execução de private.coleta_externa_run em executando há mais de 6 h '
  '(processo morto pelo runner) e devolve quantas fechou. Só o dono (postgres): job licitagym-coleta-externa-orfaos '
  'e public.coleta_externa_iniciar.';

revoke all on function private.coleta_externa_fechar_orfaos() from public, anon, authenticated, service_role;

-- Filtro do job, do iniciar e da saúde (status = 'executando'): índice parcial, pequeno (só execuções abertas).
create index if not exists coleta_externa_run_executando_idx
  on private.coleta_externa_run (started_at) where status = 'executando';

-- Fecha já no deploy a órfã que existir (a do sesc_senac_rs, aberta desde 12/11): sem isso, a verificação nova do
-- K-3 ficaria crítica até o primeiro minuto 23 e o saude.yml abriria um alerta falso. Idempotente (só 'executando').
select private.coleta_externa_fechar_orfaos();

-- K-1 ------------------------------------------------------------------------------------------------------------
create or replace function public.coleta_externa_iniciar(p_fonte text, p_modo text, p_termos text[] default null)
returns bigint
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
as $fn$
declare
  v_id bigint;
begin
  if p_fonte is null or p_modo is null then
    raise exception 'coleta_externa_iniciar: fonte e modo são obrigatórios' using errcode = '22004';
  end if;
  -- Spec 0063 K-1: órfã de qualquer fonte (a que saiu do lote não abre execução nova para se fechar).
  perform private.coleta_externa_fechar_orfaos();
  insert into private.coleta_externa_run (fonte, modo, status, termos)
  values (p_fonte, p_modo, 'executando', p_termos)
  returning id into v_id;
  return v_id;
end
$fn$;

comment on function public.coleta_externa_iniciar(text, text, text[]) is
  'Abre uma execução do coletor do Sistema S em private.coleta_externa_run (status executando), depois de fechar as '
  'execuções órfãs (> 6 h) de qualquer fonte. Só service_role.';

revoke all on function public.coleta_externa_iniciar(text, text, text[]) from public, anon, authenticated;
grant execute on function public.coleta_externa_iniciar(text, text, text[]) to service_role;

-- K-7: fontes fora da coleta agendada deixam de ser cobradas pela saúde ----------------------------------------------
update public.fontes_externas
   set ativo = false, updated_at = now()
 where slug in ('fiergs', 'fiemt', 'sesc_senac_rs') and ativo;

-- K-3: limiar -----------------------------------------------------------------------------------------------------
insert into private.saude_limiares (verificacao, descricao, unidade, atencao, critico, sem_dado) values
  ('coleta_externa_executando_horas', 'Horas da execução do Sistema S em andamento mais antiga', 'horas', 2, 7, 'atencao')
on conflict (verificacao) do nothing;

create or replace function private.saude_operacional_resumo()
returns table (verificacao text, status text, valor numeric, unidade text, atencao numeric, critico numeric,
               mensagem text, detalhe jsonb)
language plpgsql
stable
security definer
set search_path = pg_catalog, pg_temp
as $fn$
#variable_conflict use_column
declare
  m jsonb := '[]'::jsonb;   -- [{verificacao, valor, detalhe}]
  v numeric;
  d jsonb;
  n_com bigint;
  n_total bigint;
  total_estimado boolean;
begin
  if to_regclass('cron.job_run_details') is not null then
    execute $q$
      select count(*), coalesce(jsonb_agg(jsonb_build_object('job', j.jobname, 'em', r.start_time,
                                          'erro', left(r.return_message, 200)) order by r.start_time desc), '[]'::jsonb)
        from cron.job_run_details r join cron.job j on j.jobid = r.jobid
       where j.jobname like 'licitagym-%' and r.status = 'failed' and r.start_time > now() - interval '24 hours'$q$
      into v, d;
    m := m || jsonb_build_array(jsonb_build_object('verificacao', 'cron_falhas_24h', 'valor', v, 'detalhe', d));
  end if;

  if to_regclass('private.cron_edge_chamadas') is not null then
    select count(*), coalesce(jsonb_agg(jsonb_build_object('job', c.job, 'funcao', c.funcao, 'http', c.status_code,
                                        'timeout', c.timed_out, 'erro', left(coalesce(c.erro, c.resposta), 200),
                                        'em', c.chamado_em) order by c.chamado_em desc), '[]'::jsonb)
      into v, d
      from private.cron_edge_chamadas c
     where c.chamado_em > now() - interval '24 hours'
       and (c.status_code >= 400 or c.timed_out or c.erro is not null);
    m := m || jsonb_build_array(jsonb_build_object('verificacao', 'cron_http_erros_24h', 'valor', v, 'detalhe', d));

    select count(*), coalesce(jsonb_agg(jsonb_build_object('job', c.job, 'funcao', c.funcao, 'em', c.chamado_em)), '[]'::jsonb)
      into v, d
      from private.cron_edge_chamadas c
     where c.respondido_em is null and c.chamado_em < now() - interval '30 minutes'
       and c.chamado_em > now() - interval '7 days';
    m := m || jsonb_build_array(jsonb_build_object('verificacao', 'cron_sem_resposta', 'valor', v, 'detalhe', d));
  end if;

  select round(max(extract(epoch from now() - coalesce(r.last_heartbeat_at, r.iniciada_em)) / 60)),
         coalesce(jsonb_agg(jsonb_build_object('id', r.id, 'resource', r.resource_type,
                            'heartbeat', coalesce(r.last_heartbeat_at, r.iniciada_em))), '[]'::jsonb)
    into v, d
    from private.pncp_sync_run r where r.status = 'executando';
  m := m || jsonb_build_array(jsonb_build_object('verificacao', 'pncp_sync_heartbeat_parado', 'valor', coalesce(v, 0), 'detalhe', d));

  select count(*), coalesce(jsonb_agg(jsonb_build_object('id', r.id, 'resource', r.resource_type,
                                      'erro', left(r.erro_principal, 200), 'em', r.iniciada_em)), '[]'::jsonb)
    into v, d
    from private.pncp_sync_run r where r.status = 'falhou' and r.iniciada_em > now() - interval '24 hours';
  m := m || jsonb_build_array(jsonb_build_object('verificacao', 'pncp_sync_falhas_24h', 'valor', v, 'detalhe', d));

  select max(t.dias), jsonb_object_agg(t.resource_type, t.dias)
    into v, d
    from (select x.resource_type,
                 round((extract(epoch from now() - max(r.finalizada_em)) / 86400)::numeric, 1) as dias
            from (values ('pca'), ('orgaos'), ('compras_catmat')) x(resource_type)
            left join private.pncp_sync_run r
              on r.resource_type = x.resource_type and r.status in ('concluida', 'concluida_com_erros')
           group by x.resource_type) t;
  m := m || jsonb_build_array(jsonb_build_object('verificacao', 'pncp_sync_dias_sem_sucesso', 'valor', v, 'detalhe', d));

  if to_regclass('private.coleta_externa_run') is not null then
    -- Spec 0063, K-7: cobra toda fonte ativa do coletor Paradigma (fontes_externas.ativo, plataforma paradigma, modo
    -- de coleta diferente de 'bloqueado'). Valor = dias da pior fonte; fonte ativa sem nenhuma conclusão deixa o valor
    -- sem dado (crítico pelo limiar) e aparece com data nula no detalhe. Nenhuma fonte ativa = sem dado.
    select case when count(*) = 0 or bool_or(t.ultima is null) then null
                else round((extract(epoch from now() - min(t.ultima)) / 86400)::numeric, 1) end,
           coalesce(jsonb_object_agg(t.slug, t.ultima), '{}'::jsonb)
      into v, d
      from (select f.slug, max(r.finished_at) as ultima
              from public.fontes_externas f
              left join private.coleta_externa_run r
                on r.fonte = f.slug and r.status in ('concluida', 'concluida_com_erros')
             where f.ativo and f.plataforma = 'paradigma' and f.modo_coleta <> 'bloqueado'
             group by f.slug) t;
    m := m || jsonb_build_array(jsonb_build_object('verificacao', 'coleta_externa_dias_sem_sucesso', 'valor', v, 'detalhe', d));

    -- Spec 0063, K-3: horas da execução em andamento mais antiga (0 sem nenhuma); detalhe = início por fonte. Pega
    -- execução presa que o fechamento de órfãs (6 h, de hora em hora) ainda não fechou ou não consegue fechar.
    select coalesce(round((extract(epoch from now() - min(t.desde)) / 3600)::numeric, 1), 0),
           coalesce(jsonb_object_agg(t.fonte, t.desde), '{}'::jsonb)
      into v, d
      from (select fonte, min(started_at) as desde
              from private.coleta_externa_run where status = 'executando'
             group by fonte) t;
    m := m || jsonb_build_array(jsonb_build_object('verificacao', 'coleta_externa_executando_horas', 'valor', v, 'detalhe', d));
  end if;

  if to_regclass('public.precos_praticados_itens') is not null then
    -- Pesquisa de Preço (spec 0009): dias desde a última gravação de preço. last_synced_at só muda quando o upsert
    -- do coletor grava; uma coleta que falha inteira não move a data. Nenhum preço = sem dado (crítico).
    select round((extract(epoch from now() - max(p.last_synced_at)) / 86400)::numeric, 1),
           jsonb_build_object(
             'ultima_coleta', max(p.last_synced_at),
             'linhas', count(*),
             'sem_descricao_detalhada', count(*) filter (where nullif(btrim(p.descricao_detalhada_item), '') is null),
             'detalhe_sincronizado', count(*) filter (where p.detalhe_sincronizado_em is not null))
      into v, d
      from public.precos_praticados_itens p;
    m := m || jsonb_build_array(jsonb_build_object('verificacao', 'precos_dias_sem_coleta', 'valor', v, 'detalhe', d));
  end if;

  if to_regclass('public.pca_pgc_itens') is not null then
    -- PGC (spec 0057): dias desde a última gravação do coletor compras_pgc. O upsert regrava last_synced_at de toda
    -- linha lida; uma coleta que falha inteira não move a data. Nenhuma linha = sem dado (atenção, pelo limiar).
    select round((extract(epoch from now() - max(p.last_synced_at)) / 86400)::numeric, 1),
           jsonb_build_object('ultima_coleta', max(p.last_synced_at), 'linhas', count(*))
      into v, d
      from public.pca_pgc_itens p;
    m := m || jsonb_build_array(jsonb_build_object('verificacao', 'pgc_dias_sem_coleta', 'valor', v, 'detalhe', d));
  end if;

  select round((extract(epoch from now() - max(l.created_at)) / 3600)::numeric, 1),
         coalesce((select jsonb_object_agg(f.fonte, f.ultima)
                     from (select fonte, max(created_at) as ultima from public.licitacoes_externas group by fonte) f), '{}'::jsonb)
    into v, d
    from public.licitacoes_externas l;
  m := m || jsonb_build_array(jsonb_build_object('verificacao', 'licitacoes_horas_sem_novas', 'valor', v, 'detalhe', d));

  -- Itens sem taxonomia: conta exato só os itens COM taxonomia (poucos), pelo índice de expressão
  -- licitacao_itens_no_taxonomia_efetiva_idx (o predicado repete a expressão do índice). O total vem da estimativa
  -- do planner (pg_class.reltuples, mantida por autovacuum/analyze) e o detalhe diz isso em total_estimado.
  -- Tabela nunca analisada (reltuples < 0): conta exato, porque aí ela ainda é pequena.
  select count(*) into n_com
    from public.licitacao_itens i
   where coalesce(i.no_taxonomia, i.taxonomia ->> 'no_taxonomia') is not null;
  select c.reltuples::bigint into n_total from pg_class c where c.oid = 'public.licitacao_itens'::regclass;
  total_estimado := coalesce(n_total, -1) >= 0;
  if not total_estimado then
    select count(*) into n_total from public.licitacao_itens;
  end if;
  n_total := greatest(n_total, n_com);
  v := round(100.0 * (n_total - n_com) / nullif(n_total, 0), 1);
  d := jsonb_build_object('itens', n_total, 'sem_taxonomia', n_total - n_com, 'com_taxonomia', n_com,
                          'total_estimado', total_estimado);
  m := m || jsonb_build_array(jsonb_build_object('verificacao', 'itens_sem_taxonomia_pct', 'valor', v, 'detalhe', d));

  return query
    with medidas as (
      select e ->> 'verificacao' as verificacao, (e ->> 'valor')::numeric as valor, e -> 'detalhe' as detalhe
        from jsonb_array_elements(m) e
    ), avaliadas as (
      select x.verificacao,
             case when x.valor is null then l.sem_dado
                  when l.critico is not null and x.valor >= l.critico then 'critico'
                  when x.valor >= l.atencao then 'atencao'
                  else 'ok' end as status,
             x.valor, l.unidade, l.atencao, l.critico, l.descricao, x.detalhe
        from medidas x join private.saude_limiares l on l.verificacao = x.verificacao
       where l.ativo
    )
    select a.verificacao, a.status, a.valor, a.unidade, a.atencao, a.critico,
           a.descricao || ': ' || coalesce(a.valor::text || ' ' || a.unidade, 'sem dado') ||
             ' (atenção ≥ ' || a.atencao || coalesce(', crítico ≥ ' || a.critico, '') || ')',
           a.detalhe
      from avaliadas a
     order by case a.status when 'critico' then 0 when 'atencao' then 1 else 2 end, a.verificacao;
end

$fn$;

comment on function private.saude_operacional_resumo() is
  'Verificações de saúde da ingestão (cron, sync PNCP, coleta externa, coleta de preços, PGC, volume, taxonomia) com '
  'status por limiar de private.saude_limiares. Só leitura. EXECUTE só service_role (api-saude).';

revoke all on function private.saude_operacional_resumo() from public, anon, authenticated;
grant execute on function private.saude_operacional_resumo() to service_role;

-- K-2: job do pg_cron -------------------------------------------------------------------------------------
do $do$
declare
  j record;
  v_existente bigint;
begin
  if not exists (select 1 from pg_extension where extname = 'pg_cron') then
    begin
      create extension if not exists pg_cron with schema pg_catalog;
    exception
      when undefined_object
        or invalid_parameter_value
        or undefined_function
        or invalid_schema_name
        or feature_not_supported then
      raise notice 'pg_cron indisponível (%): job de órfãs da coleta externa não agendado neste Postgres.', sqlerrm;
      return;
    end;
  end if;

  for j in
    select *
      from (values
        ('licitagym-coleta-externa-orfaos', '23 * * * *',
         $cmd$select private.coleta_externa_fechar_orfaos()$cmd$)
      ) as t(nome, agenda, comando)
  loop
    select c.jobid into v_existente from cron.job c where c.jobname = j.nome;
    if v_existente is not null then
      -- Reaplicar não religa um job desligado à mão: só agenda e comando.
      perform cron.alter_job(v_existente, schedule := j.agenda, command := j.comando);
    else
      perform cron.schedule(j.nome, j.agenda, j.comando);
    end if;
  end loop;
end
$do$;

commit;
