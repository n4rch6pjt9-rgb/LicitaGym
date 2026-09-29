-- 26/09/2026 — Documentos das licitações guardados dentro do LicitaGym (Supabase Storage) com histórico.
-- Origem: licitagym-coletor-sistema-s@8925abf (20260926140000_documentos_no_licitagym.sql), nunca aplicada;
-- renumerada em 29/09/2026 para depois de 20260929130000 e com a seção 6 (ACL) acrescentada.
-- Idempotente. Depende de 20260923100000_licitacoes_externas e 20260925120000_sistema_s_coleta_externa (fontes_externas).

-- 1) Bucket privado: só usuário logado lê (por link assinado); só o coletor (service_role) grava ---------------
insert into storage.buckets (id, name, public, file_size_limit)
values ('licitacao-documentos', 'licitacao-documentos', false, 52428800)
on conflict (id) do update set public = false;

drop policy if exists licdoc_storage_select on storage.objects;
create policy licdoc_storage_select on storage.objects
  for select to authenticated using (bucket_id = 'licitacao-documentos');

-- 2) Histórico dos documentos: nada é apagado ------------------------------------------------------------------
alter table public.licitacao_documentos
  add column if not exists origem_portal          text,          -- "Processo", "Proposta"... (sDsOrigem)
  add column if not exists first_seen_at          timestamptz default now(),
  add column if not exists last_seen_at           timestamptz default now(),
  add column if not exists removido_do_portal_em  timestamptz,   -- sumiu do portal; o arquivo continua aqui
  add column if not exists baixado_em             timestamptz;
update public.licitacao_documentos set first_seen_at = coalesce(first_seen_at, created_at),
                                       last_seen_at  = coalesce(last_seen_at, updated_at, created_at)
 where first_seen_at is null or last_seen_at is null;
create index if not exists idx_licdoc_novos on public.licitacao_documentos(first_seen_at desc);

-- 3) Visitante institucional por portal (código devolvido pelo SalvarVisitante; evita cadastro repetido) --------
create table if not exists public.portal_visitante (
  fonte           text primary key,
  n_cd_visitante  int not null,
  cnpj            text not null check (cnpj ~ '^\d{14}$'),
  atualizado_em   timestamptz not null default now()
);
alter table public.portal_visitante enable row level security;   -- sem policy: só service_role

-- 4) Campo único por licitação com todos os documentos (Dashboard) ---------------------------------------------
create or replace view public.v_licitacao_documentos
with (security_invoker = true) as
select l.id                                   as licitacao_id,
       l.fonte, l.numero_edital, l.status_normalizado,
       count(d.id)                            as qtd_documentos,
       count(d.id) filter (where d.storage_uri is not null)                          as qtd_disponiveis,
       count(d.id) filter (where d.first_seen_at > now() - interval '7 days')        as qtd_novos_7d,
       count(d.id) filter (where d.status_processamento = 'pendente')                as qtd_pendentes,
       max(d.first_seen_at)                   as ultimo_documento_em,
       coalesce(jsonb_agg(jsonb_build_object(
         'id', d.id, 'nome', d.nome_original, 'secao', d.secao, 'origem', d.origem_portal,
         'data_documento', d.data_documento, 'primeira_vez', d.first_seen_at,
         'novo', d.first_seen_at > now() - interval '7 days',
         'removido_do_portal_em', d.removido_do_portal_em,
         'status', d.status_processamento, 'mime', d.mime_type, 'tamanho', d.tamanho_bytes,
         'bucket', case when d.storage_uri like 'supabase://%' then split_part(substr(d.storage_uri, 12), '/', 1) end,
         'caminho', case when d.storage_uri like 'supabase://%'
                         then substr(d.storage_uri, 12 + length(split_part(substr(d.storage_uri, 12), '/', 1)) + 1) end
       ) order by d.data_documento nulls last, d.id) filter (where d.id is not null), '[]'::jsonb) as documentos
from public.licitacoes_externas l
left join public.licitacao_documentos d on d.licitacao_id = l.id
group by l.id;

-- 5) Fontes Paradigma validadas em 26/09/2026 (sem elas o FK licext_fonte_fk barra a gravação da SFIEC etc.) -----
insert into public.fontes_externas (slug, entidade, uf, plataforma, base_url, modo_coleta, robots_permite, observacao) values
  ('firjan', 'Firjan (SESI/RJ, SENAI/RJ, IEL/RJ)',  'RJ', 'paradigma', 'https://portaldecompras.firjan.com.br/portal', 'automatico', null, 'Webservice público; robots.txt ausente (26/09/2026)'),
  ('fiergs', 'FIERGS (SESI/RS, SENAI/RS, IEL/RS)',  'RS', 'paradigma', 'https://compras.sistemafiergs.org.br/portal',  'automatico', null, 'Webservice público; robots.txt ausente (26/09/2026)'),
  ('findes', 'Findes (SESI/ES, SENAI/ES, IEL/ES)',  'ES', 'paradigma', 'https://portaldecompras.findes.org.br/portal', 'automatico', null, 'Webservice público; robots.txt ausente (26/09/2026)'),
  ('fieb',   'FIEB (SESI/BA, SENAI/BA, IEL/BA)',    'BA', 'paradigma', 'https://compras.fieb.org.br/portal',           'automatico', null, 'Webservice público; robots.txt ausente (26/09/2026)'),
  ('fiems',  'FIEMS (SESI/MS, SENAI/MS)',           'MS', 'paradigma', 'https://compras.fiems.com.br/portal',          'automatico', null, 'Webservice público; robots.txt ausente (26/09/2026)'),
  ('fiemt',  'FIEMT (SESI/MT, SENAI/MT)',           'MT', 'paradigma', 'https://compras.sfiemt.ind.br/portal',         'automatico', null, 'Webservice público; robots.txt ausente (26/09/2026)'),
  ('sfiec',  'SFIEC (SESI/CE, SENAI/CE, IEL/CE)',   'CE', 'paradigma', 'https://portaldecompras.sfiec.org.br/portal',  'automatico', null, 'Validado 26/09/2026: lances, catálogo, mural estatístico, anexos (exige visitante)'),
  ('fiemg',  'FIEMG (SESI/MG, SENAI/MG, IEL/MG)',   'MG', 'paradigma', 'https://compras.fiemg.com.br/portal',          'bloqueado',  null, 'Cloudflare recusa cliente automatizado; não contornar'),
  ('sescdn', 'Sesc Departamento Nacional (Paradigma)', null, 'paradigma', 'https://egov-br.paradigmabs.com.br/sescdn/portal', 'aviso_fornecedor', false, 'robots.txt do host proíbe coleta automatizada'),
  ('sescrj', 'Sesc RJ',                             'RJ', 'paradigma', 'https://egov.paradigmabs.com.br/SESCRJ/portal', 'aviso_fornecedor', false, 'robots.txt do host proíbe coleta automatizada'),
  ('sescba', 'Sesc BA',                             'BA', 'paradigma', 'https://egov.paradigmabs.com.br/sescba/portal', 'aviso_fornecedor', false, 'robots.txt do host proíbe coleta automatizada')
on conflict (slug) do nothing;

-- 6) ACL explícita (mesmo modelo de 20260929130000_acl_sistema_s_catalogos) ------------------------------------
-- portal_visitante: só service_role (coletor). v_licitacao_documentos: authenticated só SELECT.
revoke all on table public.portal_visitante, public.v_licitacao_documentos from anon, authenticated, PUBLIC;
grant select on table public.v_licitacao_documentos to authenticated;
grant all on table public.portal_visitante, public.v_licitacao_documentos to service_role;
