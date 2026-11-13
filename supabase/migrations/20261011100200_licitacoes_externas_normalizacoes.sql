-- LicitaGym: normalização registrada de dado errado da fonte (09/10/2026).
-- Por quê: decisão do dono: o produto NORMALIZA dado errado das fontes (não exibe "data inválida"), sempre com a origem
--   registrada e sem sobrescrever o bruto. Caso 129 (PNCP 08182313000110-1-000050/2024): dataEncerramentoProposta
--   "2604-04-16T08:30:00" (erro de digitação do órgão) com ata de registro de preço assinada em 2024-05-10.
-- O que muda (aditivo):
--   1) licitacoes_externas.normalizacoes jsonb (nullable): {"<campo>": {campo, original, normalizado, regra,
--      origem: "inferido"}}. Hoje só "data_fim" (coletor PNCP, coletor.pncp.normalizacao_prazo). O bruto continua em
--      raw (raw.data_fim_vigencia); data_fim recebe o normalizado (NULL quando o prazo só é limitado por um fato).
--      data_fim = FIM DO RECEBIMENTO DE PROPOSTAS (dataEncerramentoProposta do PNCP), não a abertura da sessão
--      (decisão do dono, 09/10/2026).
--   2) a view licitacoes_externas_prioridade_efetiva lê o prazo normalizado antes do bruto para rebaixar leads vencido
--      (mesmas colunas e ordem de 20261004140000; create or replace só troca a expressão do prazo).
-- Quem lê/escreve: coletor PNCP (service_role) grava; a view (service_role) lê. ACL da tabela não muda.
-- Verificar: supabase/tests/licitacoes_externas_normalizacoes_check.sql. O merge na main aplica em produção.

begin;

set local lock_timeout = '10s';

alter table public.licitacoes_externas
  add column if not exists normalizacoes jsonb;

do $$
begin
  if not exists (select 1 from pg_constraint
                  where conname = 'licext_normalizacoes_objeto_chk'
                    and conrelid = 'public.licitacoes_externas'::regclass) then
    alter table public.licitacoes_externas
      add constraint licext_normalizacoes_objeto_chk
      check (normalizacoes is null or jsonb_typeof(normalizacoes) = 'object') not valid;
    alter table public.licitacoes_externas validate constraint licext_normalizacoes_objeto_chk;
  end if;
end
$$;

comment on column public.licitacoes_externas.normalizacoes is
  'Normalizações de dado errado da fonte, por campo: {"data_fim": {campo, original, normalizado, regra, origem: "inferido"}}. '
  'regra: ano_da_abertura | ano_da_publicacao | limitado_por_ata | limitado_por_resultado. O bruto continua em raw; '
  'NULL = nada normalizado. data_fim = fim do recebimento de propostas. Escrito pelo coletor PNCP '
  '(coletor.pncp.normalizacao_prazo).';

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
  select (
    l.prioridade = 'leads'
    and coalesce(private.pncp_instante_brt(l.normalizacoes #>> '{data_fim,normalizado}'),
                 private.pncp_instante_brt(l.raw ->> 'data_fim_vigencia'),
                 l.data_fim) <= now()
  ) is true as prazo_encerrado
) j;

comment on view public.licitacoes_externas_prioridade_efetiva is
  'Colunas públicas de licitacoes_externas com prioridade EFETIVA (só rebaixa): historico com qualquer sinal de encerramento; leads -> monitorar com prazo vencido (normalizacoes.data_fim.normalizado, senão raw.data_fim_vigencia em BRT, senão data_fim); senão a gravada. prioridade_gravada = coluna da tabela. canonica_id/eh_canonica = licitacoes_pncp_canonica (Oportunidades lista só eh_canonica). security_invoker; SELECT só para service_role.';

-- create or replace preserva os grants da view; reafirmados aqui (idempotente).
revoke all on table public.licitacoes_externas_prioridade_efetiva from PUBLIC, anon, authenticated, service_role;
grant select on table public.licitacoes_externas_prioridade_efetiva to service_role;

commit;
