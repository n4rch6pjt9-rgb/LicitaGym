-- LicitaGym: obra nunca vira lead na prioridade efetiva
--
-- Contexto (12/11/2026, MCP somente leitura):
--   A regra de negócio diz que contrato de obra nunca vira lead (`.claude/rules/regras-negocio.md`), e o README do
--   coletor diz que `obra_piso` não promove obra a `leads`. Nenhum código aplicava isso: a oportunidade 57149 (Sesc DN
--   4387, "Contratação de empresa especializada para execução da reforma de quadra de futebol com grama sintética")
--   estava em `leads` com `categoria_escopo = 'obra_piso'`, e o PNCP tinha 56 obras na mesma situação.
--   `obra_piso` continua no escopo de propósito: a obra interessa pela borracha do vencedor (escopo.py).
--
-- O que muda:
--   * `public.licitacoes_externas_prioridade_efetiva`: a mesma definição da 20261026000000, mais uma regra que só
--     rebaixa: `leads` com `categoria_escopo = 'obra_piso'` vira `monitorar`, com `prioridade_motivo = 'obra_nao_e_lead'`.
--     Encerramento e prazo vencido continuam vencendo antes. Prioridade nula não é promovida.
--   * Nenhuma tabela muda, nenhum dado é reescrito. Vale para o PNCP e o Sistema S, inclusive para as linhas já gravadas.
-- Quem lê: as Edge Functions `api-*` (list e get), com service_role. ACL igual à anterior.
-- Verificar: supabase/tests/obra_nao_e_lead_check.sql e os checks de prioridade efetiva já existentes.
begin;

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
    when l.prioridade = 'leads' and l.categoria_escopo = 'obra_piso' then 'monitorar'
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
    when l.prioridade = 'leads' and l.categoria_escopo = 'obra_piso' then 'obra_nao_e_lead'
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
  'Colunas públicas de licitacoes_externas com prioridade EFETIVA (só rebaixa): historico com qualquer sinal de encerramento (incluindo fase e prazo > 30d); leads -> monitorar com prazo vencido; obra (categoria obra_piso) nunca é lead: leads -> monitorar; senão a gravada. prioridade_gravada = coluna da tabela. canonica_id/eh_canonica = licitacoes_pncp_canonica. security_invoker; SELECT só para service_role.';

revoke all on table public.licitacoes_externas_prioridade_efetiva from PUBLIC, anon, authenticated, service_role;
grant select on table public.licitacoes_externas_prioridade_efetiva to service_role;

commit;
