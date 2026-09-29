-- LicitaGym: taxonomia de pisos e placas de borracha (linha Playfit) no casamento CATMAT
--
-- Contexto:
-- O dicionário de aparelhos v0.3 não tem pisos. A taxonomia de pisos
-- (services/coletor-externo/coletor/data/taxonomia-pisos-v0.1.json, classificador coletor/classificar_piso.py)
-- dá o nó (produto), o segmento e a prioridade comercial:
--   Alta  : placa emborrachada, piso emborrachado, piso de borracha reciclada (SBR), EPDM, piso para academia,
--           crossfit e playground;
--   Média : haras, paisagismo; proteção/absorção de impacto e segurança infantil só como contexto (não casam sozinhos);
--   Baixa : piso modular esportivo PP/TPE, polipropileno copolímero, quadra poliesportiva modular, piso desmontável,
--           futsal/basquete/handebol sem borracha -> indício de concorrente (Flexquadra), não é aderente.
--
-- Esta migration:
--   1) catmat_pdm_exclusoes: padrões de exclusão por PDM, em tabela própria (catmat_pdm_palavras não muda, então
--      nenhuma view ou consulta que lê os padrões passa a tratar uma exclusão como inclusão). Texto (item ou objeto)
--      que casar uma exclusão ativa não conta para o PDM no casamento por texto. Mesma ACL de catmat_pdm_palavras:
--      authenticated só lê; escrita só service_role (Edge Function api-catmat, admin);
--   2) taxonomia_no_pdm: 12 pares (6 nós, 4 PDMs) da taxonomia de pisos, versão 'pisos-0.1'. O PDM 9461
--      (BORRACHA GRANULADA, classe 9320) fica inerte até entrar no catálogo. Um teste
--      (tests/supabase/taxonomia_pisos_test.ts) garante que a carga acompanha o JSON;
--   3) padrões de inclusão Alta/Média nos PDMs 10779 (PISO SINTÉTICO) e 12550 (TAPETE DE BORRACHA) e exclusões Baixa
--      em 10779 e 757 (REVESTIMENTO PISO). Só entram para PDMs já materializados e sem sobrescrever padrões editados
--      pelo admin (on conflict do nothing);
--   4) licitacoes_ids_por_catmat: motivos texto_item/texto_objeto respeitam as exclusões. Código, taxonomia e as
--      views que leem catmat_pdm_palavras (ex.: homologacoes_itens) não mudam.
--
-- Idempotente. Leitura authenticated; escrita só service_role.

begin;

-- 1) Exclusões por PDM ---------------------------------------------------------------------------------------------
create table if not exists public.catmat_pdm_exclusoes (
  id         bigint generated always as identity primary key,
  codigo_pdm int not null references public.catmat_pdms(codigo_pdm) on delete cascade,
  padrao     text not null,
  ativo      boolean not null default true,
  created_at timestamptz not null default now(),
  updated_by uuid,
  updated_at timestamptz,
  constraint catmat_pdm_exclusoes_codigo_pdm_padrao_key unique (codigo_pdm, padrao)
);
comment on table public.catmat_pdm_exclusoes is
  'Padrões de exclusão (regex ARE do Postgres sobre lg_normalizar) por PDM: texto de item ou objeto que casar um padrão ativo não conta para o PDM no casamento por texto de licitacoes_ids_por_catmat (ex.: piso modular PP/TPE de concorrente). Escrita só via Edge Function api-catmat (admin); leitura authenticated.';

alter table public.catmat_pdm_exclusoes enable row level security;
drop policy if exists catmat_pdm_exclusoes_select on public.catmat_pdm_exclusoes;
create policy catmat_pdm_exclusoes_select on public.catmat_pdm_exclusoes for select to authenticated using (true);
revoke all on table public.catmat_pdm_exclusoes from anon, authenticated, PUBLIC;
grant select on table public.catmat_pdm_exclusoes to authenticated;
grant all on table public.catmat_pdm_exclusoes to service_role;
revoke all on sequence public.catmat_pdm_exclusoes_id_seq from anon, authenticated, PUBLIC;
grant all on sequence public.catmat_pdm_exclusoes_id_seq to service_role;

-- 2) Taxonomia de pisos -> PDM ------------------------------------------------------------------------------------------
insert into public.taxonomia_no_pdm (no_taxonomia, codigo_pdm, versao_dicionario) values
  ('piso_epdm', 10779, 'pisos-0.1'),
  ('piso_epdm', 757, 'pisos-0.1'),
  ('piso_borracha_reciclada_sbr', 10779, 'pisos-0.1'),
  ('piso_borracha_reciclada_sbr', 757, 'pisos-0.1'),
  ('placa_emborrachada', 10779, 'pisos-0.1'),
  ('placa_emborrachada', 757, 'pisos-0.1'),
  ('placa_emborrachada', 12550, 'pisos-0.1'),
  ('borracha_granulada', 9461, 'pisos-0.1'),
  ('tapete_borracha', 12550, 'pisos-0.1'),
  ('tapete_borracha', 757, 'pisos-0.1'),
  ('piso_emborrachado', 10779, 'pisos-0.1'),
  ('piso_emborrachado', 757, 'pisos-0.1')
on conflict (no_taxonomia, codigo_pdm) do update set versao_dicionario = excluded.versao_dicionario;

-- 3) Padrões (regex ARE sobre lg_normalizar) --------------------------------------------------------------------------
-- Inclusões (Alta/Média)
insert into public.catmat_pdm_palavras (codigo_pdm, padrao)
select v.codigo_pdm, v.padrao
  from (values
  (10779, 'placas? (de piso )?(emborrachad|de borracha|em borracha)'),
  (10779, 'pisos? (emborrachados? |de borracha )?(de |em )?(borracha reciclad|sbr|epdm|granulad|granulos? de (borracha|pneu))'),
  (10779, 'pisos? (emborrachados? |de borracha )?para (academia|crossfit|box de crossfit|playground|parque infantil)'),
  (12550, '(tapetes?|pisos?|placas?)( de borracha| emborrachad[oa]s?)?( para)? (baias?|cocheiras?|estabulos?|haras)')
       ) as v(codigo_pdm, padrao)
 where exists (select 1 from public.catmat_pdms p where p.codigo_pdm = v.codigo_pdm)
on conflict (codigo_pdm, padrao) do nothing;

-- Exclusões (Baixa: concorrente PP/TPE e quadra sem borracha)
insert into public.catmat_pdm_exclusoes (codigo_pdm, padrao)
select v.codigo_pdm, v.padrao
  from (values
  (10779, 'polipropileno|copolimero|\mpp\M|\mtpe\M|desmontave|piso modular esportiv|quadra poliesportiva modular|placas? plastic'),
  (10779, '^(?!.*(borracha|emborrach|\msbr\M|\mepdm\M)).*\m(futsal|basquete|basquetebol|handebol)\M'),
  (757, 'polipropileno|copolimero|\mpp\M|\mtpe\M|desmontave|piso modular esportiv|quadra poliesportiva modular|placas? plastic'),
  (757, '^(?!.*(borracha|emborrach|\msbr\M|\mepdm\M)).*\m(futsal|basquete|basquetebol|handebol)\M')
       ) as v(codigo_pdm, padrao)
 where exists (select 1 from public.catmat_pdms p where p.codigo_pdm = v.codigo_pdm)
on conflict (codigo_pdm, padrao) do nothing;

-- 4) Resolução com exclusões --------------------------------------------------------------------------------------------
-- Licitações que casam com um recorte CATMAT.
--   p_grupos/p_classes/p_pdms/p_itens: recorte em cascata (nulo = sem restrição naquele nível)
--   p_somente_catalogo: restringe ao catálogo da empresa (herança + exclusões)
-- motivo: 'codigo' (catalogo_codigo_item numérico do item), 'texto_item' (padrão do PDM na descrição do item),
--         'texto_objeto' (padrão do PDM no objeto da licitação), 'taxonomia' (no_taxonomia do item, classificado
--         pelo dicionário de aparelhos, aponta para o PDM em taxonomia_no_pdm), 'taxonomia_objeto' (idem, na licitação).
--         No item, o nó vem de no_taxonomia ou, se nula, de taxonomia->>'no_taxonomia' (backfill aplicar_taxonomia.py).
--         Com p_itens, texto e taxonomia viram '*_aprox' (identificam o PDM, não o item).
--   Padrões de public.catmat_pdm_exclusoes anulam o casamento por texto do PDM no mesmo texto (item ou objeto).
-- Regras de recorte:
--   - item pedido em p_itens respeita grupo/classe/PDM informados e, no catálogo, as exclusões de item;
--   - texto/taxonomia sem p_itens: só os PDMs alvo (item avulso do catálogo casa só por código, não expande
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
  -- padrões de exclusão (catmat_pdm_exclusoes): o mesmo texto que casar um deles não conta para o PDM
  exclusoes as (
    select x.codigo_pdm, x.padrao from public.catmat_pdm_exclusoes x
     where x.ativo and x.codigo_pdm in (select codigo_pdm from pdms_texto)
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
     where not exists (select 1 from exclusoes x
                        where x.codigo_pdm = pa.codigo_pdm and public.lg_normalizar(li.descricao) ~ x.padrao)
  ),
  por_texto_objeto as (
    select le.id as licitacao_id, pa.codigo_pdm, null::bigint as codigo_item,
           case when p_itens is null then 'texto_objeto' else 'texto_item_aprox' end as motivo
      from public.licitacoes_externas le
      join padroes pa on public.lg_normalizar(le.objeto) ~ pa.padrao
     where not exists (select 1 from exclusoes x
                        where x.codigo_pdm = pa.codigo_pdm and public.lg_normalizar(le.objeto) ~ x.padrao)
  ),
  nos_alvo as (
    select t.no_taxonomia, t.codigo_pdm from public.taxonomia_no_pdm t
     where t.codigo_pdm in (select codigo_pdm from pdms_texto)
  ),
  por_taxonomia as (
    select li.licitacao_id, n.codigo_pdm, null::bigint as codigo_item,
           case when p_itens is null then 'taxonomia' else 'taxonomia_aprox' end as motivo
      from public.licitacao_itens li
      join nos_alvo n on n.no_taxonomia = coalesce(li.no_taxonomia, li.taxonomia->>'no_taxonomia')
  ),
  por_taxonomia_objeto as (
    select le.id as licitacao_id, n.codigo_pdm, null::bigint as codigo_item,
           case when p_itens is null then 'taxonomia_objeto' else 'taxonomia_aprox' end as motivo
      from public.licitacoes_externas le
      join nos_alvo n on n.no_taxonomia = le.no_taxonomia
  )
  select distinct * from (
    select * from por_codigo
    union all select * from por_texto_item
    union all select * from por_texto_objeto
    union all select * from por_taxonomia
    union all select * from por_taxonomia_objeto
  ) t
$$;

-- create or replace preserva os grants da função; reafirmados por clareza
revoke execute on function public.licitacoes_ids_por_catmat(int[], int[], int[], int[], boolean) from PUBLIC, anon, authenticated;
grant execute on function public.licitacoes_ids_por_catmat(int[], int[], int[], int[], boolean) to service_role;

commit;
