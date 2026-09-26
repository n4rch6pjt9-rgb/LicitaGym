# Upsert Consolidado E1-E7

Carrega JSONs coletados pelos collectors (endpoints 1-7) → insere em tabelas `icatmat_*` com FKs respeitadas.

## Workflow

1. **Coletar dados** via collectors (E1-E7)
   ```bash
   python scripts/collector_grupo_material.py
   python scripts/collector_classe_material.py
   # ... etc (E3-E7)
   ```
   Resultado: `collector_*_resultado.json` em `scripts/`

2. **Fazer upsert consolidado**
   ```bash
   pip install supabase
   python scripts/upsert_icatmat_consolidado.py
   ```

3. **Validar**
   ```bash
   supabase db query --local "SELECT COUNT(*) FROM icatmat_grupo_material;"
   ```

## Schema E1-E7

Ordem de ingestão (respeita FKs):

| E | Tabela Staging (`icatmat_*`) | Registro Oficial | FK Pai | Natural Key Staging | Chave Natural Canônica Oficial |
|---|-----------------------------|------------------|--------|---------------------|--------------------------------|
| 1 | `icatmat_grupo_material` | 2 grupos | — | `codigo_grupo` | `codigo_grupo` |
| 2 | `icatmat_classe_material` | 2 classes | E1 | `codigo_grupo,codigo_classe` | `codigo_grupo,codigo_classe` |
| 3 | `icatmat_pdm_material` | N PDMs | E2 | `codigo_grupo,codigo_classe,codigo_pdm` | `codigo_pdm` |
| 4 | `icatmat_item_material` | N itens | E3 | `codigo_grupo,codigo_classe,codigo_pdm,codigo_item` | `codigo_item` |
| 5 | `icatmat_natureza_despesa` | N naturezas | E4 | `codigo_grupo,codigo_classe,codigo_item,codigo_natureza` | `codigo_pdm,codigo_natureza` |
| 6 | `icatmat_unidade_fornecimento` | ~76k unidades | E4 | `codigo_grupo,codigo_classe,codigo_item,codigo_unidade` | `codigo_pdm,sigla_unidade,numero_sequencial` |
| 7 | `icatmat_caracteristica_material` | N características | E4 | `codigo_grupo,codigo_classe,codigo_item,codigo_caracteristica` | `codigo_item,codigo_caracteristica,codigo_valor_caracteristica` |

### Arquitetura Dual-Path (Lab Python vs. Edge Production)

O LicitaGym opera uma separação arquitetural explícita entre ingestão exploratória e produção:

1. **Python Lab Staging (`scripts/collector_*` e `scripts/upsert_icatmat_consolidado.py`)**:
   - Ingestão em lote e staging nas tabelas `icatmat_*`.
   - Permite análise exploratória, validação volumétrica e testes de carga offline sem afetar o catálogo em produção.
   - Preserva rastreabilidade e histórico hierárquico com FKs cascata completas (E1 ← E2 ← E3 ← E4 ← E5/E6/E7).
   - Utiliza `payload_hash` SHA-256 estável para idempotência em upserts.
   - E5 e E6 agora iteram PDMs respeitando o schema oficial (`codigoPdm`) da API Dados Abertos Compras.gov.br.
   - `load_resultado` desempacota envelopes de API (`resultado`) e dicionários agrupados (`data.grupo_*`, `data.item_*`) sem erros de desestruturação.

2. **Edge Production Client (`supabase/functions/sync-compras-catmat` e `_shared/compras-gov/material-client.ts`)**:
   - Ingestão contínua e reconciliação com o catálogo unificado de produção (`catmat_*` e `catalogo_itens`).
   - E5 consulta `/modulo-material/5_consultarMaterialNaturezaDespesa?codigoPdm={id}` gravando em `catmat_pdm_naturezas_despesa`.
   - E6 consulta `/modulo-material/6_consultarMaterialUnidadeFornecimento?codigoPdm={id}` gravando em `catmat_pdm_unidades`.
   - E7 consulta `/modulo-material/7_consultarMaterialCaracteristicas?codigoItem={id}` gravando em `catmat_item_caracteristicas`.

### Política de Nulos para Características (E7: `codigo_valor_caracteristica`)

Conforme `schemas-consultas.md §1.7` e o modelo relacional de produção `catmat_item_caracteristicas`, a chave natural de características inclui o valor:
- Em Dados Abertos, determinadas características podem omitir ou retornar nulo para `codigoValorCaracteristica`.
- No enriquecimento `enrich_e7`:
  - `NULL` continua `NULL`. Nenhum sentinel (`'0'`, `''`, `'N/A'`) é gravado. String só de espaços vira `NULL`.
  - A migração `20260922110000_icatmat_additive_alignment.sql` cria `codigo_valor_caracteristica` sem `DEFAULT` e a constraint `unique_caracteristica_valor UNIQUE NULLS NOT DISTINCT (codigo_item, codigo_caracteristica, codigo_valor_caracteristica)`.
  - O upsert usa `on_conflict=codigo_item,codigo_caracteristica,codigo_valor_caracteristica`: reprocessar o mesmo item com valor `NULL` atualiza a mesma linha.

### Erro ≠ vazio

- E5/E6: timeout, 429/5xx esgotados e JSON inválido levantam `HttpFetchError`; resposta 200 sem lista `resultado` levanta `InvalidEnvelopeError`. `{"resultado": []}` é o único vazio válido.
- E5/E6: PDMs vêm só dos resultados E3/E4. Sem esses arquivos, ou com arquivo corrompido, a coleta falha (`PdmSourceError`). Não há lista fixa de PDMs nem seed de curadoria como substituto.
- `load_resultado`: arquivo ausente, JSON inválido ou envelope desconhecido levantam `ResultadoLoadError`.
- `upsert_table`: falha de persistência levanta `UpsertError`; `main()` retorna 1.

## Deduplicação

Cada registro tem `payload_hash` (SHA-256 do payload estável, alinhado ao Edge `_shared/pncp/hash.ts`). Upsert via natural key (`on_conflict`) + hash evita duplicatas e garante idempotência.

Se mesmo registro é coletado 2x → mesmo hash → atualiza (não duplica).

## Configuração

**Local (dev) / Staging / Prod:**
As credenciais devem ser configuradas exclusivamente via variáveis de ambiente (SEC-P1-01):
```bash
export SUPABASE_URL="http://127.0.0.1:54321"
export SUPABASE_SERVICE_ROLE_KEY="sua_chave_service_role"
# ou SUPABASE_KEY
```

## Troubleshooting

- **"supabase-py não instalado"** → `pip install supabase`
- **FK constraint violation** → E5-E7 referencia items que não existem em E4 (verificar collectors E4)
- **`ResultadoLoadError: nenhum arquivo encontrado`** → collectors não foram rodados ou resultados salvos em outro lugar
- **`PdmSourceError`** → rodar E3/E4 antes de E5/E6

---

**Próximo:** Criar edge function para automatizar upsert em schedule (pg_cron trigger).
