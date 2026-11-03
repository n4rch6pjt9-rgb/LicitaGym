-- LicitaGym: documentos de habilitação do tenant (fase B, Dashboard #29 / LicitaGym #253).
--
-- O que evita a queda no certame fica no cadastro: tipo, arquivo, emissão e validade.
-- Sem data de validade, a validade efetiva é a emissão mais 90 dias e fica marcada como calculada.
-- Falência e balanço não são sanáveis. Fiscal e trabalhista são. Alerta de calendário: vencido, 7, 15, 30 dias.
-- O alerta pela data da sessão fica na fase E.
--
-- Arquivo no bucket privado tenant-documentos, caminho {tenant_id}/...
-- Quem lê e anexa: membro ativo do tenant (admin e operacao). anon não lê.
-- service_role também escreve. licitagym_role não abre estas tabelas.
-- Verificar: supabase/tests/tenant_documentos_check.sql
-- Aditiva. O merge na main aplica em produção.

begin;

set local lock_timeout = '10s';

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'tenant-documentos',
  'tenant-documentos',
  false,
  20971520,
  array['application/pdf', 'image/jpeg', 'image/png']
)
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

create table if not exists public.documento_tipos (
  codigo               text primary key,
  grupo                text not null,
  nome                 text not null,
  tem_validade         boolean not null,
  validade_padrao_dias integer,
  sanavel              boolean not null,
  exige_escopo         boolean not null default false,
  ordem                smallint not null,
  constraint documento_tipos_grupo_chk check (grupo in (
    'juridica', 'fiscal_trabalhista', 'economico_financeira', 'tecnica', 'complementares'
  )),
  constraint documento_tipos_padrao_chk check (
    validade_padrao_dias is null or validade_padrao_dias > 0
  )
);

comment on table public.documento_tipos is
  'Catálogo dos documentos de habilitação, na ordem do item 8 do edital. sanavel false não se cura depois de vencer.';

insert into public.documento_tipos (codigo, grupo, nome, tem_validade, validade_padrao_dias, sanavel, exige_escopo, ordem)
values
  ('contrato_social', 'juridica', 'Contrato social e última alteração', false, null, false, false, 10),
  ('documento_representante', 'juridica', 'Documento do representante', false, null, false, false, 20),
  ('procuracao', 'juridica', 'Procuração', true, 90, false, false, 30),
  ('cartao_cnpj', 'fiscal_trabalhista', 'Cartão CNPJ', true, 90, true, false, 40),
  ('certidao_federal', 'fiscal_trabalhista', 'Certidão conjunta federal', true, 90, true, false, 50),
  ('certidao_estadual', 'fiscal_trabalhista', 'Certidão estadual', true, 90, true, false, 60),
  ('certidao_municipal', 'fiscal_trabalhista', 'Certidão municipal', true, 90, true, false, 70),
  ('crf_fgts', 'fiscal_trabalhista', 'CRF do FGTS', true, 90, true, false, 80),
  ('cndt', 'fiscal_trabalhista', 'CNDT', true, 90, true, false, 90),
  ('certidao_falencia', 'economico_financeira', 'Certidão de falência', true, 90, false, false, 100),
  ('balanco', 'economico_financeira', 'Balanço', true, 90, false, false, 110),
  ('atestado_capacidade', 'tecnica', 'Atestado de capacidade técnica', false, null, false, true, 120),
  ('sicaf', 'complementares', 'SICAF', true, 90, false, false, 130),
  ('tcu', 'complementares', 'Certidão do TCU', true, 90, false, false, 140),
  ('ceis', 'complementares', 'CEIS', true, 90, false, false, 150),
  ('cnj', 'complementares', 'Certidão do CNJ', true, 90, false, false, 160),
  ('simples_nacional', 'complementares', 'Simples Nacional', true, 90, false, false, 170),
  ('alvara', 'complementares', 'Alvará', true, 90, false, false, 180)
on conflict (codigo) do nothing;

create table if not exists public.tenant_documentos (
  id                  bigint generated always as identity primary key,
  tenant_id           bigint not null references public.tenants (id) on delete cascade,
  tipo_codigo         text not null references public.documento_tipos (codigo),
  storage_path        text,
  emitido_em          date,
  valido_ate          date,
  validade_calculada  boolean not null default false,
  emissor             text,
  autenticidade       text,
  observacao          text,
  substituido_por     bigint,
  created_at          timestamptz not null default now(),
  created_by          uuid,
  constraint tenant_documentos_tenant_id_key unique (tenant_id, id),
  constraint tenant_documentos_substitui_fkey foreign key (tenant_id, substituido_por)
    references public.tenant_documentos (tenant_id, id) on delete restrict,
  constraint tenant_documentos_path_chk check (
    storage_path is null
    or (
      storage_path ~ '^[0-9]+/.+'
      and split_part(storage_path, '/', 1) = tenant_id::text
    )
  )
);

create index if not exists tenant_documentos_tenant_idx
  on public.tenant_documentos (tenant_id, tipo_codigo);

comment on table public.tenant_documentos is
  'Documento de habilitação do tenant. valido_ate informado ou calculado (emissão + 90 dias). Arquivo em tenant-documentos/{tenant_id}/.';

create or replace function public.tenant_documento_validade(
  p_emitido date,
  p_informada date,
  p_padrao_dias integer
) returns jsonb
language sql
immutable
set search_path = public, pg_temp
as $$
  select case
    when p_informada is not null then jsonb_build_object('validade', p_informada, 'calculada', false)
    when p_emitido is not null and p_padrao_dias is not null then
      jsonb_build_object('validade', (p_emitido + p_padrao_dias), 'calculada', true)
    else jsonb_build_object('validade', null, 'calculada', false)
  end
$$;

create or replace function public.tenant_documento_alerta(p_validade date, p_hoje date)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
  select case
    when p_validade is null then 'sem_data'
    when p_validade < p_hoje then 'vencido'
    when p_validade <= p_hoje + 7 then 'd7'
    when p_validade <= p_hoje + 15 then 'd15'
    when p_validade <= p_hoje + 30 then 'd30'
    else 'ok'
  end
$$;

comment on function public.tenant_documento_alerta(date, date) is
  'Alerta de calendário: vencido, d7, d15, d30, ok ou sem_data. A sessão do certame não entra aqui.';

create or replace function public.tenant_documentos_validade_trg()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_tem boolean;
  v_padrao integer;
begin
  select t.tem_validade, t.validade_padrao_dias
    into v_tem, v_padrao
    from public.documento_tipos t
   where t.codigo = new.tipo_codigo;
  if new.valido_ate is not null then
    new.validade_calculada := false;
  elsif coalesce(v_tem, false) and new.emitido_em is not null and v_padrao is not null then
    new.valido_ate := new.emitido_em + v_padrao;
    new.validade_calculada := true;
  else
    new.validade_calculada := false;
  end if;
  return new;
end
$$;

drop trigger if exists tenant_documentos_validade on public.tenant_documentos;
create trigger tenant_documentos_validade
  before insert or update of emitido_em, valido_ate, tipo_codigo
  on public.tenant_documentos
  for each row execute function public.tenant_documentos_validade_trg();

revoke all on function public.tenant_documentos_validade_trg() from PUBLIC, anon, authenticated;
grant execute on function public.tenant_documentos_validade_trg() to service_role;

alter table public.documento_tipos enable row level security;
alter table public.tenant_documentos enable row level security;

drop policy if exists documento_tipos_select on public.documento_tipos;
create policy documento_tipos_select on public.documento_tipos
  for select to authenticated
  using (true);

drop policy if exists tenant_documentos_select on public.tenant_documentos;
create policy tenant_documentos_select on public.tenant_documentos
  for select to authenticated
  using (public.tenant_papel(tenant_id) is not null);

drop policy if exists tenant_documentos_escrever on public.tenant_documentos;
create policy tenant_documentos_escrever on public.tenant_documentos
  for all to authenticated
  using (public.tenant_papel(tenant_id) is not null)
  with check (public.tenant_papel(tenant_id) is not null);

drop policy if exists tenant_doc_storage_select on storage.objects;
create policy tenant_doc_storage_select on storage.objects
  for select to authenticated
  using (
    bucket_id = 'tenant-documentos'
    and (storage.foldername(name))[1] ~ '^[0-9]+$'
    and public.tenant_papel(((storage.foldername(name))[1])::bigint) is not null
  );

drop policy if exists tenant_doc_storage_escrever on storage.objects;
create policy tenant_doc_storage_escrever on storage.objects
  for all to authenticated
  using (
    bucket_id = 'tenant-documentos'
    and (storage.foldername(name))[1] ~ '^[0-9]+$'
    and public.tenant_papel(((storage.foldername(name))[1])::bigint) is not null
  )
  with check (
    bucket_id = 'tenant-documentos'
    and (storage.foldername(name))[1] ~ '^[0-9]+$'
    and public.tenant_papel(((storage.foldername(name))[1])::bigint) is not null
  );

revoke all on table public.documento_tipos, public.tenant_documentos from PUBLIC, anon, authenticated, service_role;
grant select on table public.documento_tipos to authenticated, service_role;
grant select, insert, update, delete on table public.tenant_documentos to authenticated, service_role;

revoke all on function public.tenant_documento_validade(date, date, integer) from PUBLIC, anon, authenticated, service_role;
revoke all on function public.tenant_documento_alerta(date, date) from PUBLIC, anon, authenticated, service_role;
grant execute on function public.tenant_documento_validade(date, date, integer) to authenticated, service_role;
grant execute on function public.tenant_documento_alerta(date, date) to authenticated, service_role;

commit;
