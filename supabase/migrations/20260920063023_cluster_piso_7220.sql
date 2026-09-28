-- Recuperado de supabase_migrations.schema_migrations em 2026-09-28 (aplicado no remoto sem arquivo no repo).
-- Nao reaplicar: versao ja registrada como aplicada.

WITH mat AS (
  SELECT
    c.codigo_item::text AS codigo_catmat,
    string_agg(DISTINCT upper(trim(c.nome_valor_caracteristica)), ' | '
      ORDER BY upper(trim(c.nome_valor_caracteristica))) AS materiais
  FROM public.catmat_item_caracteristicas c
  JOIN public.catalogo_itens i
    ON i.codigo_catmat = c.codigo_item::text
   AND i.ativo
  WHERE i.classe_catmat = '7220'
    AND upper(c.nome_caracteristica) LIKE 'MATERIAL%'
  GROUP BY 1
),
tagged AS (
  SELECT
    i.id,
    i.codigo_catmat,
    i.codigo_pdm,
    m.materiais,
    CASE
      WHEN i.codigo_pdm IN ('757', '10779', '14647', '12550', '10782', '18481')
        THEN 'trigo_pdm'
      WHEN i.codigo_pdm IN ('758', '745', '789', '16135', '18253')
        THEN 'joio_pdm'
      ELSE 'outros_pdm'
    END AS cluster_pdm,
    CASE
      WHEN coalesce(m.materiais, '') ~ 'BORRACHA|EPDM|SBR|EVA'
        THEN 'borracha'
      WHEN coalesce(m.materiais, '') ~ 'POLIPROPILENO|POLIETILENO|PVC|VIN[IÍ]L'
        THEN 'sintetico'
      WHEN coalesce(m.materiais, '') ~ 'N[AÁ]ILON|POLI[EÉ]STER|ALGOD|JUTA|SISAL|COCO|ACR[IÍ]LICO|TUFTING'
        THEN 'tecido'
      WHEN coalesce(m.materiais, '') ~ 'PORCELANATO|GRANITO|ARD[OÓ]SIA|CER[AÂ]MICA|M[AÁ]RMORE|CONCRETO|CIMENTO'
        THEN 'pedra'
      ELSE 'indefinido'
    END AS subtipo_material
  FROM public.catalogo_itens i
  LEFT JOIN mat m ON m.codigo_catmat = i.codigo_catmat
  WHERE i.ativo
    AND i.classe_catmat = '7220'
),
trigo AS (
  SELECT
    id,
    codigo_catmat,
    materiais,
    CASE
      WHEN subtipo_material = 'borracha' THEN 'borracha'
      WHEN subtipo_material = 'sintetico' THEN 'sintetico'
      WHEN codigo_pdm = '12550' THEN 'borracha'
      WHEN codigo_pdm IN ('14647', '18481') THEN 'modular'
      WHEN codigo_pdm = '10782' THEN 'resina'
      ELSE 'piso'
    END AS subtipo
  FROM tagged
  WHERE cluster_pdm = 'trigo_pdm'
    AND subtipo_material IN ('borracha', 'sintetico', 'indefinido')
)
UPDATE public.catalogo_itens AS ci
SET
  categoria_licitagym = 'piso',
  candidato_fitness = true,
  fonte_curadoria = 'cluster_7220_v1',
  taxonomias = coalesce(ci.taxonomias, '{}'::jsonb) || jsonb_build_object(
    'cluster', 'trigo',
    'subtipo', t.subtipo,
    'material_catmat', coalesce(t.materiais, ''),
    'classe_origem', '7220'
  )
FROM trigo t
WHERE ci.id = t.id;

WITH mat AS (
  SELECT
    c.codigo_item::text AS codigo_catmat,
    string_agg(DISTINCT upper(trim(c.nome_valor_caracteristica)), ' | '
      ORDER BY upper(trim(c.nome_valor_caracteristica))) AS materiais
  FROM public.catmat_item_caracteristicas c
  JOIN public.catalogo_itens i
    ON i.codigo_catmat = c.codigo_item::text
   AND i.ativo
  WHERE i.classe_catmat = '7220'
    AND upper(c.nome_caracteristica) LIKE 'MATERIAL%'
  GROUP BY 1
),
tagged AS (
  SELECT
    i.id,
    i.codigo_pdm,
    CASE
      WHEN i.codigo_pdm IN ('757', '10779', '14647', '12550', '10782', '18481')
        THEN 'trigo_pdm'
      WHEN i.codigo_pdm IN ('758', '745', '789', '16135', '18253')
        THEN 'joio_pdm'
      ELSE 'outros_pdm'
    END AS cluster_pdm,
    CASE
      WHEN coalesce(m.materiais, '') ~ 'BORRACHA|EPDM|SBR|EVA'
        THEN 'borracha'
      WHEN coalesce(m.materiais, '') ~ 'POLIPROPILENO|POLIETILENO|PVC|VIN[IÍ]L'
        THEN 'sintetico'
      WHEN coalesce(m.materiais, '') ~ 'N[AÁ]ILON|POLI[EÉ]STER|ALGOD|JUTA|SISAL|COCO|ACR[IÍ]LICO|TUFTING'
        THEN 'tecido'
      WHEN coalesce(m.materiais, '') ~ 'PORCELANATO|GRANITO|ARD[OÓ]SIA|CER[AÂ]MICA|M[AÁ]RMORE|CONCRETO|CIMENTO'
        THEN 'pedra'
      ELSE 'indefinido'
    END AS subtipo_material
  FROM public.catalogo_itens i
  LEFT JOIN mat m ON m.codigo_catmat = i.codigo_catmat
  WHERE i.ativo
    AND i.classe_catmat = '7220'
),
joio AS (
  SELECT id, subtipo_material
  FROM tagged
  WHERE
    cluster_pdm = 'joio_pdm'
    OR (cluster_pdm = 'trigo_pdm' AND subtipo_material IN ('pedra', 'tecido'))
    OR cluster_pdm = 'outros_pdm'
)
UPDATE public.catalogo_itens AS ci
SET
  fonte_curadoria = CASE
    WHEN ci.fonte_curadoria IN ('manual', 'import-catmat-curadoria') THEN ci.fonte_curadoria
    ELSE 'cluster_7220_v1'
  END,
  taxonomias = coalesce(ci.taxonomias, '{}'::jsonb) || jsonb_build_object(
    'cluster', 'joio',
    'subtipo_material', j.subtipo_material,
    'classe_origem', '7220'
  )
FROM joio j
WHERE ci.id = j.id
  AND (ci.categoria_licitagym IS DISTINCT FROM 'piso');

COMMENT ON COLUMN public.catalogo_itens.fonte_curadoria IS
  'Origem da curadoria: manual | import-catmat-curadoria | cluster_7220_v1 | sync Compras.gov';
