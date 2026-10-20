---
paths:
  - "**/*.py"
---
<!-- GERADO de .github/instructions/python-ingestion.instructions.md por scripts/ci/sincronizar-regras-claude.sh. Não edite aqui. -->
# Python — collectors, ETL e sync

## [BLOQUEANTE]
- `except Exception: return []` (ou `{}`/`None`) quando o vazio é uma resposta válida da API. Distinguir SUCCESS_WITH_DATA, EMPTY_VALID, PARTIAL, FAILED.
- Chave/URL do Supabase ou `service_role` hardcoded (inclusive chave "dummy"). Ler de variável de ambiente.
- Valor oficial destruído na normalização (guardar `valor_original` + `valor_normalizado`, `unidade_original` + `unidade_normalizada`, `parser_version`, `source`).

## HTTP
- `timeout=` explícito em toda requisição.
- Retry limitado com backoff exponencial (+ jitter); respeitar `Retry-After` em 429; tratar como transitório 429/502/503/504/timeout/erro de conexão; não repetir 4xx permanente.
- Validar status, JSON, envelope, campos e tipos — 200 não garante payload válido.

## Paginação
- Limite por endpoint (ver `docs/pncp/schemas-consultas-pncp.md` e `docs/compras-gov/schemas-consultas.md`). `PAGE_SIZE` global é [IMPORTANTE].
- Detectar página repetida e loop infinito; falha em página intermediária não é fim de dados.

## Idempotência e provenance
- Reexecutar com o mesmo input não duplica. Identidade = chave natural/oficial; `payload_hash` detecta mudança.
- Preservar fonte, endpoint, parâmetros, identificador externo, timestamp da coleta e hash.
- Operações longas com checkpoint (operação, escopo, página/cursor, entidade pai).

## CATMAT
- E5/E6 por `codigoPdm`; E7 por `codigoItem`. Nunca E7 direto por classe/PDM.
- `codigoItem` ≠ `codigoPdm`. `codigoValorCaracteristica` pode ser NULL.
- Escopo configurável (78/7830 core, 72/7220 extensão); sem números mágicos espalhados.

## Logs e config
- Logs estruturados com source, endpoint, página, tentativa, status, duração. Nunca logar secrets.
- Centralizar base URL, timeout, retry, page size, concorrência e batch size.
- Não commitar arquivos de resultado (`*_resultado.json`, `*.log`) no repositório.

## Refatoração
Antes de criar cliente HTTP compartilhado, comparar os clientes existentes; migrar incrementalmente com testes de regressão.
