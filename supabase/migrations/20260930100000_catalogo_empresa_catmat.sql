-- LicitaGym: catálogo CATMAT da empresa (Grupo -> Classe -> PDM -> Item) e resolução do filtro de oportunidades
--
-- Contexto:
-- O admin (app_metadata.licitagym_role = 'admin') registra CATMAT em qualquer nível pela UI (/catmat), navegando
-- a árvore ao vivo no Compras.gov via Edge Function api-catmat. O registro vale para a empresa toda e alimenta o
-- filtro Grupo -> Classe -> PDM -> Item de /oportunidades (mesmo modelo do /bi).
--
-- Itens de licitação do PNCP quase nunca trazem código CATMAT (catalogo_codigo_item nulo em 100% hoje), então a
-- resolução casa por código quando existe e, senão, pelos padrões de texto do PDM (catmat_pdm_palavras).
--
-- Escrita: só service_role (Edge Function api-catmat, que valida o nó no Compras.gov e o papel de admin).
-- Leitura: authenticated só SELECT nas regras e nos padrões; o cache é só service_role; anon nada.
-- Verificação: supabase/tests/catalogo_catmat_acl_check.sql.
--
-- Idempotente.

begin;

-- 1) Regras do catálogo ---------------------------------------------------------------------------------------
create table if not exists public.catalogo_empresa_catmat (
  id                  bigint generated always as identity primary key,
  nivel               text not null check (nivel in ('grupo', 'classe', 'pdm', 'item')),
  codigo_grupo        int  not null,
  codigo_classe       int,
  codigo_pdm          int,
  codigo_item         int,
  nome_snapshot       text not null,
  ancestrais_snapshot jsonb not null default '{}'::jsonb,   -- {nome_grupo, nome_classe, nome_pdm}
  incluido            boolean not null default true,        -- false = exclusão de um nó herdado
  observacao          text check (observacao is null or length(observacao) <= 500),
  created_by          uuid,
  updated_by          uuid,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  chave               text generated always as (
                        nivel || ':' || coalesce(codigo_item, codigo_pdm, codigo_classe, codigo_grupo)::text
                      ) stored,
  constraint catalogo_empresa_catmat_chave_key unique (chave),
  constraint catalogo_empresa_catmat_niveis_chk check (
    (nivel = 'grupo'  and codigo_classe is null     and codigo_pdm is null     and codigo_item is null) or
    (nivel = 'classe' and codigo_classe is not null and codigo_pdm is null     and codigo_item is null) or
    (nivel = 'pdm'    and codigo_classe is not null and codigo_pdm is not null and codigo_item is null) or
    (nivel = 'item'   and codigo_classe is not null and codigo_pdm is not null and codigo_item is not null)
  )
);
create index if not exists catalogo_empresa_catmat_classe_idx on public.catalogo_empresa_catmat (codigo_classe);
create index if not exists catalogo_empresa_catmat_pdm_idx    on public.catalogo_empresa_catmat (codigo_pdm);
create index if not exists catalogo_empresa_catmat_item_idx   on public.catalogo_empresa_catmat (codigo_item);

comment on table public.catalogo_empresa_catmat is
  'Catálogo CATMAT da empresa: regras por nível (grupo/classe/pdm/item) com herança para baixo; incluido=false exclui um nó herdado. Escrita só via Edge Function api-catmat (service_role, admin); leitura authenticated.';

-- 2) Mapa item -> PDM dos nós cadastrados (independente de catalogo_itens, que tem outros escritores) ----------
create table if not exists public.catmat_item_pdm (
  codigo_item   int primary key,
  codigo_pdm    int not null,
  codigo_classe int not null,
  codigo_grupo  int not null,
  descricao     text,
  status_item   boolean,
  atualizado_em timestamptz not null default now()
);
create index if not exists catmat_item_pdm_pdm_idx on public.catmat_item_pdm (codigo_pdm);

comment on table public.catmat_item_pdm is
  'Itens CATMAT (código -> PDM/classe/grupo) hidratados pela Edge Function api-catmat para os nós do catálogo. Só service_role grava.';

-- 3) Cache persistente da árvore do Compras.gov (só service_role) ----------------------------------------------
create table if not exists public.compras_catmat_cache (
  chave      text primary key,               -- ex.: 'classes:78', 'pdms:7830', 'itens:7115'
  payload    jsonb not null,
  total      int,
  buscado_em timestamptz not null default now(),
  expira_em  timestamptz not null
);

comment on table public.compras_catmat_cache is
  'Cache da árvore CATMAT do Compras.gov usado pela Edge Function api-catmat. Só service_role.';

-- 4) Padrões de texto por PDM: criada em 20260929105430 (#82); aqui só completa (idempotente) -----------------------
create table if not exists public.catmat_pdm_palavras (
  id         bigint generated always as identity primary key,
  codigo_pdm int not null references public.catmat_pdms(codigo_pdm) on delete cascade,
  padrao     text not null,
  ativo      boolean not null default true,
  created_at timestamptz not null default now(),
  constraint catmat_pdm_palavras_codigo_pdm_padrao_key unique (codigo_pdm, padrao)
);
alter table public.catmat_pdm_palavras
  add column if not exists updated_by uuid,
  add column if not exists updated_at timestamptz;

comment on table public.catmat_pdm_palavras is
  'Padrões (regex ARE do Postgres, sobre texto em minúsculas e sem acento) que identificam um PDM em descrições de itens e objetos de licitação. Escrita só via Edge Function api-catmat (admin); leitura authenticated.';

-- 5) Funções ------------------------------------------------------------------------------------------------------

-- Minúsculas e sem acento (não há unaccent no projeto). Mesma normalização usada na medição inicial (204 itens).
create or replace function public.lg_normalizar(p text)
returns text
language sql
immutable
parallel safe
set search_path = pg_catalog, pg_temp
as $$
  select lower(translate(coalesce(p, ''),
    'áàâãäéèêëíìîïóòôõöúùûüçÁÀÂÃÄÉÈÊËÍÌÎÏÓÒÔÕÖÚÙÛÜÇ',
    'aaaaaeeeeiiiiooooouuuucaaaaaeeeeiiiiooooouuuuc'))
$$;

-- Valida um padrão no dialeto de regex do Postgres (o mesmo usado no casamento).
create or replace function public.catmat_regex_valido(p text)
returns boolean
language plpgsql
stable
set search_path = pg_catalog, pg_temp
as $$
begin
  if p is null or length(p) = 0 or length(p) > 300 then
    return false;
  end if;
  perform '' ~ p;
  return true;
exception when others then
  return false;
end
$$;

-- PDMs efetivos do catálogo: a regra mais específica vence (pdm > classe > grupo); só entram os incluídos.
create or replace function public.catalogo_catmat_pdms_efetivos()
returns table (codigo_pdm int, codigo_classe int, codigo_grupo int, origem_nivel text, regra_id bigint)
language sql
stable
set search_path = public, pg_temp
as $$
  with regras as (
    select p.codigo_pdm, p.codigo_classe, p.codigo_grupo,
           coalesce(rp.id, rc.id, rg.id)               as regra_id,
           coalesce(rp.nivel, rc.nivel, rg.nivel)       as origem_nivel,
           coalesce(rp.incluido, rc.incluido, rg.incluido) as incluido
      from public.catmat_pdms p
      left join public.catalogo_empresa_catmat rp on rp.nivel = 'pdm'    and rp.codigo_pdm    = p.codigo_pdm
      left join public.catalogo_empresa_catmat rc on rc.nivel = 'classe' and rc.codigo_classe = p.codigo_classe
      left join public.catalogo_empresa_catmat rg on rg.nivel = 'grupo'  and rg.codigo_grupo  = p.codigo_grupo
  )
  select codigo_pdm, codigo_classe, codigo_grupo, origem_nivel, regra_id
    from regras
   where incluido is true
$$;

-- Mapa item -> PDM a partir de todas as fontes conhecidas (sem duplicar).
create or replace function public.catmat_itens_mapa()
returns table (codigo_item bigint, codigo_pdm int)
language sql
stable
set search_path = public, pg_temp
as $$
  select distinct on (codigo_item) codigo_item, codigo_pdm from (
    select m.codigo_item::bigint, m.codigo_pdm, 1 as prio from public.catmat_item_pdm m
    union all
    select c.codigo_catmat::bigint, c.codigo_pdm::int, 2
      from public.catalogo_itens c
     where c.codigo_catmat ~ '^\d+$' and c.codigo_pdm ~ '^\d+$'
    union all
    select i.codigo_item, i.codigo_pdm::int, 3
      from public.catmat_itens i
     where i.codigo_pdm ~ '^\d+$'
  ) s
  order by codigo_item, prio
$$;

-- Licitações que casam com um recorte CATMAT.
--   p_grupos/p_classes/p_pdms/p_itens: recorte em cascata (nulo = sem restrição naquele nível)
--   p_somente_catalogo: restringe ao catálogo da empresa (herança + exclusões)
-- motivo: 'codigo' (catalogo_codigo_item numérico do item), 'texto_item' (padrão do PDM na descrição do item),
--         'texto_objeto' (padrão do PDM no objeto da licitação). Com p_itens, o texto vira 'texto_item_aprox'
--         (texto identifica o PDM, não o item).
-- Regras de recorte:
--   - item pedido em p_itens respeita grupo/classe/PDM informados e, no catálogo, as exclusões de item;
--   - texto sem p_itens: só os PDMs alvo (item avulso do catálogo casa só por código, não expande
--     para o PDM inteiro); com p_itens: os PDMs dos itens pedidos que passaram no recorte;
--   - sem LIMIT: o chamador (api-dashboard-oportunidades) aplica o teto de licitações.
create or replace function public.licitacoes_ids_por_catmat(
  p_grupos int[] default null,
  p_classes int[] default null,
  p_pdms int[] default null,
  p_itens int[] default null,
  p_somente_catalogo boolean default false
)
returns table (licitacao_id bigint, codigo_pdm int, codigo_item bigint, motivo text)
language sql
stable
set search_path = public, pg_temp
as $$
  with
  mapa as (select * from public.catmat_itens_mapa()),
  pdms_recorte as (
    select p.codigo_pdm
      from public.catmat_pdms p
     where (p_grupos  is null or p.codigo_grupo  = any (p_grupos))
       and (p_classes is null or p.codigo_classe = any (p_classes))
       and (p_pdms    is null or p.codigo_pdm    = any (p_pdms))
       and (p_itens   is null or p.codigo_pdm in (select m.codigo_pdm from mapa m where m.codigo_item = any (p_itens::bigint[])))
  ),
  pdms_alvo as (
    select r.codigo_pdm from pdms_recorte r
     where not coalesce(p_somente_catalogo, false)
        or r.codigo_pdm in (select e.codigo_pdm from public.catalogo_catmat_pdms_efetivos() e)
  ),
  itens_excluidos as (
    select c.codigo_item::bigint as codigo_item from public.catalogo_empresa_catmat c
     where c.nivel = 'item' and not c.incluido
  ),
  itens_avulsos as (
    select c.codigo_item::bigint as codigo_item, c.codigo_pdm from public.catalogo_empresa_catmat c
     where c.nivel = 'item' and c.incluido
       and (p_grupos  is null or c.codigo_grupo  = any (p_grupos))
       and (p_classes is null or c.codigo_classe = any (p_classes))
       and (p_pdms    is null or c.codigo_pdm    = any (p_pdms))
  ),
  itens_alvo as (
    -- itens pedidos explicitamente: dentro do recorte grupo/classe/PDM (quando informado) e, no catálogo,
    -- PDM efetivo sem exclusão do item, ou item avulso incluído
    select m.codigo_item, m.codigo_pdm from mapa m
     where p_itens is not null and m.codigo_item = any (p_itens::bigint[])
       and ((p_grupos is null and p_classes is null and p_pdms is null)
            or m.codigo_pdm in (select codigo_pdm from pdms_recorte))
       and (not coalesce(p_somente_catalogo, false)
            or (m.codigo_pdm in (select codigo_pdm from pdms_alvo)
                and m.codigo_item not in (select codigo_item from itens_excluidos))
            or m.codigo_item in (select codigo_item from itens_avulsos))
    union
    -- itens dos PDMs alvo (menos exclusões, quando for o catálogo)
    select m.codigo_item, m.codigo_pdm from mapa m
     where p_itens is null and m.codigo_pdm in (select codigo_pdm from pdms_alvo)
       and (not coalesce(p_somente_catalogo, false) or m.codigo_item not in (select codigo_item from itens_excluidos))
    union
    -- itens avulsos do catálogo (PDM não incluído como um todo): só por código
    select a.codigo_item, a.codigo_pdm from itens_avulsos a
     where coalesce(p_somente_catalogo, false) and p_itens is null
  ),
  pdms_texto as (
    -- sem p_itens: PDMs alvo (item avulso não expande para o PDM inteiro)
    select codigo_pdm from pdms_alvo where p_itens is null
    union
    -- com p_itens: PDMs dos itens pedidos que passaram no recorte (inclui avulsos; exclui itens excluídos)
    select codigo_pdm from itens_alvo where p_itens is not null
  ),
  padroes as (
    select w.codigo_pdm, w.padrao from public.catmat_pdm_palavras w
     where w.ativo and w.codigo_pdm in (select codigo_pdm from pdms_texto)
  ),
  por_codigo as (
    select li.licitacao_id, ia.codigo_pdm, ia.codigo_item, 'codigo'::text as motivo
      from public.licitacao_itens li
      -- cast protegido: códigos não numéricos (ex.: Paradigma 'AI0300075') viram null e não casam
      join itens_alvo ia on ia.codigo_item =
           case when li.catalogo_codigo_item ~ '^\d{1,15}$' then li.catalogo_codigo_item::bigint end
  ),
  por_texto_item as (
    select li.licitacao_id, pa.codigo_pdm, null::bigint as codigo_item,
           case when p_itens is null then 'texto_item' else 'texto_item_aprox' end as motivo
      from public.licitacao_itens li
      join padroes pa on public.lg_normalizar(li.descricao) ~ pa.padrao
  ),
  por_texto_objeto as (
    select le.id as licitacao_id, pa.codigo_pdm, null::bigint as codigo_item,
           case when p_itens is null then 'texto_objeto' else 'texto_item_aprox' end as motivo
      from public.licitacoes_externas le
      join padroes pa on public.lg_normalizar(le.objeto) ~ pa.padrao
  )
  select distinct * from (
    select * from por_codigo
    union all select * from por_texto_item
    union all select * from por_texto_objeto
  ) t
$$;

-- 6) Índice para o casamento por código -----------------------------------------------------------------------------
create index if not exists licitacao_itens_catalogo_codigo_item_idx
  on public.licitacao_itens (catalogo_codigo_item)
  where catalogo_codigo_item is not null;

-- 7) RLS e ACL explícitas (anon nada; authenticated só leitura; escrita só service_role) -----------------------------
alter table public.catalogo_empresa_catmat enable row level security;
alter table public.catmat_item_pdm        enable row level security;
alter table public.compras_catmat_cache   enable row level security;
alter table public.catmat_pdm_palavras    enable row level security;

drop policy if exists catalogo_empresa_catmat_select on public.catalogo_empresa_catmat;
create policy catalogo_empresa_catmat_select on public.catalogo_empresa_catmat for select to authenticated using (true);
drop policy if exists catmat_item_pdm_select on public.catmat_item_pdm;
create policy catmat_item_pdm_select on public.catmat_item_pdm for select to authenticated using (true);
drop policy if exists catmat_pdm_palavras_select on public.catmat_pdm_palavras;
create policy catmat_pdm_palavras_select on public.catmat_pdm_palavras for select to authenticated using (true);
-- compras_catmat_cache: sem policy (só service_role, que ignora RLS)

revoke all on table
  public.catalogo_empresa_catmat, public.catmat_item_pdm, public.compras_catmat_cache, public.catmat_pdm_palavras
from anon, authenticated, PUBLIC;

grant select on table public.catalogo_empresa_catmat, public.catmat_item_pdm, public.catmat_pdm_palavras to authenticated;

grant all on table
  public.catalogo_empresa_catmat, public.catmat_item_pdm, public.compras_catmat_cache, public.catmat_pdm_palavras
to service_role;

revoke all on sequence public.catalogo_empresa_catmat_id_seq, public.catmat_pdm_palavras_id_seq from anon, authenticated, PUBLIC;
grant all on sequence public.catalogo_empresa_catmat_id_seq, public.catmat_pdm_palavras_id_seq to service_role;

revoke execute on function public.lg_normalizar(text)                  from PUBLIC, anon, authenticated;
revoke execute on function public.catmat_regex_valido(text)            from PUBLIC, anon, authenticated;
revoke execute on function public.catalogo_catmat_pdms_efetivos()      from PUBLIC, anon, authenticated;
revoke execute on function public.catmat_itens_mapa()                  from PUBLIC, anon, authenticated;
revoke execute on function public.licitacoes_ids_por_catmat(int[], int[], int[], int[], boolean) from PUBLIC, anon, authenticated;
grant execute on function public.lg_normalizar(text)                   to service_role;
grant execute on function public.catmat_regex_valido(text)             to service_role;
grant execute on function public.catalogo_catmat_pdms_efetivos()       to service_role;
grant execute on function public.catmat_itens_mapa()                   to service_role;
grant execute on function public.licitacoes_ids_por_catmat(int[], int[], int[], int[], boolean) to service_role;

commit;
