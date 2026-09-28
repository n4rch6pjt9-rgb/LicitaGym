# Edge Function: `api-dashboard-oportunidades`

Função Supabase Edge Function responsável por atender o frontend do Dashboard do LicitaGym com operações de **leitura** de oportunidades a partir da tabela `licitacoes_externas`.

## Sumário
- [Arquitetura & Segurança](#arquitetura--segurança)
- [Protocolo & CORS](#protocolo--cors)
- [Ações Disponíveis](#ações-disponíveis)
  - [1. `readiness`](#1-readiness)
  - [2. `get`](#2-get)
  - [3. `list`](#3-list)
- [Exemplos de Requisição](#exemplos-de-requisição)
- [Tratamento de Erros](#tratamento-de-erros)

---

## Arquitetura & Segurança

- **Chave pública (`anon`)**: A função usa apenas as credenciais de leitura com RLS no Supabase. O service_role **nunca** é exposto ao cliente.
- **RLS (Row Level Security)**: A tabela `public.licitacoes_externas` possui policy de `SELECT` para `anon` e `authenticated`. Escrita (`INSERT`, `UPDATE`, `DELETE`) permanece bloqueada para `anon`/`authenticated`, restrita exclusivamente ao coletor via `service_role`.
- **Prevenção de Injeção SQL**: Todas as consultas são estruturadas via PostgREST Query Builder (`supabase-js`), sem concatenação direta de SQL.

---

## Protocolo & CORS

- Aceita requisições **`GET`** (parâmetros via query string) e **`POST`** (corpo em JSON `{ "action": "...", ... }`).
- Suporta requisições `OPTIONS` com headers CORS liberados para `Access-Control-Allow-Origin: *`.
- Responde com cabeçalho `Content-Type: application/json; charset=utf-8`.

---

## Ações Disponíveis

### 1. `readiness`
Verifica a conectividade e disponibilidade da base de licitações externas sem expor credenciais.

#### Requisição
- **GET**: `/functions/v1/api-dashboard-oportunidades?action=readiness`
- **POST**:
  ```json
  {
    "action": "readiness"
  }
  ```

#### Resposta de Sucesso (HTTP 200)
```json
{
  "status": "ready",
  "ready": true,
  "table": "licitacoes_externas",
  "total_registros": 1542,
  "ultima_atualizacao": "2026-09-28T10:15:30.000Z",
  "ultimo_sync": "2026-09-28T10:00:00.000Z"
}
```

#### Resposta em caso de Indisponibilidade (HTTP 503)
```json
{
  "status": "unhealthy",
  "ready": false,
  "error": "Descrição do erro de conexão"
}
```

---

### 2. `get`
Obtém uma licitação específica por seu ID único numérico ou pela identidade do certame: CNPJ do órgão (`orgao_cnpj`) + número normalizado do processo (`processo_norm`).

#### Requisição por ID
- **GET**: `/functions/v1/api-dashboard-oportunidades?action=get&id=123`
- **POST**:
  ```json
  {
    "action": "get",
    "id": 123
  }
  ```

#### Requisição por Identidade do Certame
- **GET**: `/functions/v1/api-dashboard-oportunidades?action=get&orgao_cnpj=07.486.108/0001-85&processo_norm=00007.20260204/0002-28`
- **POST**:
  ```json
  {
    "action": "get",
    "orgao_cnpj": "07486108000185",
    "processo_norm": "0000720260204000228"
  }
  ```

#### Resposta de Sucesso (HTTP 200)
```json
{
  "item": {
    "id": 123,
    "fonte": "pncp",
    "codigo_externo": "07486108000185-1-000001/2026",
    "numero_processo": "00007.20260204/0002-28",
    "processo_norm": "0000720260204000228",
    "numero_edital": "01/2026",
    "objeto": "Aquisição de equipamentos de musculação e esteiras ergométricas...",
    "orgao_cnpj": "07486108000185",
    "orgao_nome": "Prefeitura Municipal Exemplo",
    "municipio": "São Paulo",
    "uf": "SP",
    "modalidade": "Pregão - Eletrônico",
    "fase": "Julgamento",
    "situacao": "Divulgada no PNCP",
    "data_publicacao": "2026-09-20T08:00:00Z",
    "data_inicio": "2026-09-21T08:00:00Z",
    "data_fim": "2026-10-05T18:00:00Z",
    "valor_total": 250000.00,
    "categoria_escopo": "catmat",
    "interesse_borracha": false,
    "prioridade": "leads",
    "updated_at": "2026-09-28T09:00:00Z"
  }
}
```

#### Resposta quando não encontrado (HTTP 404)
```json
{
  "error": "Licitação não encontrada",
  "item": null
}
```

---

### 3. `list`
Lista oportunidades com suporte a paginação, ordenação configurável e múltiplos filtros.

#### Parâmetros de Paginação e Ordenação
| Parâmetro | Tipo | Padrão | Descrição |
|---|---|---|---|
| `page` | integer | `1` | Página atual (1-based) |
| `limit` | integer | `20` | Quantidade de registros por página (máx: `100`) |
| `order_by` | string | `data_fim` | Campo de ordenação: `data_fim`, `data_publicacao` ou `valor_total` |
| `order_direction` | string | `desc` | Direção da ordenação: `asc` ou `desc` |

#### Parâmetros de Filtro
| Filtro | Tipo | Descrição |
|---|---|---|
| `prioridade` | string | Prioridade do certame (`leads`, `monitorar`, `historico`) |
| `uf` | string | Sigla da UF com 2 letras (ex: `SP`, `RJ`) |
| `municipio` | string | Busca parcial (ilike) no nome do município |
| `orgao_cnpj` | string | CNPJ do órgão (apenas dígitos são considerados) |
| `orgao_nome` | string | Busca parcial (ilike) no nome do órgão |
| `modalidade` | string / string[] | Modalidade única ou lista separada por vírgula / array |
| `situacao` | string | Situação da licitação |
| `fase` | string | Fase da licitação |
| `categoria_escopo` | string | Categoria (`catmat`, `borracha`, `piso`, `obra_piso`, `forte`, `fraco`) |
| `interesse_borracha` | boolean | Filtrar oportunidades de interesse em borracha (`true`/`false`) |
| `fonte` | string | Fonte dos dados (`pncp`, `sestsenat`, etc.) |
| `data_publicacao_inicio` | string (ISO) | `data_publicacao >= data_publicacao_inicio` |
| `data_publicacao_fim` | string (ISO) | `data_publicacao <= data_publicacao_fim` |
| `data_inicio_min` | string (ISO) | `data_inicio >= data_inicio_min` |
| `data_inicio_max` | string (ISO) | `data_inicio <= data_inicio_max` |
| `data_fim_min` | string (ISO) | `data_fim >= data_fim_min` |
| `data_fim_max` | string (ISO) | `data_fim <= data_fim_max` |
| `data_homologacao_min` | string (ISO) | `data_homologacao >= data_homologacao_min` |
| `data_homologacao_max` | string (ISO) | `data_homologacao <= data_homologacao_max` |
| `valor_min` | number | `valor_total >= valor_min` |
| `valor_max` | number | `valor_total <= valor_max` |
| `busca` (ou `q`) | string | Busca textual livre em `objeto`, `numero_processo` e `numero_edital` |

#### Resposta de Sucesso (HTTP 200)
*Nota: Lista vazia é retornada com HTTP 200 e `items: []`, sem gerar erro.*
```json
{
  "action": "list",
  "page": 1,
  "limit": 20,
  "total": 42,
  "order_by": "data_fim",
  "order_direction": "desc",
  "items": [
    {
      "id": 1,
      "objeto": "Aquisição de Anilhas e Halteres",
      "orgao_nome": "Comando da Aeronáutica",
      "uf": "DF",
      "valor_total": 45000.00,
      "data_fim": "2026-10-15T10:00:00Z"
    }
  ]
}
```

---

## Tratamento de Erros

As respostas de erro utilizam os seguintes códigos de status HTTP e formato JSON padrão:

- **HTTP 400 Bad Request**: Parâmetro inválido, JSON malformado ou ação não reconhecida.
  ```json
  {
    "error": "Identificador ausente: informe 'id' ou o par ('orgao_cnpj' e 'processo_norm')"
  }
  ```
- **HTTP 404 Not Found**: Certame não localizado na ação `get`.
  ```json
  {
    "error": "Licitação não encontrada",
    "item": null
  }
  ```
- **HTTP 405 Method Not Allowed**: Uso de verbos HTTP não suportados (ex: `PUT`, `DELETE`).
  ```json
  {
    "error": "Método não permitido. Utilize GET ou POST."
  }
  ```
- **HTTP 500 Internal Server Error**: Erro inesperado interno.
  ```json
  {
    "error": "Mensagem descritiva do erro"
  }
  ```
- **HTTP 503 Service Unavailable**: Erro ao conectar ao banco de dados durante checagem de readiness.
  ```json
  {
    "status": "unhealthy",
    "ready": false,
    "error": "Falha na conexão com o banco"
  }
  ```
