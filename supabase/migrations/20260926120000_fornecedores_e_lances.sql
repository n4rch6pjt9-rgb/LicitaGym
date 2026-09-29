-- -----------------------------------------------------------------------------
-- Versionada em 29/09/2026 a partir do coletor do Sistema S
-- (n4rch6pjt9-rgb/licitagym-coletor-sistema-s, licitagym-coletor/migrations/20260926120000_fornecedores_e_lances.sql, commit 8925abf).
-- JÁ APLICADA em produção pelo SQL Editor em 26/09/2026, fora do histórico de migrations.
-- Conferida objeto a objeto em 29/09/2026. Não reexecutar em produção: registrar com
--   supabase migration repair --status applied 20260926120000 --linked
-- antes do merge na main (a integração Supabase aplica migrations pendentes no merge).
-- Conteúdo abaixo idêntico ao arquivo de origem.
-- -----------------------------------------------------------------------------

-- 26/09/2026 — Paradigma v15: resultado por lances (marca/modelo), catálogo e cadastro de fornecedores.
-- Depende de 20260925120000_sistema_s_coleta_externa.sql (colunas ranking/vencedor/valor_proposta e escopo_*).
-- Idempotente.

-- 1) licitacao_resultados: marca e modelo do lance (grade de lances do Paradigma) --------------------------
alter table public.licitacao_resultados
  add column if not exists marca  text,
  add column if not exists modelo text;
comment on column public.licitacao_resultados.situacao is
  'vencedor | perdida (status vazio no portal) | status textual do portal (ex.: Desclassificada)';

-- 2) escopo_metodo: o classificador v14/v15 também emite regra_item e catalogo --------------------------------
alter table public.licitacao_itens drop constraint if exists licitem_metodo_chk;
alter table public.licitacao_itens add constraint licitem_metodo_chk
  check (escopo_metodo is null or escopo_metodo in ('catmat','regra','regra_item','catalogo','llm','manual'));

-- 3) Cadastro de fornecedores (dados públicos de PJ; QSA/sócios não são gravados) ------------------------------
create table if not exists public.fornecedores (
  cnpj                      text primary key check (cnpj ~ '^\d{14}$'),
  cnpj_raiz                 text not null,
  razao_social              text,
  nome_fantasia             text,
  matriz_filial             text,
  situacao_cadastral        text,
  data_situacao_cadastral   date,
  data_inicio_atividade     date,
  natureza_juridica         text,
  porte                     text,
  opcao_simples             boolean,
  opcao_mei                 boolean,
  capital_social            numeric,
  cnae_principal            int,
  cnae_principal_descricao  text,
  cnaes_secundarios         jsonb default '[]'::jsonb,
  cnae_fitness              boolean default false,
  uf                        text,
  municipio                 text,
  codigo_municipio_ibge     int,
  cep                       text,
  logradouro                text,
  numero                    text,
  complemento               text,
  bairro                    text,
  email                     text,
  telefones                 text[],
  titular_pessoa_fisica     boolean default false,  -- MEI/empresário individual: sem contato/endereço, CPF mascarado
  consulta_status           text not null check (consulta_status in ('ok','nao_encontrado')),
  consulta_fonte            text,
  consultado_em             timestamptz not null default now(),
  raw                       jsonb,
  created_at                timestamptz default now()
);
create index if not exists idx_fornecedores_raiz on public.fornecedores(cnpj_raiz);
create index if not exists idx_fornecedores_uf on public.fornecedores(uf);
alter table public.fornecedores enable row level security;
drop policy if exists fornecedores_select on public.fornecedores;
create policy fornecedores_select on public.fornecedores for select to authenticated using (true);

-- 4) Participação por certame (lê de licitacao_resultados; não duplica dado) ----------------------------------
create or replace view public.v_fornecedor_participacoes
with (security_invoker = true) as
select r.fornecedor_cnpj                        as cnpj,
       f.razao_social, f.porte, f.uf,
       l.fonte, l.id                             as licitacao_id, l.numero_edital, l.orgao_nome,
       r.numero_item, r.ranking, r.vencedor, r.valor_proposta, r.marca, r.modelo, r.situacao, r.data_resultado
from public.licitacao_resultados r
join public.licitacoes_externas l on l.id = r.licitacao_id
left join public.fornecedores f on f.cnpj = r.fornecedor_cnpj
where r.fornecedor_cnpj is not null;
