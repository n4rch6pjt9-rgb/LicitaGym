-- Taxonomia dos itens CATMAT: atributos por item e palavras âncora geradas a partir deles.
-- SÓ ARQUIVO: não aplicar sem o ok do Marcelo (plano: handoffs/licitagym-dashboard-pipeline/TAXONOMIA-ITENS-PLANO.md).
--
-- 1) catmat_item_atributo: a descrição de cada item CATMAT ("ANILHA, MATERIAL: FERRO, COR: PRETA") vira
--    linhas (codigo_item, ordem, atributo, valor). Fonte 'descricao' (parser abaixo) ou 'compras_gov'
--    (endpoint 7_consultarMaterialCaracteristicas, quando catmat_item_caracteristicas tiver o item).
-- 2) catmat_item_pdm.nome_item: a cabeça da descrição (texto antes do primeiro "CHAVE:"), âncora do casamento.
-- 3) catmat_pdm_ancoras: as palavras derivadas (origem cabeca/atributo_nome/atributo_tipo/item_avulso e
--    codigo_item_origem). NÃO entram em catmat_pdm_palavras (motivo na seção 3). catmat_pdm_palavras não muda.
-- 4) Funções puras (parser, variantes de plural, tokens) + geradora com dry-run (p_aplicar = false) +
--    catmat_itens_ancorados(ids) (só leitura, ainda sem consumidor).
--
-- Casamento ancorado: tokens do item sem o enchimento inicial ("lote único -", "kit 10", "item 3", "catmat 12345");
--   1º token = núcleo da âncora (com plural); as demais palavras da âncora entre os 11 tokens seguintes.
-- A geração NÃO roda nesta migration (nem a hidratação dos itens): ver o plano.

begin;

-- 1) Funções puras -------------------------------------------------------------------------------------------------

-- Partes da descrição: separa em ", CHAVE:" (chave em maiúsculas, até 80 caracteres, sem vírgula nem dois-pontos).
-- Valores com vírgula ("2,0 KG") não quebram porque o pedaço seguinte não tem "CHAVE:".
create or replace function public.catmat_cabeca_descricao(p text)
returns text
language sql
immutable
parallel safe
set search_path = pg_catalog, pg_temp
as $$
  select nullif(btrim(rtrim(btrim((regexp_split_to_array(btrim(coalesce(p, '')),
    ',\s*(?=[A-ZÁÀÂÃÄÉÈÊËÍÌÎÏÓÒÔÕÖÚÙÛÜÇ0-9][A-ZÁÀÂÃÄÉÈÊËÍÌÎÏÓÒÔÕÖÚÙÛÜÇ0-9 /().ºª-]{0,80}:)'))[1]), ',')), '')
$$;

create or replace function public.catmat_atributos_da_descricao(p text)
returns table (ordem int, atributo text, valor text)
language sql
immutable
parallel safe
set search_path = pg_catalog, pg_temp
as $$
  select (t.o - 1)::int,
         btrim(regexp_replace(split_part(t.parte, ':', 1), '\s+', ' ', 'g')),
         btrim(rtrim(btrim(regexp_replace(substr(t.parte, strpos(t.parte, ':') + 1), '\s+', ' ', 'g')), ','))
    from regexp_split_to_table(btrim(coalesce(p, '')),
           ',\s*(?=[A-ZÁÀÂÃÄÉÈÊËÍÌÎÏÓÒÔÕÖÚÙÛÜÇ0-9][A-ZÁÀÂÃÄÉÈÊËÍÌÎÏÓÒÔÕÖÚÙÛÜÇ0-9 /().ºª-]{0,80}:)')
         with ordinality t(parte, o)
   where t.o > 1 and strpos(t.parte, ':') > 0
$$;

-- Texto de âncora: minúsculas, sem acento, só [a-z0-9] separados por um espaço.
create or replace function public.catmat_norm_ancora(p text)
returns text
language sql
immutable
parallel safe
set search_path = pg_catalog, pg_temp
as $$
  select btrim(regexp_replace(public.lg_normalizar(p), '[^a-z0-9]+', ' ', 'g'))
$$;

-- Variantes de número de uma palavra (haltere ~ halter/halteres; elástica ~ elásticas; cinturão ~ cinturões).
create or replace function public.catmat_palavra_variantes(w text)
returns text[]
language sql
immutable
parallel safe
set search_path = pg_catalog, pg_temp
as $$
  select array_agg(distinct v collate "C" order by v collate "C")
    from unnest(array[
      w,
      case when right(w, 1) in ('a', 'e', 'i', 'o', 'u') then w || 's' end,
      case when right(w, 1) = 'l' then left(w, -1) || 'is' end,
      case when right(w, 1) = 'm' then left(w, -1) || 'ns' end,
      case when right(w, 1) in ('r', 'z') then w || 'es' end,
      case when right(w, 2) = 'ao' then left(w, -2) || 'oes' end,
      case when right(w, 2) = 'ao' then left(w, -2) || 'aes' end,
      case when right(w, 1) = 's' and length(w) > 3 then left(w, -1) end,
      case when right(w, 1) = 'e' and length(w) > 4 and substr(w, length(w) - 1, 1) in ('r', 't', 'l') then left(w, -1) end,
      case when right(w, 1) = 'e' and length(w) > 4 and substr(w, length(w) - 1, 1) in ('r', 't', 'l') then left(w, -1) || 'es' end,
      -- sinônimo (Marcelo, 03/10/2026 19:47 BRT): catálogo "ESTEIRA ERGONÔMICA" ~ licitação "esteira ergométrica"
      case when w ~ '^ergonomic[ao]s?$' then regexp_replace(w, '^ergonomic([ao])s?$', 'ergometric\1') end,
      case when w ~ '^ergonomic[ao]s?$' then regexp_replace(w, '^ergonomic([ao])s?$', 'ergometric\1s') end,
      case when w ~ '^ergometric[ao]s?$' then regexp_replace(w, '^ergometric([ao])s?$', 'ergonomic\1') end,
      case when w ~ '^ergometric[ao]s?$' then regexp_replace(w, '^ergometric([ao])s?$', 'ergonomic\1s') end
    ]) v
   where v is not null and v <> ''
$$;

-- Tokens do texto de um item de licitação para o casamento ancorado: minúsculas, sem acento, sem o enchimento
-- inicial ("LOTE ÚNICO -", "Item 3", "kit 10", "par de", "CATMAT 12345", "MAT. ESPORTIVO -", "(ID131043)", números),
-- quebrado em [a-z0-9]+.
-- Um único regex fixo (fica no cache de regex do Postgres); as âncoras não viram regex.
create or replace function public.catmat_texto_tokens(p text)
returns text[]
language sql
immutable
parallel safe
set search_path = pg_catalog, pg_temp
as $$
  select coalesce(array_agg(m.t[1] order by m.o), '{}')
    from regexp_matches(
           regexp_replace(public.lg_normalizar(p),
             '^[^a-z0-9]*(?:(?:item|itens|lote|lotes|cota|catmat|kit|kits|par|pares|jogo|jogos|conjunto|conjuntos|unico'
             '|principal|reservada|ampla|mat(?=\.)|material|materiais|esportivo|esportivos|contendo|unidades|unidade|pecas'
             '|no|n|com|de|id[0-9]+|[ivxl]+|[0-9]+[a-z]{0,2}|[a-z]{2}[0-9]{7})[^a-z0-9]+)*', ''),
           '[a-z0-9]+', 'g') with ordinality m(t, o)
$$;

-- Palavras significativas de uma âncora (sem conectivos): a 1ª é o núcleo, as demais refinam.
create or replace function public.catmat_ancora_palavras(p_ancora text)
returns text[]
language sql
immutable
parallel safe
set search_path = pg_catalog, pg_temp
as $$
  select coalesce(array_agg(m.w[1] order by m.o), '{}')
    from regexp_matches(public.lg_normalizar(p_ancora), '[a-z0-9]+', 'g') with ordinality m(w, o)
   where m.w[1] <> all (array['a','com','da','das','de','do','dos','e','em','o','p','para','uso'])
$$;

-- 2) Atributos por item -------------------------------------------------------------------------------------------
create table if not exists public.catmat_item_atributo (
  codigo_item   int not null references public.catmat_item_pdm (codigo_item) on delete cascade,
  ordem         smallint not null check (ordem >= 1),
  atributo      text not null,
  valor         text not null,
  fonte         text not null default 'descricao' check (fonte in ('descricao', 'compras_gov')),
  atualizado_em timestamptz not null default now(),
  primary key (codigo_item, ordem)
);
create index if not exists catmat_item_atributo_atributo_idx on public.catmat_item_atributo (atributo);

comment on table public.catmat_item_atributo is
  'Atributos de taxonomia de cada item CATMAT (descrição "NOME, CHAVE: VALOR, ..." quebrada em linhas). Fonte descricao (catmat_atributos_da_descricao) ou compras_gov (catmat_item_caracteristicas). Escrita só service_role (api-catmat / catmat_item_atributo_sincronizar).';

alter table public.catmat_item_pdm
  add column if not exists nome_item text generated always as (public.catmat_cabeca_descricao(descricao)) stored;
comment on column public.catmat_item_pdm.nome_item is 'Cabeça da descrição do item (antes do primeiro "CHAVE:"): âncora do casamento.';

-- (Re)gera os atributos dos itens pedidos (null = todos os de catmat_item_pdm). Usa a característica estruturada do
-- Compras.gov quando catmat_item_caracteristicas tem o item; senão a descrição. Devolve quantas linhas gravou.
create or replace function public.catmat_item_atributo_sincronizar(p_itens int[] default null)
returns int
language plpgsql
set search_path = public, pg_catalog, pg_temp
as $$
declare
  v_n int;
begin
  delete from public.catmat_item_atributo a
   where p_itens is null or a.codigo_item = any (p_itens);

  insert into public.catmat_item_atributo (codigo_item, ordem, atributo, valor, fonte)
  with alvo as (
    select m.codigo_item, m.descricao from public.catmat_item_pdm m
     where p_itens is null or m.codigo_item = any (p_itens)
  ),
  estruturado as (
    select c.codigo_item,
           row_number() over (partition by c.codigo_item order by c.numero_caracteristica nulls last, c.codigo_caracteristica)::smallint ordem,
           c.nome_caracteristica atributo,
           btrim(coalesce(c.nome_valor_caracteristica, '') || coalesce(' ' || c.sigla_unidade_medida, '')) valor
      from public.catmat_item_caracteristicas c
     where c.status and c.codigo_item in (select codigo_item from alvo)
  )
  select codigo_item, ordem, atributo, valor, 'compras_gov' from estruturado
  union all
  select a.codigo_item, d.ordem::smallint, d.atributo, d.valor, 'descricao'
    from alvo a cross join lateral public.catmat_atributos_da_descricao(a.descricao) d
   where not exists (select 1 from estruturado e where e.codigo_item = a.codigo_item)
     and d.atributo <> '';
  get diagnostics v_n = row_count;
  return v_n;
end
$$;

-- 3) Âncoras geradas (palavras derivadas dos itens) ---------------------------------------------------------------
-- Ficam FORA de catmat_pdm_palavras de propósito: lá cada linha é um regex que 10+ consumidores (licitacao_match,
-- licitacoes_ids_por_catmat, views de BI) aplicam a todo item; 138 regex longos estouram o cache de 32 regex
-- compiladas do Postgres (medido no dry-run: 2,7 s -> mais de 60 s). Aqui o casamento é por tokens (hash na 1ª palavra).
create table if not exists public.catmat_pdm_ancoras (
  id                 bigint generated always as identity primary key,
  codigo_pdm         int not null,
  ancora             text not null,                 -- legível, normalizada: 'corda de pular'
  palavras           text[] not null,               -- catmat_ancora_palavras(ancora): {corda,pular}
  origem             text not null check (origem in ('manual', 'cabeca', 'atributo_nome', 'atributo_tipo', 'item_avulso')),
  codigo_item_origem int,                           -- item CATMAT de onde saiu (o de menor código)
  ativo              boolean not null default true,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz,
  updated_by         uuid,
  constraint catmat_pdm_ancoras_pdm_ancora_key unique (codigo_pdm, ancora),
  constraint catmat_pdm_ancoras_palavras_chk check (cardinality(palavras) >= 1)
);
create index if not exists catmat_pdm_ancoras_pdm_idx on public.catmat_pdm_ancoras (codigo_pdm);

comment on table public.catmat_pdm_ancoras is
  'Âncoras de casamento por PDM derivadas da taxonomia dos itens CATMAT (cabeça da descrição, NOME, TIPO de PDM genérico, item avulso + MATERIAL). Casamento: 1ª palavra do item = núcleo (com plural) e as demais palavras nas 11 seguintes. Geradas por catmat_gerar_ancoras(); origem manual = escrita pelo admin.';

-- Núcleo -> âncora, com as variantes de plural já expandidas (para hash join na 1ª palavra do item).
create or replace view public.catmat_pdm_ancoras_nucleo
with (security_invoker = true) as
select a.id ancora_id, a.codigo_pdm, a.ancora, a.origem, a.palavras, v.variante
  from public.catmat_pdm_ancoras a
 cross join lateral unnest(public.catmat_palavra_variantes(a.palavras[1])) v(variante)
 where a.ativo;

-- Itens (de material) das licitações pedidas que casam alguma âncora ativa. Só leitura; ainda sem consumidor:
-- é a peça que a regra "forte = item casa PDM/item do catálogo" usaria (depende do ok do Marcelo).
create or replace function public.catmat_itens_ancorados(p_licitacoes bigint[])
returns table (licitacao_id bigint, item_id bigint, numero_item int, codigo_pdm int, ancora_id bigint, ancora text, origem text)
language sql
stable
set search_path = public, pg_catalog, pg_temp
as $$
  with it as materialized (
    select i.licitacao_id, i.id, i.numero_item, public.catmat_texto_tokens(i.descricao) tk
      from public.licitacao_itens i
     where i.licitacao_id = any (p_licitacoes) and coalesce(i.material_ou_servico, 'M') <> 'S'
  )
  select it.licitacao_id, it.id, it.numero_item, n.codigo_pdm, n.ancora_id, n.ancora, n.origem
    from it join public.catmat_pdm_ancoras_nucleo n on n.variante = it.tk[1]
   where not exists (
     select 1 from unnest(n.palavras[2:]) w
      where not (it.tk[2:12] && public.catmat_palavra_variantes(w)))
$$;

-- Âncoras do catálogo efetivo: cabeça dos itens (e variantes), NOME, TIPO quando a cabeça é genérica
-- ("APARELHO / EQUIPAMENTO ..."), e itens avulsos de PDM fora do catálogo (cabeça + MATERIAL do item).
create or replace function public.catmat_ancoras_geradas()
returns table (codigo_pdm int, ancora text, origem text, codigo_item_origem int)
language sql
stable
set search_path = public, pg_catalog, pg_temp
as $$
  with ef as (select e.codigo_pdm from public.catalogo_catmat_pdms_efetivos() e),
  regras_item as (select c.codigo_item, c.incluido from public.catalogo_empresa_catmat c where c.nivel = 'item'),
  itens as (
    select m.codigo_item, m.codigo_pdm, m.nome_item, (m.codigo_pdm in (select codigo_pdm from ef)) efetivo,
           public.catmat_norm_ancora(m.nome_item) cab
      from public.catmat_item_pdm m
     where m.nome_item is not null
       and ((m.codigo_pdm in (select codigo_pdm from ef)
             and m.codigo_item not in (select codigo_item from regras_item where not incluido))
            or m.codigo_item in (select codigo_item from regras_item where incluido))
  ),
  partes as (                       -- "MESA TÊNIS DE MESA / FUTMESA" -> partes; "BOLA HANDEBOL - FEMININA" -> base
    select i.*, p.parte from itens i
      cross join lateral regexp_split_to_table(i.nome_item, '\s/\s|/') p(parte)
     where i.efetivo and i.cab !~ '^(aparelho|equipamento)( |$)'
  ),
  cand as (
    select codigo_pdm, cab ancora, 'cabeca' origem, codigo_item, 0 fase, 0 ordem from itens where efetivo
    union all
    select codigo_pdm, public.catmat_norm_ancora(split_part(regexp_replace(parte, '\s-\s', '|', 'g'), '|', 1)), 'cabeca', codigo_item, 1, 0 from partes
    union all
    select codigo_pdm, public.catmat_norm_ancora(parte), 'cabeca', codigo_item, 1, 0 from partes
    union all
    select i.codigo_pdm, public.catmat_norm_ancora(a.valor),
           case when public.catmat_norm_ancora(a.atributo) = 'nome' then 'atributo_nome' else 'atributo_tipo' end,
           i.codigo_item, 2, a.ordem
      from itens i join public.catmat_item_atributo a on a.codigo_item = i.codigo_item
     where i.efetivo
       and ((public.catmat_norm_ancora(a.atributo) = 'nome'
             and public.catmat_norm_ancora(a.valor) !~ '^(aparelho|equipamento)( |$)'
             and array_length(regexp_split_to_array(public.catmat_norm_ancora(a.valor), ' '), 1) <= 5)
         or (public.catmat_norm_ancora(a.atributo) = 'tipo' and i.cab ~ '^(aparelho|equipamento)( |$)'
             and public.catmat_norm_ancora(a.valor) <> all (array['eletrica','eletrico','mecanica','mecanico','articulado','barra',
                   'escada','manual','simples','duplo','dupla','nao aplicavel','outros','outro','roda','caixa','transport','puxador',
                   'biceps','conjugado','extensor','argola','pedestal','abdominal','pelota','universal','profissional','infantil','adulto'])))
    union all
    select i.codigo_pdm,
           case when public.catmat_norm_ancora(a.atributo) = 'material'
                then i.cab || ' ' || array_to_string((regexp_split_to_array(public.catmat_norm_ancora(a.valor), ' '))[1:2], ' ')
                else public.catmat_norm_ancora(a.valor) end,
           'item_avulso', i.codigo_item, 2, a.ordem
      from itens i join public.catmat_item_atributo a on a.codigo_item = i.codigo_item
     where not i.efetivo and public.catmat_norm_ancora(a.atributo) in ('material', 'nome') and public.catmat_norm_ancora(a.valor) <> ''
  ),
  validas as (
    select * from cand
     where length(ancora) >= 4 and ancora !~ '^[0-9 ]+$'
       and ancora <> all (array['bola','mesa','estante','suporte','corda','cinto'])
       -- Marcelo, 03/10/2026 19:47 BRT: 'gangorra' (TIPO do item 353216, plataforma vibratória) não é âncora
       and ancora <> all (array['gangorra'])
       and not (fase = 1 and ancora ~ '^(aparelho|equipamento)( |$)')
  ),
  unicas as (
    select distinct on (v.codigo_pdm, v.ancora) v.codigo_pdm, v.ancora, v.origem, v.codigo_item
      from validas v order by v.codigo_pdm, v.ancora, v.codigo_item, v.fase, v.ordem
  ),
  cabecas as (select cab, array_agg(distinct codigo_pdm) pdms from itens group by cab)
  -- variante que é a cabeça inteira de OUTRO PDM fica com o outro (ex.: 'haltere' de 'HALTERE - USO PISCINA')
  select u.codigo_pdm, u.ancora, u.origem, u.codigo_item
    from unicas u left join cabecas c on c.cab = u.ancora
   where c.cab is null or u.codigo_pdm = any (c.pdms)
$$;

-- Dry-run (p_aplicar = false, padrão) ou aplicação. Não toca âncora manual; não reativa gerada que o admin desativou;
-- desativa gerada que deixou de sair (item excluído do catálogo, PDM fora etc.). Devolve o plano de ANTES de aplicar.
create or replace function public.catmat_gerar_ancoras(p_aplicar boolean default false)
returns table (acao text, codigo_pdm int, ancora text, origem text, codigo_item_origem int)
language plpgsql
set search_path = public, pg_catalog, pg_temp
as $$
begin
  return query
  with alvo as (select g.codigo_pdm, g.ancora, g.origem, g.codigo_item_origem from public.catmat_ancoras_geradas() g)
  select case
           when w.id is null then 'inserir'
           when w.origem = 'manual' then 'ja_existe_manual'
           when w.ativo then 'manter'
           else 'inativa_mantida'
         end, a.codigo_pdm, a.ancora, a.origem, a.codigo_item_origem
    from alvo a left join public.catmat_pdm_ancoras w on w.codigo_pdm = a.codigo_pdm and w.ancora = a.ancora
  union all
  select 'desativar', w.codigo_pdm, w.ancora, w.origem, w.codigo_item_origem
    from public.catmat_pdm_ancoras w
   where w.origem <> 'manual' and w.ativo
     and not exists (select 1 from public.catmat_ancoras_geradas() a where a.codigo_pdm = w.codigo_pdm and a.ancora = w.ancora)
  order by 2, 3;

  if p_aplicar then
    update public.catmat_pdm_ancoras w set ativo = false, updated_at = now()
     where w.origem <> 'manual' and w.ativo
       and not exists (select 1 from public.catmat_ancoras_geradas() a where a.codigo_pdm = w.codigo_pdm and a.ancora = w.ancora);
    insert into public.catmat_pdm_ancoras (codigo_pdm, ancora, palavras, origem, codigo_item_origem)
    select g.codigo_pdm, g.ancora, public.catmat_ancora_palavras(g.ancora), g.origem, g.codigo_item_origem
      from public.catmat_ancoras_geradas() g
     where cardinality(public.catmat_ancora_palavras(g.ancora)) >= 1
    on conflict on constraint catmat_pdm_ancoras_pdm_ancora_key do nothing;
  end if;
end
$$;

-- 4) RLS e ACL (mesmo modelo de catmat_item_pdm: authenticated lê; escrita e funções só service_role) ---------------
alter table public.catmat_item_atributo enable row level security;
drop policy if exists catmat_item_atributo_select on public.catmat_item_atributo;
create policy catmat_item_atributo_select on public.catmat_item_atributo for select to authenticated using (true);
alter table public.catmat_pdm_ancoras enable row level security;
drop policy if exists catmat_pdm_ancoras_select on public.catmat_pdm_ancoras;
create policy catmat_pdm_ancoras_select on public.catmat_pdm_ancoras for select to authenticated using (true);
revoke all on table public.catmat_item_atributo, public.catmat_pdm_ancoras, public.catmat_pdm_ancoras_nucleo from anon, authenticated, PUBLIC;
grant select on table public.catmat_item_atributo, public.catmat_pdm_ancoras to authenticated;
grant all on table public.catmat_item_atributo, public.catmat_pdm_ancoras to service_role;
grant select on table public.catmat_pdm_ancoras_nucleo to service_role;
revoke all on sequence public.catmat_pdm_ancoras_id_seq from anon, authenticated, PUBLIC;
grant all on sequence public.catmat_pdm_ancoras_id_seq to service_role;

revoke execute on function public.catmat_cabeca_descricao(text)               from PUBLIC, anon, authenticated;
revoke execute on function public.catmat_atributos_da_descricao(text)         from PUBLIC, anon, authenticated;
revoke execute on function public.catmat_norm_ancora(text)                    from PUBLIC, anon, authenticated;
revoke execute on function public.catmat_palavra_variantes(text)              from PUBLIC, anon, authenticated;
revoke execute on function public.catmat_texto_tokens(text)                   from PUBLIC, anon, authenticated;
revoke execute on function public.catmat_ancora_palavras(text)                from PUBLIC, anon, authenticated;
revoke execute on function public.catmat_itens_ancorados(bigint[])            from PUBLIC, anon, authenticated;
revoke execute on function public.catmat_item_atributo_sincronizar(int[])     from PUBLIC, anon, authenticated;
revoke execute on function public.catmat_ancoras_geradas()                    from PUBLIC, anon, authenticated;
revoke execute on function public.catmat_gerar_ancoras(boolean)              from PUBLIC, anon, authenticated;
grant execute on function public.catmat_cabeca_descricao(text)                to service_role;
grant execute on function public.catmat_atributos_da_descricao(text)          to service_role;
grant execute on function public.catmat_norm_ancora(text)                     to service_role;
grant execute on function public.catmat_palavra_variantes(text)               to service_role;
grant execute on function public.catmat_texto_tokens(text)                    to service_role;
grant execute on function public.catmat_ancora_palavras(text)                 to service_role;
grant execute on function public.catmat_itens_ancorados(bigint[])             to service_role;
grant execute on function public.catmat_item_atributo_sincronizar(int[])      to service_role;
grant execute on function public.catmat_ancoras_geradas()                     to service_role;
grant execute on function public.catmat_gerar_ancoras(boolean)               to service_role;

commit;
