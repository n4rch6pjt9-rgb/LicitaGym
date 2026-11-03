-- LicitaGym: casamento CATMAT por taxonomia (dicionário de aparelhos -> PDM)
--
-- Contexto:
-- Portais do Sistema S (Paradigma) não usam CATMAT: catalogo_codigo_item traz o código do catálogo do portal
-- (ex.: 'AI0300075'), que a resolução por código ignora. E padrões de texto escritos à mão falham em variações
-- ("Esteira profissional elétrica" não casa 'esteira eletrica'). Os coletores classificam cada item no dicionário de
-- aparelhos (services/coletor-externo/coletor/data/dicionario-aparelhos-v0.3.json) e gravam o slug do nó em
-- licitacao_itens.no_taxonomia (e licitacoes_externas.no_taxonomia). Cada nó do dicionário já aponta para PDMs
-- CATMAT (pdm_catmat). Esta migration leva esse mapeamento para o banco e acrescenta os motivos 'taxonomia' e
-- 'taxonomia_objeto' em licitacoes_ids_por_catmat. Vale para o Sistema S e para o PNCP.
-- No item, o nó vem de coalesce(no_taxonomia, taxonomia->>'no_taxonomia'): o aplicar_taxonomia.py antigo gravava
-- só o JSONB. Na licitação só existe a coluna no_taxonomia (licitacoes_externas não tem o JSONB).
--
-- taxonomia_no_pdm: 180 pares (98 nós, 24 PDMs) do dicionário v0.3. O nó 'fora_escopo' NÃO entra: é o balde
-- de tudo que está fora do escopo e aponta para 24 PDMs (cartão de árbitro, bandeirola, aro de basquete,
-- gangorra...); mapeá-lo faria um item fora de escopo casar com todos esses PDMs. Sem FK para catmat_pdms: PDMs ainda não
-- materializados ficam inertes até entrarem no catálogo. Um teste (tests/supabase/taxonomia_no_pdm_test.ts) garante
-- que a carga acompanha o JSON; nova versão do dicionário = nova migration.
--
-- Idempotente. Leitura authenticated; escrita só service_role.

begin;

create table if not exists public.taxonomia_no_pdm (
  no_taxonomia      text not null,
  codigo_pdm        int  not null,
  versao_dicionario text not null,
  primary key (no_taxonomia, codigo_pdm)
);
create index if not exists taxonomia_no_pdm_pdm_idx on public.taxonomia_no_pdm (codigo_pdm);

comment on table public.taxonomia_no_pdm is
  'Nó do dicionário de aparelhos (slug gravado em licitacao_itens.no_taxonomia) -> PDM CATMAT. Carga do dicionario-aparelhos-v0.3.json. Escrita só service_role; leitura authenticated.';

insert into public.taxonomia_no_pdm (no_taxonomia, codigo_pdm, versao_dicionario) values
  ('abdominal_maquina', 2640, '0.3'),
  ('abdominal_maquina', 17574, '0.3'),
  ('abdominal_obliquo_maquina', 2640, '0.3'),
  ('abdominal_obliquo_maquina', 17574, '0.3'),
  ('academia_ar_livre', 2640, '0.3'),
  ('academia_ar_livre', 6827, '0.3'),
  ('acessorio_pilates', 2640, '0.3'),
  ('acessorio_pilates', 17574, '0.3'),
  ('agachamento_maquina', 2640, '0.3'),
  ('agachamento_maquina', 17574, '0.3'),
  ('air_bike', 2640, '0.3'),
  ('air_bike', 3522, '0.3'),
  ('aparelho_musculacao_indefinido', 2640, '0.3'),
  ('aparelho_musculacao_indefinido', 17574, '0.3'),
  ('banco_abdominal', 2640, '0.3'),
  ('banco_abdominal', 11131, '0.3'),
  ('banco_abdominal', 17574, '0.3'),
  ('banco_livre', 2640, '0.3'),
  ('banco_livre', 17574, '0.3'),
  ('banco_lombar_45', 2640, '0.3'),
  ('banco_lombar_45', 17574, '0.3'),
  ('banco_scott', 2640, '0.3'),
  ('banco_scott', 17574, '0.3'),
  ('banco_sissy', 2640, '0.3'),
  ('banco_sissy', 17574, '0.3'),
  ('banco_supino', 2640, '0.3'),
  ('banco_supino', 17574, '0.3'),
  ('barra_livre', 2640, '0.3'),
  ('barrel', 2640, '0.3'),
  ('barrel', 17574, '0.3'),
  ('bicicleta_horizontal', 3522, '0.3'),
  ('bicicleta_vertical', 3522, '0.3'),
  ('bike_spinning', 2640, '0.3'),
  ('bike_spinning', 3522, '0.3'),
  ('bola_medicinal', 2638, '0.3'),
  ('bola_medicinal', 2640, '0.3'),
  ('bola_suica', 2640, '0.3'),
  ('cadeira_abdutora', 2640, '0.3'),
  ('cadeira_abdutora', 17574, '0.3'),
  ('cadeira_adutora', 2640, '0.3'),
  ('cadeira_adutora', 17574, '0.3'),
  ('cadeira_combo', 2640, '0.3'),
  ('cadeira_combo', 17574, '0.3'),
  ('cadeira_extensora', 2640, '0.3'),
  ('cadeira_extensora', 17574, '0.3'),
  ('cadeira_flexora', 2640, '0.3'),
  ('cadeira_flexora', 17574, '0.3'),
  ('cadillac', 17574, '0.3'),
  ('caixa_pilates', 17574, '0.3'),
  ('caixa_salto', 2640, '0.3'),
  ('cardio_indefinido', 2640, '0.3'),
  ('colchonete', 5341, '0.3'),
  ('colete_peso', 2638, '0.3'),
  ('corda_naval', 2640, '0.3'),
  ('corda_pular', 1400, '0.3'),
  ('crossover', 2640, '0.3'),
  ('crossover', 17574, '0.3'),
  ('crossover_com_smith', 2640, '0.3'),
  ('crossover_com_smith', 17574, '0.3'),
  ('desenvolvimento_maquina', 2640, '0.3'),
  ('desenvolvimento_maquina', 17574, '0.3'),
  ('dual_abdutora_adutora', 2640, '0.3'),
  ('dual_abdutora_adutora', 17574, '0.3'),
  ('dual_biceps_triceps', 2640, '0.3'),
  ('dual_biceps_triceps', 17574, '0.3'),
  ('dual_extensora_flexora', 2640, '0.3'),
  ('dual_extensora_flexora', 17574, '0.3'),
  ('dual_lombar_abdominal', 2640, '0.3'),
  ('dual_lombar_abdominal', 17574, '0.3'),
  ('dual_puxada_remada', 2640, '0.3'),
  ('dual_puxada_remada', 17574, '0.3'),
  ('dual_supino_desenvolvimento', 2640, '0.3'),
  ('dual_supino_desenvolvimento', 17574, '0.3'),
  ('dual_voador_inverso', 2640, '0.3'),
  ('dual_voador_inverso', 17574, '0.3'),
  ('elevacao_lateral_maquina', 2640, '0.3'),
  ('elevacao_lateral_maquina', 17574, '0.3'),
  ('elevacao_pelvica', 2640, '0.3'),
  ('elevacao_pelvica', 17574, '0.3'),
  ('eliptico', 2640, '0.3'),
  ('eliptico', 17574, '0.3'),
  ('equilibrio', 2640, '0.3'),
  ('escada_agilidade', 2640, '0.3'),
  ('estacao_musculacao', 2640, '0.3'),
  ('estacao_musculacao', 6827, '0.3'),
  ('estacao_musculacao', 17574, '0.3'),
  ('esteira_eletrica', 2640, '0.3'),
  ('esteira_eletrica', 7113, '0.3'),
  ('esteira_eletrica', 7115, '0.3'),
  ('esteira_nao_eletrica', 2640, '0.3'),
  ('esteira_nao_eletrica', 7116, '0.3'),
  ('faixa_elastica', 2638, '0.3'),
  ('faixa_elastica', 7253, '0.3'),
  ('fita_suspensao', 2638, '0.3'),
  ('fita_suspensao', 2640, '0.3'),
  ('flexora_em_pe', 2640, '0.3'),
  ('flexora_em_pe', 17574, '0.3'),
  ('ginastica_artistica_ritmica', 2640, '0.3'),
  ('ginastica_artistica_ritmica', 2976, '0.3'),
  ('ginastica_artistica_ritmica', 3431, '0.3'),
  ('ginastica_artistica_ritmica', 6886, '0.3'),
  ('ginastica_artistica_ritmica', 10897, '0.3'),
  ('ginastica_artistica_ritmica', 15172, '0.3'),
  ('ginastica_artistica_ritmica', 15285, '0.3'),
  ('ginastica_artistica_ritmica', 16229, '0.3'),
  ('gluteo_maquina', 2640, '0.3'),
  ('gluteo_maquina', 17574, '0.3'),
  ('graviton', 2640, '0.3'),
  ('graviton', 17574, '0.3'),
  ('hack', 2640, '0.3'),
  ('hack', 17574, '0.3'),
  ('haltere', 8166, '0.3'),
  ('kettlebell', 8166, '0.3'),
  ('leg_press_45', 2640, '0.3'),
  ('leg_press_45', 17574, '0.3'),
  ('leg_press_horizontal', 2640, '0.3'),
  ('leg_press_horizontal', 17574, '0.3'),
  ('leg_press_indefinido', 2640, '0.3'),
  ('leg_press_indefinido', 17574, '0.3'),
  ('leg_press_vertical', 2640, '0.3'),
  ('leg_press_vertical', 17574, '0.3'),
  ('lombar_maquina', 2640, '0.3'),
  ('lombar_maquina', 17574, '0.3'),
  ('mesa_flexora', 2640, '0.3'),
  ('mesa_flexora', 17574, '0.3'),
  ('mini_trampolim', 2640, '0.3'),
  ('panturrilha_em_pe', 2640, '0.3'),
  ('panturrilha_em_pe', 17574, '0.3'),
  ('panturrilha_sentado', 2640, '0.3'),
  ('panturrilha_sentado', 17574, '0.3'),
  ('paralela_barra_fixa', 2640, '0.3'),
  ('paralela_barra_fixa', 17574, '0.3'),
  ('pegador_polia', 2638, '0.3'),
  ('pegador_polia', 2640, '0.3'),
  ('plataforma_vibratoria', 2640, '0.3'),
  ('polia', 2638, '0.3'),
  ('polia', 2640, '0.3'),
  ('polia', 17574, '0.3'),
  ('puxada_alta', 2640, '0.3'),
  ('puxada_alta', 17574, '0.3'),
  ('rack_gaiola', 2640, '0.3'),
  ('rack_gaiola', 17574, '0.3'),
  ('reformer', 17574, '0.3'),
  ('remada_cavalinho', 2640, '0.3'),
  ('remada_cavalinho', 17574, '0.3'),
  ('remada_maquina', 2640, '0.3'),
  ('remada_maquina', 17574, '0.3'),
  ('remada_sentada', 2640, '0.3'),
  ('remada_sentada', 17574, '0.3'),
  ('remo_ergometro', 2640, '0.3'),
  ('remo_ergometro', 17574, '0.3'),
  ('roda_abdominal', 2640, '0.3'),
  ('rolo_liberacao', 2640, '0.3'),
  ('rolo_liberacao', 17733, '0.3'),
  ('rolo_treino_bicicleta', 2640, '0.3'),
  ('rosca_biceps_maquina', 2640, '0.3'),
  ('rosca_biceps_maquina', 17574, '0.3'),
  ('saco_areia', 2638, '0.3'),
  ('saco_pancada', 18453, '0.3'),
  ('simulador_escada', 2640, '0.3'),
  ('simulador_escada', 17574, '0.3'),
  ('simulador_esqui', 2640, '0.3'),
  ('simulador_esqui', 17574, '0.3'),
  ('smith', 2640, '0.3'),
  ('smith', 17574, '0.3'),
  ('step', 2640, '0.3'),
  ('step', 10897, '0.3'),
  ('supino_maquina', 2640, '0.3'),
  ('supino_maquina', 17574, '0.3'),
  ('suporte_armazenamento', 7100, '0.3'),
  ('tatame', 18452, '0.3'),
  ('triceps_maquina', 2640, '0.3'),
  ('triceps_maquina', 17574, '0.3'),
  ('triceps_paralela_maquina', 2640, '0.3'),
  ('triceps_paralela_maquina', 17574, '0.3'),
  ('voador_inverso', 2640, '0.3'),
  ('voador_inverso', 17574, '0.3'),
  ('voador_peck_deck', 2640, '0.3'),
  ('voador_peck_deck', 17574, '0.3'),
  ('wall_unit', 17574, '0.3')
on conflict (no_taxonomia, codigo_pdm) do nothing;
-- Nó-balde fora_escopo nunca mapeia para PDM (ver cabeçalho)
delete from public.taxonomia_no_pdm where no_taxonomia = 'fora_escopo';

create index if not exists licitacao_itens_no_taxonomia_idx
  on public.licitacao_itens (no_taxonomia) where no_taxonomia is not null;

-- Licitações que casam com um recorte CATMAT.
--   p_grupos/p_classes/p_pdms/p_itens: recorte em cascata (nulo = sem restrição naquele nível)
--   p_somente_catalogo: restringe ao catálogo da empresa (herança + exclusões)
-- motivo: 'codigo' (catalogo_codigo_item numérico do item), 'texto_item' (padrão do PDM na descrição do item),
--         'texto_objeto' (padrão do PDM no objeto da licitação), 'taxonomia' (no_taxonomia do item, classificado
--         pelo dicionário de aparelhos, aponta para o PDM em taxonomia_no_pdm), 'taxonomia_objeto' (idem, na licitação).
--         No item, o nó vem de no_taxonomia ou, se nula, de taxonomia->>'no_taxonomia' (backfill aplicar_taxonomia.py).
--         Com p_itens, texto e taxonomia viram '*_aprox' (identificam o PDM, não o item).
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

alter table public.taxonomia_no_pdm enable row level security;
drop policy if exists taxonomia_no_pdm_select on public.taxonomia_no_pdm;
create policy taxonomia_no_pdm_select on public.taxonomia_no_pdm for select to authenticated using (true);
revoke all on table public.taxonomia_no_pdm from anon, authenticated, PUBLIC;
grant select on table public.taxonomia_no_pdm to authenticated;
grant all on table public.taxonomia_no_pdm to service_role;

-- create or replace preserva os grants da função; reafirmados por clareza
revoke execute on function public.licitacoes_ids_por_catmat(int[], int[], int[], int[], boolean) from PUBLIC, anon, authenticated;
grant execute on function public.licitacoes_ids_por_catmat(int[], int[], int[], int[], boolean) to service_role;

commit;
