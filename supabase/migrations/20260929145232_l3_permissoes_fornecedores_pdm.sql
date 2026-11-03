-- LicitaGym: L3 — permissões de fornecedores (Econodata), licitacao_itens/licitacao_resultados,
-- catmat_pdm_palavras, norm_txt(text), sequences de identidade e índice duplicado de fornecedor_cnpj.
--
-- Contexto (L0: consultas só leitura no projeto ifaiagegyicjzlpskafh em 29/09/2026):
--   - fornecedores: authenticated com SELECT + policy fornecedores_select (using true). A coluna jsonb
--     econodata guarda a resposta bruta da Econodata (com CPF/e-mail de sócios), além de email,
--     telefones e emails_publicos: qualquer JWT lia isso direto pelo PostgREST.
--   - licitacao_itens / licitacao_resultados: authenticated com SELECT + policy using (true); anon sem nada.
--   - catmat_pdm_palavras: anon e authenticated com ALL (inclusive TRUNCATE, que ignora RLS), herdado da
--     default ACL do schema public. RLS ligado + policy catmat_pdm_palavras_select (authenticated, SELECT).
--   - norm_txt(text): EXECUTE para PUBLIC, anon, authenticated (default ACL). Função SQL imutável, sem
--     efeito colateral; o dono é postgres (routine_privileges não lista supabase_admin).
--   - econodata_consultas: já só postgres/service_role (revoke da 20260929104503); aqui só se reafirma.
--   - licitacao_resultados tem dois índices btree idênticos em (fornecedor_cnpj): idx_licres_cnpj
--     (20260924100000) e licitacao_resultados_fornecedor_cnpj_idx (20260929104503).
--
-- Quem lê o quê (conferido em 29/09/2026):
--   - Edge Function api-fornecedores-homologados: todas as consultas usam o cliente service_role
--     (serviceClient() com SUPABASE_SERVICE_ROLE_KEY); o cliente anon só chama auth.getUser (não lê tabela).
--   - As views fornecedores_homologados, orgaos_compradores e homologacoes_itens são security_invoker:
--     leem as tabelas com os privilégios de quem consulta (service_role). O EXECUTE de norm_txt, usado em
--     homologacoes_itens, também é conferido contra quem consulta: por isso o grant explícito a service_role.
--   - Coletores (services/coletor-externo) leem e gravam com SUPABASE_SERVICE_ROLE_KEY.
--   - Frontend (Dashboard---LicitaGym@650ba5b): só functions.invoke (api-fornecedores-homologados e
--     api-dashboard-oportunidades) e auth; nenhum .from()/.rpc() direto.
--   - Edge Functions com cliente do JWT do usuário (api-pncp-*) não leem nenhum destes objetos.
--   - Views security_invoker com SELECT para authenticated que leem estas tabelas (oportunidades_borracha,
--     v_oportunidades_externas, v_fornecedor_participacoes, v_bi_resultados_itens) também leem
--     licitacoes_externas, cujo acesso de authenticated foi revogado em 20260928140000: já falham hoje para
--     authenticated (permission denied). Esta migration não quebra nada que funcione.
--   - Nenhum índice, coluna gerada ou trigger usa norm_txt nas migrations do repo nem nas 3 recuperadas.
--
-- Modelo após esta migration:
--   fornecedores, econodata_consultas,
--   licitacao_itens, licitacao_resultados -> só service_role (+ dono). Sem policy para authenticated.
--   catmat_pdm_palavras                   -> SELECT para authenticated (policy catmat_pdm_palavras_select);
--                                            ALL para service_role. anon sem nada.
--   norm_txt(text)                        -> EXECUTE para service_role (+ dono postgres). Sem PUBLIC/anon/authenticated.
--   sequences de identidade dessas tabelas -> sem anon/authenticated/PUBLIC (default ACL dava rwU).
--   idx_licres_cnpj                        -> removido; fica licitacao_resultados_fornecedor_cnpj_idx.
--
-- Decisão que esta migration substitui (29/09/2026, Marcelo): a 20260926110000_pncp_rls_policies
-- previa SELECT direto de authenticated em licitacao_itens e licitacao_resultados. Essa previsão deixa de valer:
-- arquiteturalmente, dado de licitação só sai por Edge Function com JWT validado (service_role no banco), como já
-- é em licitacoes_externas desde a 20260928140000. Os COMMENT ON TABLE abaixo substituem os da 20260926110000.
--
-- RLS continua ligado em todas as tabelas. Idempotente (pode rodar duas vezes). Não altera dados.
-- Verificação (só leitura): supabase/tests/l3_permissoes_fornecedores_pdm_acl_check.sql

begin;

-- Falha rápido em vez de enfileirar atrás de uma transação longa do coletor (e bloquear leituras).
set local lock_timeout = '10s';

-- 1) fornecedores: leitura só pela Edge Function (service_role) -------------------------------------------
drop policy if exists fornecedores_select on public.fornecedores;
revoke all on table public.fornecedores from anon, authenticated, PUBLIC;
grant all on table public.fornecedores to service_role;
alter table public.fornecedores enable row level security;
comment on table public.fornecedores is
  'Cadastro de fornecedores (Receita/BrasilAPI + Econodata). Contém dados de contato e o payload bruto da Econodata: sem acesso direto para anon/authenticated; leitura e escrita só service_role (coletor e Edge Function api-fornecedores-homologados).';

-- 2) econodata_consultas: auditoria de chamadas pagas, só service_role (reafirma a 20260929104503) --------
revoke all on table public.econodata_consultas from anon, authenticated, PUBLIC;
grant all on table public.econodata_consultas to service_role;
alter table public.econodata_consultas enable row level security;

-- 3) licitacao_itens / licitacao_resultados: sem leitura direta (mesmo caminho da D1.2 em licitacoes_externas)
drop policy if exists licitacao_itens_select on public.licitacao_itens;
drop policy if exists licitacao_resultados_select on public.licitacao_resultados;
revoke all on table public.licitacao_itens, public.licitacao_resultados from anon, authenticated, PUBLIC;
grant all on table public.licitacao_itens, public.licitacao_resultados to service_role;
alter table public.licitacao_itens enable row level security;
alter table public.licitacao_resultados enable row level security;
comment on table public.licitacao_itens is
  'Itens de contratações públicas. Sem acesso direto para anon/authenticated; leitura via Edge Functions (service_role); escrita só service_role (coletores).';
comment on table public.licitacao_resultados is
  'Resultados (homologação) por item. Sem acesso direto para anon/authenticated; leitura via Edge Functions (service_role); escrita só service_role (coletores).';

-- 4) catmat_pdm_palavras: curadoria de referência, só leitura para authenticated ---------------------------
revoke all on table public.catmat_pdm_palavras from anon, authenticated, PUBLIC;
grant select on table public.catmat_pdm_palavras to authenticated;
grant all on table public.catmat_pdm_palavras to service_role;
alter table public.catmat_pdm_palavras enable row level security;
-- Com RLS ligado e sem policy, o SELECT de authenticated voltaria vazio. A policy vem da 20260929105430;
-- recria só se tiver sumido (não mexe se já existir).
do $$
begin
  if not exists (
    select 1 from pg_policies
     where schemaname = 'public' and tablename = 'catmat_pdm_palavras'
       and policyname = 'catmat_pdm_palavras_select'
  ) then
    create policy catmat_pdm_palavras_select on public.catmat_pdm_palavras
      for select to authenticated using (true);
  end if;
end $$;

-- 5) Sequences de identidade (default ACL do schema public dava USAGE/SELECT/UPDATE a anon/authenticated) --
-- Colunas identity não conferem privilégio na sequence no INSERT; o grant a service_role é só explícito.
do $$
declare
  v_tab text;
  v_seq text;
begin
  foreach v_tab in array array[
    'public.fornecedores', 'public.econodata_consultas', 'public.catmat_pdm_palavras',
    'public.licitacao_itens', 'public.licitacao_resultados'
  ] loop
    if exists (select 1 from pg_attribute
                where attrelid = v_tab::regclass and attname = 'id' and not attisdropped) then
      v_seq := pg_get_serial_sequence(v_tab, 'id');
      if v_seq is not null then
        execute format('revoke all on sequence %s from anon, authenticated, PUBLIC', v_seq);
        execute format('grant all on sequence %s to service_role', v_seq);
      end if;
    end if;
  end loop;
end $$;

-- 6) norm_txt(text): só quem consulta homologacoes_itens (service_role) precisa de EXECUTE ------------------
revoke all on function public.norm_txt(text) from PUBLIC, anon, authenticated;
grant execute on function public.norm_txt(text) to service_role;

-- 7) Índice duplicado em licitacao_resultados(fornecedor_cnpj) ----------------------------------------------
-- Só remove idx_licres_cnpj se licitacao_resultados_fornecedor_cnpj_idx existir, válido, btree, não único,
-- sem predicado nem expressão, exatamente na coluna fornecedor_cnpj.
do $$
begin
  if exists (
    select 1
      from pg_index i
      join pg_class ic on ic.oid = i.indexrelid
      join pg_am am on am.oid = ic.relam
      join pg_attribute a on a.attrelid = i.indrelid and a.attnum = i.indkey[0]
     where i.indrelid = 'public.licitacao_resultados'::regclass
       and ic.relname = 'licitacao_resultados_fornecedor_cnpj_idx'
       and am.amname = 'btree'
       and i.indnatts = 1
       and a.attname = 'fornecedor_cnpj'
       and not i.indisunique
       and i.indisvalid
       and i.indpred is null
       and i.indexprs is null
  ) then
    drop index if exists public.idx_licres_cnpj;
  else
    raise notice 'L3: licitacao_resultados_fornecedor_cnpj_idx ausente ou diferente; idx_licres_cnpj mantido';
  end if;
end $$;

commit;
