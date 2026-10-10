-- Spec 0012, PR 2 (#289): fila de planos do PCA.
--
-- Por quê: a consulta /pca/ por classe pula itens na paginação (medido em 09/10/2026), então os itens passam a vir da
-- integração por plano (/orgaos/{cnpj}/pca/{ano}/{seq}/itens). A descoberta (consulta por classe) enfileira os planos
-- novos ou alterados; a carga tira planos da fila em fatias cronometradas.
--
-- O que muda:
--   1. private.pca_plano_fila: um plano por linha aberta (pendente, processando ou erro); feito fica como histórico.
--   2. public.pca_planos.descoberta_ausente (jsonb): por escopo de classes ("7220,7830"), quantas descobertas
--      completas seguidas daquele escopo não viram o plano; e reprocessar: a carga falhou depois de gravar o
--      cabeçalho (o incremental reenfileira). A reconciliação só inativa plano ausente em 2 descobertas seguidas do
--      mesmo escopo e sem item do escopo na integração.
--   3. Funções (só service_role, security invoker):
--      private.pca_fila_enfileirar(jsonb), private.pca_fila_reservar(int, int, int) e
--      private.pca_marcar_descoberta(int, text[], text[]) e private.pca_zerar_ausencia(uuid, text[]).
--
-- Quem lê/escreve: só a Edge Function sync-pncp-pca (service_role, por client.schema('private')).
-- Aditiva e idempotente. Nenhum cron muda aqui (ver 20261009210100_cron_pca_fila.sql).
-- Verificar: supabase/tests/pca_plano_fila_check.sql.

begin;

-- O add column em public.pca_planos pede ACCESS EXCLUSIVE: não espera atrás de leitura longa (sync/Dashboard).
set local lock_timeout = '10s';

create table if not exists private.pca_plano_fila (
  id bigint generated always as identity primary key,
  id_pca_pncp text not null,
  orgao_cnpj text not null,
  ano integer not null,
  sequencial integer not null,
  motivo text not null,
  -- cabeçalho do plano como veio da consulta (sem itens); nulo para plano só conhecido do banco (motivo ausente)
  plano jsonb,
  -- classes do escopo com que o plano foi enfileirado: a carga (inclusive a continuação) usa estas
  classes text[] not null default array['7830']::text[],
  data_atualizacao_fonte timestamptz,
  status text not null default 'pendente',
  tentativas integer not null default 0,
  erro text,
  chain_id uuid,
  criado_em timestamptz not null default now(),
  atualizado_em timestamptz not null default now(),
  processado_em timestamptz
);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'pca_plano_fila_motivo_check'
                    and conrelid = 'private.pca_plano_fila'::regclass) then
    alter table private.pca_plano_fila add constraint pca_plano_fila_motivo_check
      check (motivo in ('novo', 'alterado', 'backfill', 'reconciliacao', 'ausente'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'pca_plano_fila_status_check'
                    and conrelid = 'private.pca_plano_fila'::regclass) then
    alter table private.pca_plano_fila add constraint pca_plano_fila_status_check
      check (status in ('pendente', 'processando', 'feito', 'erro'));
  end if;
end
$$;

-- Um plano aberto por vez: reenfileirar atualiza a linha aberta em vez de duplicar.
create unique index if not exists pca_plano_fila_aberto_uq
  on private.pca_plano_fila (id_pca_pncp)
  where status in ('pendente', 'processando', 'erro');

-- Reserva: pendentes e erros por ordem de chegada; saúde (PR 3): abertos antigos.
create index if not exists pca_plano_fila_status_criado_idx
  on private.pca_plano_fila (status, criado_em);

comment on table private.pca_plano_fila is
  'Spec 0012: fila de planos do PCA a carregar pela integração por plano. Escrita só pelo sync-pncp-pca (service_role).';

alter table private.pca_plano_fila enable row level security;
revoke all on table private.pca_plano_fila from PUBLIC, anon, authenticated;
grant select, insert, update on table private.pca_plano_fila to service_role;

-- Um contador por escopo de classes (chave: classes ordenadas, sem repetição, separadas por vírgula). Cada descoberta
-- só lê e escreve a chave do próprio escopo: a da 7830 não zera nem usa a ausência medida só na 7220. Chave ausente
-- vale 0.
alter table public.pca_planos
  add column if not exists descoberta_ausente jsonb not null default '{}'::jsonb;

comment on column public.pca_planos.descoberta_ausente is
  'Spec 0012: {"<classes ordenadas>": n}, descobertas completas seguidas daquele escopo em que o plano não apareceu.';

-- Plano cuja carga falhou depois de gravar o cabeçalho: o incremental o reenfileira mesmo com a data da fonte igual à
-- gravada (a fila pode ter esgotado as tentativas). Fica fora dos campos da fonte (data_atualizacao_origem,
-- payload_hash), que guardam só o último dado oficial gravado. A fila desliga a marca quando o plano termina 'feito'.
alter table public.pca_planos
  add column if not exists reprocessar boolean not null default false;

comment on column public.pca_planos.reprocessar is
  'Spec 0012: carga do plano falhou depois de gravar o cabeçalho; o incremental reenfileira. Desligada quando a fila termina o plano.';

-- Enfileira (ou atualiza a linha aberta de) cada plano. p_itens: array de objetos com id_pca_pncp, orgao_cnpj, ano,
-- sequencial, motivo, plano, classes, data_atualizacao_fonte, chain_id. Linha em processamento recente (< 15 min) não
-- volta para pendente: se ela terminar 'feito' com a versão anterior, a próxima descoberta vê a data maior e
-- reenfileira. Linha pendente, em erro ou processando abandonada (>= 15 min, worker que morreu; com as tentativas
-- esgotadas a reserva não a pega mais) que recebe trabalho novo recomeça as tentativas: a versão nova da fonte não
-- herda as falhas da anterior. Motivo 'ausente' (sem cabeçalho) não troca o motivo de uma linha que já tem cabeçalho:
-- a carga dela grava cabeçalho e itens, que é mais que a do ausente.
create or replace function private.pca_fila_enfileirar(p_itens jsonb)
returns integer
language plpgsql
security invoker
set search_path = ''
as $fn$
declare
  v_total integer;
begin
  insert into private.pca_plano_fila as f
    (id_pca_pncp, orgao_cnpj, ano, sequencial, motivo, plano, classes, data_atualizacao_fonte, chain_id)
  select x.id_pca_pncp, x.orgao_cnpj, x.ano, x.sequencial, x.motivo, x.plano,
         coalesce(x.classes, array['7830']::text[]), x.data_atualizacao_fonte, x.chain_id
    from jsonb_to_recordset(coalesce(p_itens, '[]'::jsonb)) as x(
      id_pca_pncp text, orgao_cnpj text, ano integer, sequencial integer, motivo text,
      plano jsonb, classes text[], data_atualizacao_fonte timestamptz, chain_id uuid)
  on conflict (id_pca_pncp) where status in ('pendente', 'processando', 'erro')
  do update set
    plano = coalesce(excluded.plano, f.plano),
    classes = (select array_agg(distinct c order by c) from unnest(f.classes || excluded.classes) c),
    data_atualizacao_fonte = coalesce(excluded.data_atualizacao_fonte, f.data_atualizacao_fonte),
    motivo = case when excluded.motivo = 'ausente' and f.plano is not null then f.motivo else excluded.motivo end,
    chain_id = excluded.chain_id,
    status = case when f.status = 'processando' and f.atualizado_em >= now() - interval '15 minutes'
                  then f.status else 'pendente' end,
    tentativas = case when f.status = 'processando' and f.atualizado_em >= now() - interval '15 minutes'
                      then f.tentativas else 0 end,
    erro = case when f.status = 'processando' and f.atualizado_em >= now() - interval '15 minutes'
                then f.erro else null end,
    atualizado_em = now();
  get diagnostics v_total = row_count;
  return v_total;
end
$fn$;

-- Reserva até p_limite planos: pendentes, erros com menos de p_max_tentativas e parados há mais de 10 min (recuo
-- entre tentativas: a mesma invocação não repete o plano que acabou de falhar) e processando abandonados (> 15 min,
-- worker que morreu). Abandono conta tentativa: um plano que derruba o worker (CPU/tempo) para em p_max_tentativas
-- em vez de ser reprocessado para sempre. for update skip locked: duas invocações não pegam o mesmo plano.
create or replace function private.pca_fila_reservar(p_limite integer, p_max_tentativas integer default 5,
                                                     p_ano integer default null)
returns setof private.pca_plano_fila
language sql
security invoker
set search_path = ''
as $fn$
  update private.pca_plano_fila f
     set status = 'processando',
         tentativas = f.tentativas + case when f.status = 'processando' then 1 else 0 end,
         atualizado_em = now()
   where f.id in (
     select g.id
       from private.pca_plano_fila g
      where (p_ano is null or g.ano = p_ano)
        and (g.status = 'pendente'
         or (g.status = 'erro' and g.tentativas < p_max_tentativas
             and g.atualizado_em < now() - interval '10 minutes')
         or (g.status = 'processando' and g.tentativas < p_max_tentativas
             and g.atualizado_em < now() - interval '15 minutes'))
      order by g.criado_em, g.id
      limit greatest(p_limite, 0)
      for update skip locked
   )
  returning f.*;
$fn$;

-- Chave do escopo em descoberta_ausente: classes ordenadas, sem repetição, separadas por vírgula.
create or replace function private.pca_escopo_ausencia(p_classes text[])
returns text
language sql
immutable
set search_path = ''
as $fn$
  select coalesce(string_agg(c, ',' order by c), '') from (select distinct c from unnest(p_classes) c) x;
$fn$;

-- Depois de uma descoberta COMPLETA (todas as páginas de todas as classes lidas sem erro), só na chave deste escopo:
-- tira a chave dos planos vistos e soma 1 nos planos ativos do ano, com item ativo das classes descobertas, que não
-- apareceram. Devolve quantos planos ficaram com 2 ou mais ausências seguidas neste escopo.
create or replace function private.pca_marcar_descoberta(p_ano integer, p_vistos text[], p_classes text[])
returns integer
language plpgsql
security invoker
set search_path = ''
as $fn$
declare
  v_ausentes integer;
  v_chave text := private.pca_escopo_ausencia(p_classes);
begin
  update public.pca_planos p
     set descoberta_ausente = p.descoberta_ausente - v_chave
   where p.ano_exercicio = p_ano
     and p.id_pca_pncp = any(p_vistos)
     and p.descoberta_ausente ? v_chave;

  update public.pca_planos p
     set descoberta_ausente = jsonb_set(p.descoberta_ausente, array[v_chave],
                                        to_jsonb(coalesce((p.descoberta_ausente ->> v_chave)::integer, 0) + 1))
   where p.ano_exercicio = p_ano
     and p.ativo
     and not (p.id_pca_pncp = any(p_vistos))
     and exists (
       select 1 from public.pca_itens i
        where i.pca_plano_id = p.id and i.ativo and i.classe_material_servico = any(p_classes)
     );

  select count(*) into v_ausentes
    from public.pca_planos p
   where p.ano_exercicio = p_ano and p.ativo and coalesce((p.descoberta_ausente ->> v_chave)::integer, 0) >= 2;
  return v_ausentes;
end
$fn$;

-- Plano ausente que ainda tem item do escopo na integração: a ausência daquele escopo não vale, zera só a chave dele.
create or replace function private.pca_zerar_ausencia(p_plano_id uuid, p_classes text[])
returns void
language sql
security invoker
set search_path = ''
as $fn$
  update public.pca_planos p
     set descoberta_ausente = p.descoberta_ausente - private.pca_escopo_ausencia(p_classes)
   where p.id = p_plano_id
     and p.descoberta_ausente ? private.pca_escopo_ausencia(p_classes);
$fn$;

comment on function private.pca_fila_enfileirar(jsonb) is 'Spec 0012: enfileira planos do PCA. EXECUTE só service_role.';
comment on function private.pca_fila_reservar(integer, integer, integer) is 'Spec 0012: reserva planos da fila (skip locked). EXECUTE só service_role.';
comment on function private.pca_marcar_descoberta(integer, text[], text[]) is
  'Spec 0012: atualiza descoberta_ausente (chave do escopo) depois de descoberta completa. EXECUTE só service_role.';
comment on function private.pca_zerar_ausencia(uuid, text[]) is
  'Spec 0012: zera a ausência de um plano num escopo de classes. EXECUTE só service_role.';
comment on function private.pca_escopo_ausencia(text[]) is
  'Spec 0012: chave do escopo de classes em pca_planos.descoberta_ausente. EXECUTE só service_role.';

revoke all on function private.pca_fila_enfileirar(jsonb) from PUBLIC, anon, authenticated, service_role;
revoke all on function private.pca_fila_reservar(integer, integer, integer) from PUBLIC, anon, authenticated, service_role;
revoke all on function private.pca_marcar_descoberta(integer, text[], text[]) from PUBLIC, anon, authenticated, service_role;
revoke all on function private.pca_zerar_ausencia(uuid, text[]) from PUBLIC, anon, authenticated, service_role;
revoke all on function private.pca_escopo_ausencia(text[]) from PUBLIC, anon, authenticated, service_role;
grant execute on function private.pca_fila_enfileirar(jsonb) to service_role;
grant execute on function private.pca_fila_reservar(integer, integer, integer) to service_role;
grant execute on function private.pca_marcar_descoberta(integer, text[], text[]) to service_role;
grant execute on function private.pca_zerar_ausencia(uuid, text[]) to service_role;
grant execute on function private.pca_escopo_ausencia(text[]) to service_role;

commit;
