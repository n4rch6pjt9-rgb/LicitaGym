# Schemas do Dados Abertos Compras.gov.br

Versão: **2026-09-19** | Análise completa em [../catalogo-perguntas.md](../catalogo-perguntas.md)

## Conteúdo

- **schemas-inventory.md** — inventário dos 78 DTOs com contagens de campo e status de transcrição
- **dto-errors-2026-09-19.md** — erros críticos, transcrição, anomalias de nomenclatura e tipo (BLOCOS 1-38)
- **bridges-consolidados.md** — 5 caminhos de integração: PCA → PNCP, PNCP → CATMAT, ARP → PNCP, subrogação, ORG-01/02
- **fix-pca-bridge-v1.md** — correção normalizePcaItem: recuperar codigoPdm, codigoItem, numeroControlePncp
- **escopo-materiais-academia.md** — filtrar Bridge 2 por piso, borracha, PVC (não 113 PDMs genéricos)
- **pncp-integracao-v3-api-docs-2026-10-09.json**: OpenAPI da integração PNCP (`/pncp-api/v3/api-docs`, produção). O do treina é idêntico, exceto pelos `example` de data
- **pncp-consulta-v3-api-docs-2026-10-09.json**: OpenAPI da consulta PNCP (`/api/consulta/v3/api-docs`)
- **compras-dadosabertos-v3-api-docs-2026-10-09.json**: OpenAPI do Dados Abertos Compras.gov.br (`/v3/api-docs`)
  Os três são de 09/10/2026; origem, SHA-256 e comparação em [../avaliacao-apis-pca-2026-10.md](../avaliacao-apis-pca-2026-10.md)
- **schemas.json** — definiçõesJSON Schema (quando versionado)

## Propósito

Versionar o lastro da API Compras.gov.br para:

1. **Evitar perda de informação** — schemas hoje existem só no histórico de conversa
2. **Apoiar decisões de schema** — sem versionamento, toda mudança vira arqueologia
3. **Rastrear divergências** — quando a API muda, divergência com este repo é sinal de alarme
4. **Suportar manutenção de catálogo** — campos do DTO definem o que é respondível

## Estrutura

```
202609180004_pncp.sql        ← Migrations do banco
schemas-consultas.md          ← 8 DTOs mapeados campo→coluna Postgres
catalogo-perguntas.md         ← Perguntas respondíveis + seus bloqueios
openapi/README.md             ← Este arquivo
openapi/schemas-inventory.md  ← 78 DTOs: contagem, tipo, status
openapi/dto-errors.md         ← Erros críticos do esquema
```

## Como se mantém

### Quando a API muda

1. Comparar novo dump vs versão atual em `schemas-inventory.md`
2. Atualizar inventário
3. Verificar impacto em `catalogo-perguntas.md` — mudanças de campo podem reclassificar perguntas
4. Se novo DTO responde a pergunta do catálogo, validar no catálogo e catalogar em
   `schemas-consultas.md`

### Adição de DTO ao catálogo

1. Ler de `schemas-inventory.md`
2. Mapear campos na forma de `schemas-consultas.md` §1.x
3. Adicionar `(não persistido)` onde houver
4. Atualizar `catalogo-perguntas.md` para reclassificar perguntas bloqueadas por aquele DTO

## Nota sobre a análise 2026-09-19

Análise completa dos BLOCOS 1-38 (380 DTOs → 78-80 entidades únicas). Achados principais:

### Erros estruturais e transcrição
- **3 erros críticos OCDS** — AwardDTO nesting, ItemDTO type, ReleaseDTO contamination
- **2 erros de transcrição** — descricaoDetalhada (camelCase esperado, snakeCase retornado), VwKpisGeralDTO typo
- **Inconsistência de tipo (API-level)** — valor_* alternam `string`/`number` entre SIASG, PNCP Consulta, Compras.gov
- **Anomalias de nomenclatura** — sufixo `API` espúrio, `VwFt*` drift vs produção `Vw*`
- **Padrão de repetição** — BLOCOS 36-38 idênticos; indica 10 endpoints cyclados; Swagger finito em ~380

### Descobertas positivas
- **Reclassificações** — CONTR-01, ORG-01, ORG-02 respondíveis via DTOs já presentes (sem nova migração)
- **5 bridges de integração** — PCA → PNCP, PNCP → CATMAT, ARP → PNCP, subrogação, ORG-01/02 via API
- **Recuperação de 113 PDMs** — codigoPdm em VwFtPNCPCompraItemDTO permite vincular itens antes perdidos
- **Dados exclusivos ARP** — saldo_adesao, saldo_empenho não existem em PNCP Consulta

Ver [dto-errors-2026-09-19.md](./dto-errors-2026-09-19.md) e [bridges-consolidados.md](./bridges-consolidados.md) para detalhes.
