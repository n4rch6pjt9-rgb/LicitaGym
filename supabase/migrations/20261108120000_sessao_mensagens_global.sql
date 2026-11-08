-- Spec 0039, etapa 1 (K-1 e K-2): chat da sessão do Compras.gov.br lido do Integra Compras (Serpro).
--
-- Por quê: a 20261025000000 criou public.disputa_mensagens com tenant_id e com colunas que não existem na API
-- (id, item, remetente). Decisão do Marcelo de 23/10/2026: o chat é dado GLOBAL da plataforma (uma cópia por compra,
-- sem tenant_id). A chave natural da fonte é chaveMensagem (uuid). Exemplo oficial: docs/compras-gov/integra-compras.md.
--
-- O que muda:
--   1. public.disputa_mensagens sai. Só é apagada se estiver vazia (estava vazia em 07/11/2026); com linha, a
--      migration aborta e nada muda.
--   2. public.sessao_mensagens (K-1): uma linha por mensagem da fonte, sem tenant, idempotente por chave_mensagem.
--   3. private.integra_compras_run (K-2): uma linha por consulta de compra, com as chamadas por código HTTP
--      (200, 206 e 404 são cobrados pelo Serpro).
--
-- Quem lê e escreve: só service_role (api-disputa). RLS ligada e sem policy: o Dashboard lê pela Edge Function.
-- Retenção (K-7): expira_em fica nulo até o prazo ser decidido (pergunta 2 da spec).
-- Verificação: supabase/tests/sessao_mensagens_check.sql.

begin;

do $$
declare
  v_n bigint;
begin
  if to_regclass('public.disputa_mensagens') is not null then
    execute 'select count(*) from public.disputa_mensagens' into v_n;
    if v_n > 0 then
      raise exception 'public.disputa_mensagens tem % linha(s); migrar os dados antes de apagar a tabela', v_n;
    end if;
    execute 'drop table public.disputa_mensagens';
  end if;
end
$$;

create table if not exists public.sessao_mensagens (
  id bigint generated always as identity primary key,
  chave_compra text not null,
  id_uasg integer,
  id_modalidade integer,
  numero integer,
  ano integer,
  numero_uasg integer,
  identificador_item text,
  chave_mensagem uuid not null,
  tipo text not null,
  categoria text,
  tipo_remetente text,
  texto text,
  data_hora timestamptz not null,
  data_hora_fonte text not null,
  fonte text not null default 'integra_compras',
  coletado_em timestamptz not null default now(),
  expira_em timestamptz,
  constraint sessao_mensagens_chave_mensagem_key unique (chave_mensagem),
  constraint sessao_mensagens_chave_compra_ck check (chave_compra ~ '^[0-9]{17}$'),
  constraint sessao_mensagens_tipo_ck check (tipo in ('mensagem', 'diligencia')),
  constraint sessao_mensagens_fonte_ck check (fonte in ('integra_compras', 'extensao'))
);

comment on table public.sessao_mensagens is
  'Spec 0039 K-1. Chat e diligências da sessão do Compras.gov.br, como o Integra Compras entrega. Dado global '
  '(sem tenant). categoria e tipo_remetente guardam o código da fonte, sem tradução (nulo = a fonte não informou). '
  'texto nulo = apagado pela retenção.';

create index if not exists sessao_mensagens_compra_idx
  on public.sessao_mensagens (chave_compra, data_hora);

alter table public.sessao_mensagens enable row level security;
revoke all on table public.sessao_mensagens from PUBLIC, anon, authenticated;
grant select, insert, update on table public.sessao_mensagens to service_role;

create table if not exists private.integra_compras_run (
  id bigint generated always as identity primary key,
  chave_compra text not null,
  origem text not null,
  iniciado_em timestamptz not null default now(),
  terminado_em timestamptz,
  chamadas jsonb not null default '{}'::jsonb,
  mensagens_lidas integer not null default 0,
  mensagens_novas integer not null default 0,
  erro text,
  constraint integra_compras_run_chave_compra_ck check (chave_compra ~ '^[0-9]{17}$'),
  constraint integra_compras_run_origem_ck check (origem in ('cron', 'usuario'))
);

comment on table private.integra_compras_run is
  'Spec 0039 K-2. Uma linha por consulta de compra ao Integra Compras. chamadas = {"200": n, "404": n, ...}; '
  '200, 206 e 404 são cobrados.';

create index if not exists integra_compras_run_compra_idx
  on private.integra_compras_run (chave_compra, iniciado_em desc);

alter table private.integra_compras_run enable row level security;
revoke all on table private.integra_compras_run from PUBLIC, anon, authenticated;
grant select, insert, update on table private.integra_compras_run to service_role;

commit;
