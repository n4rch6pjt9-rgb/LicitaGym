-- LicitaGym: fecha o acesso direto a public.entidades e public.unidades (cadastro PNCP de órgãos/unidades).
-- Regra do projeto: dado do LicitaGym só para usuário logado, e sempre via Edge Function com service_role;
-- nada direto por PostgREST para anon, authenticated ou PUBLIC. Só ACL/RLS: nenhum dado muda.
--
-- Contexto (consultas só leitura no projeto ifaiagegyicjzlpskafh em 30/09/2026, ~09:45 BRT):
--   - entidades (191 linhas) e unidades (497): RLS ligado, mas authenticated tem ALL (inclusive TRUNCATE,
--     que ignora RLS, e INSERT/UPDATE/DELETE sem policy de escrita) + policies *_select_authenticated
--     (using true), criadas em 202609180002. anon e PUBLIC: nada. service_role: ALL.
--   - Chaves uuid com default gen_random_uuid(): não há sequence. Nenhuma trigger, nenhuma publicação.
--   - Dependentes no banco: v_licitacoes_filtro (security_invoker; lê unidades; SELECT só para service_role)
--     e fn_orgaos_uasgs_classificar() (roda como o dono, pg_cron/postgres). FKs de orgaos, irp_*,
--     contratacoes_* apontam para as duas tabelas; a checagem de FK roda como o dono, não precisa de grant.
--
-- Quem lê/escreve (conferido no repo em 3a18caa, no Dashboard em b94e256 e nas Edge Functions publicadas):
--   - Único acesso: Edge Function sync-pncp-orgaos (service_role; upsert em entidades e SELECT do id).
--   - Nenhum .from('entidades'|'unidades') nem rpc no Dashboard (só functions.invoke); nenhuma Edge Function
--     publicada fora do repo (api-fornecedores-homologados, sync-pncp-contratacoes-itens, link-pca-edital,
--     analyze-public-material, smooth-api, linear-health) cita essas tabelas; coletores Python também não.
--   => Nenhum cliente logado lê direto: authenticated perde tudo, sem policy de exceção.
--
-- Modelo após esta migration (mesmo padrão de orgaos/uasgs em 20260930130000):
--   entidades, unidades -> RLS ligado, nenhuma policy; anon/authenticated/PUBLIC sem privilégio algum
--   (tabela e colunas); service_role só SELECT/INSERT/UPDATE/DELETE (sai TRUNCATE/REFERENCES/TRIGGER/MAINTAIN).
--   Sequences próprias (hoje nenhuma): sem privilégio para anon/authenticated/PUBLIC.
--
-- Idempotente (pode rodar duas vezes). Verificação (só leitura; erra se algo falhar):
--   supabase/tests/entidades_unidades_acl_check.sql

begin;

-- Falha rápido em vez de enfileirar atrás de uma transação longa do coletor (e bloquear leituras).
set local lock_timeout = '10s';

alter table public.entidades enable row level security;
alter table public.unidades  enable row level security;

drop policy if exists entidades_select_authenticated on public.entidades;
drop policy if exists unidades_select_authenticated  on public.unidades;

-- REVOKE na tabela também revoga os privilégios de coluna.
revoke all on table public.entidades, public.unidades from PUBLIC, anon, authenticated;
revoke all on table public.entidades, public.unidades from service_role;
grant select, insert, update, delete on table public.entidades, public.unidades to service_role;

-- Sequences ligadas às tabelas (identity/serial). Hoje não há nenhuma (uuid); fica para o caso de alguém criar.
do $$
declare
  v_seq regclass;
begin
  for v_seq in
    select d.objid::regclass
      from pg_depend d join pg_class s on s.oid = d.objid and s.relkind = 'S'
     where d.classid = 'pg_class'::regclass
       and d.refobjid in ('public.entidades'::regclass, 'public.unidades'::regclass)
       and d.deptype in ('a', 'i')
  loop
    execute format('revoke all on sequence %s from PUBLIC, anon, authenticated', v_seq);
  end loop;
end $$;

comment on table public.entidades is
  'Entidades PNCP (órgãos) sincronizadas pela Edge Function sync-pncp-orgaos. Sem acesso direto via PostgREST para anon, authenticated ou PUBLIC; leitura e escrita só por service_role (Edge Functions).';
comment on table public.unidades is
  'Unidades compradoras PNCP ligadas a public.orgaos. Sem acesso direto via PostgREST para anon, authenticated ou PUBLIC; leitura e escrita só por service_role (Edge Functions).';

commit;
