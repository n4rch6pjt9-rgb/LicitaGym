-- RLS das tabelas de licitações externas / PNCP e da taxonomia CATMAT.
--
-- Decisão (2026-09-25): licitações, itens e resultados vêm de portais públicos e podem ser
-- lidos por authenticated. Já documentos/chunks podem carregar texto bruto antes da
-- sanitização; por isso ficam sem SELECT direto para authenticated.
--   INSERT/UPDATE/DELETE: nenhuma policy para anon/authenticated; só service_role (coletor),
--   que ignora RLS.
-- taxonomia_mapa_caracteristica é curadoria editável: leitura authenticated; escrita só admin
-- (app_metadata.licitagym_role = 'admin', gravável apenas com service_role via Admin API).
--
-- ACL: RLS filtra linhas; GRANT concede acesso à tabela. Projetos novos não concedem DML por
-- padrão, e produção herdou ALL para anon/authenticated (inclusive TRUNCATE, que ignora RLS).
-- Os GRANTs abaixo tornam o modelo explícito nos dois casos (precedente: 20260919233512).
--
-- Idempotente. Não altera dados.

revoke all on table
  public.licitacoes_externas, public.licitacao_documentos, public.licitacao_chunks,
  public.licitacao_itens, public.licitacao_resultados, public.catmat_itens,
  public.oportunidades_borracha, public.catmat_itens_taxonomia,
  public.taxonomia_mapa_caracteristica
from anon, authenticated;

grant select on table
  public.licitacoes_externas, public.licitacao_itens, public.licitacao_resultados, public.catmat_itens,
  public.oportunidades_borracha, public.catmat_itens_taxonomia
to authenticated;

grant select, insert, update, delete on table public.taxonomia_mapa_caracteristica to authenticated;

grant all on table
  public.licitacoes_externas, public.licitacao_documentos, public.licitacao_chunks,
  public.licitacao_itens, public.licitacao_resultados, public.catmat_itens,
  public.oportunidades_borracha, public.catmat_itens_taxonomia,
  public.taxonomia_mapa_caracteristica
to service_role;

comment on table public.licitacoes_externas is
  'Licitações de portais públicos (PNCP, Paradigma). RLS: SELECT authenticated; escrita só service_role.';
comment on table public.licitacao_documentos is
  'Documentos das licitações. Sem SELECT direto para authenticated; escrita só service_role.';
comment on table public.licitacao_chunks is
  'Chunks/embeddings de documentos de licitações. Sem SELECT direto para authenticated; escrita só service_role.';
comment on table public.licitacao_itens is
  'Itens de contratações públicas. RLS: SELECT authenticated; escrita só service_role.';
comment on table public.licitacao_resultados is
  'Resultados (homologação) públicos por item. RLS: SELECT authenticated; escrita só service_role.';
comment on table public.taxonomia_mapa_caracteristica is
  'Curadoria característica CATMAT -> bloco. RLS: SELECT authenticated; escrita app_metadata.licitagym_role = admin.';

alter table public.licitacao_documentos enable row level security;
alter table public.licitacao_chunks enable row level security;
alter table public.taxonomia_mapa_caracteristica enable row level security;

drop policy if exists licitacao_documentos_select on public.licitacao_documentos;
drop policy if exists licitacao_chunks_select on public.licitacao_chunks;

revoke all on function public.match_licitacao_chunks(vector, integer, text, text)
  from public, anon, authenticated;
grant execute on function public.match_licitacao_chunks(vector, integer, text, text)
  to service_role;

drop policy if exists taxonomia_mapa_admin_insert on public.taxonomia_mapa_caracteristica;
create policy taxonomia_mapa_admin_insert on public.taxonomia_mapa_caracteristica
  for insert to authenticated
  with check (((select auth.jwt()) -> 'app_metadata' ->> 'licitagym_role') = 'admin');

drop policy if exists taxonomia_mapa_admin_update on public.taxonomia_mapa_caracteristica;
create policy taxonomia_mapa_admin_update on public.taxonomia_mapa_caracteristica
  for update to authenticated
  using (((select auth.jwt()) -> 'app_metadata' ->> 'licitagym_role') = 'admin')
  with check (((select auth.jwt()) -> 'app_metadata' ->> 'licitagym_role') = 'admin');

drop policy if exists taxonomia_mapa_admin_delete on public.taxonomia_mapa_caracteristica;
create policy taxonomia_mapa_admin_delete on public.taxonomia_mapa_caracteristica
  for delete to authenticated
  using (((select auth.jwt()) -> 'app_metadata' ->> 'licitagym_role') = 'admin');
