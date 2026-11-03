-- =============================================================================
-- CATMAT — a chave que falta (catmat_itens) + fonte da verdade consolidada
-- =============================================================================
--
-- POR QUE NÃO É UMA MIGRATION AINDA
-- As tabelas catmat_* existem no banco mas em nenhuma migration do repo (drift).
-- Colocar este arquivo em supabase/migrations/ quebraria `db reset`, porque ele
-- referencia tabelas que nenhuma migration cria. Ele vira 202609180016_*.sql
-- assim que a 202609180015 (reconciliação do drift) existir.
-- Até lá: rode manualmente no banco, onde as tabelas existem.
--
-- NOMES DE COLUNA — origem e confiança
-- Agora derivados dos DTOs oficiais do Swagger (compras_gov_schemas.json):
-- DmMaterialGrupoDTO, DmMaterialClasseDTO, DmMaterialPDMDTO, DmMaterialItemDTO,
-- DmMaterialUnidadeFornecimentoDTO, DmMaterialNaturezaDespesaDTO,
-- DmMaterialCaracteristicasDTO — convertidos para snake_case.
--
-- Os nomes de COLUNA LOCAL vêm de docs/pncp/schemas-consultas.md (seções 1.x e
-- 3.1), que mapeia campo da API -> coluna da tabela. O DTO diz o que a API
-- devolve; ele NÃO é o nome da coluna. Os dois divergem de propósito:
--   DmMaterialNaturezaDespesaDTO.nomeNaturezaDespesa -> coluna `descricao`
--   numeroSequencialUnidadeFornecimento              -> coluna `numero_sequencial`
--   nomeGrupo / nomeClasse                           -> coluna `nome` nas duas
--   statusUnidadeFornecimentoPdm                     -> coluna `status`
-- E dois campos do DTO NÃO são persistidos na v1:
--   siglaUnidadeMedida e capacidadeUnidadeFornecimento em catmat_pdm_unidades.
-- Referenciá-los aqui quebraria a matview — por isso ficam de fora.
--
-- VALIDAÇÃO JÁ FEITA
-- Executado em PostgreSQL 16.13 contra um fixture com a hierarquia mínima
-- (grupo 78 / classe 7830 / PDM / unidades / natureza) e a linha real de
-- catmat_item_caracteristicas (item 287851). Confirmado: o arquivo roda do
-- zero, é idempotente na reexecução, o REFRESH CONCURRENTLY funciona, o filtro
-- regex descarta codigo_catmat não numérico, e nome de característica repetido
-- no mesmo item NÃO quebra o jsonb_object_agg (o último vence em `taxonomias`;
-- `caracteristicas` preserva os três). O que o fixture NÃO prova são os nomes
-- de coluna marcados [?], que vieram do levantamento em prosa.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 1. catmat_itens — a entidade que falta
-- -----------------------------------------------------------------------------
-- Hoje o código de item existe SÓ dentro de catmat_item_caracteristicas. Não há
-- tabela de item, logo não há aresta item → PDM, logo grupo/classe/PDM não se
-- ligam às características de jeito nenhum. Esta é a chave que falta — não uma
-- tabela de junção, mas a entidade central do catálogo.
--
-- Fonte autoritativa: endpoint de consulta de itens do módulo
-- "01 - CATÁLOGO - MATERIAL" (Dados Abertos Compras). Enquanto o sync não existe,
-- o bootstrap abaixo popula o que dá a partir do que já está no banco.

-- Espelha DmMaterialItemDTO campo a campo. O DTO confirma que a entidade existe
-- na API e que ela carrega a hierarquia inteira já desnormalizada.
CREATE TABLE IF NOT EXISTS public.catmat_itens (
  codigo_item               bigint PRIMARY KEY,     -- DTO: int64
  codigo_grupo              bigint,
  nome_grupo                text,
  codigo_classe             bigint,
  nome_classe               text,
  codigo_pdm                text,                   -- ver nota 7: o tipo varia por módulo
  nome_pdm                  text,
  descricao_item            text,
  status_item               boolean NOT NULL DEFAULT true,
  item_sustentavel          boolean,
  codigo_ncm                text,
  descricao_ncm             text,
  aplica_margem_preferencia boolean,
  data_hora_atualizacao     timestamptz,
  origem                    text NOT NULL DEFAULT 'api'
                            CHECK (origem IN ('api', 'bootstrap_catalogo',
                                              'bootstrap_caracteristica', 'bootstrap_preco')),
  payload_hash              text,
  last_synced_at            timestamptz,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS catmat_itens_pdm_idx ON public.catmat_itens (codigo_pdm);

ALTER TABLE public.catmat_itens ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS catmat_itens_select ON public.catmat_itens;
CREATE POLICY catmat_itens_select ON public.catmat_itens
  FOR SELECT TO authenticated USING (true);

COMMENT ON TABLE public.catmat_itens IS
  'Item CATMAT. Fecha a aresta item -> PDM, sem a qual características e '
  'hierarquia grupo/classe/PDM não se conectam. Fonte: Dados Abertos Compras.';
COMMENT ON COLUMN public.catmat_itens.origem IS
  'api = sync oficial; bootstrap_* = inferido enquanto o sync não existe';


-- -----------------------------------------------------------------------------
-- 2. Bootstrap — popular sem esperar o sync
-- -----------------------------------------------------------------------------
-- 2a. Itens curados que já têm PDM em catalogo_itens.
--     ATENÇÃO: codigo_item é integer e codigo_catmat é text sem padding
--     normalizado. Se o export do app HTML zerou à esquerda, o cast falha ou
--     não casa. O filtro ~ '^[0-9]+$' evita erro de cast em lixo.
INSERT INTO public.catmat_itens (codigo_item, codigo_pdm, descricao_item, origem)
SELECT ci.codigo_catmat::bigint, ci.codigo_pdm, ci.descricao, 'bootstrap_catalogo'
FROM public.catalogo_itens ci
WHERE ci.codigo_catmat ~ '^[0-9]+$'
  AND ci.codigo_pdm IS NOT NULL
ON CONFLICT (codigo_item) DO UPDATE
  SET codigo_pdm     = COALESCE(EXCLUDED.codigo_pdm, public.catmat_itens.codigo_pdm),
      descricao_item = COALESCE(EXCLUDED.descricao_item, public.catmat_itens.descricao_item),
      updated_at     = now();

-- 2b. Itens que só aparecem nas características — entram sem PDM, para ficarem
--     visíveis como lacuna em vez de sumirem da consolidação.
INSERT INTO public.catmat_itens (codigo_item, origem)
SELECT DISTINCT c.codigo_item, 'bootstrap_caracteristica'
FROM public.catmat_item_caracteristicas c
ON CONFLICT (codigo_item) DO NOTHING;


-- -----------------------------------------------------------------------------
-- 3. catmat_item_completo — a fonte da verdade consolidada
-- -----------------------------------------------------------------------------
-- MATERIALIZED VIEW, não tabela: as tabelas-fonte já são a verdade. Uma cópia
-- física precisaria do próprio sync e poderia divergir em silêncio. A matview
-- é physical, indexável e consultável como tabela, mas reconstrói do original.
--
-- Uma linha por item. Características são 1:N, então vão agregadas em jsonb.

DROP MATERIALIZED VIEW IF EXISTS public.catmat_item_completo;

CREATE MATERIALIZED VIEW public.catmat_item_completo AS
WITH carac AS (
  SELECT
    c.codigo_item,
    -- Lossless: preserva ordem, códigos e a unidade DA CARACTERÍSTICA
    -- (que é MM/W/V — não é unidade de fornecimento; ver docs/pncp/cruzamentos.md)
    jsonb_agg(
      jsonb_build_object(
        'numero',          c.numero_caracteristica,
        'codigo',          c.codigo_caracteristica,
        'nome',            c.nome_caracteristica,
        'codigo_valor',    c.codigo_valor_caracteristica,
        'valor',           c.nome_valor_caracteristica,
        'unidade_medida',  c.sigla_unidade_medida
      ) ORDER BY c.numero_caracteristica
    ) AS caracteristicas,
    -- Best-effort para consumo direto (formato de catalogo_itens.taxonomias).
    -- Nome de característica repetido no mesmo item sobrescreve: use o array
    -- acima quando precisar de fidelidade.
    jsonb_object_agg(c.nome_caracteristica, c.nome_valor_caracteristica)
      FILTER (WHERE c.nome_caracteristica IS NOT NULL) AS taxonomias,
    count(*) AS qtd_caracteristicas
  FROM public.catmat_item_caracteristicas c
  WHERE c.status IS DISTINCT FROM false
  GROUP BY c.codigo_item
),
unidades AS (
  SELECT
    u.codigo_pdm,
    -- Só colunas da v1. A API também devolve siglaUnidadeMedida e
    -- capacidadeUnidadeFornecimento ("UN com capacidade 2 KG"), que ainda não
    -- são persistidas — quando forem, entram aqui.
    jsonb_agg(jsonb_build_object(
      'sigla',     u.sigla_unidade_fornecimento,
      'nome',      u.nome_unidade_fornecimento,
      'descricao', u.descricao_unidade_fornecimento
    ) ORDER BY u.numero_sequencial) AS unidades_fornecimento
  FROM public.catmat_pdm_unidades u
  GROUP BY u.codigo_pdm
),
naturezas AS (
  SELECT
    n.codigo_pdm,
    jsonb_agg(jsonb_build_object(
      'codigo', n.codigo_natureza_despesa, 'descricao', n.descricao
    )) AS naturezas_despesa
  FROM public.catmat_pdm_naturezas_despesa n
  GROUP BY n.codigo_pdm
)
SELECT
  i.codigo_item,
  i.descricao_item,
  i.status_item                   AS item_ativo,
  i.origem                        AS item_origem,

  p.codigo_pdm,
  COALESCE(p.nome_pdm, i.nome_pdm)                AS nome_pdm,
  COALESCE(cl.codigo_classe, i.codigo_classe)     AS codigo_classe,
  COALESCE(cl.nome, i.nome_classe)                AS nome_classe,
  COALESCE(p.codigo_grupo, g.codigo_grupo, i.codigo_grupo) AS codigo_grupo,
  COALESCE(g.nome, i.nome_grupo)                  AS nome_grupo,
  i.codigo_ncm,
  i.item_sustentavel,

  COALESCE(un.unidades_fornecimento, '[]'::jsonb) AS unidades_fornecimento,
  COALESCE(nd.naturezas_despesa,     '[]'::jsonb) AS naturezas_despesa,
  COALESCE(ca.caracteristicas,       '[]'::jsonb) AS caracteristicas,
  COALESCE(ca.taxonomias,            '{}'::jsonb) AS taxonomias,
  COALESCE(ca.qtd_caracteristicas, 0)             AS qtd_caracteristicas,

  -- Ponte com a curadoria local (não sobrescrita pelo sync oficial)
  ci.id                   AS catalogo_item_id,
  ci.categoria_licitagym,
  ci.candidato_fitness,

  -- Diagnóstico de completude — o que ainda falta ligar
  (p.codigo_pdm IS NULL)          AS sem_pdm,
  (ca.codigo_item IS NULL)        AS sem_caracteristica,
  (un.codigo_pdm IS NULL)         AS sem_unidade_fornecimento,
  (nd.codigo_pdm IS NULL)         AS sem_natureza_despesa,

  now() AS refreshed_at
FROM public.catmat_itens i
LEFT JOIN public.catmat_pdms     p  ON p.codigo_pdm    = i.codigo_pdm
LEFT JOIN public.catmat_classes  cl ON cl.codigo_classe = COALESCE(p.codigo_classe, i.codigo_classe)
LEFT JOIN public.catmat_grupos   g  ON g.codigo_grupo   = COALESCE(p.codigo_grupo, cl.codigo_grupo, i.codigo_grupo)
LEFT JOIN carac      ca ON ca.codigo_item = i.codigo_item
LEFT JOIN unidades   un ON un.codigo_pdm  = i.codigo_pdm
LEFT JOIN naturezas  nd ON nd.codigo_pdm  = i.codigo_pdm
LEFT JOIN public.catalogo_itens ci
       ON ci.codigo_catmat ~ '^[0-9]+$'
      AND ci.codigo_catmat::bigint = i.codigo_item;

-- UNIQUE é obrigatório para REFRESH CONCURRENTLY
CREATE UNIQUE INDEX catmat_item_completo_pk
  ON public.catmat_item_completo (codigo_item);
CREATE INDEX catmat_item_completo_pdm_idx
  ON public.catmat_item_completo (codigo_pdm);
CREATE INDEX catmat_item_completo_classe_idx
  ON public.catmat_item_completo (codigo_classe);
CREATE INDEX catmat_item_completo_fitness_idx
  ON public.catmat_item_completo (candidato_fitness)
  WHERE candidato_fitness;

COMMENT ON MATERIALIZED VIEW public.catmat_item_completo IS
  'Fonte da verdade consolidada do CATMAT: uma linha por item, com hierarquia '
  'grupo/classe/PDM, unidades de fornecimento, naturezas de despesa e '
  'características agregadas. Reconstruída de catmat_*; não escrever aqui.';


-- -----------------------------------------------------------------------------
-- 4. Refresh — chamar ao fim de cada sync CATMAT
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.refresh_catmat_item_completo()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  REFRESH MATERIALIZED VIEW CONCURRENTLY public.catmat_item_completo;
EXCEPTION
  -- CONCURRENTLY falha se a matview nunca foi populada
  WHEN object_not_in_prerequisite_state THEN
    REFRESH MATERIALIZED VIEW public.catmat_item_completo;
END;
$$;

REVOKE ALL ON FUNCTION public.refresh_catmat_item_completo() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.refresh_catmat_item_completo() TO service_role;

-- MV fora da Data API: sem RLS; só service_role (advisor 0016).
REVOKE ALL ON public.catmat_item_completo FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.catmat_item_completo TO service_role;


-- -----------------------------------------------------------------------------
-- 5. Conferir o resultado
-- -----------------------------------------------------------------------------
-- SELECT count(*) FILTER (WHERE NOT sem_pdm)                 AS com_pdm,
--        count(*) FILTER (WHERE sem_pdm)                     AS sem_pdm,
--        count(*) FILTER (WHERE NOT sem_caracteristica)      AS com_caracteristica,
--        count(*) FILTER (WHERE NOT sem_unidade_fornecimento) AS com_unidade,
--        count(*)                                            AS total
-- FROM public.catmat_item_completo;


-- -----------------------------------------------------------------------------
-- NOTA 7 — codigoPdm NÃO TEM TIPO ÚNICO NA API
-- -----------------------------------------------------------------------------
-- Conferido em compras_gov_schemas.json, o mesmo campo muda de tipo por módulo:
--   DmMaterialPDMDTO.codigoPdm                  integer / int64
--   DmMaterialItemDTO.codigoPdm                 integer / int64
--   DmMaterialUnidadeFornecimentoDTO.codigoPdm  integer / int64
--   DmMaterialNaturezaDespesaDTO.codigoPdm      integer / int64
--   FtPesqPrecoCompraMaterialDTO.codigoPdm      STRING
--   VwFtPNCPCompraItemDTO.codigoPdm             STRING
--   VwFtArpUnidadesItemDTO.codigoPdm            STRING
--   VwFtArpItemDTO.codigoPdm                    integer / int32
-- Por isso codigo_pdm é `text` em todo lugar aqui: text absorve as duas formas.
-- O risco real é zero à esquerda — '0123' vindo de um módulo não casa com 123
-- vindo de outro. Normalize na entrada (ltrim(x,'0') ou ::bigint::text) e
-- aplique a MESMA normalização dos dois lados de qualquer junção por PDM.

-- -----------------------------------------------------------------------------
-- NOTA 8 — catmat_classes tem UNIQUE COMPOSTO, não PK em codigo_classe
-- -----------------------------------------------------------------------------
-- Conforme schemas-consultas.md 3.1:
--   catmat_classes (id uuid PK, codigo_grupo FK, codigo_classe, nome,
--                   UNIQUE (codigo_grupo, codigo_classe))
-- O join acima usa só codigo_classe. Funciona na prática porque o código da
-- classe embute o grupo ('7830' -> grupo '78'), mas não é o que a constraint
-- garante. Se algum dia aparecer a mesma classe em dois grupos, o join duplica
-- linhas na matview. O CREATE UNIQUE INDEX em codigo_item faria o REFRESH
-- estourar — o que é bom: falha alto em vez de silenciosa.
