-- LicitaGym: versiona o drift do catálogo de tenant (tenants, catalogo_precos, catalogo_de_para,
-- v_catalogo_viabilidade e colunas extras de catalogo_produtos) e fecha o acesso de anon/authenticated.
--
-- Contexto:
-- Estes objetos foram criados direto em produção (ifaiagegyicjzlpskafh), fora de migration: nenhum deles
-- aparece em supabase/migrations nem em supabase_migrations.schema_migrations (conferido em 02/10/2026, só
-- leitura). As definições abaixo foram extraídas do catálogo de produção no mesmo dia (pg_attribute,
-- pg_get_constraintdef, pg_get_indexdef, pg_get_viewdef, reloptions, pg_policies). Nenhuma coluna inventada.
-- Pré-requisito do PR seguinte (catalogo_marcas_schema), que evolui catalogo_produtos e passa a usar tenants.
--
-- O que muda em produção (os objetos já existem):
--   * estrutura: nada. create table if not exists / add column if not exists / create index if not exists e
--     drop not null em catalogo_produtos.url são no-op; create or replace view regrava a mesma definição;
--     comments regravados com o mesmo texto;
--   * ACL: tenants, catalogo_precos e catalogo_de_para hoje dão ALL (inclusive TRUNCATE, que ignora RLS) a
--     anon e authenticated, e as sequences de identidade dão USAGE/SELECT/UPDATE aos dois. Passam a ser só
--     service_role. RLS já está ligado sem policy (nenhuma linha visível para anon/authenticated hoje).
--     v_catalogo_viabilidade já é só service_role e security_invoker=true: a migration só fixa isso.
--   * catalogo_produtos: só as colunas/índices/FK do drift. Grants e a policy catprod_select (SELECT para
--     authenticated, da 20260926160000) NÃO mudam aqui; ficam para o PR de schema do catálogo de marcas
--     junto com supabase/tests/sistema_s_catalogos_acl_check.sql.
--
-- Quem lê/escreve: ninguém além de service_role. Conferido em 02/10/2026: nenhuma referência no backend
-- (supabase/functions, services, scripts, Kuib-Harness), nenhuma no Dashboard (que só usa
-- supabase.functions.invoke) e nenhuma requisição /rest/v1 a estes objetos nos logs das últimas 24 h.
--
-- Verificação (só leitura): supabase/tests/catalogo_drift_tenant_acl_check.sql
--
-- Idempotente (pode rodar duas vezes). Não altera dados. Merge na main aplica em produção.

begin;

-- 1) tenants ---------------------------------------------------------------------------------------
create table if not exists public.tenants (
  id         bigint generated always as identity,
  slug       text not null,
  nome       text not null,
  cnpj       text,
  tipo       text not null default 'cliente'::text,
  ativo      boolean not null default true,
  created_at timestamptz not null default now(),
  constraint tenants_pkey primary key (id),
  constraint tenants_slug_key unique (slug),
  constraint tenants_tipo_check check (tipo = any (array['cliente'::text, 'interno'::text]))
);

comment on table public.tenants is
  'Clientes atendidos pela equipe LicitaGym (gestão de licitação). Acesso só service_role.';

-- 2) catalogo_produtos: colunas, FK e índices do drift ----------------------------------------------
alter table public.catalogo_produtos
  add column if not exists tenant_id bigint constraint catalogo_produtos_tenant_id_fkey references public.tenants(id),
  add column if not exists atributos jsonb not null default '{}'::jsonb,
  add column if not exists fonte_documento text,
  add column if not exists ativo boolean not null default true;

-- Em produção url já é opcional (catálogo de tenant importado de PDF não tem página). UNIQUE (url) continua.
alter table public.catalogo_produtos alter column url drop not null;

create index if not exists idx_catprod_tenant_no on public.catalogo_produtos using btree (tenant_id, no_taxonomia);
create unique index if not exists uq_catprod_tenant_codigo on public.catalogo_produtos using btree (tenant_id, codigo);

comment on column public.catalogo_produtos.url is
  'Página do produto no site do fabricante (coletor). Opcional para catálogos de tenant importados de PDF; nesse caso ver fonte_documento.';
comment on column public.catalogo_produtos.atributos is
  'Atributos comparáveis com editais: usuario_max_kg, motor_hp, vel_max_kmh, incl_max_pct, tipo_carga, peso_min_kg/peso_max_kg (pesos livres), medida.';

-- 3) catalogo_precos --------------------------------------------------------------------------------
create table if not exists public.catalogo_precos (
  id               bigint generated always as identity,
  tenant_id        bigint not null,
  produto_id       bigint not null,
  preco_tabela     numeric(14,2) not null,
  desconto_max_pct numeric(5,2) not null default 0,
  vigencia_inicio  date not null default current_date,
  vigencia_fim     date,
  created_at       timestamptz not null default now(),
  constraint catalogo_precos_pkey primary key (id),
  constraint catalogo_precos_tenant_id_fkey foreign key (tenant_id) references public.tenants(id),
  constraint catalogo_precos_produto_id_fkey foreign key (produto_id)
    references public.catalogo_produtos(id) on delete cascade,
  constraint catalogo_precos_preco_tabela_check check (preco_tabela > (0)::numeric),
  constraint catalogo_precos_desconto_max_pct_check
    check (desconto_max_pct >= (0)::numeric and desconto_max_pct <= (100)::numeric),
  constraint catalogo_precos_produto_id_vigencia_inicio_key unique (produto_id, vigencia_inicio)
);

comment on table public.catalogo_precos is
  'Tabela cheia e desconto máximo por produto do tenant. Sigiloso: só service_role.';

-- 4) catalogo_de_para -------------------------------------------------------------------------------
create table if not exists public.catalogo_de_para (
  id                       bigint generated always as identity,
  tenant_id                bigint not null,
  produto_id               bigint not null,
  fonte                    text not null,
  pca_item_id              uuid,
  licitacao_item_id        bigint,
  no_taxonomia             text not null,
  codigo_pdm               integer,
  nivel                    text not null,
  score                    numeric(5,2) not null,
  atributos_ok             text[] not null default '{}'::text[],
  atributos_falha          text[] not null default '{}'::text[],
  atributos_nao_informados text[] not null default '{}'::text[],
  status                   text not null default 'sugerido'::text,
  aderencia                text not null,
  revisado_por             uuid,
  revisado_em              timestamptz,
  metodo_versao            text not null,
  created_at               timestamptz not null default now(),
  constraint catalogo_de_para_pkey primary key (id),
  constraint catalogo_de_para_tenant_id_fkey foreign key (tenant_id) references public.tenants(id),
  constraint catalogo_de_para_produto_id_fkey foreign key (produto_id)
    references public.catalogo_produtos(id) on delete cascade,
  constraint catalogo_de_para_pca_item_id_fkey foreign key (pca_item_id)
    references public.pca_itens(id) on delete cascade,
  constraint catalogo_de_para_licitacao_item_id_fkey foreign key (licitacao_item_id)
    references public.licitacao_itens(id) on delete cascade,
  constraint catalogo_de_para_fonte_check check (fonte = any (array['pca'::text, 'licitacao'::text])),
  constraint catalogo_de_para_nivel_check
    check (nivel = any (array['catmat_item'::text, 'pdm_no'::text, 'texto'::text])),
  constraint catalogo_de_para_status_check
    check (status = any (array['sugerido'::text, 'confirmado'::text, 'rejeitado'::text])),
  constraint catalogo_de_para_aderencia_check
    check (aderencia = any (array['atende'::text, 'parcial'::text, 'nao_atende'::text])),
  constraint catalogo_de_para_check check (
    (fonte = 'pca'::text and pca_item_id is not null and licitacao_item_id is null)
    or (fonte = 'licitacao'::text and licitacao_item_id is not null and pca_item_id is null))
);

create index if not exists idx_depara_tenant_status
  on public.catalogo_de_para using btree (tenant_id, status, aderencia);
create unique index if not exists uq_depara_lic
  on public.catalogo_de_para using btree (produto_id, licitacao_item_id) where (licitacao_item_id is not null);
create unique index if not exists uq_depara_pca
  on public.catalogo_de_para using btree (produto_id, pca_item_id) where (pca_item_id is not null);

comment on table public.catalogo_de_para is
  'Casamento produto do tenant x item (PCA ou licitação). nivel: catmat_item (código exato) > pdm_no (PDM + nó da taxonomia) > texto. Só service_role.';

-- 5) v_catalogo_viabilidade (corpo = pg_get_viewdef de produção em 02/10/2026; security_invoker como lá) ---
create or replace view public.v_catalogo_viabilidade
with (security_invoker = true)
as
 WITH ref AS (
         SELECT d.produto_id,
            percentile_cont(0.5::double precision) WITHIN GROUP (ORDER BY (r.valor_unitario_homologado::double precision)) FILTER (WHERE r.valor_unitario_homologado > 0::numeric) AS med_hom,
            count(r.valor_unitario_homologado) FILTER (WHERE r.valor_unitario_homologado > 0::numeric) AS n_hom,
            percentile_cont(0.5::double precision) WITHIN GROUP (ORDER BY (COALESCE(pi.valor_unitario_estimado, li.valor_unitario_estimado)::double precision)) FILTER (WHERE COALESCE(pi.valor_unitario_estimado, li.valor_unitario_estimado) > 0::numeric) AS med_est,
            count(*) AS n_itens
           FROM catalogo_de_para d
             LEFT JOIN pca_itens pi ON pi.id = d.pca_item_id
             LEFT JOIN licitacao_itens li ON li.id = d.licitacao_item_id
             LEFT JOIN licitacao_resultados r ON r.licitacao_id = li.licitacao_id AND r.numero_item = li.numero_item
          WHERE d.status <> 'rejeitado'::text AND d.aderencia <> 'nao_atende'::text
          GROUP BY d.produto_id
        )
 SELECT p.tenant_id,
    p.id AS produto_id,
    p.codigo,
    p.nome,
    p.no_taxonomia,
    pr.preco_tabela,
    pr.desconto_max_pct,
    ref.n_itens,
    ref.n_hom,
        CASE
            WHEN ref.n_hom >= 3 THEN ref.med_hom
            ELSE ref.med_est
        END AS preco_referencia,
        CASE
            WHEN ref.n_hom >= 3 THEN 'homologado'::text
            ELSE 'estimado'::text
        END AS base_referencia,
    round(100::numeric * (1::double precision -
        CASE
            WHEN ref.n_hom >= 3 THEN ref.med_hom
            ELSE ref.med_est
        END / pr.preco_tabela::double precision)::numeric, 2) AS desconto_necessario_pct,
    (100::double precision * (1::double precision -
        CASE
            WHEN ref.n_hom >= 3 THEN ref.med_hom
            ELSE ref.med_est
        END / pr.preco_tabela::double precision)) <= pr.desconto_max_pct::double precision AS viavel
   FROM catalogo_produtos p
     JOIN ref ON ref.produto_id = p.id
     LEFT JOIN LATERAL ( SELECT c.preco_tabela,
            c.desconto_max_pct
           FROM catalogo_precos c
          WHERE c.produto_id = p.id AND c.vigencia_inicio <= CURRENT_DATE AND (c.vigencia_fim IS NULL OR c.vigencia_fim >= CURRENT_DATE)
          ORDER BY c.vigencia_inicio DESC
         LIMIT 1) pr ON true;

comment on view public.v_catalogo_viabilidade is
  'Desconto necessário = 1 - referência/tabela. Viável quando desconto necessário <= desconto máximo do tenant.';

-- 6) RLS (já ligado em produção; sem policy: só service_role, que tem bypassrls) ---------------------
alter table public.tenants          enable row level security;
alter table public.catalogo_precos  enable row level security;
alter table public.catalogo_de_para enable row level security;

-- 7) ACL ---------------------------------------------------------------------------------------------
revoke all on table
  public.tenants, public.catalogo_precos, public.catalogo_de_para, public.v_catalogo_viabilidade
from anon, authenticated, PUBLIC;

grant all on table
  public.tenants, public.catalogo_precos, public.catalogo_de_para, public.v_catalogo_viabilidade
to service_role;

revoke all on sequence
  public.tenants_id_seq, public.catalogo_precos_id_seq, public.catalogo_de_para_id_seq
from anon, authenticated, PUBLIC;

grant all on sequence
  public.tenants_id_seq, public.catalogo_precos_id_seq, public.catalogo_de_para_id_seq
to service_role;

commit;
