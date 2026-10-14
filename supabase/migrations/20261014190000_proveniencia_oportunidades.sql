-- 20261014190000_proveniencia_oportunidades: proveniência da última ingestão por linha (spec 0023, #363)
--
-- Por quê: a tela /oportunidades ganhou a coluna Sync (Dashboard #93), mas licitacoes_externas não sabe dizer quando
--   nem como cada linha foi ingerida pela última vez: last_synced_at/updated_at são iguais a created_at em todas as
--   1.656 linhas (medido em 14/10/2026), porque o upsert do coletor não os envia. payload_hash (20260925120000)
--   existe e está vazio para o PNCP.
-- O que muda (aditivo, idempotente, sem backfill):
--   * licitacoes_externas.ingestao_origem text ('cron' | 'manual' | nulo = linha anterior à spec) e
--     ingestao_em timestamptz (UTC); payload_hash passa a ter semântica definida: sha256 hex do raw serializado de
--     forma estável (chaves ordenadas, sem espaços, UTF-8; coletor/proveniencia.py). Não é o mesmo cálculo de
--     _shared/pncp/hash.ts (números e chaves voláteis diferem): alinhar antes de os syncs em TS gravarem a tabela (#363).
--     Só a última passagem fica na linha (decisão do Marcelo, 14/10/2026).
--   * a view licitacoes_externas_prioridade_efetiva expõe as três colunas (a api-dashboard-oportunidades lê a view).
--   * o job do pg_cron de sync-portal-compras manda origem "cron" no corpo (a api-syncs manda "manual"); esse sync
--     só grava portal_consulta e não toca a proveniência (decisão de 14/10).
-- Quem escreve: coletor Python (pncp, paradigma, sestsenat) com --origem; backfills não mexem. Quem lê: a view e a
--   api-dashboard-oportunidades (service_role). ACL inalterada (anon/authenticated sem SELECT direto).
-- Verificação: supabase/tests/proveniencia_oportunidades_check.sql (CA-1, CA-3, CA-6, CA-7 da spec 0023).

begin;

set local lock_timeout = '10s';
set local statement_timeout = '2min';

alter table public.licitacoes_externas
  add column if not exists ingestao_origem text,
  add column if not exists ingestao_em timestamptz;

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.licitacoes_externas'::regclass and conname = 'licitacoes_externas_ingestao_origem_chk'
  ) then
    alter table public.licitacoes_externas
      add constraint licitacoes_externas_ingestao_origem_chk
      check (ingestao_origem is null or ingestao_origem in ('cron', 'manual'));
  end if;
end $$;

comment on column public.licitacoes_externas.payload_hash is
  'sha256 hex do raw serializado de forma estável (chaves ordenadas, sem espaços, UTF-8; coletor/proveniencia.py). Nulo sem payload ou em linha anterior à spec 0023. Mesmo raw pelo mesmo escritor = mesmo hash; não comparável com _shared/pncp/hash.ts até o alinhamento (#363).';
comment on column public.licitacoes_externas.ingestao_origem is
  'Origem da última ingestão da linha: cron (agendado) ou manual (tela ou linha de comando). Nulo em linha anterior à spec 0023. Backfills e sync-portal-compras não mexem.';
comment on column public.licitacoes_externas.ingestao_em is
  'Instante UTC da última ingestão da linha (spec 0023). A tela mostra em Brasília. last_synced_at continua sendo a primeira gravação.';

-- view: mesma definição de 20261012010000 com as três colunas de proveniência no fim
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
        -- texto do PNCP em Brasília (normalizado, senão o bruto) já venceu
        (coalesce(p.normalizado, p.bruto) is not null and coalesce(p.normalizado, p.bruto) <= now())
        -- sem texto: vale o data_fim gravado
        or (coalesce(p.normalizado, p.bruto) is null and l.data_fim <= now())
      )
    ) is true as prazo_encerrado,
    -- 2604, 9999 e qualquer texto além de 730 dias, sem normalização: não é lead e não é encerrado
    (
      l.prioridade = 'leads'
      and p.normalizado is null
      and p.bruto > now() + interval '730 days'
    ) is true as prazo_invalido
) j;

comment on view public.licitacoes_externas_prioridade_efetiva is
  'Colunas públicas de licitacoes_externas com prioridade EFETIVA (só rebaixa, #319): historico com qualquer sinal de encerramento; leads -> monitorar com prazo vencido em Brasília (instante <= now(): normalizacoes.data_fim.normalizado, senão raw.data_fim_vigencia, senão data_fim; motivo prazo_encerrado) ou com texto além de 730 dias sem normalização (motivo prazo_invalido, fase gravada intacta). Só prazo_encerrado troca "Recebendo propostas" para "Propostas encerradas, aguardando resultado". situacao oficial não muda. prioridade NULL não vira lead. prioridade_gravada = coluna da tabela. canonica_id/eh_canonica = licitacoes_pncp_canonica. payload_hash/ingestao_origem/ingestao_em = proveniência da última ingestão (spec 0023). security_invoker; SELECT só para service_role.';

revoke all on table public.licitacoes_externas_prioridade_efetiva from PUBLIC, anon, authenticated, service_role;
grant select on table public.licitacoes_externas_prioridade_efetiva to service_role;

-- job do pg_cron de sync-portal-compras: mesmo horário e limite de 20261008180000, agora com origem "cron"
do $cron$
begin
  if to_regnamespace('cron') is null
     or to_regprocedure('cron.schedule(text,text,text)') is null then
    raise notice 'pg_cron ausente: job licitagym-sync-portal-compras não reagendado.';
    return;
  end if;
  perform cron.unschedule(c.jobid)
    from cron.job c
   where c.jobname = 'licitagym-sync-portal-compras';
  perform cron.schedule(
    'licitagym-sync-portal-compras',
    '0 11 * * *',
    $cmd$select private.cron_chamar_edge('licitagym-sync-portal-compras', 'sync-portal-compras', '{"limite": 40, "origem": "cron"}'::jsonb, 150000)$cmd$);
end
$cron$;

commit;
