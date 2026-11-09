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
--   2. private.sessao_alertas_destinos(licitacao): tenants ativos com a licitação no pipeline, fora das etapas
--      perdida e descartada (mesma regra de private.sessao_chat_alvos), com o CNPJ do tenant (para da_empresa).
-- Dados: só cria. Nada é apagado nem alterado.
-- ACL: tabela sem privilégio para PUBLIC/anon/authenticated; service_role lê, grava e atualiza (marcar lido).
--      Função security invoker, search_path fixo, EXECUTE só service_role.
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
      check (fornecedor_cnpj is null or fornecedor_cnpj ~ '^[0-9]{14}$');
  end if;
end $$;

-- Leitura do sino: alertas do tenant do mais novo para o mais velho; não lidos primeiro no filtro.
create index if not exists sessao_alertas_tenant_mensagem_em_idx
  on public.sessao_alertas (tenant_id, mensagem_em desc);
create index if not exists sessao_alertas_licitacao_idx on public.sessao_alertas (licitacao_id);

comment on table public.sessao_alertas is
  'Spec 0039 K-5a. Alerta de convocação (anexos, etapa fechada) detectado no chat da sessão, por tenant. '
  'Escrita: coleta (Edge Functions, service_role). Leitura: api-disputa (GET alertas, POST alertas/lido).';

alter table public.sessao_alertas enable row level security;
revoke all on table public.sessao_alertas from PUBLIC, anon, authenticated;
grant select, insert, update on table public.sessao_alertas to service_role;

create or replace function private.sessao_alertas_destinos(p_licitacao_id bigint)
returns table (tenant_id bigint, cnpj text)
language sql
stable
security invoker
set search_path = pg_catalog, pg_temp
as $fn$
  select distinct t.id, t.cnpj
    from public.pipeline_oportunidades p
    join public.tenants t on t.id = p.tenant_id and t.ativo
    left join public.pipeline_etapas e on e.id = p.etapa_id
   where p.licitacao_id = p_licitacao_id
     and (e.desfecho is null or e.desfecho not in ('perdida', 'descartada'))
$fn$;

revoke all on function private.sessao_alertas_destinos(bigint) from public, anon, authenticated;
grant execute on function private.sessao_alertas_destinos(bigint) to service_role;

comment on function private.sessao_alertas_destinos(bigint) is
  'Spec 0039 K-5b. Tenants que recebem o alerta de uma licitação (pipeline de empresa ativa, fora de perdida/descartada).';

commit;
