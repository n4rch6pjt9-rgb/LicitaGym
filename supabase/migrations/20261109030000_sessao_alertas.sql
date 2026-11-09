-- Spec 0039, etapa 1b (K-5a): alerta de convocação do chat da sessão, por tenant.
--
-- Por quê: a convocação para enviar anexos sai só no chat do Compras.gov.br, com prazo de horas; perder o prazo
-- inabilitou a empresa num caso real (specs/0018, linhas 223-224). O chat já é coletado (sessao_mensagens, global);
-- falta avisar cada empresa que tem o certame no pipeline. Decisões do Marcelo (08/11/2026): alerta para convocação
-- de anexos e início da etapa fechada; toda convocação vira alerta, com a razão social de quem foi convocado; canal
-- só o sino do Dashboard.
--
-- O que muda:
--   1. public.sessao_alertas: um alerta por (tenant, mensagem). Gravado pelas Edge Functions da coleta
--      (_shared/sessao_alertas.ts, chamada por sincronizarCompra) e lido/marcado pela api-disputa. RLS ligada, sem
--      policy: o cliente só lê pela Edge Function, filtrado pelo tenant de quem chama.
--   2. private.sessao_alertas_destinos(licitacoes[]): tenants ativos com alguma das licitações (mesma chave de
--      compra) no pipeline, fora das etapas perdida e descartada (mesma regra de private.sessao_chat_alvos: se uma
--      mudar, mudar a outra), com o CNPJ do tenant (para da_empresa) e a licitação do pipeline dele.
--   3. private.sessao_mensagens_retencao() (K-7, de 20261108130000): também apaga razão social e CNPJ do fornecedor
--      dos alertas cuja mensagem já teve o texto apagado (90 dias depois da homologação). O resto é cópia fiel.
-- Dados: só cria; a retenção passa a anonimizar alertas vencidos (hoje não há nenhum).
-- ACL: tabela sem privilégio para PUBLIC/anon/authenticated; service_role lê e insere, e só atualiza lido_em e
--      lido_por (marcar lido); sem DELETE. Funções security invoker, search_path fixo; destinos executável só por
--      service_role; retenção sem EXECUTE para ninguém além do dono (cron).
-- Verificação: supabase/tests/sessao_alertas_check.sql. Idempotente.

begin;

set local lock_timeout = '10s';

create table if not exists public.sessao_alertas (
  id bigint generated always as identity primary key,
  tenant_id bigint not null references public.tenants(id) on delete cascade,
  licitacao_id bigint not null references public.licitacoes_externas(id) on delete cascade,
  chave_mensagem uuid not null references public.sessao_mensagens(chave_mensagem) on delete cascade,
  tipo text not null,
  identificador_item text,
  fornecedor_razao_social text,
  fornecedor_cnpj text,
  da_empresa boolean not null default false,
  prazo timestamptz,
  mensagem_em timestamptz not null,
  criado_em timestamptz not null default now(),
  lido_em timestamptz,
  lido_por uuid,
  constraint sessao_alertas_tenant_mensagem_key unique (tenant_id, chave_mensagem)
);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'sessao_alertas_tipo_check'
                   and conrelid = 'public.sessao_alertas'::regclass) then
    alter table public.sessao_alertas add constraint sessao_alertas_tipo_check
      check (tipo in ('convocacao_anexos', 'etapa_fechada'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'sessao_alertas_cnpj_check'
                   and conrelid = 'public.sessao_alertas'::regclass) then
    alter table public.sessao_alertas add constraint sessao_alertas_cnpj_check
      check (fornecedor_cnpj is null or fornecedor_cnpj ~ '^[0-9A-Z]{12}[0-9]{2}$');
  end if;
end $$;

-- Leitura do sino: alertas do tenant do mais novo para o mais velho (todos e só os não lidos).
create index if not exists sessao_alertas_tenant_mensagem_em_idx
  on public.sessao_alertas (tenant_id, mensagem_em desc);
create index if not exists sessao_alertas_tenant_nao_lidos_idx
  on public.sessao_alertas (tenant_id, mensagem_em desc) where lido_em is null;
-- FKs (cascade por licitação e por mensagem) e a anonimização da retenção.
create index if not exists sessao_alertas_licitacao_idx on public.sessao_alertas (licitacao_id);
create index if not exists sessao_alertas_chave_mensagem_idx on public.sessao_alertas (chave_mensagem);

comment on table public.sessao_alertas is
  'Spec 0039 K-5a. Alerta de convocação (anexos, etapa fechada) detectado no chat da sessão, por tenant. '
  'Escrita: coleta (Edge Functions, service_role). Leitura: api-disputa (GET alertas, POST alertas/lido).';

alter table public.sessao_alertas enable row level security;
revoke all on table public.sessao_alertas from PUBLIC, anon, authenticated, service_role;
grant select, insert on table public.sessao_alertas to service_role;
grant update (lido_em, lido_por) on table public.sessao_alertas to service_role;

drop function if exists private.sessao_alertas_destinos(bigint);

create or replace function private.sessao_alertas_destinos(p_licitacao_ids bigint[])
returns table (tenant_id bigint, cnpj text, licitacao_id bigint)
language sql
stable
security invoker
set search_path = pg_catalog, pg_temp
as $fn$
  -- Mesma regra de private.sessao_chat_alvos (20261108130000): empresa ativa, etapa sem desfecho perdida/descartada.
  -- Um tenant com duas licitações da mesma compra recebe o alerta ligado à de menor id.
  select distinct on (t.id) t.id, t.cnpj, p.licitacao_id
    from public.pipeline_oportunidades p
    join public.tenants t on t.id = p.tenant_id and t.ativo
    left join public.pipeline_etapas e on e.id = p.etapa_id
   where p.licitacao_id = any (p_licitacao_ids)
     and (e.desfecho is null or e.desfecho not in ('perdida', 'descartada'))
   order by t.id, p.licitacao_id
$fn$;

revoke all on function private.sessao_alertas_destinos(bigint[]) from public, anon, authenticated;
grant execute on function private.sessao_alertas_destinos(bigint[]) to service_role;

comment on function private.sessao_alertas_destinos(bigint[]) is
  'Spec 0039 K-5b. Tenants que recebem o alerta de uma compra (pipeline de empresa ativa, fora de perdida/descartada).';

-- Retenção (K-7, cópia fiel de 20261108130000 + anonimização dos alertas).
create or replace function private.sessao_mensagens_retencao()
returns jsonb
language plpgsql
volatile
security invoker
set search_path = pg_catalog, pg_temp
as $fn$
declare
  v_marcadas integer;
  v_apagadas integer;
  v_alertas integer;
begin
  -- data_homologacao em licitacoes_externas é a data mais recente de resultado dos itens: o prazo pode ficar um
  -- pouco mais longo, nunca mais curto.
  create temporary table if not exists pg_temp.sessao_prazo (chave_compra text primary key, expira_em timestamptz)
    on commit drop;
  truncate pg_temp.sessao_prazo;
  insert into pg_temp.sessao_prazo
  select r.chave_compra, min(l.data_homologacao) + interval '90 days'
    from private.integra_compras_run r
    join public.licitacoes_externas l on l.id = r.licitacao_id
   where l.data_homologacao is not null
   group by r.chave_compra;

  update public.sessao_mensagens m
     set expira_em = p.expira_em
    from pg_temp.sessao_prazo p
   where m.chave_compra = p.chave_compra
     and m.expira_em is distinct from p.expira_em;
  get diagnostics v_marcadas = row_count;

  -- Homologação desfeita na fonte (reprocessamento): o prazo some enquanto o texto ainda existe.
  update public.sessao_mensagens m
     set expira_em = null
   where m.expira_em is not null
     and m.texto is not null
     and not exists (select 1 from pg_temp.sessao_prazo p where p.chave_compra = m.chave_compra);

  update public.sessao_mensagens
     set texto = null
   where expira_em <= now()
     and texto is not null;
  get diagnostics v_apagadas = row_count;

  -- Spec 0039 K-5b: o alerta copia razão social e CNPJ do texto; somem junto com o texto bruto da mensagem.
  update public.sessao_alertas a
     set fornecedor_razao_social = null,
         fornecedor_cnpj = null
    from public.sessao_mensagens m
   where m.chave_mensagem = a.chave_mensagem
     and m.texto is null
     and (a.fornecedor_razao_social is not null or a.fornecedor_cnpj is not null);
  get diagnostics v_alertas = row_count;

  return jsonb_build_object('marcadas', v_marcadas, 'textos_apagados', v_apagadas, 'alertas_anonimizados', v_alertas,
                            'executado_em', now());
end
$fn$;

revoke all on function private.sessao_mensagens_retencao() from public, anon, authenticated, service_role;

comment on function private.sessao_mensagens_retencao() is
  'Spec 0039 K-7. Marca expira_em = homologação + 90 dias e apaga o texto bruto vencido (a linha fica). '
  'Execução só para o dono (postgres), pelo job licitagym-sessao-retencao.';

commit;
