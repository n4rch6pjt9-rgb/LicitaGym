# Schemas para consultas — Compras.gov.br × LicitaGym

Referência para montar queries SQL e chamadas à API **Dados Abertos Compras.gov.br**.

- **Fonte Swagger (DTOs):** `compras_gov_schemas.json` (OpenAPI components)
- **Base URL:** `https://dadosabertos.compras.gov.br`
- **Escopo LicitaGym:** classe CORE **78/7830**. Extensões curadas na mesma lista: **72/7220**, **78/7810** e **93/9320**. Essa lista alimenta o sync CATMAT, o `link-catmat-pca`, o `pcaItemScope` e o sync de órgãos. O download do PCA (`defaultPcaClassificacoes` / `PNCP_PCA_CLASSIFICACOES`) permanece só **7830**.
- **Matriz de contratos:** [`docs/pncp/contract-matrix.md`](../pncp/contract-matrix.md)
- **Mapa de cruzamentos:** [`docs/pncp/cruzamentos.md`](../pncp/cruzamentos.md)

---

## Envelope de resposta (todos os endpoints paginados)

| Campo API | Tipo | Descrição |
|-----------|------|-----------|
| `resultado` | `array` | Itens da página |
| `totalRegistros` | `int64` | Total no filtro |
| `totalPaginas` | `int64` | Páginas totais |
| `paginasRestantes` | `int64` | Páginas após a atual |

**Query params comuns**

| Param | Tipo | Observação |
|-------|------|------------|
| `pagina` | int | Obrigatório em vários endpoints |
| `tamanhoPagina` | int | Intervalo **10–500**; sync LicitaGym e a árvore usam default **100** (`clampComprasGovPageSize`) |
| `statusGrupo` / `statusClasse` / `statusPdm` / `statusItem` | boolean | `true` = somente ativos (padrão do sync LicitaGym) |

**Contagens validadas (classe 7830, mar/2026)**

| Filtro | PDMs | Itens |
|--------|------|-------|
| Somente ativos (`status*=true`) | 49 | 594 |
| Todos (sem filtro de status) | 53 | 646 |

**Contagens oficiais (classe 7220, 2026-09-19, API Dados Abertos)**

| Filtro | PDMs | Itens |
|--------|------|-------|
| Somente ativos (`status*=true`) | 14 | ~1133 |

Classe 7220 = REVESTIMENTOS PARA PISOS (grupo 72). Entra no catálogo para curadoria; **não** amplia o download do PCA.

Classes **7810** (grupo 78) e **9320** (grupo 93) estão na mesma lista fixa, como extensão curada. O sync CATMAT por classe, o link e o sync de órgãos passam a considerá-las. O download do PCA não. Não há, neste repositório, contagem oficial de PDMs ou itens da classe inteira: a conferência de 03/10/2026 mediu o catálogo da empresa (15 PDMs em 7810, com 209 itens ativos faltando no espelho; em 9320 só o PDM 9461 está no catálogo). O job por classe puxa a classe inteira, inclusive PDM excluído do catálogo.

---

## 1. CATÁLOGO — MATERIAL (endpoints 1–7)

### 1.1 Grupo — `DmMaterialGrupoDTO`

**GET** `/modulo-material/1_consultarGrupoMaterial`

| Campo API | Tipo | Postgres `catmat_grupos` |
|-----------|------|--------------------------|
| `codigoGrupo` | int64 | `codigo_grupo` PK |
| `nomeGrupo` | string | `nome` |
| `statusGrupo` | boolean | `status` |
| `dataHoraAtualizacao` | date-time | `data_atualizacao_origem` |

---

### 1.2 Classe — `DmMaterialClasseDTO`

**GET** `/modulo-material/2_consultarClasseMaterial`

| Campo API | Tipo | Postgres `catmat_classes` |
|-----------|------|---------------------------|
| `codigoGrupo` | int64 | `codigo_grupo` FK |
| `codigoClasse` | int64 | `codigo_classe` |
| `nomeGrupo` | string | *(denormalizado na API; não persistido)* |
| `nomeClasse` | string | `nome` |
| `statusClasse` | boolean | `status` |
| `dataHoraAtualizacao` | date-time | `data_atualizacao_origem` |

**Chave natural:** `(codigo_grupo, codigo_classe)`

---

### 1.3 PDM — `DmMaterialPDMDTO`

**GET** `/modulo-material/3_consultarPdmMaterial`

| Campo API | Tipo | Postgres `catmat_pdms` |
|-----------|------|------------------------|
| `codigoPdm` | int64 | `codigo_pdm` PK |
| `codigoGrupo` | int64 | `codigo_grupo` |
| `codigoClasse` | int64 | `codigo_classe` |
| `nomePdm` | string | `nome_pdm` |
| `statusPdm` | boolean | `status` |
| `dataHoraAtualizacao` | date-time | `data_atualizacao_origem` |

**Filtro LicitaGym:** `codigoGrupo=78`, `codigoClasse=7830` (fitness). Segundo recorte do catálogo: `codigoGrupo=72`, `codigoClasse=7220` (pisos, curadoria).

---

### 1.4 Item — `DmMaterialItemDTO`

**GET** `/modulo-material/4_consultarItemMaterial`

| Campo API | Tipo | Postgres |
|-----------|------|----------|
| `codigoItem` | int64 | `catalogo_itens.codigo_catmat` (text) |
| `codigoPdm` | int64 | `catalogo_itens.codigo_pdm` |
| `codigoGrupo` | int64 | `catalogo_itens.grupo_catmat` |
| `codigoClasse` | int64 | `catalogo_itens.classe_catmat` |
| `descricaoItem` | string | `catalogo_itens.descricao` |
| `statusItem` | boolean | `catalogo_itens.ativo` |
| `itemSustentavel` | boolean | *(não persistido v1)* |
| `codigo_ncm` | string | *(não persistido v1)* |
| `descricao_ncm` | string | *(não persistido v1)* |
| `aplica_margem_preferencia` | boolean | *(não persistido v1)* |
| `dataHoraAtualizacao` | date-time | *(via payload_hash / sync)* |

**Campos derivados em `catalogo_itens`**

| Coluna | Origem |
|--------|--------|
| `tipo` | constante `'material'` |
| `fonte_curadoria` | `'compras.gov.br'` no sync automático |
| `taxonomias` | parse de `descricaoItem` (`TIPO:`, `MATERIAL:`, etc.) |
| `categoria_licitagym` | curadoria manual (`import-catmat-curadoria`) |

**Chave natural catálogo:** `codigo_catmat` = `String(codigoItem)`

---

### 1.5 Natureza de despesa — `DmMaterialNaturezaDespesaDTO`

**GET** `/modulo-material/5_consultarMaterialNaturezaDespesa?codigoPdm={id}`

| Campo API | Tipo | Postgres `catmat_pdm_naturezas_despesa` |
|-----------|------|----------------------------------------|
| `codigoPdm` | int64 | `codigo_pdm` FK |
| `codigoNaturezaDespesa` | string | `codigo_natureza_despesa` |
| `nomeNaturezaDespesa` | string | `descricao` |
| `statusNaturezaDespesa` | **string** (`"0"`/`"1"`) | `status` (boolean normalizado no sync) |

**Nota:** para classe **7830**, a API retorna **0 registros** por PDM ativo (comportamento observado em mar/2026). A tabela pode ficar vazia mesmo com sync correto.

**Chave natural:** `(codigo_pdm, codigo_natureza_despesa)`

---

### 1.6 Unidade de fornecimento — `DmMaterialUnidadeFornecimentoDTO`

**GET** `/modulo-material/6_consultarMaterialUnidadeFornecimento?codigoPdm={id}`

| Campo API | Tipo | Postgres `catmat_pdm_unidades` |
|-----------|------|--------------------------------|
| `codigoPdm` | int64 | `codigo_pdm` FK |
| `siglaUnidadeFornecimento` | string | `sigla_unidade_fornecimento` |
| `nomeUnidadeFornecimento` | string | `nome_unidade_fornecimento` |
| `descricaoUnidadeFornecimento` | string | `descricao_unidade_fornecimento` |
| `numeroSequencialUnidadeFornecimento` | int32 | `numero_sequencial` |
| `siglaUnidadeMedida` | string | *(não persistido v1)* |
| `capacidadeUnidadeFornecimento` | number | *(não persistido v1)* |
| `statusUnidadeFornecimentoPdm` | boolean | `status` |
| `dataHoraAtualizacao` | date-time | `last_synced_at` |

**Chave natural:** `(codigo_pdm, sigla_unidade_fornecimento, numero_sequencial)`

**Uso em cotações:** preferir esta tabela antes de criar `unidades_medida` genérica — já traz equivalências oficiais por PDM.

---

### 1.7 Características — `DmMaterialCaracteristicasDTO`

**GET** `/modulo-material/7_consultarMaterialCaracteristicas?codigoItem={id}`

| Campo API | Tipo | Postgres `catmat_item_caracteristicas` |
|-----------|------|----------------------------------------|
| `codigoItem` | int64 | `codigo_item` |
| `codigoCaracteristica` | string | `codigo_caracteristica` |
| `nomeCaracteristica` | string | `nome_caracteristica` |
| `codigoValorCaracteristica` | string | `codigo_valor_caracteristica` |
| `nomeValorCaracteristica` | string | `nome_valor_caracteristica` |
| `numeroCaracteristica` | int32 | `numero_caracteristica` |
| `siglaUnidadeMedida` | string | `sigla_unidade_medida` |
| `statusCaracteristica` | boolean | `status` (combinado com valor no sync) |
| `statusValorCaracteristica` | boolean | idem |
| `dataHoraAtualizacao` | date-time | `last_synced_at` |

**Chave natural:** `(codigo_item, codigo_caracteristica, codigo_valor_caracteristica)`

---

## 2. Pesquisa de preço — material (`FtPesqPrecoCompraMaterialDTO`)

Útil para **cotações** e benchmark de preços. Ainda **não ingerido** no Postgres LicitaGym — consulta direta à API.

**DTO principal:** `FtPesqPrecoCompraMaterialDTO`
**Detalhe:** `FtPesqPrecoCompraMaterialDetalheDTO`

| Campo API | Tipo | Uso |
|-----------|------|-----|
| `idCompra` | int64 | Identificador da compra |
| `idItemCompra` / `numeroItemCompra` | int | Item dentro da compra |
| `codigoItemCatalogo` | int32 | **CATMAT** (`codigoItem`) |
| `codigoPdm` | string | PDM |
| `codigoClasse` | int32 | Classe CATMAT |
| `descricaoItem` | string | Descrição resumida |
| `descricaoDetalhadaItem` | string | Descrição expandida |
| `objetoCompra` | string | Objeto da licitação/compra |
| `quantidade` | number | Quantidade homologada |
| `precoUnitario` | number | Preço unitário |
| `siglaUnidadeFornecimento` | string | Unidade de fornecimento |
| `nomeUnidadeFornecimento` | string | Nome da unidade |
| `siglaUnidadeMedida` | string | Unidade de medida |
| `dataCompra` | date | Data da compra |
| `dataResultado` | date | Data do resultado |
| `niFornecedor` / `nomeFornecedor` | string | Fornecedor |
| `codigoUasg` / `nomeUasg` | string | UASG compradora |
| `codigoOrgao` / `nomeOrgao` | string | Órgão |
| `estado` / `municipio` | string | Localização |
| `modalidade` | int32 | Código modalidade |
| `marca` | string | Marca informada |

**Join futuro sugerido:** `codigoItemCatalogo` → `catalogo_itens.codigo_catmat`

---

## 3. Tabelas Postgres — resumo para SQL

### 3.1 Hierarquia CATMAT (`catmat_*`)

```sql
-- Grupo
catmat_grupos (codigo_grupo PK, nome, status, data_atualizacao_origem, payload_hash, ...)

-- Classe
catmat_classes (id uuid PK, codigo_grupo FK, codigo_classe, nome, status, UNIQUE(codigo_grupo, codigo_classe))

-- PDM
catmat_pdms (codigo_pdm PK, codigo_grupo, codigo_classe, nome_pdm, status, ...)

-- Enriquecimento
catmat_pdm_naturezas_despesa (id uuid, codigo_pdm FK, codigo_natureza_despesa, descricao, ...)
catmat_pdm_unidades (id uuid, codigo_pdm FK, sigla_unidade_fornecimento, numero_sequencial, ...)
catmat_item_caracteristicas (id uuid, codigo_item, codigo_caracteristica, codigo_valor_caracteristica, ...)
```

### 3.2 Catálogo unificado

```sql
catalogo_itens (
  id uuid PK,
  codigo_catmat text UNIQUE,   -- codigoItem Compras.gov
  codigo_pdm text,
  grupo_catmat text,           -- '78'
  classe_catmat text,          -- '7830'
  descricao text NOT NULL,
  tipo text,                   -- 'material'
  unidade_medida text,
  ativo boolean,
  categoria_licitagym text,    -- musculacao | cardio | acessorios (manual)
  candidato_fitness boolean,
  taxonomias jsonb,
  fonte_curadoria text,        -- 'compras.gov.br' | 'manual'
  payload_hash text,
  ...
)

catalogo_ponte (
  catalogo_item_id FK,
  entidade_tipo text,          -- 'pca_item' | 'irp_item' | 'contratacao_item'
  entidade_id uuid,
  tipo_correspondencia text,   -- 'exata' | 'provavel' | 'incerta'
  evidencia text
)
```

Junções entre domínios (FK, lógicas, PCA↔PDM, lacunas): [`docs/pncp/cruzamentos.md`](../pncp/cruzamentos.md).

### 3.3 PCA (PNCP)

```sql
pca_planos (
  id uuid PK,
  id_pca_pncp text UNIQUE,     -- ex.: 06740278000181-0-000005/2026
  ano_exercicio int,
  orgao_cnpj text,
  titulo, descricao, status text,
  data_aprovacao date,
  data_publicacao date,
  ...
)

pca_itens (
  id uuid PK,
  pca_plano_id FK,
  numero_item int,               -- sequência DENTRO do plano (≠ codigo_pdm)
  descricao text,
  categoria text,
  classe_material_servico text,  -- código PNCP (7830 = classe CATMAT fitness)
  codigo_classe_catmat int,      -- classe explícita (backfill de classe_material_servico)
  quantidade numeric,
  unidade_medida text,
  valor_unitario_estimado numeric,
  valor_total_estimado numeric,
  data_prevista_contratacao date,
  prioridade text,
  status text,
  payload_hash text,
  UNIQUE (pca_plano_id, numero_item)
)
```

### 3.4 Provenance (schema `private`)

```sql
private.pncp_sync_run       -- execuções de sync (resource_type = 'compras_catmat', 'pca', ...)
private.pncp_sync_request   -- log HTTP por página
private.source_record       -- payload bruto JSONB
private.pncp_period_anchor  -- checkpoint Search API PCA
```

---

## 4. Consultas SQL prontas

### 4.1 Validação pós-sync CATMAT 7830

```sql
SELECT count(*) AS pdms_ativos
FROM catmat_pdms
WHERE codigo_classe = 7830 AND status = true;

SELECT count(*) AS itens_catalogo
FROM catalogo_itens
WHERE classe_catmat = '7830' AND ativo = true;

SELECT count(*) AS caracteristicas
FROM catmat_item_caracteristicas c
JOIN catalogo_itens i ON i.codigo_catmat = c.codigo_item::text
WHERE i.classe_catmat = '7830';
```

### 4.2 Item CATMAT com PDM, unidades e características

```sql
SELECT
  i.codigo_catmat,
  i.descricao,
  p.nome_pdm,
  u.sigla_unidade_fornecimento,
  u.nome_unidade_fornecimento,
  c.nome_caracteristica,
  c.nome_valor_caracteristica
FROM catalogo_itens i
JOIN catmat_pdms p ON p.codigo_pdm = i.codigo_pdm::int
LEFT JOIN catmat_pdm_unidades u ON u.codigo_pdm = p.codigo_pdm
LEFT JOIN catmat_item_caracteristicas c
  ON c.codigo_item = i.codigo_catmat::int
WHERE i.codigo_catmat = '623742'  -- substituir
ORDER BY c.numero_caracteristica NULLS LAST;
```

### 4.3 PCA classe 7830 com ponte ao catálogo

```sql
SELECT
  pl.id_pca_pncp,
  pl.orgao_cnpj,
  pi.numero_item,
  pi.descricao AS descricao_pca,
  pi.unidade_medida,
  pi.quantidade,
  pi.valor_unitario_estimado,
  to_char(pi.data_prevista_contratacao, 'DD/MM/YYYY') AS data_prevista_br,
  cp.tipo_correspondencia,
  ci.codigo_catmat,
  ci.descricao AS descricao_catmat
FROM pca_itens pi
JOIN pca_planos pl ON pl.id = pi.pca_plano_id
LEFT JOIN catalogo_ponte cp
  ON cp.entidade_tipo = 'pca_item' AND cp.entidade_id = pi.id
LEFT JOIN catalogo_itens ci ON ci.id = cp.catalogo_item_id
WHERE pi.classe_material_servico = '7830'
  AND pi.ativo = true
ORDER BY pl.ano_exercicio DESC, pl.orgao_cnpj, pi.numero_item;
```

> Cruzamentos PCA↔PDM (candidatos por classe, `pca_item_pdm`, curadoria): [`cruzamentos.md` §G](../pncp/cruzamentos.md#g-pca--catmat--estado-validado-mar2026).

### 4.4 PCA sem correspondência no catálogo

```sql
SELECT pi.id, pi.descricao, pi.unidade_medida
FROM pca_itens pi
LEFT JOIN catalogo_ponte cp
  ON cp.entidade_tipo = 'pca_item' AND cp.entidade_id = pi.id
WHERE pi.classe_material_servico = '7830'
  AND pi.ativo = true
  AND cp.id IS NULL;
```

### 4.5 Busca textual (atual — sem coluna normalizada)

```sql
SELECT codigo_catmat, descricao, categoria_licitagym
FROM catalogo_itens
WHERE classe_catmat = '7830'
  AND ativo = true
  AND upper(unaccent(descricao)) LIKE upper(unaccent('%halter%'))
ORDER BY descricao;
```

> Requer extensão `unaccent` habilitada. Após migration de normalização, preferir `descricao_normalizada`.

### 4.6 Unidades oficiais por PDM (para padronizar PCA)

```sql
SELECT DISTINCT
  p.codigo_pdm,
  p.nome_pdm,
  u.sigla_unidade_fornecimento,
  u.nome_unidade_fornecimento
FROM catmat_pdms p
JOIN catmat_pdm_unidades u ON u.codigo_pdm = p.codigo_pdm
WHERE p.codigo_classe = 7830
ORDER BY p.nome_pdm, u.sigla_unidade_fornecimento;
```

### 4.7 Diagnóstico de valores distintos (PCA — fase 1 normalização)

```sql
-- Unidades distintas no PCA
SELECT unidade_medida, count(*) AS n
FROM pca_itens
WHERE ativo = true
GROUP BY 1
ORDER BY n DESC;

-- Status / prioridade / categoria
SELECT status, count(*) FROM pca_itens GROUP BY 1;
SELECT prioridade, count(*) FROM pca_itens GROUP BY 1;
SELECT categoria, count(*) FROM pca_itens GROUP BY 1;

-- Datas e valores
SELECT count(*) FILTER (WHERE data_prevista_contratacao IS NULL) AS sem_data,
       count(*) FILTER (WHERE quantidade < 0) AS qty_neg,
       count(*) FILTER (WHERE valor_unitario_estimado < 0) AS val_neg
FROM pca_itens;
```

---

## 5. Regras de tipos e formatação

| Domínio | Armazenar | Exibir |
|---------|-----------|--------|
| Datas de negócio (`data_prevista_contratacao`) | `date` | `to_char(..., 'DD/MM/YYYY')` na query/UI |
| Auditoria (`created_at`, `last_synced_at`) | `timestamptz` | ISO 8601 / locale |
| Valores monetários | `numeric` | formatar na aplicação |
| Quantidades | `numeric` | validar `>= 0` |
| Códigos CATMAT/PDM | `text` ou `int` conforme tabela | sem zeros à esquerda perdidos |
| `payload_hash` | hash do **payload original** da API | nunca do texto normalizado |

---

## 6. Normalização proposta (`pca_itens`) — roadmap

**Princípio:** não sobrescrever dados originais sincronizados do PNCP. Separar valor recebido, valor para busca e valor padronizado.

### 6.1 Colunas sugeridas (migration futura)

| Coluna | Tipo | Função |
|--------|------|--------|
| `descricao` | text | Valor original PNCP |
| `descricao_normalizada` | text | UPPER, trim, sem acentos — busca/comparação |
| `unidade_medida` | text | Valor original (renomear mentalmente para `unidade_medida_original`) |
| `unidade_medida_codigo` | text | Sigla padronizada (`UN`, `KG`, …) |
| `categoria_normalizada` | text | Domínio controlado |
| `prioridade_normalizada` | text | Domínio controlado |
| `status_normalizado` | text | Domínio controlado |

### 6.2 Unidades — reutilizar catálogo existente

Antes de criar `unidades_medida` global:

1. **`catmat_pdm_unidades`** — unidades oficiais por PDM (Compras.gov)
2. **`catalogo_ponte`** — ligar item PCA → item CATMAT
3. Tabela de equivalência (`UN` = `UND` = `UNIDADE`) só para resíduos não cobertos

### 6.3 Pipeline de ingestão (sync)

1. Persistir payload original → `payload_hash`
2. Calcular colunas `*_normalizada` / `*_codigo` no upsert
3. Não alterar curadoria manual (`fonte_curadoria = 'manual'`)

### 6.4 Ordem de implementação

1. Diagnóstico (queries §4.7)
2. Colunas normalizadas (sem DROP de originais)
3. Tabelas de domínio (status, prioridade, unidades)
4. Backfill
5. Ajuste Edge Functions de sync
6. Formatação apenas na camada de apresentação

---

## 7. Mapa rápido API → sync → tabela

| Endpoint | Edge Function | Tabela(s) |
|----------|---------------|-----------|
| 1 Grupo | `sync-compras-catmat` | `catmat_grupos` |
| 2 Classe | idem | `catmat_classes` |
| 3 PDM | idem | `catmat_pdms` |
| 4 Item | idem | `catalogo_itens` |
| 5 Natureza | idem | `catmat_pdm_naturezas_despesa` |
| 6 Unidade | idem | `catmat_pdm_unidades` |
| 7 Características | idem (lotes) | `catmat_item_caracteristicas` |
| PCA Consulta | `sync-pncp-pca` | `pca_planos`, `pca_itens` |
| Ponte PCA↔CATMAT | `link-catmat-pca` | `catalogo_ponte` |

---

## 8. Referências

- [Swagger CATÁLOGO MATERIAL](https://dadosabertos.compras.gov.br/swagger-ui/index.html#/01%20-%20CAT%C3%81LOGO%20-%20MATERIAL)
- DTOs locais: `supabase/functions/_shared/compras-gov/material-types.ts`
- Mapa de cruzamentos: [`docs/pncp/cruzamentos.md`](../pncp/cruzamentos.md)
- Migrations: `supabase/migrations/202609180007_catalogo.sql`, `202609180015_catmat_compras.sql`, `202609180004_pca.sql`
- Script sync: `scripts/invoke-sync-compras-catmat.ps1`
