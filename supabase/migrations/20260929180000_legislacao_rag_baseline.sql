-- LicitaGym: baseline das tabelas do RAG jurídico (legislacao, legislacao_embeddings, consultas_log)
--
-- Contexto (review do PR #89, Copilot e Codex): essas tabelas e a função match_legislacao_embeddings
-- foram criadas em produção fora do histórico, por docs/agente-juridico-ml/supabase_schema.sql. Sem
-- esta migration, um banco novo ou um `supabase db reset` falha na 20260929180014_sec_rag_acl_lock
-- ("relation does not exist"). Mesmo padrão da 20260923090000_enable_pgvector: espelha o estado de
-- produção para que o histórico seja reproduzível.
--
-- Deliberadamente NÃO recria as policies de escrita de supabase_schema.sql ("Permitir inserção/
-- atualização autenticada..."): a migration seguinte as remove, e recriá-las aqui reabriria a base se
-- esta migration fosse reaplicada. Funções só são criadas se não existirem, para não apagar o
-- search_path fixado depois (CREATE OR REPLACE redefine os SET da função).
--
-- Idempotente: no-op em produção (registrada como aplicada em 29/09/2026).

create table if not exists public.legislacao (
  id bigserial primary key,
  titulo text not null,
  numero varchar(50) not null,
  ano integer not null,
  data_publicacao timestamptz,
  orgao_emissor text,
  tipo varchar(50) not null,
  ementa text,
  texto_completo text,
  url_origem text,
  tags text[],
  esfera varchar(20),
  uf varchar(2),
  municipio text,
  palavras_chave text[],
  artigos jsonb,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index if not exists idx_legislacao_tipo on public.legislacao (tipo);
create index if not exists idx_legislacao_ano on public.legislacao (ano);
create index if not exists idx_legislacao_esfera on public.legislacao (esfera);
create index if not exists idx_legislacao_data on public.legislacao (data_publicacao);
create index if not exists idx_legislacao_orgao on public.legislacao (orgao_emissor);
create index if not exists idx_legislacao_texto on public.legislacao using gin (to_tsvector('portuguese', texto_completo));

create table if not exists public.legislacao_embeddings (
  id bigserial primary key,
  documento_id bigint references public.legislacao (id) on delete cascade,
  embedding vector(768),
  texto_resumo text,
  metadados jsonb,
  created_at timestamptz default now()
);

create index if not exists idx_legislacao_embedding_hnsw
  on public.legislacao_embeddings using hnsw (embedding vector_cosine_ops) with (m = 16, ef_construction = 64);

create table if not exists public.consultas_log (
  id bigserial primary key,
  pergunta text not null,
  classificacao jsonb,
  resultados_count integer,
  tempo_processamento_ms integer,
  created_at timestamptz default now()
);

alter table public.legislacao enable row level security;
alter table public.legislacao_embeddings enable row level security;
alter table public.consultas_log enable row level security;

do $$
begin
  if to_regprocedure('public.update_updated_at_column()') is null then
    execute $f$
      create function public.update_updated_at_column() returns trigger language plpgsql as $b$
      begin
        new.updated_at = now();
        return new;
      end;
      $b$
    $f$;
  end if;

  if not exists (select 1 from pg_trigger where tgrelid = 'public.legislacao'::regclass
                  and tgname = 'update_legislacao_updated_at' and not tgisinternal) then
    create trigger update_legislacao_updated_at before update on public.legislacao
      for each row execute function public.update_updated_at_column();
  end if;

  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'legislacao'
                  and policyname = 'Permitir leitura pública de legislação') then
    create policy "Permitir leitura pública de legislação" on public.legislacao for select using (true);
  end if;

  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'legislacao_embeddings'
                  and policyname = 'Permitir leitura pública de embeddings') then
    create policy "Permitir leitura pública de embeddings" on public.legislacao_embeddings for select using (true);
  end if;

  if to_regprocedure('public.match_legislacao_embeddings(vector,double precision,integer)') is null then
    execute $f$
      create function public.match_legislacao_embeddings(
        query_embedding vector(768),
        match_threshold float default 0.7,
        match_count int default 10
      )
      returns table (documento_id bigint, similaridade float, texto_resumo text, metadados jsonb)
      language sql stable as $b$
        select le.documento_id,
               (1 - (le.embedding <=> query_embedding))::float as similaridade,
               le.texto_resumo,
               le.metadados
          from public.legislacao_embeddings le
         where le.embedding is not null
           and (1 - (le.embedding <=> query_embedding)) >= match_threshold
         order by le.embedding <=> query_embedding
         limit match_count;
      $b$
    $f$;
  end if;
end $$;
