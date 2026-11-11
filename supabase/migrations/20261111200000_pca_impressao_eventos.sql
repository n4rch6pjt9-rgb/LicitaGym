-- Spec 0056 (PCA em camadas), contrato K-1 e cronograma do K-5.
--
-- Por quê: a descoberta pela consulta /v1/pca/ falha por dias (503 em 07/11) e não diz o que mudou em cada plano.
-- A rotina `impressao` (camada 1) lê `consolidado/unidades` por órgão e guarda uma impressão digital por plano
-- (quantidade, valor total e datas); só o plano novo ou alterado vai para a fila de carga. A carga passa a registrar
-- eventos de negócio (camada 3) em `pca_alteracoes`.
--
-- O que muda:
--   1. private.pca_impressao_plano: impressão por plano (chave orgao_cnpj, ano, sequencial) e contador de leituras
--      seguidas em que o plano gravado não veio na lista do órgão (P-4: duas seguidas inativam).
--   2. private.pca_impressao_orgao: última leitura e último erro de cada órgão (a rotina lê a mais antiga primeiro).
--   3. public.pca_alteracoes: evento, detectado_em, data_fonte, campos_alterados; tipo_operacao aceita 'aviso'
--      (pca_removido "a confirmar"). As linhas antigas ficam com evento e detectado_em nulos.
--      Trigger BEFORE INSERT classifica a linha a partir de tipo_operacao e dos snapshots (a RPC de persistência e o
--      trigger de inativação não mudam).
--   4. public.pca_itens: grupo_contratacao_codigo/nome (literal do DTO, nunca derivado) e data_atualizacao_origem.
--   5. private.pca_plano_fila: motivo 'impressao'.
--   6. Crons: cria impressão (a cada 10 min das 05:00 às 05:50 UTC; cada disparo lê os órgãos ainda não lidos no
--      dia) e descoberta (domingo 04:13 UTC); a continuação da carga passa a cobrir 06:00–08:50 UTC; o incremental
--      pela consulta (licitagym-sync-pncp-pca-fila) e a reconciliação mensal são desligados (active = false, sem
--      unschedule: o rollback é religar). Reaplicar não muda o active de job que já existe.
--
-- Quem lê/escreve: só service_role (Edge Function sync-pncp-pca). anon/authenticated sem acesso às tabelas novas.
-- Como verificar: supabase/tests/pca_impressao_plano_check.sql.

begin;

set local lock_timeout = '10s';

-- 1 e 2. Impressão por plano e por órgão
create table if not exists private.pca_impressao_plano (
  orgao_cnpj text not null,
  ano integer not null,
  sequencial integer not null,
  codigo_unidade text,
  quantidade numeric,
  valor_total numeric,
  data_atualizacao timestamptz,
  data_atualizacao_global timestamptz,
  numero_controle_pncp text,
  ausente_leituras integer not null default 0,
  lido_em timestamptz not null default now(),
  sync_run_id uuid,
  primary key (orgao_cnpj, ano, sequencial)
);

create table if not exists private.pca_impressao_orgao (
  orgao_cnpj text not null,
  ano integer not null,
  lido_em timestamptz,
  planos integer,
  erro text,
  sync_run_id uuid,
  primary key (orgao_cnpj, ano)
);
create index if not exists pca_impressao_orgao_ano_lido_idx on private.pca_impressao_orgao (ano, lido_em);

alter table private.pca_impressao_plano enable row level security;
alter table private.pca_impressao_orgao enable row level security;
revoke all on table private.pca_impressao_plano, private.pca_impressao_orgao from public, anon, authenticated;
grant select, insert, update, delete on table private.pca_impressao_plano, private.pca_impressao_orgao
  to service_role;

-- 3. Eventos em pca_alteracoes
alter table public.pca_alteracoes add column if not exists evento text;
alter table public.pca_alteracoes add column if not exists detectado_em timestamptz;
alter table public.pca_alteracoes add column if not exists data_fonte timestamptz;
alter table public.pca_alteracoes add column if not exists campos_alterados text[];
-- Default só depois do add column: as linhas antigas ficam com detectado_em nulo.
alter table public.pca_alteracoes alter column detectado_em set default now();

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'pca_alteracoes_evento_check'
                    and conrelid = 'public.pca_alteracoes'::regclass) then
    alter table public.pca_alteracoes add constraint pca_alteracoes_evento_check check (evento in (
      'pca_novo', 'pca_atualizado', 'pca_removido', 'item_detectado', 'item_atualizado', 'item_removido',
      'entrou_escopo', 'saiu_escopo'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'pca_alteracoes_tipo_operacao_check'
                    and conrelid = 'public.pca_alteracoes'::regclass
                    and pg_get_constraintdef(oid) like '%aviso%') then
    alter table public.pca_alteracoes drop constraint if exists pca_alteracoes_tipo_operacao_check;
    alter table public.pca_alteracoes add constraint pca_alteracoes_tipo_operacao_check
      check (tipo_operacao in ('insert', 'update', 'inativacao', 'reativacao', 'aviso'));
  end if;
end
$$;

create index if not exists pca_alteracoes_evento_idx on public.pca_alteracoes (evento, detectado_em desc)
  where evento is not null;

-- Regra (espelhada em tests/supabase/functions/_shared/pncp/_fake_pca_eventos.ts):
--   plano: insert → pca_novo; inativacao → pca_removido; update/reativacao com campo de negócio mudado →
--          pca_atualizado; senão nulo.
--   item:  insert → item_detectado; inativacao com classe trocada → saiu_escopo, senão item_removido;
--          update/reativacao com classe trocada → entrou_escopo (só itens do escopo são gravados);
--          reativacao → item_detectado; update com campo de negócio mudado → item_atualizado, senão nulo.
--   Evento já informado (aviso) é mantido. Campos de sync, chave, situação, grupo e data da fonte não contam como
--   mudança de negócio. data_fonte = data_atualizacao_origem do snapshot novo (ou do anterior).
create or replace function private.pca_alteracoes_classificar_evento()
returns trigger language plpgsql security invoker set search_path = ''
as $fn$
declare
  v_ant jsonb := coalesce(new.dados_anteriores, '{}'::jsonb);
  v_nov jsonb := coalesce(new.dados_novos, '{}'::jsonb);
  v_item boolean := new.pca_item_id is not null;
  v_classe_mudou boolean;
  v_campos text[];
  v_texto text;
begin
  new.detectado_em := coalesce(new.detectado_em, now());

  v_texto := nullif(coalesce(v_nov ->> 'data_atualizacao_origem', v_ant ->> 'data_atualizacao_origem'), '');
  if new.data_fonte is null and v_texto is not null then
    begin
      new.data_fonte := v_texto::timestamptz;
    exception when others then
      new.data_fonte := null;
    end;
  end if;

  if new.evento is not null then
    return new;
  end if;

  v_classe_mudou := v_item and new.dados_anteriores is not null
    and (v_ant ->> 'classe_material_servico') is distinct from (v_nov ->> 'classe_material_servico');

  if new.tipo_operacao in ('update', 'reativacao') then
    select array_agg(k order by k) into v_campos
      from (select jsonb_object_keys(v_ant) as k union select jsonb_object_keys(v_nov)) s
     where k <> all (array['id', 'pca_plano_id', 'numero_item', 'payload_hash', 'last_synced_at',
                           'last_seen_sync_id', 'created_at', 'updated_at', 'ativo', 'reprocessar',
                           'descoberta_ausente', 'data_atualizacao_origem', 'grupo_contratacao_codigo',
                           'grupo_contratacao_nome'])
       and (v_ant -> k) is distinct from (v_nov -> k);
  end if;

  if not v_item then
    new.evento := case
      when new.tipo_operacao = 'insert' then 'pca_novo'
      when new.tipo_operacao = 'inativacao' then 'pca_removido'
      when new.tipo_operacao in ('update', 'reativacao') and v_campos is not null then 'pca_atualizado'
    end;
  else
    new.evento := case
      when new.tipo_operacao = 'insert' then 'item_detectado'
      when new.tipo_operacao = 'inativacao' then
        case when v_classe_mudou then 'saiu_escopo' else 'item_removido' end
      when new.tipo_operacao in ('update', 'reativacao') and v_classe_mudou then 'entrou_escopo'
      when new.tipo_operacao = 'reativacao' then 'item_detectado'
      when new.tipo_operacao = 'update' and v_campos is not null then 'item_atualizado'
    end;
  end if;

  if new.evento in ('item_atualizado', 'pca_atualizado') then
    new.campos_alterados := v_campos;
  end if;
  return new;
end;
$fn$;
revoke all on function private.pca_alteracoes_classificar_evento() from public, anon, authenticated;
grant execute on function private.pca_alteracoes_classificar_evento() to service_role;

create or replace trigger pca_alteracoes_classificar_evento
  before insert on public.pca_alteracoes
  for each row execute function private.pca_alteracoes_classificar_evento();

-- A rotina de impressão grava o aviso "a confirmar" direto (service_role).
grant select, insert on table public.pca_alteracoes to service_role;

-- 4. pca_itens
alter table public.pca_itens add column if not exists grupo_contratacao_codigo text;
alter table public.pca_itens add column if not exists grupo_contratacao_nome text;
alter table public.pca_itens add column if not exists data_atualizacao_origem timestamptz;

-- 5. Motivo da fila
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'pca_plano_fila_motivo_check'
                    and conrelid = 'private.pca_plano_fila'::regclass
                    and pg_get_constraintdef(oid) like '%impressao%') then
    alter table private.pca_plano_fila drop constraint if exists pca_plano_fila_motivo_check;
    alter table private.pca_plano_fila add constraint pca_plano_fila_motivo_check
      check (motivo in ('novo', 'alterado', 'backfill', 'reconciliacao', 'ausente', 'impressao'));
  end if;
end
$$;

commit;

-- 6. Crons (fora da transação das tabelas: sem pg_cron, só avisa)
begin;

set local lock_timeout = '10s';

do $do$
declare
  j record;
  v_jobid bigint;
  v_existente bigint;
begin
  if not exists (select 1 from pg_extension where extname = 'pg_cron') then
    raise notice 'pg_cron indisponível: crons da impressão do PCA não agendados neste Postgres.';
    return;
  end if;

  for j in
    select *
      from (values
        ('licitagym-sync-pncp-pca-impressao', '*/10 5 * * *',
         $cmd$select private.cron_chamar_edge('licitagym-sync-pncp-pca-impressao', 'sync-pncp-pca', '{"rotina":"impressao","async":true}'::jsonb, 150000)$cmd$),
        ('licitagym-sync-pncp-pca-descoberta', '13 4 * * 0',
         $cmd$select private.cron_chamar_edge('licitagym-sync-pncp-pca-descoberta', 'sync-pncp-pca', '{"rotina":"descoberta","async":true}'::jsonb, 150000)$cmd$)
      ) as t(nome, agenda, comando)
  loop
    select c.jobid into v_existente from cron.job c where c.jobname = j.nome;
    if v_existente is not null then
      perform cron.alter_job(v_existente, schedule := j.agenda, command := j.comando);
    else
      v_jobid := cron.schedule(j.nome, j.agenda, j.comando);
    end if;
  end loop;

  -- Carga: a continuação (só a fila, sem descoberta) cobre a janela depois da impressão.
  select c.jobid into v_existente from cron.job c where c.jobname = 'licitagym-sync-pncp-pca-fila-continuacao';
  if v_existente is not null then
    perform cron.alter_job(v_existente, schedule := '*/10 6-8 * * *');
  end if;

  -- Substituídos: o incremental pela consulta /v1/pca/ e a reconciliação mensal. Rollback: active := true.
  for j in
    select c.jobid from cron.job c
     where c.jobname in ('licitagym-sync-pncp-pca-fila', 'licitagym-sync-pncp-pca-reconciliacao') and c.active
  loop
    perform cron.alter_job(j.jobid, active := false);
  end loop;
end
$do$;

commit;
