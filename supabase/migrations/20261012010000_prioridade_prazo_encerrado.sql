-- LicitaGym: lead com prazo de proposta vencido sai de leads na leitura (#319).
--
-- Por quê (medição em 11/10/2026, só leitura): 218 leads gravados, 116 com data_fim < now(), nenhum com
--   resultado em licitacao_resultados. Exemplo: licitação 185 (46377800000127-1-003879/2026), fase
--   "Recebendo propostas", situacao "Divulgada no PNCP", data_fim 2026-10-08 10:00+00, prioridade gravada
--   leads, last_synced_at 2026-09-30. A contagem dos 116 é da coluna gravada, não da view. A view já
--   rebaixava quando o texto do PNCP em Brasília já tinha vencido, mas a fase gravada na coleta continuava
--   no selo ("Recebendo propostas"). data_fim de coleta antiga está 3 h adiantado (#332: horário de
--   Brasília gravado como UTC); o texto raw.data_fim_vigencia, lido em Brasília, é o prazo que vale.
--   Texto ainda aberto não perde para esse data_fim. Texto implausível (2604, 9999, além de 730 dias) sem
--   normalização não fica lead.
--
-- O que muda: só o corpo de licitacoes_externas_prioridade_efetiva (create or replace; mesmas colunas e
--   ordem). A prioridade continua só rebaixando: sinal de encerramento -> historico; prazo vencido em
--   Brasília, ou data_fim vencido quando não há texto, ou texto implausível -> monitorar; senão a gravada.
--   Status desconhecido (prioridade NULL) não vira lead. A view não chama API: falha de API não vira
--   historico. Se a fase gravada é "Recebendo propostas" e o prazo encerrou sem sinal de encerramento, a
--   fase lida passa a "Propostas encerradas, aguardando resultado". situacao oficial não muda.
--
-- Quem lê: service_role, pela api-dashboard-oportunidades. Nenhuma linha é regravada.
-- Verificar: supabase/tests/licitacoes_prioridade_prazo_encerrado_check.sql
-- Idempotente (create or replace + revoke/grant). O merge na main aplica em produção.

begin;

set local lock_timeout = '10s';

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
  case
    when e.encerramento is null
     and j.prazo_encerrado
     and l.fase = 'Recebendo propostas'
      then 'Propostas encerradas, aguardando resultado'
    else l.fase
  end as fase,
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
  end as prioridade_motivo,
  c.canonica_id,
  c.eh_canonica,
  l.objeto_categoria,
  l.objeto_registro_preco
from public.licitacoes_externas l
join public.licitacoes_pncp_canonica c on c.id = l.id
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
  select
    private.pncp_instante_brt(l.normalizacoes #>> '{data_fim,normalizado}') as normalizado,
    private.pncp_instante_brt(l.raw ->> 'data_fim_vigencia') as bruto
) p
cross join lateral (
  select (
    l.prioridade = 'leads'
    and (
      -- texto do PNCP em Brasília (normalizado, senão o bruto) já venceu
      (coalesce(p.normalizado, p.bruto) is not null and coalesce(p.normalizado, p.bruto) <= now())
      -- sem texto: vale o data_fim gravado
      or (coalesce(p.normalizado, p.bruto) is null and l.data_fim <= now())
      -- 2604, 9999 e qualquer texto além de 730 dias, sem normalização crível: não é lead
      or (p.normalizado is null and p.bruto > now() + interval '730 days')
    )
  ) is true as prazo_encerrado
) j;

comment on view public.licitacoes_externas_prioridade_efetiva is
  'Colunas públicas de licitacoes_externas com prioridade EFETIVA (só rebaixa, #319): historico com qualquer sinal de encerramento; leads -> monitorar com prazo vencido em Brasília (normalizacoes.data_fim.normalizado, senão raw.data_fim_vigencia, senão data_fim) ou com texto de prazo além de 730 dias sem normalização. Fase "Recebendo propostas" com prazo encerrado e sem encerramento lê como "Propostas encerradas, aguardando resultado"; situacao oficial não muda. prioridade NULL não vira lead. prioridade_gravada = coluna da tabela. canonica_id/eh_canonica = licitacoes_pncp_canonica. security_invoker; SELECT só para service_role.';

revoke all on table public.licitacoes_externas_prioridade_efetiva from PUBLIC, anon, authenticated, service_role;
grant select on table public.licitacoes_externas_prioridade_efetiva to service_role;

commit;
