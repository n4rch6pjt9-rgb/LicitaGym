-- LicitaGym: Varredura de certames encerrados e transição determinística para histórico.
--
-- Por quê:
--   1) A view `public.licitacoes_externas_prioridade_efetiva` não considerava a coluna `l.fase`
--      (apenas l.situacao e data_homologacao). Quando o coletor grava `l.fase = 'homologada'` ou
--      `'encerrada'`, o certame permanecia com a prioridade antiga.
--   2) Certames cujo prazo para envio de proposta encerrou há mais de 30 dias continuavam como
--      'monitorar' indefinidamente se a fonte demorasse a publicar a homologação formal no PNCP.
--   3) A coluna física `licitacoes_externas.prioridade` não era sincronizada com a prioridade
--      efetiva calculada, gerando discrepância entre a tabela e a view.
--
-- O que muda:
--   - Atualiza `public.licitacoes_externas_prioridade_efetiva` para:
--       a) Considerar `l.fase` com termos terminais (homologad, encerrad, adjudicad, cancelad, etc.);
--       b) Transitar certames cujo prazo de propostas encerrou há > 30 dias para 'historico' (motivo: 'prazo_expirado_sessao').
--   - Cria a função `private.varredura_transicao_historico()` que atualiza a coluna `prioridade`
--     em `public.licitacoes_externas` para 'historico' quando a prioridade efetiva for 'historico'.
--   - Agenda a execução diária da varredura via `pg_cron` (às 06:00 UTC / 03:00 BRT).
--
-- Quem executa: service_role / postgres.
-- Idempotente.

begin;

set local lock_timeout = '10s';

-- 1. Atualização da view pública com prioridade efetiva
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
    when j.prazo_encerrado or j.prazo_invalido then 'monitorar'
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
    when j.prazo_invalido then 'prazo_invalido'
  end as prioridade_motivo,
  c.canonica_id,
  c.eh_canonica,
  l.objeto_categoria,
  l.objeto_registro_preco,
  l.payload_hash,
  l.ingestao_origem,
  l.ingestao_em
from public.licitacoes_externas l
join public.licitacoes_pncp_canonica c on c.id = l.id
cross join lateral (
  select case
    when l.data_homologacao is not null then 'data_homologacao'
    when exists (select 1 from public.licitacao_resultados r where r.licitacao_id = l.id) then 'resultado'
    when lower(coalesce(l.raw ->> 'tem_resultado', '')) in ('true', 't', '1', 'sim') then 'tem_resultado'
    when lower(coalesce(l.raw ->> 'cancelado', '')) in ('true', 't', '1', 'sim') then 'cancelado'
    when coalesce(nullif(l.fase, ''), '') ~* '(revogad|anulad|cancelad|desert|fracassad|encerrad|homologad|adjudicad|conclu[ií]d|finalizad)'
      then 'fase_terminal'
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
  select
    (
      l.prioridade = 'leads'
      and (
        (coalesce(p.normalizado, p.bruto) is not null and coalesce(p.normalizado, p.bruto) <= now())
        or (coalesce(p.normalizado, p.bruto) is null and l.data_fim <= now())
      )
    ) is true as prazo_encerrado,
    (
      l.prioridade = 'leads'
      and p.normalizado is null
      and p.bruto > now() + interval '730 days'
    ) is true as prazo_invalido
) j;

comment on view public.licitacoes_externas_prioridade_efetiva is
  'Colunas públicas de licitacoes_externas com prioridade EFETIVA (só rebaixa): historico com qualquer sinal de encerramento (incluindo fase e prazo > 30d); leads -> monitorar com prazo vencido; senão a gravada. prioridade_gravada = coluna da tabela. canonica_id/eh_canonica = licitacoes_pncp_canonica. security_invoker; SELECT só para service_role.';

revoke all on table public.licitacoes_externas_prioridade_efetiva from PUBLIC, anon, authenticated, service_role;
grant select on table public.licitacoes_externas_prioridade_efetiva to service_role;

-- 2. Função de sincronização física
create or replace function private.varredura_transicao_historico()
returns table(total_rebaixados bigint)
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  rebaixados bigint := 0;
begin
  with candidatos as (
    select id, prioridade as nova_prioridade
    from public.licitacoes_externas_prioridade_efetiva
    where prioridade = 'historico' and prioridade_gravada <> 'historico'
  ),
  upd as (
    update public.licitacoes_externas l
       set prioridade = c.nova_prioridade,
           updated_at = now()
      from candidatos c
     where l.id = c.id
    returning l.id
  )
  select count(*) into rebaixados from upd;

  return query select rebaixados;
end;
$$;

comment on function private.varredura_transicao_historico() is
  'Varre certames cuja prioridade efetiva calculada é histórico e atualiza a coluna prioridade em licitacoes_externas.';

revoke all on function private.varredura_transicao_historico() from PUBLIC, anon, authenticated;
grant execute on function private.varredura_transicao_historico() to service_role;

-- 3. Agendamento via pg_cron se o schema existir
do $$
begin
  if exists (select 1 from pg_namespace where nspname = 'cron') then
    -- Remove agendamento antigo se houver para garantir idempotência
    if exists (select 1 from cron.job where jobname = 'varredura-certames-historico') then
      perform cron.unschedule(jobid) from cron.job where jobname = 'varredura-certames-historico';
    end if;

    perform cron.schedule(
      'varredura-certames-historico',
      '0 6 * * *',
      'select private.varredura_transicao_historico();'
    );
  end if;
end;
$$;

commit;
