-- -----------------------------------------------------------------------------
-- Versionada em 29/09/2026 a partir do coletor do Sistema S
-- (n4rch6pjt9-rgb/licitagym-coletor-sistema-s, licitagym-coletor/migrations/20260925120000_sistema_s_coleta_externa.sql, commit 8925abf).
-- JÁ APLICADA em produção pelo SQL Editor em 25/09/2026, fora do histórico de migrations.
-- Conferida objeto a objeto em 29/09/2026. Não reexecutar em produção: registrar com
--   supabase migration repair --status applied 20260925120000 --linked
-- antes do merge na main (a integração Supabase aplica migrations pendentes no merge).
-- Conteúdo abaixo idêntico ao arquivo de origem.
-- -----------------------------------------------------------------------------

-- =============================================================================
-- Sistema S — coleta externa multi-portal (Paradigma/FIESC, SEST SENAT, ...)
-- PRD: docs/pncp/PRD/PRD_SISTEMA_S_COLETA_EXTERNA_v1.md
--
-- Pré-requisitos (já aplicados no banco em 23–24/09/2026 pelo SQL Editor, regularizados
-- no repositório como 20260923_licitacoes_externas.sql e 20260924_pncp_itens_resultados.sql):
--   public.licitacoes_externas, public.licitacao_documentos, public.licitacao_chunks,
--   public.licitacao_itens, public.licitacao_resultados
--
-- Esta migration é ADITIVA e IDEMPOTENTE: só cria tabelas/colunas/índices/view novos,
-- não remove nem reescreve dados. Escrita: somente service_role (coletor/Edge Function).
-- Leitura: authenticated (anon sem acesso).
-- ⚠️ P0-bis: aplicar SOMENTE depois da reconciliação de migrations (D0).
-- =============================================================================

begin;

-- 1) Catálogo de fontes (portais) ---------------------------------------------
create table if not exists public.fontes_externas (
  slug               text primary key check (slug ~ '^[a-z0-9_]+$'),
  entidade           text not null,
  uf                 text check (uf is null or uf ~ '^[A-Z]{2}$'),
  plataforma         text not null check (plataforma in ('paradigma','portal_rlc_rca','wordpress','pncp','manual')),
  base_url           text not null,
  modo_coleta        text not null check (modo_coleta in ('automatico','aviso_fornecedor','manual','bloqueado')),
  robots_permite     boolean,                 -- null = não verificado
  ativo              boolean not null default true,
  observacao         text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

insert into public.fontes_externas (slug, entidade, uf, plataforma, base_url, modo_coleta, robots_permite, observacao) values
  ('pncp',          'PNCP (trilho secundário: leads e preço)', null, 'pncp',       'https://pncp.gov.br/api',                                   'automatico', true,  'Coletor PNCP (coletor/pncp.py)'),
  ('sestsenat',     'SEST SENAT',                              null, 'paradigma',  'https://compras.sestsenat.org.br/portal',                   'automatico', true,  'Adaptador Paradigma'),
  ('fiesc',         'FIESC (SESI/SC, SENAI/SC, IEL/SC)',       'SC', 'paradigma',  'https://portaldecompras.fiesc.com.br/portal',               'automatico', true,  'Validado 24/09/2026: listagem, detalhe, itens, ranking, anexos'),
  ('sescsp',        'Sesc SP',                                 'SP', 'paradigma',  'https://scr360.paradigmabs.com.br/sescsp/portal',           'aviso_fornecedor', false, 'robots.txt do host proíbe coleta automatizada'),
  ('sesc_senac_rs', 'Sesc/Senac RS',                           'RS', 'paradigma',  'https://egov.paradigmabs.com.br/sesc_senac_rs/portal',      'aviso_fornecedor', false, 'robots.txt do host proíbe coleta automatizada'),
  ('sesi_pe',       'SESI/SENAI/FIEPE/IEL PE',                 'PE', 'portal_rlc_rca', 'https://licitacoes.pe.sesi.org.br:8081',                'manual', null, 'Export XLSX/ODS; adaptador B pendente'),
  ('sesi_pa',       'SESI/SENAI PA',                           'PA', 'portal_rlc_rca', 'https://licitacao.sesipa.org.br',                       'manual', null, 'Export XLSX/ODS; adaptador B pendente'),
  ('sesc_dn',       'Sesc Departamento Nacional',              null, 'wordpress',  'https://www.sesc.com.br/licitacoes',                        'manual', null, 'HTML por modalidade; adaptador C pendente'),
  ('cn_sesi',       'Conselho Nacional do SESI',               null, 'manual',     'https://www.cnsesi.com.br/licitacoes-e-editais',            'manual', null, 'Baixo volume; só monitorar')
on conflict (slug) do nothing;

-- 2) licitacoes_externas: campos de estado e governança -------------------------
alter table public.licitacoes_externas
  add column if not exists entidade           text,
  add column if not exists regulamento        text,
  add column if not exists status_normalizado text,
  add column if not exists acionabilidade     text,
  add column if not exists escopo_estado      text,
  add column if not exists no_taxonomia       text,
  add column if not exists versao_taxonomia   text,
  add column if not exists payload_hash       text,
  add column if not exists first_seen_at      timestamptz default now(),
  add column if not exists last_seen_run_id   bigint;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'licext_regulamento_chk') then
    alter table public.licitacoes_externas add constraint licext_regulamento_chk
      check (regulamento is null or regulamento in ('RLC','RCA','LEI_14133','OUTRO'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'licext_status_chk') then
    alter table public.licitacoes_externas add constraint licext_status_chk
      check (status_normalizado is null or status_normalizado in
        ('aberta','em_julgamento','homologada','sem_vencedor','cancelada','suspensa','encerrada','desconhecida'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'licext_acionab_chk') then
    alter table public.licitacoes_externas add constraint licext_acionab_chk
      check (acionabilidade is null or acionabilidade in ('ACTIONABLE','NOT_ACTIONABLE','ACTIONABILITY_UNRESOLVED'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'licext_escopo_chk') then
    alter table public.licitacoes_externas add constraint licext_escopo_chk
      check (escopo_estado is null or escopo_estado in
        ('CLASSIFICATION_CANDIDATE','USER_CONFIRMED','USER_REJECTED','OUT_OF_SCOPE','SCOPE_UNRESOLVED'));
  end if;
  -- fonte precisa existir no catálogo (linhas atuais: 'sestsenat' e 'pncp', semeadas acima)
  if not exists (select 1 from pg_constraint where conname = 'licext_fonte_fk') then
    alter table public.licitacoes_externas add constraint licext_fonte_fk
      foreign key (fonte) references public.fontes_externas(slug) not valid;
    alter table public.licitacoes_externas validate constraint licext_fonte_fk;
  end if;
end $$;

create index if not exists idx_licext_fonte_status on public.licitacoes_externas(fonte, status_normalizado);
create index if not exists idx_licext_acionab      on public.licitacoes_externas(acionabilidade) where acionabilidade = 'ACTIONABLE';
create index if not exists idx_licext_escopo       on public.licitacoes_externas(escopo_estado);

-- 3) licitacao_itens: identidade externa, texto estruturado e estado de escopo ----
alter table public.licitacao_itens
  add column if not exists id_item_externo      bigint,
  add column if not exists categoria_fornecedor text,     -- ex.: "Acessorios para pilates e equipamentos de academia em geral"
  add column if not exists variacao             text,     -- ex.: "Equipamentos para academia"
  add column if not exists escopo_estado        text,
  add column if not exists escopo_metodo        text,
  add column if not exists escopo_confianca     numeric,
  add column if not exists no_taxonomia         text,
  add column if not exists versao_taxonomia     text;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'licitem_escopo_chk') then
    alter table public.licitacao_itens add constraint licitem_escopo_chk
      check (escopo_estado is null or escopo_estado in
        ('CLASSIFICATION_CANDIDATE','USER_CONFIRMED','USER_REJECTED','OUT_OF_SCOPE','SCOPE_UNRESOLVED'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'licitem_metodo_chk') then
    alter table public.licitacao_itens add constraint licitem_metodo_chk
      check (escopo_metodo is null or escopo_metodo in ('catmat','regra','llm','manual'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'licitem_conf_chk') then
    alter table public.licitacao_itens add constraint licitem_conf_chk
      check (escopo_confianca is null or (escopo_confianca >= 0 and escopo_confianca <= 1));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'licitem_ms_chk') then
    alter table public.licitacao_itens add constraint licitem_ms_chk
      check (material_ou_servico is null or material_ou_servico in ('M','S')) not valid;
  end if;
end $$;
create index if not exists idx_licitem_escopo on public.licitacao_itens(licitacao_id) where escopo_estado in ('CLASSIFICATION_CANDIDATE','USER_CONFIRMED');

-- 4) licitacao_resultados: ranking e vencedor (Paradigma não expõe CNPJ no ranking) --
alter table public.licitacao_resultados
  add column if not exists ranking        int,
  add column if not exists vencedor       boolean,
  add column if not exists valor_proposta numeric;
create index if not exists idx_licres_vencedor on public.licitacao_resultados(licitacao_id, numero_item) where vencedor;

-- 5) Runs de coleta (observabilidade; mesmo vocabulário de status do pncp_sync_run) --
create schema if not exists private;
create table if not exists private.coleta_externa_run (
  id            bigint generated always as identity primary key,
  fonte         text not null references public.fontes_externas(slug),
  modo          text not null check (modo in ('leads','monitorar','historico','dry_run')),
  status        text not null default 'executando'
                check (status in ('pendente','executando','concluida','concluida_com_erros','falhou','cancelada','incompleta')),
  termos        text[],
  listados      int not null default 0,
  processos     int not null default 0,
  no_escopo     int not null default 0,
  itens_escopo  int not null default 0,
  erros         int not null default 0,
  detalhe_erros jsonb,
  started_at    timestamptz not null default now(),
  finished_at   timestamptz
);
alter table private.coleta_externa_run enable row level security;  -- sem policy: só service_role

-- 6) Decisões do usuário sobre escopo (USER_CONFIRMED / USER_REJECTED) -----------
create table if not exists public.licitacao_escopo_decisao (
  id            bigint generated always as identity primary key,
  licitacao_id  bigint not null references public.licitacoes_externas(id) on delete cascade,
  numero_item   int,                          -- null = decisão sobre a licitação inteira
  decisao       text not null check (decisao in ('USER_CONFIRMED','USER_REJECTED')),
  no_taxonomia  text,
  nota          text check (nota is null or length(nota) <= 1000),
  user_id       uuid not null default auth.uid(),
  created_at    timestamptz not null default now()
);
create index if not exists idx_licdec_lic on public.licitacao_escopo_decisao(licitacao_id, numero_item, created_at desc);

alter table public.fontes_externas          enable row level security;
alter table public.licitacao_escopo_decisao enable row level security;

drop policy if exists fontes_externas_select on public.fontes_externas;
create policy fontes_externas_select on public.fontes_externas for select to authenticated using (true);

drop policy if exists licdec_select on public.licitacao_escopo_decisao;
create policy licdec_select on public.licitacao_escopo_decisao for select to authenticated using (true);
drop policy if exists licdec_insert_own on public.licitacao_escopo_decisao;
create policy licdec_insert_own on public.licitacao_escopo_decisao for insert to authenticated
  with check (user_id = auth.uid());

-- 7) View para o frontend (via Edge Function api-licitacoes-externas) ------------
create or replace view public.v_oportunidades_externas with (security_invoker = true) as
with itens as (
  select i.licitacao_id,
         count(*)                                                        as itens_total,
         count(*) filter (where i.escopo_estado in ('CLASSIFICATION_CANDIDATE','USER_CONFIRMED')) as itens_escopo,
         sum(i.valor_total_estimado) filter (where i.escopo_estado in ('CLASSIFICATION_CANDIDATE','USER_CONFIRMED')) as valor_ref_escopo,
         bool_or(i.interesse_borracha)                                   as algum_item_borracha
  from public.licitacao_itens i
  group by i.licitacao_id
), venc as (
  select r.licitacao_id,
         string_agg(distinct r.fornecedor_nome, ' | ') filter (where r.vencedor) as vencedores,
         sum(r.valor_proposta) filter (where r.vencedor)                         as valor_vencedor
  from public.licitacao_resultados r
  group by r.licitacao_id
), dec as (
  select distinct on (d.licitacao_id) d.licitacao_id, d.decisao, d.created_at
  from public.licitacao_escopo_decisao d
  where d.numero_item is null
  order by d.licitacao_id, d.created_at desc
)
select l.id                                   as licitacao_id,
       l.fonte, f.entidade                    as fonte_entidade, f.plataforma,
       coalesce(l.uf, f.uf)                   as uf,
       l.numero_edital, l.numero_processo, l.objeto, l.unidade_compradora, l.modalidade, l.regulamento,
       l.situacao, l.status_normalizado, l.acionabilidade,
       l.data_inicio, l.data_fim, l.data_homologacao,
       (current_date - l.data_homologacao::date) as dias_desde_homologacao,
       l.categoria_escopo,
       coalesce(dec.decisao, l.escopo_estado)  as escopo_estado,
       l.no_taxonomia,
       coalesce(itens.itens_total, 0)          as itens_total,
       coalesce(itens.itens_escopo, 0)         as itens_escopo,
       itens.valor_ref_escopo,
       venc.vencedores, venc.valor_vencedor,
       (l.interesse_borracha or coalesce(itens.algum_item_borracha, false)) as interesse_borracha,
       l.last_synced_at
from public.licitacoes_externas l
join public.fontes_externas f on f.slug = l.fonte
left join itens on itens.licitacao_id = l.id
left join venc  on venc.licitacao_id  = l.id
left join dec   on dec.licitacao_id   = l.id
where l.fonte <> 'pncp';   -- PNCP tem trilho próprio (oportunidades_borracha / api-pncp-*)

-- 8) Privilégios: anon fora; escrita só service_role --------------------------------
revoke all on public.fontes_externas, public.licitacao_escopo_decisao, public.v_oportunidades_externas from anon;
revoke insert, update, delete on public.fontes_externas from authenticated;
revoke update, delete on public.licitacao_escopo_decisao from authenticated;
grant select on public.fontes_externas, public.v_oportunidades_externas, public.licitacao_escopo_decisao to authenticated;
grant insert on public.licitacao_escopo_decisao to authenticated;
revoke all on public.licitacoes_externas, public.licitacao_itens, public.licitacao_resultados,
              public.licitacao_documentos, public.licitacao_chunks from anon;

commit;
