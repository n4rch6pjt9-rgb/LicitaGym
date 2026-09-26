-- LicitaGym: ingestão de licitações de portais externos (1ª fonte: SEST SENAT / Paradigma)
-- Leitura: authenticated. Escrita: somente service_role (coletor), que ignora RLS.

create table if not exists public.licitacoes_externas (
  id                 bigint generated always as identity primary key,
  fonte              text not null,                 -- 'sestsenat'
  modulo             int  not null,                 -- nCdModulo (59 = pregão eletrônico)
  id_externo         int  not null,                 -- nCdProcesso
  numero_processo    text,
  numero_edital      text,
  objeto             text,
  unidade_compradora text,
  modalidade         text,
  fase               text,
  situacao           text,
  data_inicio        timestamptz,
  data_fim           timestamptz,
  valor_total        numeric,
  anexo_raiz_id      bigint,                        -- nCdAnexo (chave dos anexos no portal)
  edital_id          uuid references public.contratacoes_editais(id) on delete set null,
  esclarecimentos    jsonb,                         -- fórum: pedidos de esclarecimento/impugnação + respostas
  notas              jsonb,                         -- notas/avisos publicados pela comissão
  raw                jsonb,
  last_synced_at     timestamptz default now(),
  created_at         timestamptz default now(),
  updated_at         timestamptz default now(),
  unique (fonte, modulo, id_externo)
);

create table if not exists public.licitacao_documentos (
  id                   bigint generated always as identity primary key,
  licitacao_id         bigint not null references public.licitacoes_externas(id) on delete cascade,
  secao                text not null check (secao in
                         ('processo','proposta','lance','negociacao','habilitacao',
                          'recurso','contrarrazoes','parecer','esclarecimento','nota')),
  nome_original        text,
  arquivo_origem       text not null,               -- sNmArquivo no portal
  itens_lote           text[],                      -- lotes/itens em que o arquivo aparece
  fornecedor_nome      text,
  fornecedor_cnpj      text,
  data_documento       timestamptz,
  storage_uri          text,                        -- gs://bucket/...
  mime_type            text,
  tamanho_bytes        bigint,
  sha256               text,
  status_processamento text not null default 'pendente'
                         check (status_processamento in ('pendente','baixado','extraido','indexado','erro','ignorado')),
  erro                 text,
  extracao             jsonb,                       -- campos estruturados extraídos pelo Gemini
  raw                  jsonb,
  created_at           timestamptz default now(),
  updated_at           timestamptz default now(),
  unique (licitacao_id, secao, arquivo_origem)
);
create index if not exists idx_licdoc_licitacao on public.licitacao_documentos(licitacao_id);
create index if not exists idx_licdoc_status    on public.licitacao_documentos(status_processamento);

create table if not exists public.licitacao_chunks (
  id            bigint generated always as identity primary key,
  documento_id  bigint not null references public.licitacao_documentos(id) on delete cascade,
  licitacao_id  bigint not null references public.licitacoes_externas(id) on delete cascade,
  secao         text not null,
  ordem         int  not null,
  pagina        int,
  texto         text not null,
  embedding     vector(768),
  metadados     jsonb,
  created_at    timestamptz default now(),
  unique (documento_id, ordem)
);
create index if not exists idx_licchunk_hnsw on public.licitacao_chunks
  using hnsw (embedding vector_cosine_ops) with (m = 16, ef_construction = 64);
create index if not exists idx_licchunk_licitacao on public.licitacao_chunks(licitacao_id);

alter table public.licitacoes_externas  enable row level security;
alter table public.licitacao_documentos enable row level security;
alter table public.licitacao_chunks     enable row level security;

drop policy if exists licitacoes_externas_select on public.licitacoes_externas;
create policy licitacoes_externas_select  on public.licitacoes_externas  for select to authenticated using (true);
drop policy if exists licitacao_documentos_select on public.licitacao_documentos;
create policy licitacao_documentos_select on public.licitacao_documentos for select to authenticated using (true);
drop policy if exists licitacao_chunks_select on public.licitacao_chunks;
create policy licitacao_chunks_select     on public.licitacao_chunks     for select to authenticated using (true);

-- Busca semântica com filtros opcionais
create or replace function public.match_licitacao_chunks(
  query_embedding vector(768),
  match_count     int  default 10,
  filtro_secao    text default null,
  filtro_fonte    text default null
) returns table (
  chunk_id bigint, documento_id bigint, licitacao_id bigint, secao text,
  texto text, numero_processo text, objeto text, nome_original text, similaridade float
)
language sql stable security invoker set search_path = public as $$
  select c.id, c.documento_id, c.licitacao_id, c.secao, c.texto,
         l.numero_processo, l.objeto, d.nome_original,
         1 - (c.embedding <=> query_embedding) as similaridade
  from public.licitacao_chunks c
  join public.licitacao_documentos d on d.id = c.documento_id
  join public.licitacoes_externas  l on l.id = c.licitacao_id
  where (filtro_secao is null or c.secao = filtro_secao)
    and (filtro_fonte is null or l.fonte = filtro_fonte)
  order by c.embedding <=> query_embedding
  limit match_count;
$$;
