-- LicitaGym: fecha para anon as views de contexto PCA x edital criadas em 20260920192204_pca_edital_contexto.
-- Regra do projeto: dado do LicitaGym só para usuário logado. Só ACL e opção de view: nenhum dado muda.
--
-- Contexto (consultas só leitura no projeto ifaiagegyicjzlpskafh em 30/09/2026, ~15:50 BRT):
--   - public.pca_alteracoes_resumo, public.pca_conversao_edital_item e public.pca_conversao_edital_taxa:
--     dono postgres, SEM security_invoker (rodam com os privilégios do dono, ignorando RLS) e, pela ACL
--     padrão do schema public, anon/authenticated/service_role com ALL (SELECT, INSERT, UPDATE, DELETE,
--     TRUNCATE, REFERENCES, TRIGGER). Resultado: anon lia as três pelo PostgREST sem login.
--   - Tabelas base: pca_alteracoes, pca_itens, pca_planos, contratacoes_editais. RLS ligado em todas, uma
--     policy SELECT "using (true)" para authenticated em cada uma, nenhuma policy para anon; anon sem grant.
--   - pca_conversao_edital_taxa lê pca_conversao_edital_item. Nenhuma outra view ou função depende das três.
--
-- Quem lê (conferido no repo em 7e99c65, no Dashboard em 33d6cec e nos logs da API das últimas 24 h):
--   nenhum consumidor. Nenhuma Edge Function, nenhum .from() no Dashboard e nenhuma requisição
--   /rest/v1/pca_* às três views.
--
-- Decisão: security_invoker = true; anon e PUBLIC sem privilégio; authenticated e service_role só SELECT.
--   authenticated fica porque as tabelas base já liberam leitura ao usuário logado por RLS (policy using
--   true + grant): com security_invoker a view mostra ao usuário exatamente o que ele já lê nas tabelas, sem
--   ampliar acesso. Se um dia as tabelas pca_* forem fechadas só para service_role, a view fecha junto,
--   porque passa a respeitar a RLS e os grants de quem consulta.
--
-- Idempotente (pode rodar duas vezes). Verificação (só leitura; erra se algo falhar):
--   supabase/tests/pca_views_security_invoker_check.sql

begin;

-- Falha rápido em vez de esperar atrás de uma transação longa do sync PCA.
set local lock_timeout = '10s';

alter view public.pca_alteracoes_resumo     set (security_invoker = true);
alter view public.pca_conversao_edital_item set (security_invoker = true);
alter view public.pca_conversao_edital_taxa set (security_invoker = true);

-- REVOKE na relação também revoga os privilégios de coluna.
revoke all on table public.pca_alteracoes_resumo, public.pca_conversao_edital_item, public.pca_conversao_edital_taxa
  from PUBLIC, anon, authenticated, service_role;
grant select on table public.pca_alteracoes_resumo, public.pca_conversao_edital_item, public.pca_conversao_edital_taxa
  to authenticated, service_role;

comment on view public.pca_alteracoes_resumo is
  'Resumo do histórico de sync PCA por plano/item. security_invoker: respeita a RLS de pca_alteracoes. Sem acesso para anon/PUBLIC; SELECT para authenticated e service_role.';
comment on view public.pca_conversao_edital_item is
  'Coorte de itens PCA 7830/7220 x edital com vínculo auditável. security_invoker: respeita a RLS das tabelas base. Sem acesso para anon/PUBLIC; SELECT para authenticated e service_role.';
comment on view public.pca_conversao_edital_taxa is
  'Taxa histórica de conversão PCA -> edital (frequência, não ML). security_invoker: respeita a RLS das tabelas base. Sem acesso para anon/PUBLIC; SELECT para authenticated e service_role.';

commit;
