-- LicitaGym: fuso de data_documento, data_resultado e data_homologacao do PNCP (#339, continuação da #332).
--
-- Por quê: o coletor gravava o horário de Brasília dessas três colunas rotulado como UTC (pncp._data), 3 h antes
--   do instante real. Em 11/10/2026 eram 4.997 documentos, 10.222 resultados e 622 homologações. O raw do
--   documento não guarda dataPublicacaoPncp e o resultado não tem raw: não dá para reconstruir a data. A
--   correção das linhas já gravadas é somar 3 h, uma vez.
-- O que muda:
--   private.pncp_fuso_linha_339 marca a linha já corrigida (a migration pode rodar de novo sem somar 6 h);
--   private.corrigir_fuso_pncp_339() soma 3 h só nas linhas ainda não marcadas e devolve a contagem;
--   esta migration chama a função uma vez.
-- Quem escreve: o dono da migration (postgres). anon, authenticated e service_role não leem a marca nem executam
--   a função. Não inventa data: só desloca o timestamptz que já está na linha.
-- A imagem antiga do coletor, se gravar depois desta migration, volta a gravar no formato velho. O merge na main
-- aplica isto em produção; a imagem do Cloud Run precisa publicar junto (a issue #339).
-- Verificar: supabase/tests/pncp_fuso_documento_resultado_homologacao_check.sql
-- Idempotente. Rollback: somar -3 h nas linhas da marca e apagar a marca; não está neste arquivo.

begin;

set local lock_timeout = '10s';
set local statement_timeout = '2min';

create schema if not exists private;

create table if not exists private.pncp_fuso_linha_339 (
  relacao text not null check (relacao in ('licitacao_documentos', 'licitacao_resultados', 'licitacoes_externas')),
  id bigint not null,
  corrigida_em timestamptz not null default now(),
  primary key (relacao, id)
);

alter table private.pncp_fuso_linha_339 enable row level security;

revoke all on table private.pncp_fuso_linha_339 from PUBLIC, anon, authenticated, service_role;

create or replace function private.corrigir_fuso_pncp_339()
returns table (relacao text, corrigidas bigint)
language plpgsql
volatile
security invoker
set search_path = public, private, pg_temp
as $fn$
declare
  n bigint;
begin
  with alvo as (
    update public.licitacao_documentos d
       set data_documento = d.data_documento + interval '3 hours'
     where d.data_documento is not null
       and not exists (
         select 1 from private.pncp_fuso_linha_339 m
          where m.relacao = 'licitacao_documentos' and m.id = d.id)
    returning d.id
  )
  insert into private.pncp_fuso_linha_339 (relacao, id)
  select 'licitacao_documentos', alvo.id from alvo;
  get diagnostics n = row_count;
  relacao := 'licitacao_documentos';
  corrigidas := n;
  return next;

  with alvo as (
    update public.licitacao_resultados r
       set data_resultado = r.data_resultado + interval '3 hours'
     where r.data_resultado is not null
       and not exists (
         select 1 from private.pncp_fuso_linha_339 m
          where m.relacao = 'licitacao_resultados' and m.id = r.id)
    returning r.id
  )
  insert into private.pncp_fuso_linha_339 (relacao, id)
  select 'licitacao_resultados', alvo.id from alvo;
  get diagnostics n = row_count;
  relacao := 'licitacao_resultados';
  corrigidas := n;
  return next;

  with alvo as (
    update public.licitacoes_externas l
       set data_homologacao = l.data_homologacao + interval '3 hours'
     where l.data_homologacao is not null
       and not exists (
         select 1 from private.pncp_fuso_linha_339 m
          where m.relacao = 'licitacoes_externas' and m.id = l.id)
    returning l.id
  )
  insert into private.pncp_fuso_linha_339 (relacao, id)
  select 'licitacoes_externas', alvo.id from alvo;
  get diagnostics n = row_count;
  relacao := 'licitacoes_externas';
  corrigidas := n;
  return next;
end
$fn$;

revoke all on function private.corrigir_fuso_pncp_339() from PUBLIC, anon, authenticated, service_role;

comment on function private.corrigir_fuso_pncp_339() is
  'Soma 3 h em data_documento, data_resultado e data_homologacao ainda não marcadas (#339). '
  'A segunda chamada não mexe na linha já marcada.';

select * from private.corrigir_fuso_pncp_339();

commit;
