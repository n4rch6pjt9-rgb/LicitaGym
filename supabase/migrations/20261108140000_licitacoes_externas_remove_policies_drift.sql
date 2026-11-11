-- LicitaGym: remove policies criadas à mão em public.licitacoes_externas (drift, issue #468)
--
-- Contexto:
-- A verificação de produção depois do merge do PR #467 encontrou duas policies em
-- public.licitacoes_externas que nenhuma migration cria:
--   "Permitir leitura via API anon"          for select to anon          using (true)
--   "Permitir leitura via API authenticated" for select to authenticated using (true)
-- Elas contrariam a decisão D1.2 (20260928140000_licitacoes_externas_revoke_authenticated.sql):
-- leitura de usuário só pela Edge Function api-dashboard-oportunidades (service_role +
-- PUBLIC_LICITACAO_COLUMNS), sem acesso direto via PostgREST para anon, authenticated ou PUBLIC.
--
-- Impacto hoje: nenhum. anon e authenticated não têm grant na tabela, então as policies não
-- liberam linha nenhuma. O risco era latente: um grant devolvido por engano abriria a tabela
-- inteira (inclusive raw, notas, esclarecimentos) para leitura direta, até sem login.
--
-- Esta migration:
-- 1. Remove TODA policy da tabela que alcance anon, authenticated ou public (laço em pg_policies,
--    não só os dois nomes: pega também variação de nome feita à mão). A D1.2 não prevê nenhuma.
--    Idempotente: sem policy, o laço não faz nada (caso do Postgres descartável da CI).
-- 2. Reafirma o revoke de anon, authenticated e PUBLIC, o RLS ligado e o comentário da D1.2.
-- Quem lê/escreve: só service_role (Edge Function e coletores). Nada muda para o Dashboard.
--
-- Verificar: supabase/tests/licitacoes_externas_acl_check.sql (item 4: nenhuma policy para
-- anon/authenticated/public) e, em produção,
--   select policyname from pg_policies where schemaname = 'public' and tablename = 'licitacoes_externas';
-- deve voltar vazio.

begin;

do $$
declare
  v_policy name;
begin
  for v_policy in
    select p.policyname
      from pg_policies p
     where p.schemaname = 'public'
       and p.tablename = 'licitacoes_externas'
       and p.roles && array['anon', 'authenticated', 'public']::name[]
  loop
    execute format('drop policy if exists %I on public.licitacoes_externas', v_policy);
    raise notice 'policy removida de public.licitacoes_externas: %', v_policy;
  end loop;
end $$;

revoke all on table public.licitacoes_externas from anon, authenticated, PUBLIC;

alter table public.licitacoes_externas enable row level security;

comment on table public.licitacoes_externas is
  'Licitações de portais públicos (PNCP, Paradigma). Leituras de usuários/dashboard: exclusivamente via Edge Function api-dashboard-oportunidades (service_role + PUBLIC_LICITACAO_COLUMNS); leituras e escritas internas: service_role (Edge Function + coletores). Sem acesso direto via PostgREST para authenticated, anon ou PUBLIC.';

commit;
