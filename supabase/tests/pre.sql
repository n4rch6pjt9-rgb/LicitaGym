-- Stubs do ambiente Supabase para validar migrations num Postgres puro (pgvector/pgvector:pg16).
-- Uso: skill .claude/skills/validar-migrations (caminho B). Não é aplicado em produção.
create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
create schema auth; create function auth.uid() returns uuid language sql stable as $$ select null::uuid $$;
grant usage on schema auth to anon, authenticated, service_role;
create schema storage;
create table storage.buckets (id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text, name text);
alter table storage.objects enable row level security;
create extension vector;
grant usage on schema public to anon, authenticated, service_role;
-- privilégios padrão como no Supabase (origem do problema)
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;
create or replace function auth.jwt() returns jsonb language sql stable as $$ select '{}'::jsonb $$;
create role authenticator noinherit nologin;
create table auth.users (id uuid primary key, email text, raw_app_meta_data jsonb default '{}'::jsonb);
