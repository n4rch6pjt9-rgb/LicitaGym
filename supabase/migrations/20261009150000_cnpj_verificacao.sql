-- Verificação local de CNPJ (spec specs/0008-verificacao-cnpj-brasilapi.md, entrega 1).
--
-- Contexto (medição só leitura em produção, 09/10/2026): 9 CNPJs de 14 dígitos com DV inválido em orgaos.cnpj
-- (de 11.736); 0 em fornecedores, licitacao_resultados, precos_praticados_itens e licitacoes_externas. 0 órgãos do
-- PCA sem nome; pca_pgc_itens vazia. O Marcelo decidiu: Edge Function, só verificação local agora, BrasilAPI quando o
-- PGC entrar (entrega 2; as colunas da consulta já existem e ficam nulas).
--
-- O que muda:
--   1. private.cnpj_verificacao: um registro por CNPJ que precisa de verificação, com status, motivos e onde aparece.
--      RLS ligada, sem policy; só service_role (a Edge Function sync-cnpj-verificacao).
--   2. private.cnpj_verificacao_atualizar(): lê as colunas de CNPJ das tabelas de dado oficial (só leitura), aplica
--      private.cnpj_valido (#262) aos valores com 14 dígitos (CPF fica de fora) e faz upsert dos alvos:
--        dv_invalido       DV inválido em qualquer coluna listada              -> status 'dv_invalido'
--        orgao_sem_nome    órgão de plano PCA ativo sem título nem nome/razão em orgaos (DV válido)
--        pgc_pncp_sem_par  órgão do PGC sem plano PNCP ativo no mesmo ano (DV válido)
--      DV válido com motivo -> 'aguardando_consulta' (a entrega 2 consulta a BrasilAPI). Não muda status já consultado
--      (ok / nao_encontrado / erro_consulta). Não altera nenhuma tabela de dado oficial; não apaga nada: quem sai do
--      alvo mantém a linha com ultima_vez_no_alvo antiga.
--   3. Cron semanal chamando a Edge Function (sem pg_cron, avisa e segue, como 20261004004000).
-- Idempotente. Verificação: supabase/tests/cnpj_verificacao_check.sql.

begin;

set local lock_timeout = '5s';

create table if not exists private.cnpj_verificacao (
  cnpj text primary key check (cnpj ~ '^\d{14}$'),
  dv_valido boolean not null,
  status text not null check (status in ('dv_invalido', 'aguardando_consulta', 'ok', 'nao_encontrado', 'erro_consulta')),
  motivos text[] not null check (motivos <@ array['dv_invalido', 'orgao_sem_nome', 'pgc_pncp_sem_par']::text[]
                                 and cardinality(motivos) > 0),
  ocorrencias jsonb not null default '{}'::jsonb,
  primeira_vez_em timestamptz not null default now(),
  ultima_vez_no_alvo timestamptz not null default now(),
  -- Entrega 2 (BrasilAPI): nulas até a consulta existir. Fonte externa não oficial; nunca sobrescreve dado oficial.
  fonte text check (fonte is null or fonte = 'brasilapi'),
  http_status integer,
  situacao_cadastral text,
  razao_social text,
  nome_fantasia text,
  municipio text,
  uf text,
  natureza_juridica text,
  resposta jsonb,
  consultado_em timestamptz,
  erro text
);

comment on table private.cnpj_verificacao is
  'CNPJs que a base não confirma sozinha (spec 0008): DV inválido, órgão sem nome, órgão do PGC sem par no PNCP. Só service_role. Colunas da BrasilAPI (fonte externa, não oficial) ficam nulas até a entrega 2.';

alter table private.cnpj_verificacao enable row level security;
revoke all on table private.cnpj_verificacao from PUBLIC, anon, authenticated;
grant select, insert, update, delete on table private.cnpj_verificacao to service_role;

create or replace function private.cnpj_verificacao_atualizar()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_agora timestamptz := clock_timestamp();
  v_res jsonb;
begin
  with ocorr as (
    select 'orgaos.cnpj' as origem, regexp_replace(cnpj, '\D', '', 'g') as c from public.orgaos
    union all select 'pca_planos.orgao_cnpj', regexp_replace(orgao_cnpj, '\D', '', 'g') from public.pca_planos
    union all select 'pca_pgc_itens.orgao_cnpj', regexp_replace(orgao_cnpj, '\D', '', 'g') from public.pca_pgc_itens
    union all select 'licitacoes_externas.orgao_cnpj', regexp_replace(orgao_cnpj, '\D', '', 'g') from public.licitacoes_externas
    union all select 'contratacoes_editais.orgao_cnpj', regexp_replace(orgao_cnpj, '\D', '', 'g') from public.contratacoes_editais
    union all select 'fornecedores.cnpj', regexp_replace(cnpj, '\D', '', 'g') from public.fornecedores
    union all select 'licitacao_resultados.fornecedor_cnpj', regexp_replace(fornecedor_cnpj, '\D', '', 'g') from public.licitacao_resultados
    union all select 'homologacoes_itens.fornecedor_cnpj', regexp_replace(fornecedor_cnpj, '\D', '', 'g') from public.homologacoes_itens
    union all select 'precos_praticados_itens.ni_fornecedor', regexp_replace(ni_fornecedor, '\D', '', 'g') from public.precos_praticados_itens
    union all select 'atas_rp_itens.ni_fornecedor', regexp_replace(ni_fornecedor, '\D', '', 'g') from public.atas_rp_itens
    union all select 'contratacoes_atas.ni_fornecedor', regexp_replace(ni_fornecedor, '\D', '', 'g') from public.contratacoes_atas
    union all select 'resultados_itens_14133.ni_fornecedor', regexp_replace(ni_fornecedor, '\D', '', 'g') from public.resultados_itens_14133
  ),
  ocorr14 as (
    select origem, c, count(*)::int as n from ocorr where c ~ '^\d{14}$' group by origem, c
  ),
  dv as (
    select d.c, private.cnpj_valido(d.c) as valido from (select distinct c from ocorr14) d
  ),
  sem_nome as (
    select distinct regexp_replace(pl.orgao_cnpj, '\D', '', 'g') as c
      from public.pca_planos pl
      left join public.orgaos o on regexp_replace(o.cnpj, '\D', '', 'g') = regexp_replace(pl.orgao_cnpj, '\D', '', 'g')
     where pl.ativo
     group by pl.orgao_cnpj, pl.titulo
    having coalesce(nullif(btrim(pl.titulo), ''),
                    max(nullif(btrim(o.nome_orgao), '')),
                    max(nullif(btrim(o.razao_social), ''))) is null
  ),
  pgc_sem_par as (
    select distinct regexp_replace(p.orgao_cnpj, '\D', '', 'g') as c
      from public.pca_pgc_itens p
     where not exists (select 1 from public.pca_planos pl
                        where pl.ativo
                          and regexp_replace(pl.orgao_cnpj, '\D', '', 'g') = regexp_replace(p.orgao_cnpj, '\D', '', 'g')
                          and pl.ano_exercicio = p.ano_pca_projeto_compra)
  ),
  alvo as (
    select d.c, d.valido,
           array_remove(array[
             case when not d.valido then 'dv_invalido' end,
             case when d.valido and d.c in (select c from sem_nome) then 'orgao_sem_nome' end,
             case when d.valido and d.c in (select c from pgc_sem_par) then 'pgc_pncp_sem_par' end
           ], null) as motivos,
           (select jsonb_object_agg(o.origem, o.n) from ocorr14 o where o.c = d.c) as ocorrencias
      from dv d
  )
  insert into private.cnpj_verificacao as cv
         (cnpj, dv_valido, status, motivos, ocorrencias, primeira_vez_em, ultima_vez_no_alvo)
  select a.c, a.valido, case when a.valido then 'aguardando_consulta' else 'dv_invalido' end,
         a.motivos, coalesce(a.ocorrencias, '{}'::jsonb), v_agora, v_agora
    from alvo a
   where cardinality(a.motivos) > 0
  on conflict (cnpj) do update
     set dv_valido = excluded.dv_valido,
         motivos = excluded.motivos,
         ocorrencias = excluded.ocorrencias,
         ultima_vez_no_alvo = excluded.ultima_vez_no_alvo,
         -- DV é determinístico; status já consultado (entrega 2) não volta para aguardando
         status = case when not excluded.dv_valido then 'dv_invalido'
                       when cv.status = 'dv_invalido' then 'aguardando_consulta'
                       else cv.status end;

  select jsonb_build_object(
           'dv_invalido', count(*) filter (where status = 'dv_invalido'),
           'aguardando_consulta', count(*) filter (where status = 'aguardando_consulta'),
           'total', count(*),
           'executado_em', v_agora)
    into v_res
    from private.cnpj_verificacao
   where ultima_vez_no_alvo = v_agora;
  return v_res;
end
$fn$;

comment on function private.cnpj_verificacao_atualizar() is
  'Spec 0008: recalcula os alvos de verificação de CNPJ (DV inválido, órgão do PCA sem nome, órgão do PGC sem par no PNCP) a partir das tabelas de dado oficial, só leitura nelas; upsert em private.cnpj_verificacao. EXECUTE só service_role.';

revoke all on function private.cnpj_verificacao_atualizar() from PUBLIC, anon, authenticated, service_role;
grant execute on function private.cnpj_verificacao_atualizar() to service_role;

-- Cron semanal (segunda, 06:37 UTC). Sem pg_cron (Postgres descartável), avisa e segue.
do $do$
declare
  v_existente bigint;
  v_cmd text := $cmd$select private.cron_chamar_edge('licitagym-sync-cnpj-verificacao', 'sync-cnpj-verificacao', '{}'::jsonb, 60000)$cmd$;
begin
  if not exists (select 1 from pg_extension where extname = 'pg_cron') then
    raise notice 'pg_cron indisponível: job licitagym-sync-cnpj-verificacao não agendado neste Postgres.';
    return;
  end if;
  select jobid into v_existente from cron.job where jobname = 'licitagym-sync-cnpj-verificacao';
  if v_existente is not null then
    perform cron.alter_job(v_existente, schedule := '37 6 * * 1', command := v_cmd);
  else
    perform cron.schedule('licitagym-sync-cnpj-verificacao', '37 6 * * 1', v_cmd);
  end if;
end
$do$;

commit;
