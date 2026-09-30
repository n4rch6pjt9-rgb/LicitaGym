-- LicitaGym: espelho do módulo UASG da API Dados Abertos Compras.gov.br
-- (modulo-uasg/1_consultarOrgao -> public.orgaos; modulo-uasg/2_consultarUasg -> public.uasgs).
-- PR 1a do plano órgãos/UASG. Somente estrutura + ACL: nenhum dado é inserido, alterado ou apagado aqui;
-- o coletor sync-compras-uasg (PR 2) popula.
--
-- Contexto (L0: consultas só leitura no projeto ifaiagegyicjzlpskafh em 29/09/2026, 11:37–11:47 BRT):
--   - public.orgaos: 191 linhas, todas vindas do sync PNCP (1:1 com public.entidades, entidade_id distinto e
--     não nulo em todas); orgao_id_pncp, esfera_id e poder_id nunca preenchidos. 497 public.unidades ligadas.
--   - orgaos_cnpj_idx é UNIQUE em regexp_replace(cnpj,'[^0-9]','','g'). No Compras.gov vários códigos de órgão
--     compartilham o mesmo CNPJ (37 CNPJs em 97 de 1.536 órgãos da amostra) e 2,5% vêm com cnpjCpfOrgao = "0":
--     o índice único impede o espelho e sai.
--   - Os CNPJs/CPFs do Compras vêm em formatos diferentes (14 dígitos, "0", "", null, e às vezes sem os zeros
--     à esquerda: "508903000188"). As colunas cnpj_cpf_* guardam o valor EXATO da API; só as colunas geradas
--     *_norm (lpad 14, nula quando vazia ou só zeros) servem para casar com o PNCP.
--   - ACL hoje: authenticated tem ALL em orgaos (inclusive TRUNCATE, que ignora RLS) + policy
--     orgaos_select_authenticated (using true); anon nada. Default ACL do schema public dá ALL a
--     anon/authenticated em todo objeto novo: por isso os REVOKE explícitos, inclusive na sequence.
--
-- Quem lê o quê (conferido no repo em ab2af12):
--   - Único escritor de orgaos: Edge Function sync-pncp-orgaos (service_role; chave entidade_id). Nenhuma view,
--     função ou trigger do banco lê orgaos; nenhum .from('orgaos') em cliente com JWT de usuário ou anon.
--   - O frontend só usa functions.invoke. A leitura de usuário de órgãos/UASGs virá pela Edge Function
--     api-orgaos-uasgs (PR 4), com service_role.
--
-- Modelo após esta migration:
--   orgaos  -> + colunas Compras (codigo_orgao UNIQUE como chave natural, hierarquia, poder/esfera crus,
--              compras_raw/compras_payload_hash/compras_*_em, pncp_vinculo) e cnpj_cpf_orgao_norm (gerada);
--              entidade_id e cnpj passam a aceitar NULL; UNIQUE(entidade_id) preserva "1 linha por entidade PNCP";
--              índices NÃO únicos em CNPJ. Só service_role (SELECT/INSERT/UPDATE/DELETE). Sai a policy de authenticated.
--   uasgs   -> tabela nova (codigo_uasg UNIQUE, raw/payload_hash, FK tolerante orgao_id ON DELETE SET NULL).
--              Só service_role (SELECT/INSERT/UPDATE/DELETE); sequence de identidade sem anon/authenticated/PUBLIC.
--   Colunas legadas esfera_id/poder_id ficam (sem DROP destrutivo). entidades/unidades não mudam aqui.
--
-- RLS ligado nas duas tabelas. Idempotente (pode rodar duas vezes). Não altera dados existentes.
-- Verificação (só leitura; erra se algo falhar): supabase/tests/compras_orgaos_uasgs_check.sql

begin;

-- Falha rápido em vez de enfileirar atrás de uma transação longa do coletor (e bloquear leituras).
set local lock_timeout = '10s';

-- 1) public.orgaos: relaxar restrições herdadas do modelo "só PNCP" ---------------------------------------
alter table public.orgaos alter column entidade_id drop not null;
alter table public.orgaos alter column cnpj drop not null;

-- Índice único por CNPJ quebra com CNPJ compartilhado e "0"; substituído por orgaos_cnpj_norm_idx (não único).
drop index if exists public.orgaos_cnpj_idx;

-- 2) public.orgaos: campos de consultarOrgao --------------------------------------------------------------
alter table public.orgaos
  add column if not exists codigo_orgao              integer,
  add column if not exists nome_orgao                text,
  add column if not exists nome_mnemonico_orgao      text,
  add column if not exists cnpj_cpf_orgao            text,
  add column if not exists codigo_orgao_vinculado    integer,
  add column if not exists cnpj_cpf_orgao_vinculado  text,
  add column if not exists nome_orgao_vinculado      text,
  add column if not exists codigo_orgao_superior     integer,
  add column if not exists cnpj_cpf_orgao_superior   text,
  add column if not exists nome_orgao_superior       text,
  add column if not exists codigo_tipo_administracao integer,
  add column if not exists nome_tipo_administracao   text,
  add column if not exists poder                     text,
  add column if not exists esfera                    text,
  add column if not exists uso_sisg                  boolean,
  add column if not exists status_orgao              boolean,
  add column if not exists data_hora_movimento       timestamp without time zone,
  add column if not exists compras_raw               jsonb,
  add column if not exists compras_payload_hash      text,
  add column if not exists compras_primeira_vez_em   timestamptz,
  add column if not exists compras_last_seen_at      timestamptz,
  add column if not exists compras_removido_em       timestamptz,
  add column if not exists pncp_vinculo              text,
  add column if not exists cnpj_cpf_orgao_norm       text generated always as (
    case
      when regexp_replace(coalesce(cnpj_cpf_orgao, ''), '[^0-9]', '', 'g') ~ '^0*$' then null
      else lpad(regexp_replace(cnpj_cpf_orgao, '[^0-9]', '', 'g'), 14, '0')
    end
  ) stored;

-- Constraints nomeadas, criadas só se ainda não existirem (idempotência).
do $$
begin
  if not exists (select 1 from pg_constraint
                  where conrelid = 'public.orgaos'::regclass and conname = 'orgaos_codigo_orgao_key') then
    alter table public.orgaos add constraint orgaos_codigo_orgao_key unique (codigo_orgao);
  end if;
  if not exists (select 1 from pg_constraint
                  where conrelid = 'public.orgaos'::regclass and conname = 'orgaos_entidade_id_key') then
    alter table public.orgaos add constraint orgaos_entidade_id_key unique (entidade_id);
  end if;
  if not exists (select 1 from pg_constraint
                  where conrelid = 'public.orgaos'::regclass and conname = 'orgaos_pncp_vinculo_check') then
    alter table public.orgaos add constraint orgaos_pncp_vinculo_check check (
      pncp_vinculo is null or pncp_vinculo in
        ('titular_cnpj', 'cnpj_compartilhado', 'raiz_cnpj_candidato', 'sem_pncp', 'sem_cnpj'));
  end if;
  if not exists (select 1 from pg_constraint
                  where conrelid = 'public.orgaos'::regclass and conname = 'orgaos_compras_consistente') then
    alter table public.orgaos add constraint orgaos_compras_consistente check (
      codigo_orgao is null or (compras_raw is not null and compras_payload_hash is not null));
  end if;
  if not exists (select 1 from pg_constraint
                  where conrelid = 'public.orgaos'::regclass and conname = 'orgaos_tem_identidade') then
    alter table public.orgaos add constraint orgaos_tem_identidade check (
      codigo_orgao is not null or entidade_id is not null);
  end if;
end $$;

create index if not exists orgaos_cnpj_norm_idx              on public.orgaos (regexp_replace(cnpj, '[^0-9]', '', 'g'));
create index if not exists orgaos_cnpj_cpf_orgao_norm_idx    on public.orgaos (cnpj_cpf_orgao_norm);
create index if not exists orgaos_orgao_id_pncp_idx          on public.orgaos (orgao_id_pncp);
create index if not exists orgaos_codigo_orgao_superior_idx  on public.orgaos (codigo_orgao_superior);
create index if not exists orgaos_codigo_orgao_vinculado_idx on public.orgaos (codigo_orgao_vinculado);
create index if not exists orgaos_data_hora_movimento_idx    on public.orgaos (data_hora_movimento);

comment on table public.orgaos is
  'Órgãos: linhas do sync PNCP (entidade_id) e espelho de Compras.gov.br consultarOrgao (codigo_orgao). Sem acesso direto para anon/authenticated; leitura e escrita só service_role (coletores e Edge Function api-orgaos-uasgs).';
comment on column public.orgaos.codigo_orgao is 'Compras.gov.br consultarOrgao.codigoOrgao: chave natural do espelho Compras.';
comment on column public.orgaos.cnpj_cpf_orgao is 'consultarOrgao.cnpjCpfOrgao exatamente como veio (sem máscara; pode vir "0" ou sem zeros à esquerda).';
comment on column public.orgaos.cnpj_cpf_orgao_vinculado is 'consultarOrgao.cnpjCpfOrgaoVinculado exatamente como veio.';
comment on column public.orgaos.cnpj_cpf_orgao_superior is 'consultarOrgao.cnpjCpfOrgaoSuperior exatamente como veio.';
comment on column public.orgaos.cnpj_cpf_orgao_norm is 'Gerada: dígitos de cnpj_cpf_orgao com lpad 14; NULL se vazio ou só zeros. Só para casar com o PNCP.';
comment on column public.orgaos.cnpj is 'CNPJ canônico 14 dígitos: PNCP quando a linha veio do PNCP; senão cnpj_cpf_orgao_norm (gravado pelo coletor).';
comment on column public.orgaos.data_hora_movimento is 'consultarOrgao.dataHoraMovimento (sem fuso na API; horário de Brasília presumido).';
comment on column public.orgaos.compras_raw is 'Objeto consultarOrgao bruto da última versão vista.';
comment on column public.orgaos.compras_payload_hash is 'sha256 hex de stableStringify(compras_raw) (_shared/pncp/hash.ts).';
comment on column public.orgaos.compras_removido_em is 'Ausente de uma varredura completa e não visto há 48 h (a API não lista órgãos inativos).';
comment on column public.orgaos.pncp_vinculo is 'titular_cnpj | cnpj_compartilhado | raiz_cnpj_candidato | sem_pncp | sem_cnpj.';

-- 3) public.uasgs: campos de consultarUasg (statusUasg true e false) ---------------------------------------
create table if not exists public.uasgs (
  id                        bigint generated always as identity primary key,
  codigo_uasg               text not null,
  nome_uasg                 text,
  uso_sisg                  boolean,
  adesao_siasg              boolean,
  sigla_uf                  text,
  codigo_municipio          integer,
  codigo_municipio_ibge     integer,
  nome_municipio_ibge       text,
  codigo_unidade_polo       integer,
  nome_unidade_polo         text,
  codigo_unidade_espelho    integer,
  nome_unidade_espelho      text,
  uasg_cadastradora         boolean,
  cnpj_cpf_uasg             text,
  codigo_orgao              integer,
  cnpj_cpf_orgao            text,
  cnpj_cpf_orgao_vinculado  text,
  cnpj_cpf_orgao_superior   text,
  codigo_siorg              text,
  status_uasg               boolean,
  data_implantacao_sidec    timestamptz,
  data_hora_movimento       timestamp without time zone,
  cnpj_cpf_orgao_norm       text generated always as (
    case
      when regexp_replace(coalesce(cnpj_cpf_orgao, ''), '[^0-9]', '', 'g') ~ '^0*$' then null
      else lpad(regexp_replace(cnpj_cpf_orgao, '[^0-9]', '', 'g'), 14, '0')
    end
  ) stored,
  orgao_id                  uuid,
  raw                       jsonb not null,
  payload_hash              text  not null,
  ativo                     boolean not null default true,
  primeira_vez_em           timestamptz not null default now(),
  last_seen_at              timestamptz,
  removido_da_fonte_em      timestamptz,
  last_synced_at            timestamptz,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),
  constraint uasgs_codigo_uasg_key unique (codigo_uasg),
  constraint uasgs_orgao_id_fkey foreign key (orgao_id) references public.orgaos (id) on delete set null
);

create index if not exists uasgs_codigo_orgao_idx        on public.uasgs (codigo_orgao);
create index if not exists uasgs_orgao_id_idx            on public.uasgs (orgao_id);
create index if not exists uasgs_cnpj_cpf_orgao_norm_idx on public.uasgs (cnpj_cpf_orgao_norm);
create index if not exists uasgs_uf_municipio_idx        on public.uasgs (sigla_uf, codigo_municipio_ibge);
create index if not exists uasgs_status_uasg_idx         on public.uasgs (status_uasg);
create index if not exists uasgs_data_hora_movimento_idx on public.uasgs (data_hora_movimento);

comment on table public.uasgs is
  'Espelho de Compras.gov.br modulo-uasg/2_consultarUasg (statusUasg true e false). Sem acesso direto para anon/authenticated; leitura e escrita só service_role (coletor sync-compras-uasg e Edge Function api-orgaos-uasgs).';
comment on column public.uasgs.codigo_uasg is 'consultarUasg.codigoUasg como texto (preserva zeros à esquerda, ex.: "030204").';
comment on column public.uasgs.cnpj_cpf_uasg is 'consultarUasg.cnpjCpfUasg exatamente como veio (vazio em ~96% das UASGs).';
comment on column public.uasgs.cnpj_cpf_orgao is 'consultarUasg.cnpjCpfOrgao exatamente como veio (sem máscara; pode vir "0" ou sem zeros à esquerda).';
comment on column public.uasgs.cnpj_cpf_orgao_norm is 'Gerada: dígitos de cnpj_cpf_orgao com lpad 14; NULL se vazio ou só zeros. Só para casar com o PNCP.';
comment on column public.uasgs.orgao_id is 'FK tolerante para orgaos(id), resolvida por codigo_orgao; NULL quando o órgão não está no espelho (inativo/fora da API).';
comment on column public.uasgs.raw is 'Objeto consultarUasg bruto da última versão vista.';
comment on column public.uasgs.payload_hash is 'sha256 hex de stableStringify(raw) (_shared/pncp/hash.ts).';
comment on column public.uasgs.removido_da_fonte_em is 'Ausente de uma varredura completa e não visto há 48 h.';

-- 4) RLS e ACL: só service_role -------------------------------------------------------------------------
alter table public.orgaos enable row level security;
alter table public.uasgs  enable row level security;

drop policy if exists orgaos_select_authenticated on public.orgaos;

revoke all on table public.orgaos, public.uasgs from PUBLIC, anon, authenticated;
-- service_role: exatamente CRUD (a default ACL daria ALL, inclusive TRUNCATE/REFERENCES/TRIGGER).
revoke all on table public.orgaos, public.uasgs from service_role;
grant select, insert, update, delete on table public.orgaos, public.uasgs to service_role;

-- Sequence de identidade de uasgs (default ACL dava USAGE/SELECT/UPDATE a anon/authenticated).
do $$
declare
  v_seq text := pg_get_serial_sequence('public.uasgs', 'id');
begin
  if v_seq is not null then
    execute format('revoke all on sequence %s from PUBLIC, anon, authenticated, service_role', v_seq);
    execute format('grant usage, select on sequence %s to service_role', v_seq);
  end if;
end $$;

commit;
