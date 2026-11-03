-- LicitaGym: estimado × homologado, links da compra e filtros novos da /precos (spec 0031, fase A)
--
-- Contexto: a /precos mostra o preço homologado da Pesquisa de Preço do Compras.gov (precos_praticados_itens), mas
-- não o valor estimado nem o link da compra. A coleta nova (services/coletor-externo/coletor/compras_itens_contratacao.py)
-- busca, para cada compra do recorte de 24 meses, os itens na API 2.1 de contratações do Compras.gov
-- (2.1_consultarItensContratacoes_PNCP_14133_Id) e o link do portal oficial na consulta de compra do PNCP.
--
-- O que cria (aditiva):
--   public.precos_compras_contratacao   uma linha por compra consultada: nº de controle PNCP, CNPJ/ano/sequencial,
--                                       linkSistemaOrigem do PNCP e situação da consulta (encontrada ou não).
--   public.precos_itens_contratacao     uma linha por item da compra: estimado e resultado oficiais da API 2.1.
--   public.precos_compras_pendentes_contratacao(p_desde, p_limite)
--                                       compras do recorte ainda não consultadas, ou com atualização mais nova na fonte.
--   public.precos_praticados_recorte(...)   o recorte comum (PDM, período, item, UF, unidade, cidade, UASG, objeto,
--                                       busca livre), usado pelas três funções abaixo.
--   public.precos_praticados_amostras(...)  linhas do recorte com estimado, nº PNCP e link, paginadas, com o total.
--   public.precos_praticados_itens_pdm(...) itens do PDM com N > 0 no recorte (dropdown da /precos).
--   public.precos_praticados_municipios(...) cidades (UF e município) com preço no recorte (filtro Cidade).
-- O que muda:
--   public.precos_praticados_resumo     recriada com os filtros novos (com default) e três saídas novas: item com mais
--                                       amostras, n com estimado e mediana da diferença estimado → homologado (%).
--                                       A assinatura antiga de 6 parâmetros sai (DROP), porque o tipo de retorno muda;
--                                       única chamadora é a api-precos, republicada no mesmo merge, com os mesmos nomes
--                                       de parâmetro.
-- Higiene (spec 0031, Proposta 3; dado de produção medido em 21/10):
--   descricao_detalhada_item = '' (4.081 linhas de uma carga antiga) vira NULL; a coleta atual já não grava vazio.
--   A linha id_compra = 'ZZTESTE' (sobra de checagem rodada contra produção, sem raw nem PDM) é apagada. São dados
--   sem valor de fonte: não há backup a citar.
--
-- Filtros de texto (decisão de 21/10): sem acento e sem diferenciar maiúsculas (public.lg_normalizar); várias palavras
-- = todas presentes. Cidade compara o nome inteiro; UASG só de dígitos compara o código exato, texto procura no nome
-- da UASG ou do órgão; busca livre (p_q) procura em objeto, descrição do item, marca, fornecedor e nome da UASG
-- (nome de fornecedor pessoa física, NI com 11 dígitos, fica fora da busca: LGPD, decisão de 09/10).
-- Diferença (%): (homologado − estimado) / estimado × 100. A mediana é calculada sobre as diferenças sem arredondar e
-- arredondada a 2 casas, meio para longe do zero (round(numeric, 2)). Estimado nulo ou zero não entra.
--
-- ACL: tabelas com RLS ligada, sem policy, revoke all de anon/authenticated, grant a service_role (escritas pelo
-- coletor e lidas pela api-precos). Funções security invoker, search_path fixo, EXECUTE só service_role.
-- Verificação: supabase/tests/precos_itens_contratacao_check.sql e precos_praticados_higiene_check.sql.
-- Idempotente: if not exists, create or replace, drop if exists.

begin;

set local lock_timeout = '10s';

-- 1) Tabelas ---------------------------------------------------------------------------------------------------------

create table if not exists public.precos_compras_contratacao (
  id_compra text primary key,
  encontrada boolean not null,
  numero_controle_pncp text,
  orgao_entidade_cnpj text,
  ano_compra_pncp integer,
  sequencial_compra_pncp integer,
  link_sistema_origem text,
  data_hora_atualizacao_compra timestamptz,
  consultado_em timestamptz not null default now(),
  raw jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.precos_compras_contratacao is
  'Uma linha por compra da Pesquisa de Preço consultada na API 1.1/2.1 de contratações do Compras.gov e no PNCP '
  '(spec 0031). encontrada=false: a compra não está no PNCP (lei antiga ou sem publicação). link_sistema_origem é o '
  'linkSistemaOrigem que o PNCP mostra (null quando o PNCP não informa). data_hora_atualizacao_compra repete a da '
  'Pesquisa de Preço no momento da consulta, para reconsultar quando a fonte mudar. Escrita: coletor (service_role). '
  'Leitura: api-precos (service_role).';

create table if not exists public.precos_itens_contratacao (
  id_compra text not null,
  numero_item_compra integer not null,
  valor_unitario_estimado numeric(18, 4),
  valor_unitario_resultado numeric(18, 4),
  situacao_item text,
  tem_resultado boolean,
  numero_controle_pncp text,
  data_atualizacao_pncp timestamptz,
  raw jsonb,
  payload_hash text,
  last_synced_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (id_compra, numero_item_compra)
);

comment on table public.precos_itens_contratacao is
  'Estimado e resultado oficiais de cada item de compra (API 2.1_consultarItensContratacoes_PNCP_14133_Id do '
  'Compras.gov), para o estimado × homologado da /precos (spec 0031). A API devolve mais de uma linha por item; fica a '
  'com temResultado = true e, no empate, a de dataAtualizacaoPncp mais nova. Estimado 0 é gravado como NULL (ausente). '
  'Junta com precos_praticados_itens por (id_compra, numero_item_compra). Escrita: coletor. Leitura: api-precos.';

alter table public.precos_compras_contratacao enable row level security;
alter table public.precos_itens_contratacao enable row level security;

revoke all on table public.precos_compras_contratacao from public, anon, authenticated;
revoke all on table public.precos_itens_contratacao from public, anon, authenticated;
grant select, insert, update, delete on table public.precos_compras_contratacao to service_role;
grant select, insert, update, delete on table public.precos_itens_contratacao to service_role;

-- 2) Higiene da tabela atual -----------------------------------------------------------------------------------------

update public.precos_praticados_itens
   set descricao_detalhada_item = null, updated_at = now()
 where descricao_detalhada_item is not null and btrim(descricao_detalhada_item) = '';

delete from public.precos_praticados_itens where id_compra = 'ZZTESTE';

-- 3) Compras pendentes de consulta -----------------------------------------------------------------------------------

create or replace function public.precos_compras_pendentes_contratacao(p_desde date, p_limite integer default 500)
returns table (id_compra text, data_hora_atualizacao_compra timestamptz)
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  with compras as (
    select p.id_compra,
           max(p.data_hora_atualizacao_compra) as atualizacao,
           max(p.data_resultado) as ultima
      from public.precos_praticados_itens p
     where p.data_resultado >= p_desde
       and p.id_compra ~ '^[0-9]{17}$'
     group by p.id_compra
  )
  select c.id_compra, c.atualizacao
    from compras c
    left join public.precos_compras_contratacao k on k.id_compra = c.id_compra
   where k.id_compra is null
      or (c.atualizacao is not null and (k.data_hora_atualizacao_compra is null
                                         or k.data_hora_atualizacao_compra < c.atualizacao))
      -- não encontrada no PNCP: reconsulta depois de 30 dias (publicação tardia ou vazio passageiro da API)
      or (k.encontrada = false and k.consultado_em < now() - interval '30 days')
      -- encontrada, mas algum item com preço ainda sem resultado na API 2.1 (estava "Em andamento" na consulta):
      -- reconsulta depois de 7 dias, mesmo que a Pesquisa de Preço não tenha mudado
      or (k.encontrada = true and k.consultado_em < now() - interval '7 days'
          and exists (select 1
                        from public.precos_praticados_itens p2
                        left join public.precos_itens_contratacao i
                          on i.id_compra = p2.id_compra and i.numero_item_compra = p2.numero_item_compra
                       where p2.id_compra = c.id_compra
                         and coalesce(i.tem_resultado, false) = false))
   order by c.ultima desc, c.id_compra
   limit greatest(1, least(coalesce(p_limite, 500), 5000))
$$;

comment on function public.precos_compras_pendentes_contratacao(date, integer) is
  'Compras da Pesquisa de Preço com data_resultado >= p_desde ainda sem linha em precos_compras_contratacao, ou com '
  'data_hora_atualizacao_compra mais nova que a da última consulta, ou não encontradas no PNCP há mais de 30 dias, ou '
  'encontradas com item de preço ainda sem resultado na API 2.1 há mais de 7 dias. '
  'Mais recentes primeiro. Limite de 1 a 5000. '
  'EXECUTE só service_role (coletor). Spec 0031.';

-- 4) Recorte comum ---------------------------------------------------------------------------------------------------

create or replace function public.precos_texto_tem_todas(p_alvo text, p_termos text)
returns boolean
language sql
immutable
security invoker
set search_path = public, pg_temp
as $$
  select p_termos is null
      or btrim(p_termos) = ''
      or not exists (
           select 1
             from unnest(regexp_split_to_array(btrim(public.lg_normalizar(p_termos)), '\s+')) as t(termo)
            where t.termo <> ''
              and position(t.termo in public.lg_normalizar(p_alvo)) = 0
         )
$$;

comment on function public.precos_texto_tem_todas(text, text) is
  'true quando todas as palavras de p_termos aparecem em p_alvo, sem acento e sem diferenciar maiúsculas '
  '(lg_normalizar). p_termos vazio ou nulo -> true. EXECUTE só service_role. Spec 0031.';

create or replace function public.precos_praticados_recorte(
  p_pdm integer,
  p_inicio date,
  p_fim date,
  p_item integer default null,
  p_uf text default null,
  p_unidade text default null,
  p_municipio text default null,
  p_uasg text default null,
  p_objeto text default null,
  p_q text default null
)
returns setof public.precos_praticados_itens
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  select p.*
    from public.precos_praticados_itens p
   where p.codigo_pdm = p_pdm::text
     and p.data_resultado >= p_inicio
     and p.data_resultado <= p_fim
     and p.preco_unitario > 0
     and (p_item is null or p.codigo_item_catalogo = p_item)
     and (p_uf is null or p.estado = p_uf)
     and (p_unidade is null or p.sigla_unidade_fornecimento = p_unidade)
     and (p_municipio is null or btrim(p_municipio) = ''
          or public.lg_normalizar(btrim(p.municipio)) = public.lg_normalizar(btrim(p_municipio)))
     and (p_uasg is null or btrim(p_uasg) = ''
          or (btrim(p_uasg) ~ '^[0-9]+$' and p.codigo_uasg = btrim(p_uasg))
          or (btrim(p_uasg) !~ '^[0-9]+$'
              and (public.precos_texto_tem_todas(p.nome_uasg, p_uasg)
                   or public.precos_texto_tem_todas(p.nome_orgao, p_uasg))))
     and public.precos_texto_tem_todas(p.objeto_compra, p_objeto)
     and public.precos_texto_tem_todas(
           concat_ws(' ', p.objeto_compra, p.descricao_item, p.marca,
                     -- LGPD (decisão de 09/10): nome de pessoa física (CPF) não é buscável, como não é exibido
                     case when btrim(p.ni_fornecedor) ~ '^[0-9]{11}$' then null else p.nome_fornecedor end,
                     p.nome_uasg), p_q)
$$;

comment on function public.precos_praticados_recorte(integer, date, date, integer, text, text, text, text, text, text) is
  'Recorte da /precos: PDM, data_resultado em [p_inicio, p_fim], preço > 0 e filtros opcionais de item, UF, unidade '
  'de fornecimento (sigla), cidade (nome inteiro), UASG (código exato ou texto no nome da UASG/órgão), objeto e busca '
  'livre (todas as palavras, sem acento). Usado por resumo, amostras e itens. EXECUTE só service_role. Spec 0031.';

-- 5) Amostras --------------------------------------------------------------------------------------------------------

create or replace function public.precos_praticados_amostras(
  p_pdm integer,
  p_inicio date,
  p_fim date,
  p_item integer default null,
  p_uf text default null,
  p_unidade text default null,
  p_municipio text default null,
  p_uasg text default null,
  p_objeto text default null,
  p_q text default null,
  p_offset integer default 0,
  p_limit integer default 20
)
returns table (
  id_compra text,
  id_item_compra bigint,
  numero_item_compra integer,
  codigo_item_catalogo integer,
  codigo_pdm text,
  data_resultado date,
  data_compra date,
  codigo_uasg text,
  nome_uasg text,
  codigo_orgao integer,
  nome_orgao text,
  estado text,
  municipio text,
  esfera text,
  poder text,
  modalidade integer,
  forma text,
  criterio_julgamento text,
  percentual_maior_desconto numeric,
  quantidade numeric,
  preco_unitario numeric,
  sigla_unidade_fornecimento text,
  nome_unidade_fornecimento text,
  sigla_unidade_medida text,
  nome_unidade_medida text,
  marca text,
  nome_fornecedor text,
  ni_fornecedor text,
  objeto_compra text,
  descricao_item text,
  descricao_detalhada_item text,
  compra_consultada boolean,
  compra_encontrada boolean,
  numero_controle_pncp text,
  orgao_entidade_cnpj text,
  ano_compra_pncp integer,
  sequencial_compra_pncp integer,
  link_sistema_origem text,
  valor_unitario_estimado numeric,
  total bigint
)
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  with r as (
    select p.*, count(*) over () as total
      from public.precos_praticados_recorte(p_pdm, p_inicio, p_fim, p_item, p_uf, p_unidade, p_municipio, p_uasg,
                                            p_objeto, p_q) p
  )
  select r.id_compra, r.id_item_compra, r.numero_item_compra, r.codigo_item_catalogo, r.codigo_pdm,
         r.data_resultado, r.data_compra, r.codigo_uasg, r.nome_uasg, r.codigo_orgao, r.nome_orgao, r.estado,
         r.municipio, r.esfera, r.poder, r.modalidade, r.forma, r.criterio_julgamento, r.percentual_maior_desconto,
         r.quantidade, r.preco_unitario, r.sigla_unidade_fornecimento, r.nome_unidade_fornecimento,
         r.sigla_unidade_medida, r.nome_unidade_medida, r.marca, r.nome_fornecedor, r.ni_fornecedor,
         r.objeto_compra, r.descricao_item, r.descricao_detalhada_item,
         (k.id_compra is not null),
         k.encontrada,
         k.numero_controle_pncp,
         k.orgao_entidade_cnpj,
         k.ano_compra_pncp,
         k.sequencial_compra_pncp,
         k.link_sistema_origem,
         -- estimado só de compra consultada e encontrada no PNCP (item antigo de uma compra que passou a vir vazia
         -- não vale)
         case when k.encontrada and i.valor_unitario_estimado > 0 then i.valor_unitario_estimado end,
         r.total
    from r
    left join public.precos_compras_contratacao k on k.id_compra = r.id_compra
    left join public.precos_itens_contratacao i
           on i.id_compra = r.id_compra and i.numero_item_compra = r.numero_item_compra
   order by r.data_resultado desc nulls last, r.id_compra asc, r.id_item_compra asc
  offset greatest(0, coalesce(p_offset, 0))
   limit greatest(1, least(coalesce(p_limit, 20), 100))
$$;

comment on function public.precos_praticados_amostras(integer, date, date, integer, text, text, text, text, text, text, integer, integer) is
  'Linhas do recorte da /precos (precos_praticados_recorte) com a compra consultada no PNCP (nº de controle, '
  'CNPJ/ano/sequencial, linkSistemaOrigem) e o estimado oficial do item (null quando ausente ou 0), por '
  'data_resultado desc, id_compra, id_item_compra. total = linhas do recorte inteiro. limit de 1 a 100. '
  'EXECUTE só service_role (api-precos). Spec 0031.';

-- 6) Itens do PDM com N ----------------------------------------------------------------------------------------------

create or replace function public.precos_praticados_itens_pdm(
  p_pdm integer,
  p_inicio date,
  p_fim date,
  p_uf text default null,
  p_unidade text default null,
  p_municipio text default null,
  p_uasg text default null,
  p_objeto text default null,
  p_q text default null
)
returns table (codigo_item_catalogo integer, descricao text, n integer)
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  select distinct on (x.codigo_item_catalogo) x.codigo_item_catalogo, x.descricao, x.n
    from (
      select p.codigo_item_catalogo,
             p.descricao_item as descricao,
             count(*) over (partition by p.codigo_item_catalogo)::int as n,
             p.data_resultado
        from public.precos_praticados_recorte(p_pdm, p_inicio, p_fim, null, p_uf, p_unidade, p_municipio, p_uasg,
                                              p_objeto, p_q) p
       where p.codigo_item_catalogo is not null
    ) x
   order by x.codigo_item_catalogo, x.data_resultado desc nulls last, x.descricao asc nulls last
$$;

comment on function public.precos_praticados_itens_pdm(integer, date, date, text, text, text, text, text, text) is
  'Itens de catálogo do PDM com ao menos um preço no recorte (n > 0 por construção), com a descrição do preço mais '
  'recente e o n. O filtro de item não se aplica (é a lista para escolher o item). A api-precos ordena por n desc. '
  'EXECUTE só service_role (api-precos). Spec 0031.';

-- 6b) Cidades do recorte (lista do filtro Cidade) -------------------------------------------------------------------

create or replace function public.precos_praticados_municipios(
  p_pdm integer,
  p_inicio date,
  p_fim date,
  p_item integer default null,
  p_uf text default null,
  p_unidade text default null,
  p_uasg text default null,
  p_objeto text default null,
  p_q text default null
)
returns table (uf text, municipio text, n integer)
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  -- uma linha por cidade como o filtro compara (sem acento, sem diferenciar maiúsculas); o nome mostrado é a grafia
  -- mais frequente na fonte (empate: a menor)
  select p.estado, mode() within group (order by btrim(p.municipio)), count(*)::int
    from public.precos_praticados_recorte(p_pdm, p_inicio, p_fim, p_item, p_uf, p_unidade, null, p_uasg,
                                          p_objeto, p_q) p
   where p.estado is not null and nullif(btrim(p.municipio), '') is not null
   group by p.estado, public.lg_normalizar(btrim(p.municipio))
   order by p.estado, count(*) desc, 2
$$;

comment on function public.precos_praticados_municipios(integer, date, date, integer, text, text, text, text, text) is
  'Cidades com preço no recorte da /precos (uma por UF e nome sem acento; mostra a grafia mais frequente), com o n; o '
  'filtro de cidade não se aplica (é a lista para escolher a cidade). Lista do filtro Cidade (spec 0031, Proposta 7). '
  'EXECUTE só service_role (api-precos).';

-- 7) Resumo com filtros novos e KPIs ---------------------------------------------------------------------------------

drop function if exists public.precos_praticados_resumo(integer, date, date, integer, text, text);

create or replace function public.precos_praticados_resumo(
  p_pdm integer,
  p_inicio date,
  p_fim date,
  p_item integer default null,
  p_uf text default null,
  p_unidade text default null,
  p_municipio text default null,
  p_uasg text default null,
  p_objeto text default null,
  p_q text default null
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
  atualizado_em timestamptz,
  unidades jsonb,
  item_mais_codigo integer,
  item_mais_descricao text,
  item_mais_n integer,
  n_com_estimado integer,
  diferenca_mediana_percentual numeric
)
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  with base as (
    select p.id_compra,
           p.numero_item_compra,
           p.preco_unitario::numeric as v,
           p.sigla_unidade_fornecimento,
           p.nome_unidade_fornecimento,
           p.data_resultado,
           p.last_synced_at
      from public.precos_praticados_recorte(p_pdm, p_inicio, p_fim, p_item, p_uf, p_unidade, p_municipio, p_uasg,
                                            p_objeto, p_q) p
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
  por_nome as (
    select b.sigla_unidade_fornecimento as sigla, b.nome_unidade_fornecimento as nome, count(*)::int as c
      from base b
     group by 1, 2
  ),
  por_sigla as (
    select distinct on (x.sigla) x.sigla, x.nome, sum(x.c) over (partition by x.sigla)::int as n
      from por_nome x
     order by x.sigla, x.c desc, x.nome asc nulls last
  ),
  unidade as (
    select ps.sigla, ps.nome, ps.n as c
      from por_sigla ps
     where ps.sigla is not null
     order by ps.n desc, ps.sigla asc
     limit 1
  ),
  lista as (
    select coalesce(jsonb_agg(jsonb_build_object('sigla', ps.sigla, 'nome', ps.nome, 'n', ps.n)
                              order by ps.n desc, ps.sigla asc nulls last), '[]'::jsonb) as unidades
      from por_sigla ps
  ),
  item_mais as (
    -- no recorte sem o filtro de item (decisão de 21/10: o KPI diz qual item tem mais amostras no PDM filtrado)
    select i.codigo_item_catalogo, i.descricao, i.n
      from public.precos_praticados_itens_pdm(p_pdm, p_inicio, p_fim, p_uf, p_unidade, p_municipio, p_uasg,
                                              p_objeto, p_q) i
     order by i.n desc, i.codigo_item_catalogo asc
     limit 1
  ),
  dif as (
    select count(*)::int as n_est,
           array_agg((b.v - c.valor_unitario_estimado) / c.valor_unitario_estimado * 100
                     order by (b.v - c.valor_unitario_estimado) / c.valor_unitario_estimado) as ordenadas
      from base b
      join public.precos_itens_contratacao c
        on c.id_compra = b.id_compra and c.numero_item_compra = b.numero_item_compra
      join public.precos_compras_contratacao k
        on k.id_compra = b.id_compra and k.encontrada
     where c.valor_unitario_estimado > 0
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
         a.atualizado,
         l.unidades,
         im.codigo_item_catalogo,
         im.descricao,
         im.n,
         d.n_est,
         case when d.n_est >= 3 then round(public.precos_percentil_linear(d.ordenadas, 0.50), 2) end
    from agg a
    cross join lista l
    cross join dif d
    left join unidade u on true
    left join item_mais im on true
$$;

comment on function public.precos_praticados_resumo(integer, date, date, integer, text, text, text, text, text, text) is
  'Resumo dos preços homologados (Pesquisa de Preço Compras.gov) do recorte da /precos (precos_praticados_recorte). '
  'Sempre uma linha. Média e percentis: round(numeric, 2), meio para longe do zero; n < 3 -> null com motivo. Mín/máx '
  'como vieram. item_mais_*: item com mais preços no recorte sem o filtro de item. diferenca_mediana_percentual: '
  'mediana de (homologado − estimado) / estimado × 100 das linhas com estimado oficial > 0, 2 casas, só com '
  'n_com_estimado >= 3. EXECUTE só service_role (api-precos). Specs 0009 e 0031.';

-- 8) ACL das funções -------------------------------------------------------------------------------------------------

revoke all on function public.precos_compras_pendentes_contratacao(date, integer) from public, anon, authenticated;
revoke all on function public.precos_texto_tem_todas(text, text) from public, anon, authenticated;
revoke all on function public.precos_praticados_recorte(integer, date, date, integer, text, text, text, text, text, text) from public, anon, authenticated;
revoke all on function public.precos_praticados_amostras(integer, date, date, integer, text, text, text, text, text, text, integer, integer) from public, anon, authenticated;
revoke all on function public.precos_praticados_itens_pdm(integer, date, date, text, text, text, text, text, text) from public, anon, authenticated;
revoke all on function public.precos_praticados_municipios(integer, date, date, integer, text, text, text, text, text) from public, anon, authenticated;
revoke all on function public.precos_praticados_resumo(integer, date, date, integer, text, text, text, text, text, text) from public, anon, authenticated;

grant execute on function public.precos_compras_pendentes_contratacao(date, integer) to service_role;
grant execute on function public.precos_texto_tem_todas(text, text) to service_role;
grant execute on function public.precos_praticados_recorte(integer, date, date, integer, text, text, text, text, text, text) to service_role;
grant execute on function public.precos_praticados_amostras(integer, date, date, integer, text, text, text, text, text, text, integer, integer) to service_role;
grant execute on function public.precos_praticados_itens_pdm(integer, date, date, text, text, text, text, text, text) to service_role;
grant execute on function public.precos_praticados_municipios(integer, date, date, integer, text, text, text, text, text) to service_role;
grant execute on function public.precos_praticados_resumo(integer, date, date, integer, text, text, text, text, text, text) to service_role;

commit;
