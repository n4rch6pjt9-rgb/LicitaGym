-- LicitaGym: resumo de preços praticados com filtro de período (spec 0009, CA-2)
--
-- Contexto: a Edge Function nova api-precos (action=resumo) mostra, para um PDM do catálogo da empresa, as
-- estatísticas dos preços homologados da Pesquisa de Preço do Compras.gov (public.precos_praticados_itens) nos
-- últimos 12 ou 24 meses. A view v_bi_precos_praticados não filtra período nem UF, e usa percentile_cont, que
-- calcula em double precision. Esta migration cria o cálculo determinístico no banco.
--
-- O que cria (aditiva; não toca em tabela nem em view existente):
--   public.precos_percentil_linear(numeric[], numeric)
--       percentil por interpolação linear entre as posições vizinhas da lista ORDENADA (mesma definição do
--       percentile_cont: posição 1 + p*(n-1)), em numeric exato. Lista vazia -> null.
--   public.precos_praticados_resumo(p_pdm, p_inicio, p_fim, p_item, p_uf)
--       uma linha, sempre: n, média, mín, p25, mediana, p75, máx, motivo, unidade de fornecimento predominante
--       (sigla, nome e contagem), última data_resultado e max(last_synced_at) do recorte.
--
-- Recorte: codigo_pdm (texto da fonte) = p_pdm; data_resultado entre p_inicio e p_fim (inclusive); preco_unitario
-- > 0 (nulo ou zero não é preço); p_item filtra codigo_item_catalogo; p_uf filtra estado. Quem calcula o período
-- (12 ou 24 meses até hoje em Brasília) é a api-precos; a função recebe as datas.
--
-- Arredondamento (escrito, AGENTS.md): média e percentis com round(numeric, 2), isto é, 2 casas, meio para longe do
-- zero (15,005 -> 15,01), a mesma regra de centavos() em api-pncp-pca/radar.ts. Mín e máx saem como vieram da fonte
-- (numeric(18,4)), sem arredondar.
-- n < 3: média e quartis null, com motivo; n = 0: tudo null, com motivo.
--
-- ACL: security invoker, search_path fixo, EXECUTE só service_role (a api-precos chama depois de requireUserAuth).
-- Quem lê: api-precos. Quem escreve: ninguém (só leitura).
-- Verificação: supabase/tests/precos_praticados_resumo_check.sql. Idempotente (create or replace).

begin;

set local lock_timeout = '10s';

create or replace function public.precos_percentil_linear(p_ordenados numeric[], p_fracao numeric)
returns numeric
language sql
immutable
security invoker
set search_path = pg_catalog, pg_temp
as $$
  select case
    when p_ordenados is null or cardinality(p_ordenados) = 0 or p_fracao is null or p_fracao < 0 or p_fracao > 1
      then null
    else p_ordenados[floor(1 + p_fracao * (cardinality(p_ordenados) - 1))::int]
         + ((1 + p_fracao * (cardinality(p_ordenados) - 1)) - floor(1 + p_fracao * (cardinality(p_ordenados) - 1)))
         * (p_ordenados[ceil(1 + p_fracao * (cardinality(p_ordenados) - 1))::int]
            - p_ordenados[floor(1 + p_fracao * (cardinality(p_ordenados) - 1))::int])
  end
$$;

comment on function public.precos_percentil_linear(numeric[], numeric) is
  'Percentil por interpolação linear (definição do percentile_cont: posição 1 + p*(n-1)) em numeric exato. '
  'Recebe a lista já ordenada. Lista vazia -> null. EXECUTE só service_role. Spec 0009.';

create or replace function public.precos_praticados_resumo(
  p_pdm integer,
  p_inicio date,
  p_fim date,
  p_item integer default null,
  p_uf text default null
)
returns table (
  n integer,
  media numeric,
  preco_min numeric,
  p25 numeric,
  mediana numeric,
  p75 numeric,
  preco_max numeric,
  motivo text,
  unidade_sigla text,
  unidade_nome text,
  unidade_n integer,
  ultima_data_resultado date,
  atualizado_em timestamptz
)
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  with base as (
    select p.preco_unitario::numeric as v,
           p.sigla_unidade_fornecimento,
           p.nome_unidade_fornecimento,
           p.data_resultado,
           p.last_synced_at
      from public.precos_praticados_itens p
     where p.codigo_pdm = p_pdm::text
       and p.data_resultado >= p_inicio
       and p.data_resultado <= p_fim
       and p.preco_unitario > 0
       and (p_item is null or p.codigo_item_catalogo = p_item)
       and (p_uf is null or p.estado = p_uf)
  ),
  agg as (
    select count(*)::int as n,
           array_agg(v order by v) as ordenados,
           avg(v) as media,
           min(v) as vmin,
           max(v) as vmax,
           max(data_resultado) as ultima,
           max(last_synced_at) as atualizado
      from base
  ),
  unidade as (
    select b.sigla_unidade_fornecimento as sigla, b.nome_unidade_fornecimento as nome, count(*)::int as c
      from base b
     group by 1, 2
     order by c desc, sigla asc nulls last, nome asc nulls last
     limit 1
  )
  select a.n,
         case when a.n >= 3 then round(a.media, 2) end,
         a.vmin,
         case when a.n >= 3 then round(public.precos_percentil_linear(a.ordenados, 0.25), 2) end,
         case when a.n >= 3 then round(public.precos_percentil_linear(a.ordenados, 0.50), 2) end,
         case when a.n >= 3 then round(public.precos_percentil_linear(a.ordenados, 0.75), 2) end,
         a.vmax,
         case when a.n = 0 then 'Sem preços homologados no recorte.'
              when a.n < 3 then 'Menos de 3 preços no recorte: média e quartis não são calculados.'
         end,
         u.sigla,
         u.nome,
         u.c,
         a.ultima,
         a.atualizado
    from agg a
    left join unidade u on true
$$;

comment on function public.precos_praticados_resumo(integer, date, date, integer, text) is
  'Resumo dos preços homologados (Pesquisa de Preço Compras.gov) de um PDM no período [p_inicio, p_fim] por '
  'data_resultado, com filtros opcionais de item e UF. Sempre uma linha. Média e percentis: round(numeric, 2), meio '
  'para longe do zero; n < 3 -> null com motivo. Mín/máx como vieram. EXECUTE só service_role (api-precos). Spec 0009.';

revoke all on function public.precos_percentil_linear(numeric[], numeric) from public, anon, authenticated;
revoke all on function public.precos_praticados_resumo(integer, date, date, integer, text) from public, anon, authenticated;
grant execute on function public.precos_percentil_linear(numeric[], numeric) to service_role;
grant execute on function public.precos_praticados_resumo(integer, date, date, integer, text) to service_role;

commit;
