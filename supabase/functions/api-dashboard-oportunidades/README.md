# Edge Function: `api-dashboard-oportunidades`

Função Supabase Edge Function responsável por atender o frontend do Dashboard do LicitaGym com operações de **leitura** de oportunidades a partir da tabela `licitacoes_externas`.

## Sumário
- [Arquitetura & Segurança RLS](#arquitetura--segurança-rls)
- [Protocolo & CORS](#protocolo--cors)
- [Ações Disponíveis](#ações-disponíveis)
  - [1. `readiness`](#1-readiness)
  - [2. `get`](#2-get)
  - [3. `list`](#3-list)
  - [4. `acompanhamento`](#4-acompanhamento)
- [Exemplos de Requisição](#exemplos-de-requisição)
- [Tratamento de Erros](#tratamento-de-erros)

---

## Arquitetura & Segurança RLS

- **RLS em `public.licitacoes_externas`**: Todo acesso direto à tabela via PostgREST REST API está revogado para `authenticated`, `anon` e `PUBLIC` (conforme migrations `20260926110000_pncp_rls_policies.sql`, `20260928130000_licitacoes_externas_revoke_anon.sql` e `20260928140000_licitacoes_externas_revoke_authenticated.sql`). Nenhuma role não-privilegiada possui permissão de `SELECT`, impedindo a leitura direta de colunas sensíveis (`raw`, `notas`, `esclarecimentos`, etc.) no navegador ou REST API.
- **Leitura Server-Side do Dashboard & Acesso Interno**: Leituras de usuários e do dashboard são realizadas exclusivamente através da Edge Function `api-dashboard-oportunidades` (que executa server-side utilizando `SUPABASE_SERVICE_ROLE_KEY` e projeta estritamente as colunas públicas seguras `PUBLIC_LICITACAO_COLUMNS`). Leituras e escritas internas permanecem restritas à role `service_role` (utilizada pela Edge Function e pelos coletores de backend). A chave de `service_role` **nunca** é devolvida nem exposta ao cliente. A ação `readiness` permanece pública para verificação de saúde e contagem sem expor dados de linhas.
- **Projeção Estrita de Colunas Públicas**: As consultas **não** usam `select("*")`. Apenas um conjunto explícito de colunas seguras para consumo do dashboard é projetado (`PUBLIC_LICITACAO_COLUMNS`), incluindo identificadores de fonte não-secretos (`modulo`, `id_externo`) necessários para fontes como SEST SENAT (onde `codigo_externo` é nulo), e omitindo estritamente colunas internas, payloads brutos (`raw`), fóruns (`esclarecimentos`, `notas`) e anexos técnicos (`anexo_raiz_id`, `edital_id`).
- **Prioridade efetiva (view `public.licitacoes_externas_prioridade_efetiva`)**: `list` e `get` leem a view criada em `20260930200000_licitacoes_prioridade_efetiva.sql`, com as mesmas colunas públicas e `prioridade` recalculada só para baixo: `historico` com qualquer sinal de encerramento (`data_homologacao`, resultado em `licitacao_resultados`, `raw.tem_resultado`, `raw.cancelado`, situação encerrada/homologada/revogada...), `leads` → `monitorar` com o prazo de proposta vencido (`raw.data_fim_vigencia` em BRT, senão `data_fim`), senão a prioridade gravada. A view é `security_invoker` e só `service_role` lê. `readiness` e `acompanhamento` continuam na tabela.
- **Oportunidades sem `historico` (decisão de produto 30/09/2026)**: compra homologada ou encerrada é só do BI. Sem filtro de prioridade, `list` (itens e `total`, inclusive a contagem do PGRST103) exclui `historico` e mantém `leads`, `monitorar` e `NULL` (fonte que não grava prioridade e sem sinal de encerramento). `prioridade=historico` responde **200 com `items: []` e `total: 0`**, sem consultar o banco (não 400: o Dashboard ainda oferece "Histórico de Certames" no seletor e mostraria erro). `get` de uma compra `historico` responde normalmente, com `prioridade: "historico"`, para links do BI e links diretos continuarem funcionando.
- **Isolamento de Credenciais**: O header `Authorization` do usuário não é repassado ao cliente service_role interno.
- **Mensagens de Erro Seguras**: Detalhes crus de erros do PostgREST não são expostos na resposta HTTP; falhas de banco retornam status HTTP 500 com mensagem limpa, e erros de parâmetro inválido retornam status HTTP 400.
- **Prevenção de Injeção SQL & Sanitização**: Todas as consultas são parametrizadas e estruturadas usando o query builder do `supabase-js`. Termos de busca textual livre (`busca`, `q`, `municipio`, `orgao_nome`) são normalizados em Unicode NFC, filtrados via allowlist (`[^\p{L}\p{N}\s-]`), sem curingas `%`, `_`, `*`, `\\`, colapsados e limitados a 200 caracteres.
- **Ordenação Determinística**: As consultas usam desempate estável via `.order("id", { ascending: true })` após o campo primário de ordenação.
- **Fuso Horário & Limites de Datas**: O contrato opera no fuso horário de `America/Sao_Paulo` (UTC-3 fixo). Para limites em formato só-data (`YYYY-MM-DD`), os valores são ancorados em `${data}T00:00:00-03:00` (mínimo via `>=`) e no início do dia seguinte `${nextDay}T00:00:00-03:00` (máximo via `<`), cobrindo o dia completo. Timestamps com hora exigem obrigatoriamente o literal `T` como separador e designador `Z` ou offset de fuso (ex: `-03:00`). Timestamps com espaço ou sem offset são rejeitados com HTTP 400.
- **Limites de Paginação**: `page` e `limit` devem ser inteiros seguros ≥ 1; `limit` máximo de 100; offset máximo `(page - 1) * limit` não pode exceder 10.000 (valores superiores retornam HTTP 400).

---

## Protocolo & CORS

- Aceita requisições **`GET`** (parâmetros via query string) e **`POST`** (corpo em JSON `{ "action": "...", ... }`).
- POST com JSON malformado ou não-objeto retorna explicitamente **HTTP 400**.
- Suporta requisições `OPTIONS` com headers CORS liberados para `Access-Control-Allow-Origin: *` e `Access-Control-Allow-Methods: GET, POST, OPTIONS`.
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
  "error": "Falha ao verificar disponibilidade da base de dados"
}
```

---

### 2. `get`
Obtém certames ou compras específicas.

Lê a view da prioridade efetiva. Uma compra `historico` é devolvida normalmente (com `prioridade: "historico"`), embora não apareça no `list`.

#### Modos de Consulta:
1. **Por ID único da tabela (`id`)**: Retorna `{ item: ... }` ou 404.
2. **Por Código Externo único (`codigo_externo` + `fonte` obrigatório)**: Como a unicidade no banco é composta por `(fonte, codigo_externo)`, o parâmetro `fonte` é obrigatório quando `codigo_externo` for informado (retorna 400 se `fonte` for omitida). Retorna `{ item: ... }` ou 404.
3. **Por Identidade do Certame/Processo (`orgao_cnpj` + `processo_norm`)**:
   Como um processo administrativo pode conter múltiplas compras (relação 1..N compras por processo), retorna uma coleção paginada `{ orgao_cnpj, processo_norm, page, limit, total, items: [...] }`, sem `maybeSingle()`. Aceita parâmetros opcionais `page` e `limit`. Retorna 404 claro com `{ error: "Nenhuma licitação encontrada para este processo", items: [] }` se não houver registros.

#### Exemplos de Requisição:
- **GET por ID**: `/functions/v1/api-dashboard-oportunidades?action=get&id=123`
- **GET por Código Externo**: `/functions/v1/api-dashboard-oportunidades?action=get&codigo_externo=07486108000185-1-000001/2026&fonte=pncp`
- **GET por Processo Administrativo**: `/functions/v1/api-dashboard-oportunidades?action=get&orgao_cnpj=07.486.108/0001-85&processo_norm=00007.20260204/0002-28&page=1&limit=20`
- **POST equivalente**:
  ```json
  {
    "action": "get",
    "codigo_externo": "07486108000185-1-000001/2026",
    "fonte": "pncp"
  }
  ```

#### Resposta de Sucesso por ID ou Código Externo (HTTP 200)
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
    "url_edital": "https://pncp.gov.br/app/editais/07486108000185/2026/1",
    "created_at": "2026-09-20T08:05:00Z",
    "updated_at": "2026-09-28T09:00:00Z",
    "last_synced_at": "2026-09-28T09:00:00Z"
  }
}
```

#### Resposta de Sucesso por Processo Administrativo (HTTP 200)
```json
{
  "orgao_cnpj": "07486108000185",
  "processo_norm": "0000720260204000228",
  "page": 1,
  "limit": 20,
  "total": 2,
  "items": [
    {
      "id": 123,
      "codigo_externo": "07486108000185-1-000001/2026",
      "objeto": "Lote 1 - Esteiras Ergométricas",
      "valor_total": 120000.00,
      "url_edital": "https://pncp.gov.br/app/editais/07486108000185/2026/1"
    },
    {
      "id": 124,
      "codigo_externo": "07486108000185-1-000002/2026",
      "objeto": "Lote 2 - Anilhas e Barras",
      "valor_total": 85000.00,
      "url_edital": "https://pncp.gov.br/app/editais/07486108000185/2026/2"
    }
  ]
}
```

---

### 3. `list`
Lista oportunidades com suporte a paginação, ordenação configurável e múltiplos filtros. Lê a view da prioridade efetiva e, por padrão, **exclui `historico`** da lista e do `total` (compra homologada/encerrada é só do BI).

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
| `prioridade` | string | Prioridade **efetiva** (view): `leads` = recebendo proposta, `monitorar` = em julgamento. Sem o filtro, o list traz `leads`, `monitorar` e `NULL`, nunca `historico`. `historico` (encerrado/homologado/com resultado) responde 200 com `items: []` e `total: 0`: não é Oportunidade, é do BI (desde 30/09/2026) |
| `uf` | string | Sigla da UF com 2 letras (ex: `SP`, `RJ`) |
| `municipio` | string | Busca parcial (`ilike`) no nome do município |
| `orgao_cnpj` | string | CNPJ do órgão (apenas dígitos são considerados) |
| `orgao_nome` | string | Busca parcial (`ilike`) no nome do órgão |
| `modalidade` | string / string[] | Modalidade única ou lista separada por vírgula / array |
| `situacao` | string | Situação da licitação |
| `fase` | string | Fase da licitação |
| `categoria_escopo` | string | Categoria (`catmat`, `borracha`, `piso`, `obra_piso`, `forte`, `fraco`) |
| `interesse_borracha` | boolean | Filtrar oportunidades de interesse em borracha (`true`/`false`) |
| `fonte` | string | Fonte dos dados (`pncp`, `sestsenat`, etc.) |
| `data_publicacao_inicio` | string | Início da publicação (`>= data_publicacao_inicio`) |
| `data_publicacao_fim` | string | Fim da publicação. Se formato só-data (`YYYY-MM-DD`), inclui o dia inteiro (`< dia seguinte`) |
| `data_inicio_min` | string | Início do certame (`>= data_inicio_min`) |
| `data_inicio_max` | string | Início do certame. Se formato só-data, inclui o dia inteiro (`< dia seguinte`) |
| `data_fim_min` | string | Encerramento do certame (`>= data_fim_min`) |
| `data_fim_max` | string | Encerramento do certame. Se formato só-data, inclui o dia inteiro (`< dia seguinte`) |
| `data_homologacao_min` | string | Homologação (`>= data_homologacao_min`) |
| `data_homologacao_max` | string | Homologação. Se formato só-data, inclui o dia inteiro (`< dia seguinte`) |
| `valor_min` | number | `valor_total >= valor_min` |
| `valor_max` | number | `valor_total <= valor_max` |
| `busca` (ou `q`) | string | Busca textual livre em `objeto`, `numero_processo` e `numero_edital` |
| `catmat_grupo`, `catmat_classe`, `catmat_pdm`, `catmat_item` | int[] (CSV ou array, até 50 cada) | Recorte CATMAT em cascata, resolvido por `public.licitacoes_ids_por_catmat_unica` (wrapper de `public.licitacoes_ids_por_catmat`): casa pelo código numérico do item (`licitacao_itens.catalogo_codigo_item`) ou, sem código, pelos padrões de texto do PDM (`catmat_pdm_palavras`) na descrição do item e no objeto |
| `catalogo` | boolean | `true` restringe ao catálogo CATMAT da empresa (herança e exclusões de `catalogo_empresa_catmat`) |

Com recorte CATMAT:
- cada item da resposta ganha `catmat_match: [{codigo_pdm, nome_pdm, codigo_item, motivo}]`, com `motivo`:
  - `codigo`: código numérico do item (`licitacao_itens.catalogo_codigo_item`);
  - `texto_item` / `texto_objeto`: padrão do PDM (`catmat_pdm_palavras`) na descrição do item / no objeto;
  - `taxonomia` / `taxonomia_objeto`: nó do dicionário de aparelhos (`no_taxonomia` do item / da licitação) mapeado para o PDM em `taxonomia_no_pdm` (a partir da migration `20260930110000_taxonomia_no_pdm`);
  - `texto_item_aprox` / `taxonomia_aprox`: recorte por item (`catmat_item`) casado por texto ou taxonomia, que identificam o PDM, não o item;
- com `catalogo=true`, item avulso do catálogo (registrado sem o PDM inteiro) casa só por código: não expande para o texto/taxonomia do PDM;
- a resolução não trunca (sem `LIMIT` na função); o teto é o de licitações abaixo;
- uma chamada só por requisição: `licitacoes_ids_por_catmat_unica` devolve uma linha `{ids: bigint[], matches: jsonb}` (ids distintos em ordem crescente e os casamentos), então o `max_rows` do PostgREST não pagina e o `statement_timeout` de 8 s (por chamada, do role `authenticator`) vale uma vez. O casamento por texto vem de `public.licitacao_match`, materializado, depois do backfill; até lá vem do caminho ao vivo, como antes (ver `docs/design/licitacao-match.md`);
- sem nenhuma licitação: `200` com `items: []` e `total: 0`;
- acima de 1.000 licitações: os ids são antes reduzidos ao escopo pedido na view da prioridade efetiva (sem filtro, sem `historico`; com `prioridade`, só ela), em lotes de 500; o `422` pedindo um recorte mais restrito só vale se ainda sobrarem mais de 1.000 oportunidades (se não sobrar nenhuma, 200 vazio).
- statement_timeout do Postgres (`57014`) ao resolver o recorte: `503` com `{"error": "filtro de catálogo indisponível"}` (outros erros seguem `500`).

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
      "data_fim": "2026-10-15T10:00:00Z",
      "url_edital": "https://pncp.gov.br/app/editais/00394429000100/2026/1"
    }
  ]
}
```

---

### 4. `acompanhamento`
Obtém o painel de acompanhamento em tempo real para uma oportunidade, consultando em paralelo a API oficial do PNCP para carregar:
- Metadados da compra (`situacao`, `modalidade`, `objeto`, `valorEstimado`, `valorHomologado`, `datas`, `linkSistemaOrigem`).
- Lista completa de itens paginada (`numeroItem`, `descricao`, `quantidade`, `unidade`, `valorUnitarioEstimado`, `situacaoCompraItemNome`, `temResultado`).
- Vencedores e homologação de itens com resultado via `/itens/{n}/resultados` com concorrência limitada (~5). CNPJ/CPF retornados como dados públicos oficiais.
- Atas de registro de preço associadas (`numero`, `ano`, `vigenciaInicio`, `vigenciaFim`, `cancelado`).
- Histórico completo de eventos e retificações paginado (`data`, `categoria`, `tipo`, `item`, `documentoTitulo`, `justificativa`).
- Arquivos e editais oficiais para download direto (`titulo`, `tipo`, `url`).
- URLs seguras derivadas na leitura: `url_edital` e `url_acompanhamento` (redirecionamento Comprasnet `https://cnetmobile.estaleiro.serpro.gov.br/comprasnet-web/public/landing?destino=acompanhamento-compra&compra={idCompra}` quando `idCompra` tem 17 dígitos válidos).
- Cache em memória de ~5 minutos (`Cache-Control: private, max-age=300`).
- Isolamento de falhas parciais: falha em uma seção não inviabiliza as demais; cada seção possui seu campo `erro`.

Requer autenticação JWT do usuário (`401` se não autenticado).

A ação é somente leitura: não grava eventos nem gera tarefas. A automação de tarefas a partir do histórico está em design em [`docs/design/acompanhamento-tarefas.md`](../../../docs/design/acompanhamento-tarefas.md), com SQL proposto (não aplicado, fora de `supabase/migrations`) em [`docs/design/sql/acompanhamento_tarefas.sql`](../../../docs/design/sql/acompanhamento_tarefas.sql).

#### Requisição
- **GET**: `/functions/v1/api-dashboard-oportunidades?action=acompanhamento&id=101`
- **POST**:
  ```json
  {
    "action": "acompanhamento",
    "id": 101
  }
  ```
- **Validação de `id`**: obrigatório; somente dígitos, 1 a 18 (`/^\d{1,18}$/`, aceito como string ou inteiro no body). Qualquer outro formato retorna `400` sem consultar o banco.

#### Resposta de Sucesso para oportunidade PNCP (HTTP 200)
```json
{
  "disponivel": true,
  "id": 101,
  "pncp": {
    "cnpj": "45138070000149",
    "ano": 2026,
    "sequencial": 559,
    "numero_controle_pncp": "45138070000149-1-000559/2026"
  },
  "url_edital": "https://pncp.gov.br/app/editais/45138070000149/2026/559",
  "url_acompanhamento": "https://cnetmobile.estaleiro.serpro.gov.br/comprasnet-web/public/landing?destino=acompanhamento-compra&compra=98703305900102026",
  "compra": {
    "dados": {
      "situacao": "Divulgada no PNCP",
      "modalidade": "Pregão - Eletrônico",
      "objeto": "Visa-se o REGISTRO DE PREÇOS para futura e eventual aquisição de materiais esportivos...",
      "valorEstimado": 250000.0,
      "valorHomologado": 210000.0,
      "datas": {
        "publicacao": "2026-06-15T07:04:53",
        "aberturaProposta": "2026-06-25T08:00:00",
        "encerramentoProposta": "2026-06-25T09:00:00",
        "inclusao": "2026-06-15T07:04:53",
        "atualizacao": "2026-09-18T08:07:28"
      },
      "linkSistemaOrigem": "https://cnetmobile.estaleiro.serpro.gov.br/comprasnet-web/public/landing?destino=quadro-informativo&compra=98703305900102026"
    },
    "erro": null
  },
  "itens": {
    "dados": [
      {
        "numeroItem": 1,
        "descricao": "Apito",
        "quantidade": 90.0,
        "unidade": "Unidade",
        "valorUnitarioEstimado": 30.33,
        "situacaoCompraItemNome": "Homologado",
        "temResultado": true,
        "resultados": [
          {
            "fornecedorCnpj": "27197345000133",
            "fornecedorNome": "DAIANE CRISTINA MEIRA ZEGOBIA BARBOSA LTDA",
            "valorUnitarioHomologado": 5.4,
            "quantidadeHomologada": 90.0,
            "dataResultado": "2026-09-18"
          }
        ]
      }
    ],
    "total": 77,
    "erro": null
  },
  "atas": {
    "dados": [
      {
        "numero": "151",
        "ano": 2026,
        "vigenciaInicio": "2026-09-25",
        "vigenciaFim": "2027-09-24",
        "cancelado": false
      }
    ],
    "total": 18,
    "erro": null
  },
  "historico": {
    "dados": [
      {
        "data": "2026-06-15T07:04:53",
        "categoria": "Contratação",
        "tipo": "Inclusão",
        "item": null,
        "documentoTitulo": null,
        "justificativa": null
      }
    ],
    "total": 228,
    "erro": null
  },
  "arquivos": {
    "dados": [
      {
        "titulo": "98703305900102026000",
        "tipo": "Edital",
        "url": "https://pncp.gov.br/pncp-api/v1/orgaos/45138070000149/compras/2026/559/arquivos/1"
      }
    ],
    "total": 2,
    "erro": null
  }
}
```

#### Resposta para oportunidade Não-PNCP (HTTP 200)
```json
{
  "disponivel": false,
  "id": 202,
  "motivo": "Esta oportunidade não é de origem PNCP ou não possui chave de identificação PNCP.",
  "razao": "Esta oportunidade não é de origem PNCP ou não possui chave de identificação PNCP."
}
```

---

## Tratamento de Erros

As respostas de erro utilizam códigos de status HTTP apropriados e formato JSON com mensagens padronizadas:

- **HTTP 400 Bad Request**: Parâmetro inválido, JSON malformado ou ação não reconhecida.
  ```json
  {
    "error": "Corpo JSON inválido. Verifique a sintaxe da requisição."
  }
  ```
- **HTTP 404 Not Found**: Certame ou compra não encontrada.
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
- **HTTP 500 Internal Server Error**: Erro inesperado interno ou falha na consulta de dados ao banco (detalhes sensíveis são omitidos e logados no console).
  ```json
  {
    "error": "Falha ao consultar lista de oportunidades"
  }
  ```
- **HTTP 503 Service Unavailable**: Erro ou indisponibilidade na verificação de readiness (conexão ao banco ou contagem nula).
  ```json
  {
    "status": "unhealthy",
    "ready": false,
    "error": "Falha ao verificar disponibilidade da base de dados"
  }
  ```

---

## Verificação de ACL e RLS (Banco de Dados)

Após a aplicação das migrations em ambiente com banco de dados configurado, a restrição de acesso e a política de RLS em `public.licitacoes_externas` podem ser conferidas executando o script SQL:

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/licitacoes_externas_acl_check.sql
```

Esse script assevera deterministicamente:
1. `has_table_privilege('anon', 'public.licitacoes_externas', 'SELECT') = false`
2. `has_table_privilege('authenticated', 'public.licitacoes_externas', 'SELECT') = false`
3. Zero policies permitindo acesso a `anon`, `authenticated` ou `PUBLIC` em `pg_policies`
4. RLS habilitado (`pg_class.relrowsecurity = true`)
5. Comentário da tabela atualizado documentando o acesso exclusivo via Edge Function `api-dashboard-oportunidades`.

