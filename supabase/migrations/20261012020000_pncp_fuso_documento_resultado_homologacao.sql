-- LicitaGym: fuso de data_documento, data_resultado e data_homologacao (#339, continuação da #332).
--
-- Por quê: o coletor do PNCP gravava o horário de Brasília dessas três colunas rotulado como UTC
--   (pncp._data, antes de _instante passar a aplicar FUSO_PNCP). Em 11/10/2026 eram 4.997 documentos,
--   10.222 resultados e 622 homologações. O raw do documento não guarda dataPublicacaoPncp e o resultado
--   não tem raw: não dá para reconstruir a data. A correção das linhas já gravadas do PNCP é somar 3 h, uma vez.
-- SEST e Paradigma não têm esse bug. Os dois gravam pelo mesmo parse_data (portal.py): o portal manda
--   /Date(milissegundos)/ e o coletor faz datetime.fromtimestamp(ms/1000, tz=timezone.utc). O instante já é UTC.
--   data_resultado do Paradigma é o próprio parse_data(tDtHomologacao), o mesmo instante de data_homologacao.
--   Somar 3 h nessas linhas deslocaria data válida. fonte da coluna:
--     PNCP = 'pncp';
--     SEST SENAT = 'sestsenat' (fontes_externas.plataforma = 'paradigma');
--     os outros portais Paradigma (fiesc, firjan, ...) também têm plataforma = 'paradigma'.
--   Não há slug 'sest' nem 'paradigma' em licitacoes_externas.fonte.
-- O que muda:
--   private.pncp_fuso_linha_339 marca (relacao, id, fonte). A marca do PNCP não vale para outra fonte;
--   private.corrigir_fuso_pncp_339() soma 3 h só em fonte = 'pncp' ainda não marcada com essa fonte
--     (regra pncp_mais_3h) e, nas fontes com plataforma paradigma, só registra regra manter_utc, sem UPDATE
--     da data. A segunda chamada não soma de novo e não regrava a marca;
--   esta migration chama a função uma vez.
-- Quem escreve: o dono da migration (postgres). anon, authenticated e service_role não leem a marca nem executam
--   a função. Não inventa data: no PNCP só desloca o timestamptz que já está na linha; no Paradigma não mexe.
-- Outra plataforma (portal_rlc_rca, wordpress, manual) não entra no +3 h e não ganha marca: o coletor delas
--   não foi lido como o mesmo bug, e marcar sem regra seria tratar dado oficial no escuro.
-- A imagem antiga do coletor PNCP, se gravar depois desta migration, volta a gravar no formato velho. O merge
--   na main aplica isto em produção; a imagem do Cloud Run precisa publicar junto (a issue #339).
-- Verificar: supabase/tests/pncp_fuso_documento_resultado_homologacao_check.sql
-- Idempotente. Rollback: somar -3 h só nas linhas com regra pncp_mais_3h e apagar a marca; não está neste arquivo.
--
-- Compatibilidade (13/10/2026): a primeira versão deste arquivo (commit d96b968, sem fonte/regra e somando 3 h em
--   toda linha marcada) foi aplicada à mão em produção enquanto a integração Supabase <-> GitHub estava parada, e
--   rodou: 15.842 marcas, das quais 125 documentos do sestsenat e 1 homologação da sfiec (plataforma paradigma) foram
--   deslocados indevidamente. Esta versão nunca aplicou: "cannot change return type of existing function". O bloco
--   de compatibilidade (função private.pncp_fuso_339_compatibilidade(), chamada abaixo) só age quando encontra a
--   tabela no formato antigo: acrescenta fonte/regra, preenche com a fonte real da linha, devolve as 3 h das linhas
--   que não são pncp e as marca manter_utc, refaz a chave e, fora dela, a função antiga é derrubada antes da nova.
--   Em banco limpo (CI) não faz nada; a checagem recria o formato antigo com dados fictícios e exercita a função.
--   Marca órfã (linha apagada depois da v1): fonte fica 'desconhecida', sem inventar proveniência; em 13/10 há 0. Exceção à regra "não editar
--   migration mergeada", autorizada pelo Marcelo em 13/10/2026, porque o arquivo ainda não tinha sido aplicado pela
--   integração e qualquer migration nova ficaria atrás dele na fila.
--   Conferido em produção antes do merge (13/10, só leitura): nenhuma das 126 linhas foi regravada depois da marca da
--   v1 (12/10 04:31 UTC; o coletor do Sistema S não rodou) e não há linha PNCP com data e sem marca, então o `select`
--   final não soma 3 h em linha nova. Números esperados no `raise notice` da compatibilidade, no log da integração:
--   125 documentos, 0 resultados, 1 homologação. Marcas manter_utc com corrigida_em anterior a 13/10/2026 vieram
--   deste bloco (a função nova só marca plataforma paradigma; a v1 tinha deslocado toda fonte).
--   Volta do bloco: somar +3 h nas linhas das marcas com regra manter_utc e corrigida_em < '2026-10-13'; não está
--   neste arquivo.

begin;

set local lock_timeout = '10s';
set local statement_timeout = '2min';

create schema if not exists private;

-- Compatibilidade com a primeira versão aplicada à mão (ver cabeçalho). Só age se a tabela existe sem `fonte`.
-- Função (e não bloco anônimo) para a checagem poder recriar o formato antigo e exercitá-la. Devolve quantas linhas
-- fora do PNCP tiveram as 3 h devolvidas; zeros quando não há nada a fazer.
create or replace function private.pncp_fuso_339_compatibilidade()
returns table (documentos bigint, resultados bigint, homologacoes bigint)
language plpgsql
volatile
security invoker
set search_path = public, private, pg_temp
as $fn$
declare
  n_doc bigint := 0;
  n_res bigint := 0;
  n_hom bigint := 0;
begin
  if not exists (
    select 1 from information_schema.tables
     where table_schema = 'private' and table_name = 'pncp_fuso_linha_339'
  ) or exists (
    select 1 from information_schema.columns
     where table_schema = 'private' and table_name = 'pncp_fuso_linha_339' and column_name = 'fonte'
  ) then
    documentos := 0; resultados := 0; homologacoes := 0;
    return next;
    return;
  end if;

  alter table private.pncp_fuso_linha_339 add column fonte text, add column regra text;

  -- fonte real da linha marcada (a primeira versão não a guardava)
  update private.pncp_fuso_linha_339 m
     set fonte = l.fonte
    from public.licitacao_documentos d
    join public.licitacoes_externas l on l.id = d.licitacao_id
   where m.relacao = 'licitacao_documentos' and d.id = m.id;
  update private.pncp_fuso_linha_339 m
     set fonte = l.fonte
    from public.licitacao_resultados r
    join public.licitacoes_externas l on l.id = r.licitacao_id
   where m.relacao = 'licitacao_resultados' and r.id = m.id;
  update private.pncp_fuso_linha_339 m
     set fonte = l.fonte
    from public.licitacoes_externas l
   where m.relacao = 'licitacoes_externas' and l.id = m.id;

  -- Linhas que não são do PNCP: a primeira versão somou 3 h em data que já era UTC. Devolve e marca manter_utc.
  update public.licitacao_documentos d
     set data_documento = d.data_documento - interval '3 hours'
    from private.pncp_fuso_linha_339 m
   where m.relacao = 'licitacao_documentos' and m.id = d.id
     and m.fonte is not null and m.fonte <> 'pncp' and d.data_documento is not null;
  get diagnostics n_doc = row_count;
  update public.licitacao_resultados r
     set data_resultado = r.data_resultado - interval '3 hours'
    from private.pncp_fuso_linha_339 m
   where m.relacao = 'licitacao_resultados' and m.id = r.id
     and m.fonte is not null and m.fonte <> 'pncp' and r.data_resultado is not null;
  get diagnostics n_res = row_count;
  update public.licitacoes_externas l
     set data_homologacao = l.data_homologacao - interval '3 hours'
    from private.pncp_fuso_linha_339 m
   where m.relacao = 'licitacoes_externas' and m.id = l.id
     and m.fonte is not null and m.fonte <> 'pncp' and l.data_homologacao is not null;
  get diagnostics n_hom = row_count;

  update private.pncp_fuso_linha_339
     set regra = case when fonte = 'pncp' then 'pncp_mais_3h' else 'manter_utc' end
   where fonte is not null;
  -- Marca órfã (linha apagada depois da primeira versão): não há como saber a fonte. Fica 'desconhecida', com a
  -- regra que a v1 de fato aplicou (+3 h). A função nova não a encontra (o join com a licitação falha).
  update private.pncp_fuso_linha_339
     set fonte = 'desconhecida', regra = 'pncp_mais_3h'
   where fonte is null;

  alter table private.pncp_fuso_linha_339
    alter column fonte set not null,
    alter column regra set not null,
    drop constraint if exists pncp_fuso_linha_339_pkey,
    add primary key (relacao, id, fonte),
    add constraint pncp_fuso_linha_339_regra_check check (regra in ('pncp_mais_3h', 'manter_utc'));

  raise notice 'fuso 339 compatibilidade: devolvidas 3 h em % documentos, % resultados e % homologacoes fora do PNCP',
    n_doc, n_res, n_hom;
  documentos := n_doc; resultados := n_res; homologacoes := n_hom;
  return next;
end
$fn$;

revoke all on function private.pncp_fuso_339_compatibilidade() from PUBLIC, anon, authenticated, service_role;

select * from private.pncp_fuso_339_compatibilidade();

-- A primeira versão tinha outro retorno; create or replace não troca o tipo de retorno.
drop function if exists private.corrigir_fuso_pncp_339();

create table if not exists private.pncp_fuso_linha_339 (
  relacao text not null check (relacao in ('licitacao_documentos', 'licitacao_resultados', 'licitacoes_externas')),
  id bigint not null,
  fonte text not null,
  regra text not null check (regra in ('pncp_mais_3h', 'manter_utc')),
  corrigida_em timestamptz not null default now(),
  primary key (relacao, id, fonte)
);

alter table private.pncp_fuso_linha_339 enable row level security;

revoke all on table private.pncp_fuso_linha_339 from PUBLIC, anon, authenticated, service_role;

comment on table private.pncp_fuso_linha_339 is
  'Marca por fonte da #339. pncp_mais_3h = data do PNCP somada 3 h. manter_utc = Paradigma/SEST já em UTC, data intacta.';

create or replace function private.corrigir_fuso_pncp_339()
returns table (fonte text, relacao text, corrigidas bigint)
language plpgsql
volatile
security invoker
set search_path = public, private, pg_temp
as $fn$
#variable_conflict use_column
declare
  n_doc bigint;
  n_res bigint;
  n_hom bigint;
  n_manter bigint := 0;
  n_passo bigint;
begin
  with alvo as (
    update public.licitacao_documentos d
       set data_documento = d.data_documento + interval '3 hours'
      from public.licitacoes_externas l
     where d.licitacao_id = l.id
       and l.fonte = 'pncp'
       and d.data_documento is not null
       and not exists (
         select 1 from private.pncp_fuso_linha_339 m
          where m.relacao = 'licitacao_documentos'
            and m.id = d.id
            and m.fonte = 'pncp')
    returning d.id
  )
  insert into private.pncp_fuso_linha_339 (relacao, id, fonte, regra)
  select 'licitacao_documentos', alvo.id, 'pncp', 'pncp_mais_3h' from alvo;
  get diagnostics n_doc = row_count;

  with alvo as (
    update public.licitacao_resultados r
       set data_resultado = r.data_resultado + interval '3 hours'
      from public.licitacoes_externas l
     where r.licitacao_id = l.id
       and l.fonte = 'pncp'
       and r.data_resultado is not null
       and not exists (
         select 1 from private.pncp_fuso_linha_339 m
          where m.relacao = 'licitacao_resultados'
            and m.id = r.id
            and m.fonte = 'pncp')
    returning r.id
  )
  insert into private.pncp_fuso_linha_339 (relacao, id, fonte, regra)
  select 'licitacao_resultados', alvo.id, 'pncp', 'pncp_mais_3h' from alvo;
  get diagnostics n_res = row_count;

  with alvo as (
    update public.licitacoes_externas l
       set data_homologacao = l.data_homologacao + interval '3 hours'
     where l.fonte = 'pncp'
       and l.data_homologacao is not null
       and not exists (
         select 1 from private.pncp_fuso_linha_339 m
          where m.relacao = 'licitacoes_externas'
            and m.id = l.id
            and m.fonte = 'pncp')
    returning l.id
  )
  insert into private.pncp_fuso_linha_339 (relacao, id, fonte, regra)
  select 'licitacoes_externas', alvo.id, 'pncp', 'pncp_mais_3h' from alvo;
  get diagnostics n_hom = row_count;

  -- SEST (sestsenat) e os outros slugs com plataforma paradigma: o instante já é UTC. Não há UPDATE.
  -- A marca usa a fonte da linha (sestsenat, fiesc, ...), não 'pncp', para esta passagem não ficar
  -- bloqueada por uma marca do PNCP no mesmo id.
  insert into private.pncp_fuso_linha_339 (relacao, id, fonte, regra)
  select 'licitacao_documentos', d.id, l.fonte, 'manter_utc'
    from public.licitacao_documentos d
    join public.licitacoes_externas l on l.id = d.licitacao_id
    join public.fontes_externas f on f.slug = l.fonte
   where f.plataforma = 'paradigma'
     and d.data_documento is not null
     and not exists (
       select 1 from private.pncp_fuso_linha_339 m
        where m.relacao = 'licitacao_documentos'
          and m.id = d.id
          and m.fonte = l.fonte);
  get diagnostics n_passo = row_count;
  n_manter := n_manter + n_passo;

  insert into private.pncp_fuso_linha_339 (relacao, id, fonte, regra)
  select 'licitacao_resultados', r.id, l.fonte, 'manter_utc'
    from public.licitacao_resultados r
    join public.licitacoes_externas l on l.id = r.licitacao_id
    join public.fontes_externas f on f.slug = l.fonte
   where f.plataforma = 'paradigma'
     and r.data_resultado is not null
     and not exists (
       select 1 from private.pncp_fuso_linha_339 m
        where m.relacao = 'licitacao_resultados'
          and m.id = r.id
          and m.fonte = l.fonte);
  get diagnostics n_passo = row_count;
  n_manter := n_manter + n_passo;

  insert into private.pncp_fuso_linha_339 (relacao, id, fonte, regra)
  select 'licitacoes_externas', l.id, l.fonte, 'manter_utc'
    from public.licitacoes_externas l
    join public.fontes_externas f on f.slug = l.fonte
   where f.plataforma = 'paradigma'
     and l.data_homologacao is not null
     and not exists (
       select 1 from private.pncp_fuso_linha_339 m
        where m.relacao = 'licitacoes_externas'
          and m.id = l.id
          and m.fonte = l.fonte);
  get diagnostics n_passo = row_count;
  n_manter := n_manter + n_passo;

  raise notice 'fuso 339: pncp documentos % resultados % homologacoes %; paradigma marcado sem deslocar %',
    n_doc, n_res, n_hom, n_manter;

  fonte := 'pncp';
  relacao := 'licitacao_documentos';
  corrigidas := n_doc;
  return next;

  fonte := 'pncp';
  relacao := 'licitacao_resultados';
  corrigidas := n_res;
  return next;

  fonte := 'pncp';
  relacao := 'licitacoes_externas';
  corrigidas := n_hom;
  return next;
end
$fn$;

revoke all on function private.corrigir_fuso_pncp_339() from PUBLIC, anon, authenticated, service_role;

comment on function private.corrigir_fuso_pncp_339() is
  'PNCP (fonte pncp): soma 3 h em data_documento, data_resultado e data_homologacao ainda não marcadas com essa fonte. '
  'Paradigma, inclusive sestsenat: não altera a data (parse_data já gravou UTC) e marca a fonte da linha com manter_utc. '
  'A segunda chamada devolve zero.';

select * from private.corrigir_fuso_pncp_339();

commit;
