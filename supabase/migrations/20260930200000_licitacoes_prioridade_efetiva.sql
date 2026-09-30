-- LicitaGym: prioridade EFETIVA das oportunidades (rede de segurança do dashboard), só leitura.
--
-- Por quê (diagnóstico só leitura no projeto ifaiagegyicjzlpskafh em 30/09/2026, ~17:30 BRT):
--   licitacoes_externas.prioridade é um retrato gravado pelo coletor PNCP. As 44 linhas PNCP foram
--   gravadas em 24/09 (antes do #79) com a semântica antiga (leads = homologada nos últimos 120 dias)
--   e continuam `leads`, embora todas tenham data_homologacao e resultado (ex.: id 22, Dispensa da
--   PM-BA, homologada em 04/09). Além disso, o coletor só reclassifica compras que reencontra na
--   busca: um lead que encerra ou é homologado depois da coleta fica `leads` até alguém recoletar ou
--   rodar o backfill (coletor.backfill_prioridade_pncp).
--
-- Decisão de produto (29/09 e 30/09/2026): compra homologada/encerrada não é lead. leads = recebendo
--   proposta; monitorar = em julgamento; historico = encerrada, homologada ou com resultado.
--
-- O que esta migration cria (nenhum dado muda; nenhuma tabela é alterada):
--   private.pncp_instante_brt(text): converte o prazo do PNCP (raw.data_fim_vigencia, horário de
--     Brasília sem fuso, ex. "2026-09-11T15:30") em timestamptz; valor com fuso é respeitado; valor
--     inválido vira NULL em vez de derrubar a view.
--   public.licitacoes_externas_prioridade_efetiva: as colunas públicas do dashboard
--     (PUBLIC_LICITACAO_COLUMNS da Edge Function api-dashboard-oportunidades) com `prioridade`
--     recalculada, mais `prioridade_gravada` (a coluna da tabela) e `prioridade_motivo`.
--
-- Regra (só rebaixa; nunca promove ninguém a `leads`):
--   1. historico, se há QUALQUER sinal de encerramento: data_homologacao; linha em
--      licitacao_resultados; raw.tem_resultado verdadeiro; raw.cancelado verdadeiro; situação
--      (situacao, senão raw.situacao_nome) revogada/anulada/cancelada/deserta/fracassada/encerrada/
--      homologada/adjudicada/concluída/finalizada (mesma regex de coletor.pncp._SITUACAO_ENCERRADA).
--      Vale também para prioridade gravada NULL (fontes que não gravam prioridade, ex. sestsenat
--      com situação "Homologado"): sem isso uma compra homologada apareceria em Oportunidades.
--   2. leads -> monitorar, se o prazo de proposta passou: raw.data_fim_vigencia em BRT, senão data_fim.
--   3. senão, o valor gravado (inclusive NULL e historico).
--
-- Acesso: security_invoker = true (respeita RLS e grants de quem consulta); só service_role lê a view
--   e executa a função (mesmo padrão do #104; licitacoes_externas e licitacao_resultados já são só
--   service_role). anon, authenticated e PUBLIC sem privilégio.
--
-- Idempotente (create or replace + revoke/grant; pode rodar duas vezes). Verificação (só leitura;
--   erra se algo falhar): supabase/tests/licitacoes_prioridade_efetiva_check.sql

begin;

-- Falha rápido em vez de esperar atrás de uma transação longa do coletor.
set local lock_timeout = '10s';

create schema if not exists private;

create or replace function private.pncp_instante_brt(p_valor text)
returns timestamptz
language plpgsql
stable
parallel safe
set search_path = ''
as $fn$
begin
  if p_valor is null or btrim(p_valor) = '' then
    return null;
  end if;
  -- com fuso explícito (Z ou +hh:mm depois da hora): respeita o fuso
  if p_valor ~ 'T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}(:?\d{2})?)$' then
    return p_valor::timestamptz;
  end if;
  -- sem fuso: horário de Brasília (como o PNCP publica)
  return p_valor::timestamp at time zone 'America/Sao_Paulo';
exception
  when data_exception then
    return null;
end
$fn$;

create or replace view public.licitacoes_externas_prioridade_efetiva
with (security_invoker = true) as
select
  l.id,
  l.fonte,
  l.modulo,
  l.id_externo,
  l.codigo_externo,
  l.numero_processo,
  l.processo_norm,
  l.numero_edital,
  l.objeto,
  l.unidade_compradora,
  l.modalidade,
  l.fase,
  l.situacao,
  l.data_inicio,
  l.data_fim,
  l.valor_total,
  l.orgao_cnpj,
  l.orgao_nome,
  l.municipio,
  l.uf,
  l.data_publicacao,
  l.data_homologacao,
  l.categoria_escopo,
  l.interesse_borracha,
  case
    when e.encerramento is not null then 'historico'
    when j.prazo_encerrado then 'monitorar'
    else l.prioridade
  end as prioridade,
  l.termos_busca,
  l.created_at,
  l.updated_at,
  l.last_synced_at,
  l.prioridade as prioridade_gravada,
  case
    when e.encerramento is not null then e.encerramento
    when j.prazo_encerrado then 'prazo_encerrado'
  end as prioridade_motivo
from public.licitacoes_externas l
cross join lateral (
  select case
    when l.data_homologacao is not null then 'data_homologacao'
    when exists (select 1 from public.licitacao_resultados r where r.licitacao_id = l.id) then 'resultado'
    when lower(coalesce(l.raw ->> 'tem_resultado', '')) in ('true', 't', '1', 'sim') then 'tem_resultado'
    when lower(coalesce(l.raw ->> 'cancelado', '')) in ('true', 't', '1', 'sim') then 'cancelado'
    when coalesce(nullif(l.situacao, ''), l.raw ->> 'situacao_nome', '')
         ~* '(revogad|anulad|cancelad|desert|fracassad|encerrad|homologad|adjudicad|conclu[ií]d|finalizad)'
      then 'situacao'
  end as encerramento
) e
cross join lateral (
  select (
    l.prioridade = 'leads'
    and coalesce(private.pncp_instante_brt(l.raw ->> 'data_fim_vigencia'), l.data_fim) <= now()
  ) is true as prazo_encerrado
) j;

-- REVOKE na relação também revoga os privilégios de coluna. O default privileges do schema public
-- dá ALL a anon/authenticated em objeto novo: por isso o revoke explícito.
revoke all on table public.licitacoes_externas_prioridade_efetiva
  from PUBLIC, anon, authenticated, service_role;
grant select on table public.licitacoes_externas_prioridade_efetiva to service_role;

revoke all on function private.pncp_instante_brt(text) from PUBLIC, anon, authenticated, service_role;
grant execute on function private.pncp_instante_brt(text) to service_role;

comment on function private.pncp_instante_brt(text) is
  'Prazo do PNCP (texto) -> timestamptz. Sem fuso = horário de Brasília; com fuso, respeitado; inválido = NULL. EXECUTE só para service_role.';
comment on view public.licitacoes_externas_prioridade_efetiva is
  'Colunas públicas de licitacoes_externas com prioridade EFETIVA (só rebaixa): historico com qualquer sinal de encerramento; leads -> monitorar com prazo vencido (raw.data_fim_vigencia em BRT, senão data_fim); senão a gravada. prioridade_gravada = coluna da tabela. security_invoker; SELECT só para service_role.';

commit;
