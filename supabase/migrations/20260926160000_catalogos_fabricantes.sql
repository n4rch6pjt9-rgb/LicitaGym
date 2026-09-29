-- -----------------------------------------------------------------------------
-- Versionada em 29/09/2026 a partir do coletor do Sistema S
-- (n4rch6pjt9-rgb/licitagym-coletor-sistema-s, licitagym-coletor/migrations/20260926160000_catalogos_fabricantes.sql, commit 8925abf).
-- JÁ APLICADA em produção pelo SQL Editor em 26/09/2026, fora do histórico de migrations.
-- Conferida objeto a objeto em 29/09/2026. Não reexecutar em produção: registrar com
--   supabase migration repair --status applied 20260926160000 --linked
-- antes do merge na main (a integração Supabase aplica migrations pendentes no merge).
-- Conteúdo abaixo idêntico ao arquivo de origem.
-- -----------------------------------------------------------------------------

-- 26/09/2026 — Catálogos dos fabricantes dentro do LicitaGym (MOVEMENT, LION, TOTAL HEALTH, MACSPORT, FLEX...).
-- Idempotente. Não depende das migrations de licitação (só de pgvector, já usado em licitacao_chunks).
-- Coletor: coletor/catalogos.py (fichas por página de produto + PDFs do manifesto data/catalogos_fabricantes.json).

-- 1) Bucket privado para os PDFs (catálogos, manuais, fichas). Caminho: <marca>/<sha256>.pdf -> sem duplicata, sem apagar
insert into storage.buckets (id, name, public, file_size_limit)
values ('catalogos-fabricantes', 'catalogos-fabricantes', false, 104857600)   -- 100 MB (catálogo Movement 2022 = 54 MB)
on conflict (id) do update set public = false;

drop policy if exists catfab_storage_select on storage.objects;
create policy catfab_storage_select on storage.objects
  for select to authenticated using (bucket_id = 'catalogos-fabricantes');

-- 2) Documentos de catálogo (1 linha por arquivo; nova versão = novo sha256, a anterior fica) -----------------
create table if not exists public.catalogo_documentos (
  id              bigserial primary key,
  marca           text not null,                -- marca normalizada (coletor/perfil_item.normalizar_marca)
  titulo          text,
  ano             int,
  url_origem      text not null,
  sha256          text not null unique,
  tamanho_bytes   bigint,
  storage_uri     text not null,                -- supabase://catalogos-fabricantes/<marca>/<sha256>.pdf
  status_processamento text not null default 'pendente',   -- pendente | indexado | erro
  first_seen_at   timestamptz not null default now(),
  baixado_em      timestamptz not null default now()
);
create index if not exists idx_catdoc_marca on public.catalogo_documentos(marca);

-- 3) Ficha estruturada por produto (gabarito de linha / código / nome / carga) ---------------------------------
create table if not exists public.catalogo_produtos (
  id                  bigserial primary key,
  marca               text not null,
  linha               text,
  codigo              text,                     -- SKU do fabricante (505RRF, CR-0925, LF-200D...)
  nome                text,                     -- só o nome do produto, sem linha e sem SKU
  titulo_original     text,
  no_taxonomia        text,                     -- dicionário de aparelhos v0.3 + complemento
  produto_padronizado text,
  familia_equipamento text,
  carga_maxima_kg     numeric,
  carga_inicial_kg    numeric,
  peso_placa_kg       numeric,
  peso_equipamento_kg numeric,
  comprimento_cm      numeric,
  largura_cm          numeric,
  altura_cm           numeric,
  categorias          text[],
  descricao           text,
  url                 text not null unique,
  first_seen_at       timestamptz not null default now(),
  last_seen_at        timestamptz not null default now(),
  removido_do_site_em timestamptz               -- sumiu do site; a ficha continua (histórico de linha descontinuada)
);
create index if not exists idx_catprod_marca_linha on public.catalogo_produtos(marca, linha);
create index if not exists idx_catprod_codigo      on public.catalogo_produtos(upper(codigo));
create index if not exists idx_catprod_no          on public.catalogo_produtos(no_taxonomia);

-- 4) Trechos para o RAG (mesmo embedding de licitacao_chunks: vector 768) --------------------------------------
create table if not exists public.catalogo_chunks (
  id            bigserial primary key,
  documento_id  bigint references public.catalogo_documentos(id),
  produto_id    bigint references public.catalogo_produtos(id),
  marca         text not null,
  linha         text,
  pagina        int,
  conteudo      text not null,
  embedding     vector(768),
  created_at    timestamptz not null default now(),
  check (documento_id is not null or produto_id is not null)
);
create index if not exists idx_catchunk_marca on public.catalogo_chunks(marca);
create index if not exists idx_catchunk_vec   on public.catalogo_chunks using hnsw (embedding vector_cosine_ops);

create or replace function public.match_catalogo_chunks(query_embedding vector(768), match_count int default 8,
                                                        filtro_marca text default null, filtro_linha text default null)
returns table (id bigint, marca text, linha text, pagina int, conteudo text, documento_id bigint, produto_id bigint,
               similaridade float)
language sql stable security invoker as $$
  select c.id, c.marca, c.linha, c.pagina, c.conteudo, c.documento_id, c.produto_id,
         1 - (c.embedding <=> query_embedding) as similaridade
    from public.catalogo_chunks c
   where (filtro_marca is null or c.marca = filtro_marca)
     and (filtro_linha is null or c.linha = filtro_linha)
   order by c.embedding <=> query_embedding
   limit match_count
$$;

-- 5) Leitura: usuário logado lê; escrita só service_role (coletor) ----------------------------------------------
alter table public.catalogo_documentos enable row level security;
alter table public.catalogo_produtos   enable row level security;
alter table public.catalogo_chunks     enable row level security;
drop policy if exists catdoc_select  on public.catalogo_documentos;
drop policy if exists catprod_select on public.catalogo_produtos;
drop policy if exists catchunk_select on public.catalogo_chunks;
create policy catdoc_select   on public.catalogo_documentos for select to authenticated using (true);
create policy catprod_select  on public.catalogo_produtos   for select to authenticated using (true);
create policy catchunk_select on public.catalogo_chunks     for select to authenticated using (true);
