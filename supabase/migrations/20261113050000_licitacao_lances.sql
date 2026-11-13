-- LicitaGym: lances da disputa por item (spec 0061, K-12)
--
-- Contexto (HAR do mural da FIEB, processo 38191, 12/11/2026):
--   PesquisarProcessoDetalheItemProdutoLance devolveu 33 lances do item, cada um com data e hora, valor, empresa,
--   marca e modelo; 7 têm posição final e 1 é o vencedor. O coletor grava em licitacao_resultados só as 7 posições
--   finais (paradigma.py, linhas_resultados) e descarta os 26 lances da disputa. A aba Histórico do detalhe (spec 0061,
--   K-1 e K-3) precisa da disputa inteira, e a reconciliação de resultados da 0029 (K-10) apaga resultado de processo
--   não concluído sem perder a disputa.
--
-- O que muda (aditivo):
--   * tabela public.licitacao_lances, uma linha por lance: licitação, item, id do lance no portal (nCdLance), data e
--     hora, valor, moeda, empresa e CNPJ como o portal publica, marca, modelo, posição final (quando houver), vencedor
--     e o registro original (raw);
--   * chave única (licitacao_id, numero_item, id_lance_externo): o upsert do coletor não duplica;
--   * apagar a licitação apaga os lances.
-- Quem lê/escreve: só service_role (coletor e Edge Functions api-*). RLS ligada, sem policy, sem acesso para
--   anon e authenticated (o Dashboard lê pela Edge Function).
-- Verificar: supabase/tests/licitacao_lances_check.sql.
begin;

create table if not exists public.licitacao_lances (
  id                bigint generated always as identity primary key,
  licitacao_id      bigint not null references public.licitacoes_externas(id) on delete cascade,
  numero_item       int not null,
  id_lance_externo  bigint not null,     -- nCdLance do portal
  data_lance        timestamptz,         -- tDtLance (nulo quando a fonte não traz)
  valor             numeric,             -- dVlLanceMoeda, valor unitário como o portal mostra
  moeda             text,
  fornecedor_nome   text,                -- como o portal publica (decisão de 01/10/2026: documento de licitação é público)
  fornecedor_cnpj   text,                -- 14 dígitos quando o nome traz CNPJ; senão nulo
  marca             text,
  modelo            text,
  posicao           int,                 -- nNrRanking; nulo para lance sem posição final
  vencedor          boolean not null default false,
  raw               jsonb not null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint licitacao_lances_chave unique (licitacao_id, numero_item, id_lance_externo)
);

create index if not exists idx_licitacao_lances_item on public.licitacao_lances (licitacao_id, numero_item, data_lance);

comment on table public.licitacao_lances is
  'Lances da disputa por item (mural Paradigma, PesquisarProcessoDetalheItemProdutoLance). Histórico, não preço homologado: o preço homologado fica em licitacao_resultados. Spec 0061 (K-11, K-12).';

alter table public.licitacao_lances enable row level security;
revoke all on table public.licitacao_lances from anon, authenticated, public;
grant select, insert, update, delete on table public.licitacao_lances to service_role;

commit;
