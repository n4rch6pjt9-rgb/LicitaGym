-- LicitaGym: suporte ao coletor PNCP (busca nacional por escopo fitness/grama/borracha)
-- Rodar no SQL Editor do Supabase DEPOIS de 20260923_licitacoes_externas.sql

-- 1) licitacoes_externas passa a aceitar fontes identificadas por texto (PNCP: numero_controle_pncp)
alter table public.licitacoes_externas alter column modulo drop not null;
alter table public.licitacoes_externas alter column id_externo drop not null;
alter table public.licitacoes_externas
  add column if not exists codigo_externo     text,
  add column if not exists orgao_cnpj         text,
  add column if not exists orgao_nome         text,
  add column if not exists municipio          text,
  add column if not exists uf                 text,
  add column if not exists data_publicacao    timestamptz,
  add column if not exists categoria_escopo   text,     -- catmat|borracha|piso|obra_piso|forte|fraco
  add column if not exists interesse_borracha boolean default false,
  add column if not exists termos_busca       text[],
  add column if not exists data_homologacao   timestamptz,  -- data mais recente de resultado dos itens
  add column if not exists prioridade         text;         -- leads | monitorar | historico
create index if not exists idx_licext_homolog on public.licitacoes_externas(data_homologacao desc);
-- índice único comum (não parcial) para o upsert via PostgREST (on_conflict=fonte,codigo_externo);
-- linhas do SEST SENAT têm codigo_externo nulo e não conflitam (NULLs são distintos)
create unique index if not exists uq_licext_fonte_codigo on public.licitacoes_externas(fonte, codigo_externo);
create index if not exists idx_licext_interesse on public.licitacoes_externas(interesse_borracha) where interesse_borracha;
create index if not exists idx_licext_uf on public.licitacoes_externas(uf);

-- 2) Itens da contratação (o que foi pedido, quanto e a que preço estimado)
create table if not exists public.licitacao_itens (
  id                      bigint generated always as identity primary key,
  licitacao_id            bigint not null references public.licitacoes_externas(id) on delete cascade,
  numero_item             int not null,
  descricao               text,
  material_ou_servico     text,
  quantidade              numeric,
  unidade_medida          text,
  valor_unitario_estimado numeric,
  valor_total_estimado    numeric,
  catalogo_codigo_item    text,        -- CATMAT/CATSER quando o órgão informa (federais)
  situacao                text,
  tem_resultado           boolean,
  categoria_escopo        text,
  interesse_borracha      boolean default false,
  raw                     jsonb,
  created_at              timestamptz default now(),
  updated_at              timestamptz default now(),
  unique (licitacao_id, numero_item)
);

-- 3) Resultados por item (quem ganhou, quanto, por quanto) — base de leads
create table if not exists public.licitacao_resultados (
  id                        bigint generated always as identity primary key,
  licitacao_id              bigint not null references public.licitacoes_externas(id) on delete cascade,
  numero_item               int not null,
  sequencial_resultado      int not null default 1,
  fornecedor_nome           text,
  fornecedor_cnpj           text,       -- só pessoa jurídica (14 dígitos); CPF não é gravado
  porte_fornecedor          text,
  quantidade_homologada     numeric,
  valor_unitario_homologado numeric,
  valor_total_homologado    numeric,
  situacao                  text,
  data_resultado            timestamptz,
  raw                       jsonb,
  created_at                timestamptz default now(),
  unique (licitacao_id, numero_item, sequencial_resultado)
);
create index if not exists idx_licres_cnpj on public.licitacao_resultados(fornecedor_cnpj);

alter table public.licitacao_itens      enable row level security;
alter table public.licitacao_resultados enable row level security;
drop policy if exists licitacao_itens_select on public.licitacao_itens;
create policy licitacao_itens_select on public.licitacao_itens for select to authenticated using (true);
drop policy if exists licitacao_resultados_select on public.licitacao_resultados;
create policy licitacao_resultados_select on public.licitacao_resultados for select to authenticated using (true);

-- 4) Oportunidades para vender raspa/granulado de borracha ao vencedor
drop view if exists public.oportunidades_borracha;   -- recria (a ordem das colunas mudou)
create view public.oportunidades_borracha with (security_invoker = true) as
select l.id as licitacao_id, l.codigo_externo as numero_controle_pncp, l.orgao_nome, l.municipio, l.uf,
       l.objeto, l.situacao, l.categoria_escopo, l.prioridade, l.data_publicacao, l.data_homologacao,
       (current_date - l.data_homologacao::date) as dias_desde_homologacao,
       i.numero_item, i.descricao as item_descricao, i.quantidade, i.unidade_medida,
       i.valor_unitario_estimado,
       r.fornecedor_nome as vencedor, r.fornecedor_cnpj as vencedor_cnpj,
       r.quantidade_homologada, r.valor_unitario_homologado, r.valor_total_homologado, r.data_resultado
from public.licitacoes_externas l
left join public.licitacao_itens i on i.licitacao_id = l.id and (i.interesse_borracha or l.categoria_escopo = 'obra_piso')
left join public.licitacao_resultados r on r.licitacao_id = l.id and r.numero_item = i.numero_item
where l.interesse_borracha
order by (l.prioridade = 'leads') desc, l.data_homologacao desc nulls last, l.data_publicacao desc;
