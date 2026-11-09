# Schemas para consultas — PNCP Consulta × LicitaGym

Referência para montar queries SQL e validar normalizers das Edge Functions de sync.

- **Base URL:** `https://pncp.gov.br/api/consulta/v1`
- **Matriz de contratos:** [`contract-matrix.md`](./contract-matrix.md)
- **Compras.gov (CATMAT):** [`../compras-gov/schemas-consultas.md`](../compras-gov/schemas-consultas.md)
- **Cruzamentos:** [`cruzamentos.md`](./cruzamentos.md)

---

## Envelope de resposta (endpoints paginados)

| Campo API | Tipo | Descrição |
|-----------|------|-----------|
| `data` | `array` | Itens da página |
| `totalRegistros` | int64 | Total no filtro |
| `totalPaginas` | int64 | Páginas totais |
| `numeroPagina` | int64 | Página atual |
| `paginasRestantes` | int64 | Páginas após a atual |
| `empty` | boolean | Lista vazia |

**Erro de validação:** `RespostaErroValidacaoDTO` — `message`, `path`, `timestamp`, `status`, `error`.

**Query params comuns (Consulta)**

| Param | Endpoints | Observação |
|-------|-----------|------------|
| `pagina` | maioria | Obrigatório |
| `tamanhoPagina` | ver tabela abaixo | **Não** é 500 em todos os GETs — limites por família |
| `dataInicial` / `dataFinal` | atas, contratos, contratações | Janela de vigência/publicação |
| `dataInicio` / `dataFim` | PCA atualização | ⚠️ **não** usar `dataInicial` neste endpoint |

**Limites reais de `tamanhoPagina` (schema + probe 2026-09-19)**

| Família | Endpoints | Mín–máx (schema) | Confirmado com `tamanhoPagina=500` |
|---------|-----------|------------------|-------------------------------------|
| Atas | `/v1/atas`, `/v1/atas/atualizacao` | 10–500 | ✅ aceita 500 |
| Contratos | `/v1/contratos`, `/v1/contratos/atualizacao` | 10–500 | ✅ aceita 500 (1× 500 transitório no backend) |
| PCA | `/v1/pca/usuario`, `/v1/pca/atualizacao` | — | ✅ aceita 500 |
| PCA listagem | `/v1/pca/` | 20–500 | ⚠️ ver hang abaixo — não usar valor inválido em `codigoClassificacaoSuperior` |
| Contratações | `/v1/contratacoes/publicacao`, `/proposta`, `/atualizacao` | 10–**50** | ❌ **400** `"Tamanho de página inválido"` |
| Instrumentos cobrança | `/v1/instrumentoscobranca/inclusao` | — | ❌ **400** — limite real **100** |

Implementação LicitaGym: `clampConsultaPageSize()` em `consulta-client.ts` — defaults no máximo permitido por família (`contratacoes` 50, `pca`/`atasContratos` 500, `instrumentosCobranca` 100). Compras.gov: `clampComprasGovPageSize()` (default 500).

### Teste empírico — `tamanhoPagina=500` (2026-09-19)

Probe direto na API (fetch same-origin, sem CORS). Base: `https://pncp.gov.br/api/consulta`. Todos os GETs paginados testados com `tamanhoPagina=500`, salvo onde o endpoint rejeitou.

| Endpoint | Parâmetros de teste | Resultado com `tamanhoPagina=500` |
|----------|---------------------|-----------------------------------|
| `GET /v1/atas` | `dataInicial=20240101`, `dataFinal=20240110` | **200 OK**, dados retornados. Limite real = **500** (confere com schema). |
| `GET /v1/atas/atualizacao` | idem | **200 OK**. |
| `GET /v1/contratacoes/publicacao` | `dataInicial`/`dataFinal` + `codigoModalidadeContratacao=6` | **400** `"Tamanho de página inválido"`. Limite real = **50** (schema `maximum: 50`). |
| `GET /v1/contratacoes/proposta` | `dataFinal=20261231` + `codigoModalidadeContratacao=6` | **400** mesmo erro. Limite real = **50**. |
| `GET /v1/contratacoes/atualizacao` | idem publicação | **400** mesmo erro. Limite real = **50**. |
| `GET /v1/contratos` | `dataInicial=20240101`, `dataFinal=20240110` | 1ª tentativa: **500** `"Erro na comunicação com o banco de dados"` (transitório). Repetido: **200 OK**. Limite real = **500**. |
| `GET /v1/contratos/atualizacao` | idem | **200 OK**. |
| `GET /v1/instrumentoscobranca/inclusao` | `dataInicial`/`dataFinal` | **400** `"Tamanho de página inválido"`. Limite real = **100**. |
| `GET /v1/pca/usuario` | `anoPca=2024`, `idUsuario=1` (fictício) | **204 No Content** — paginação 500 aceita; sem dados para esse usuário. |
| `GET /v1/pca/atualizacao` | `dataInicio=20240101`, `dataFim=20240110` | **200 OK**. |
| `GET /v1/pca/` (raiz) | `anoPca=2024`, `codigoClassificacaoSuperior=1` (sonda — doc não lista valores válidos) | **Travou** — sem resposta em >180s, mesmo com `tamanhoPagina` menor. Não parece paginação: `codigoClassificacaoSuperior` inválido suspeito de full scan/lock no backend. Hang derrubou conexão do Chrome na sessão. **Reteste pendente** com valor válido (ex.: `7830`). |
| `GET /v1/orgaos/{cnpj}/compras/{ano}/{sequencial}` | recurso único, sem paginação; CNPJ/ano/sequencial reais de contrato | **200 OK**. |

**Achado principal:** nem todo GET aceita `tamanhoPagina=500`. Os três endpoints de `contratacoes/*` capam em **50**; `instrumentoscobranca/inclusao` capa em **100**. Só `atas*`, `contratos*`, `pca/usuario` e `pca/atualizacao` suportam **500** de fato.

**Pendência:** domínio de valores válidos de `codigoClassificacaoSuperior` em `/v1/pca/` — Swagger não documenta; LicitaGym usa `7830` (CATMAT classe academia). Retestar `/v1/pca/` isoladamente após reabrir aba/extensão para separar hang de parâmetro vs. instabilidade do endpoint.

---

## 1. PCA — `PlanoContratacaoComItensDoUsuarioDTO`

**GET** `/v1/pca/` — LicitaGym filtra `codigoClassificacaoSuperior=7830`  
**GET** `/v1/pca/usuario` — mesmo DTO (não usado no sync atual)

Envelope: `PaginaRetornoPlanoContratacaoComItensDoUsuarioDTO`

### 1.1 Plano → `pca_planos`

| Campo API | Tipo | Postgres | Sync |
|-----------|------|----------|------|
| `idPcaPncp` | string | `id_pca_pncp` | ✅ |
| `anoPca` | int | `ano_exercicio` | ✅ |
| `orgaoEntidadeCnpj` | string | `orgao_cnpj` | ✅ |
| `codigoUnidade` | string | `unidade_codigo` | ✅ |
| `nomeUnidade` | string | `titulo` | ✅ |
| `orgaoEntidadeRazaoSocial` | string | `descricao` | ✅ |
| `dataPublicacaoPNCP` | date-time | `data_publicacao` | ✅ |
| `dataAtualizacaoGlobalPCA` | date-time | `data_atualizacao_origem` | ✅ |

**Chave natural:** `id_pca_pncp` = `{CNPJ14}-{segmento}-{seqPad}/{ano}`

### 1.2 Item → `pca_itens`

| Campo API | Tipo | Postgres | Sync |
|-----------|------|----------|------|
| `numeroItem` | int | `numero_item` | ✅ |
| `descricaoItem` | string | `descricao` | ✅ |
| `categoriaItemPcaNome` | string | `categoria` | ✅ |
| `classificacaoSuperiorCodigo` | string | `classe_material_servico` + `codigo_classe_catmat` | ✅ |
| `quantidadeEstimada` | number | `quantidade` | ✅ |
| `unidadeFornecimento` | string | `unidade_medida` | ✅ |
| `valorUnitario` | number | `valor_unitario_estimado` | ✅ |
| `valorTotal` | number | `valor_total_estimado` | ✅ |
| `dataDesejada` | date | `data_prevista_contratacao` | ✅ |
| `pdmCodigo` | string | `pdm_codigo_origem` | ✅ → `pca_item_pdm` se PDM existir |
| `codigoItem` | string | `codigo_item_origem` | ✅ → `catalogo_ponte` se item existir |
| `pdmDescricao` | string | — | payload bruto |
| `grupoContratacaoCodigo/Nome` | string | — | v2 |
| `classificacaoCatalogoId` | int64 | — | id interno PNCP |

**Chave natural:** `(pca_plano_id, numero_item)`

---

## 2. Edital/compra — `RecuperarCompraDTO`

**GET** `/v1/contratacoes/publicacao`, `/proposta`, `/atualizacao`  
**Tabela:** `contratacoes_editais` — `normalizeEdital()`

| Campo API | Tipo | Postgres | Sync |
|-----------|------|----------|------|
| `numeroControlePNCP` | string | `numero_controle_pncp` | ✅ |
| `orgaoEntidade.cnpj` | string | `orgao_cnpj` | ✅ |
| `anoCompra` / `sequencialCompra` | int | `ano` / `sequencial` | ✅ |
| `processo` | string | `numero_processo` | ✅ |
| `modalidadeId` | int64 | `modalidade_codigo` | ✅ |
| `objetoCompra` | string | `objeto` | ✅ |
| `informacaoComplementar` | string | `descricao` | ✅ |
| `valorTotalEstimado` | number | `valor_estimado` | ✅ |
| `dataPublicacaoPncp` | date-time | `data_publicacao` | ✅ |
| `dataAberturaProposta` | date-time | `data_abertura` | ✅ |
| `dataEncerramentoProposta` | date-time | `data_encerramento` | ✅ |
| `dataAtualizacaoGlobal` | date-time | `data_atualizacao_origem` | ✅ |
| `situacaoCompraNome` | string | `status` | ✅ |
| `srp` | boolean | — | v2 (prioriza sync de atas) |
| `valorTotalHomologado` | number | — | v2 |
| `unidadeOrgao` / `orgaoEntidade` | object | `unidade_id` / `orgao_id` | FK não resolvida |

**Chave natural:** `(orgao_cnpj, ano, sequencial)` ou `numero_controle_pncp`

---

## 3. Ata — item em `PaginaRetornoAtaRegistroPrecoPeriodoDTO`

**GET** `/v1/atas`, `/v1/atas/atualizacao`  
**Tabela:** `contratacoes_atas` — `normalizeAta()`

| Campo API | Tipo | Postgres | Sync |
|-----------|------|----------|------|
| `numeroControlePNCPAta` | string | `numero_controle_pncp` | ✅ |
| `cnpjOrgao` | string | `orgao_cnpj` | ✅ |
| `numeroControlePNCPCompra` | string | `processo_origem` | ✅ |
| `objetoContratacao` | string | `objeto` | ✅ |
| `dataAssinatura` | date-time | `data_assinatura` | ✅ (date) |
| `vigenciaInicio` / `vigenciaFim` | date-time | `vigencia_inicio` / `vigencia_fim` | ✅ (date) |
| `dataPublicacaoPncp` | date-time | `data_publicacao` | ✅ |
| `cancelado` | boolean | `status` | ✅ (`ativa` / `cancelada`) |
| `possibilidadeAdesao` | boolean | — | v2 / participantes |
| `numeroAtaRegistroPreco` | string | — | v2 |
| `edital_id` | — | FK | candidata via `processo_origem` |

**Chave natural:** `numeroControlePNCPAta` = `{CNPJ14}-1-{seqCompraPad}/{anoCompra}-{seqAtaPad}`  
**Índice:** `(orgao_cnpj, ano, sequencial_ata)` — migration `202609180017`

---

## 4. Contrato — `RecuperarContratoDTO`

**GET** `/v1/contratos`, `/v1/contratos/atualizacao`  
**Tabela:** `contratacoes_contratos` — `normalizeContrato()`

| Campo API | Tipo | Postgres | Sync |
|-----------|------|----------|------|
| `numeroControlePNCP` | string | `numero_controle_pncp` | ✅ |
| `orgaoEntidade.cnpj` | string | `orgao_cnpj` | ✅ |
| `anoContrato` / `sequencialContrato` | int | `ano` / `sequencial` | ✅ |
| `processo` | string | `processo_origem` | ✅ |
| `objetoContrato` | string | `objeto` | ✅ |
| `valorInicial` | number | `valor_inicial` | ✅ |
| `valorGlobal` | number | `valor_atual` | ✅ |
| `dataAssinatura` | date | `data_assinatura` | ✅ |
| `dataVigenciaInicio` / `dataVigenciaFim` | date | `vigencia_inicio` / `vigencia_fim` | ✅ |
| `dataPublicacaoPncp` | date-time | `data_publicacao` | ✅ |
| `numeroControlePncpCompra` | string | `edital_id` | FK candidata |
| `numeroControlePncpAta` | string | `ata_id` | FK candidata |
| `niFornecedor` | string | `fornecedor_id` | FK candidata |
| `identificadorCipi` / `urlCipi` | string | — | v2 |

---

## 5. Instrumento de cobrança — `ConsultarInstrumentoCobrancaDTO`

**Sem sync v1.** Inclui NFe (`notaFiscalEletronica`), empenho e `recuperarContratoDTO` aninhado.

Candidato futuro: `contratacoes_instrumentos_cobranca` ligado por `(cnpj, ano, sequencialContrato)`.

---

## 6. Busca — `/api/search/` e `/api/search/filters` (editais e atas)

Índice de busca do portal (o mesmo do `pncp.gov.br/app/editais`). **Não** é a API de Consulta: outra base URL,
outro envelope, nomes de campo em `snake_case`. Contrato medido ao vivo em **09/11/2026**, uma requisição por vez
com intervalo ≥ 1,5 s. Script que reproduz tudo: `scripts/probe-pncp-busca.py` (referência canônica desta seção).

- **Base URL:** `https://pncp.gov.br/api/search/`
- **Clientes no repositório:** `PncpSearchClient` (`supabase/functions/_shared/pncp/search-client.ts`, hoje só
  `tipos_documento=pcaorgao`) e `PncpClient.buscar()` (`services/coletor-externo/coletor/pncp.py`, `edital`).

### 6.1 Disponibilidade medida (09/11/2026)

| Rota | Resultado |
|---|---|
| `GET /api/consulta/v1/orgaos/46523262000131/compras/2026/118` | **503** HTML `No server is available to handle this request` |
| `GET /api/consulta/v1/orgaos/01612089000100/compras/2026/168` | **503** (mesmo HTML: a família toda fora, não só uma compra) |
| `GET /api/pncp/v1/orgaos/46523262000131/compras/2026/118/itens` e `/atas` | **503** |
| `GET /api/search/?q="46523262000131-1-000118/2026"&tipos_documento=edital` | **200**, `total=1`, o edital da compra |
| `GET /api/search/?q="46523262000131-1-000118/2026"&tipos_documento=ata` | **200**, `total=10`, as 10 atas da compra |

A busca respondeu enquanto a Consulta e a `/api/pncp/v1` davam 503: é uma rota de leitura independente.

**Queda de conexão:** a busca fecha a conexão sem resposta (`RemoteDisconnected`, sem HTTP) em boa parte das
chamadas. Em 09/11, nas três rodadas com retry: 52 quedas em 82 tentativas (≈ 63 %), mesmo com 1,5 s entre chamadas. Confere com o coletor
(14/10: ~60 %). Cliente precisa de retry com backoff para queda de conexão; a mesma URL responde na tentativa seguinte.

**Compressão:** `/api/search/filters` responde gzip mesmo sem `Accept-Encoding`. Decodificar pelo magic `1f 8b`.

### 6.2 Parâmetros de `/api/search/`

| Param | Medido | Observação |
|---|---|---|
| `q` | texto livre | Sem aspas o texto é tokenizado (`q=46523262000131-1-000118/2026` → `total=2`, trouxe a 113/2026). **Com aspas** é frase exata (`total=1`). Para casar uma compra, use o `numero_controle_pncp` entre aspas e confira o campo no item. |
| `tipos_documento` | `edital`, `ata`, `pcaorgao` | `edital\|ata` (pipe) junta os dois (`total=9704` para "equipamentos de academia"). |
| `ordenacao` | `-data` | Único valor usado e medido. |
| `pagina` / `tam_pagina` | `tam_pagina` 1000 aceito (`n=1000`) | Janela: `pagina × tam_pagina ≤ 10000`; acima, **400** `Janela de resultados muito grande...`. Usar ≤ 500 (sem ganho medido acima disso). |
| `status` | `recebendo_proposta` (150), `encerradas` (5205), `vigente` (150) | **Valor desconhecido é ignorado em silêncio**: `todos`, `xyz`, `em_julgamento` e a ausência do parâmetro deram o mesmo `total=7681` para "equipamentos de academia". `em_julgamento` não filtra (o coletor já registrava o ruído em 29/09). Com `q` vazio, `status` é obrigatório (**400** `O filtro status é obrigatório`). |
| `orgaos` | **id interno do PNCP** (`orgao_id`, ex. `83243` = Guararema) | CNPJ em `orgaos` devolve `total=0`. O mapa id ↔ CNPJ está em `filters?tipos_documento=ata` → `orgaos[]{id,cnpj,nome}`. |
| `modalidades` | id da modalidade (`6` = Pregão Eletrônico) | Vários valores separados por **pipe** (`6\|8`, `total=6957`). Com vírgula (`6,8`): `total=0` em silêncio. |
| `ufs` | sigla | Pipe (`SP\|RJ`, `total=1563`). Vírgula (`SP,RJ`): `total=0` em silêncio. |
| `cnpj` | **não existe** | Ignorado em silêncio (devolveu a busca inteira). Não usar. |

### 6.3 Envelope e paginação

`{ "total": int, "items": [...] }`. Sem `paginasRestantes`. Páginas 1, 2 e 3 de `tam_pagina=100`
("equipamentos de academia", `encerradas`, `total=5205`): 0 repetidos; a página 1 pedida de novo veio idêntica.
`total` igual nas quatro chamadas. Amostra de 3 páginas: não prova ausência de salto em varreduras longas
(ver o comportamento da paginação da Consulta, que já pulou itens).

### 6.4 Item `document_type=edital` (campos medidos na compra 46523262000131/2026/118)

| Campo | Exemplo | Uso / cuidado |
|---|---|---|
| `numero_controle_pncp` | `46523262000131-1-000118/2026` | **Chave de casamento** com `licitacoes_externas.codigo_externo` |
| `orgao_cnpj`, `ano`, `numero_sequencial` | `46523262000131`, `"2026"`, `"118"` | Chave `(cnpj, ano, sequencial)`; **ano e sequencial vêm como string** |
| `item_url` | `/compras/46523262000131/2026/118` | Link do edital: `https://pncp.gov.br/app/editais/{cnpj}/{ano}/{seq}` (o `item_url` já começa com `/compras`) |
| `title`, `numero` | `Edital nº 21/2026`, `"21"` | Número do edital do órgão (não é o sequencial PNCP) |
| `description` | objeto da compra | Equivale a `objetoCompra` |
| `orgao_id`, `orgao_nome`, `unidade_*`, `esfera_*`, `poder_*`, `municipio_nome`, `codigo_ibge`, `uf` | | Identificação do órgão e da unidade |
| `modalidade_licitacao_id` / `_nome` | `"6"` / `Pregão - Eletrônico` | Id como string |
| `situacao_id` / `situacao_nome` | `"1"` / `Divulgada no PNCP` | Situação **da publicação**, não da disputa: a 118 já homologada aparece "Divulgada no PNCP". |
| `tem_resultado`, `cancelado`, `tem_ata_registro_preco`, `srp` | `true`, `false`, `true`, `true` | Sinais de estado da compra |
| `valor_total_estimado`, `valor_total_homologado` | `222420.95`, `232620.82` | Número. Na 118 o homologado é **maior** que o estimado: exibir como vem, sem "corrigir". |
| `data_publicacao_pncp`, `data_atualizacao_pncp` | `2026-08-25T10:26:11.559997` | Sem fuso. `data_atualizacao_pncp` é a data a mostrar como "conferido no índice de busca". |
| `data_inicio_vigencia`, `data_fim_vigencia` | `2026-06-30T08:00`, `2026-07-15T08:00` | No **edital** = abertura e encerramento de propostas (horário de Brasília, sem fuso; mesma leitura do coletor) |
| `data_inicio_recebimento_propostas`, `data_fim_recebimento_propostas` | `""` | Vieram **vazias** (string vazia, não null): não usar |
| `link_sistema_origem`, `link_processo_eletronico` | `null` | Vieram nulos na 118: o portal oficial não sai da busca |
| `permite_adesao` | `null` | No edital veio nulo |
| `amparo_legal_nome[]`, `criterio_julgamento_nome[]`, `modo_disputa_nome` | listas | |

**Fuso das datas sem offset:** `data_atualizacao_pncp` da 118 na busca = `2026-08-25T10:26:11.559997`;
`licitacoes_externas.pncp_data_atualizacao` da mesma compra (id 1892, gravada pelo coletor a partir de
`dataAtualizacao` da Consulta) = `2026-08-25 13:26:11+00`. Logo a data da busca está em **horário de Brasília** e
corresponde a `dataAtualizacao` (não a `dataAtualizacaoGlobal`, gravada `13:27:10+00`). `parsePncpTimestamp()` em
`search-client.ts` trata data sem offset como UTC: para `edital` isso erra em 3 h (não medido para `pcaorgao`).

**Não vem na busca:** itens, resultados por item, arquivos/documentos, histórico, número do processo administrativo
(`processo`), data de abertura de proposta como campo próprio. Esses continuam só na `/api/pncp/v1` e na Consulta.

### 6.5 Item `document_type=ata`

| Campo | Exemplo | Uso / cuidado |
|---|---|---|
| `numero_controle_pncp` | `46523262000131-1-000118/2026-000010` | Controle da ata = controle da compra + `-{seqAta 6 dígitos}` |
| `numero_sequencial_compra_ata` | `"118"` | Sequencial da **compra** de origem |
| `numero_sequencial` | `"10"` | Sequencial da **ata** |
| `item_url` | `/atas/46523262000131/2026/118/10` | Link: `https://pncp.gov.br/app{item_url}` |
| `title` | `Ata nº 85/2026` | Número da ata do órgão |
| `data_assinatura` | `2026-08-28` | Data (sem hora) |
| `data_inicio_vigencia`, `data_fim_vigencia` | `2026-08-28`, `2027-08-28` | Na **ata** = vigência da ata |
| `permite_adesao` | `false` (118) / `true` (outra) | Booleano ou null |
| `cancelado`, `situacao_nome` | `false`, `Divulgada no PNCP` | |
| `valor_global`, `fornecedor_*` | `null` | **Não vêm**: a busca não dá valor nem fornecedor da ata |

Buscar as atas de uma compra: `q="{numero_controle_pncp da compra}"&tipos_documento=ata` e filtrar os itens cujo
`numero_controle_pncp` começa com o controle da compra + `-`.

### 6.6 `/api/search/filters`

`{ "filters": { categoria: [{ id | ano | cnpj, nome, total }] } }`. Medido em 09/11:

- `q` **não muda os totais** (contagens iguais com e sem termo): é um catálogo global, não faceta da consulta.
- `tipos_documento=edital`: `modalidades` (18), `anos`, `ufs` (27), `esferas`, `poderes`, `tipos`, `situacoes` (4),
  `criterios_julgamento`, `amparos_legais`... **sem `orgaos`**.
- `tipos_documento=ata`: inclui `orgaos` (8272, `{id, cnpj, nome, total}`), `unidades`, `municipios`.
- A chamada derruba a conexão com frequência (mesmo padrão da busca). `tipos_documento=edital` sem `q` (ou com `q` vazio) caiu em
  todas as tentativas do dia; `tipos_documento=ata` sem `q` respondeu 200. Com `q` preenchido, `edital` respondeu.
  Tratar como instável: não depender de `filters` no caminho do usuário.

---

## Datas e tipos Postgres

| Uso | Tipo API | Coluna Postgres | Normalizer |
|-----|----------|-----------------|------------|
| Vigência / assinatura | date-time ou date | `date` | `readOptionalDate()` → `YYYY-MM-DD` |
| Publicação / atualização | date-time | `timestamptz` | pass-through |
| PCA data desejada | date | `date` | pass-through |

---

## Normalizers (`supabase/functions/_shared/pncp/normalize.ts`)

| Função | DTO origem |
|--------|------------|
| `normalizePcaPlano` / `normalizePcaItem` | `PlanoContratacaoComItensDoUsuarioDTO` |
| `normalizeEdital` | `RecuperarCompraDTO` |
| `normalizeAta` | item de `PaginaRetornoAtaRegistroPrecoPeriodoDTO` |
| `normalizeContrato` | `RecuperarContratoDTO` |

Vínculo automático PCA→CATMAT quando o PNCP informa códigos: `pca-origem-link.ts` (chamado por `sync-pncp-pca`).
