# Avaliação das APIs de PCA (outubro/2026)

- **Data da medição:** 09/10/2026, entre 14:30 e 14:47 (horário de Brasília).
- **Motivo:** reescrever a spec 0012 (issue #289). O `sync-pncp-pca` morre com `CPU Time exceeded` desde 26/09.
- **Regras da medição:** só GET público, sem credencial, no máximo 1 requisição por segundo, timeout de 90 s por
  requisição. Nada foi escrito em produção. As respostas ficaram fora do repositório. Aqui só entram os números e os
  contratos (OpenAPI).
- **Acesso:** `pncp.gov.br`, `treina.pncp.gov.br` e `dadosabertos.compras.gov.br` responderam 302 na raiz.

Toda latência abaixo é de uma única requisição, medida do cliente. "Fria" é a primeira chamada de uma consulta.
"Quente" é a mesma consulta repetida logo depois. O servidor guarda a resposta em cache por alguns minutos.

## Resumo

| | T1 consulta por classe | T2 atualização global | T3 integração por plano | T4 PGC Compras.gov |
|---|---|---|---|---|
| Endpoint | `GET /api/consulta/v1/pca/` | `GET /api/consulta/v1/pca/atualizacao` | `GET /api/pncp/v1/orgaos/{cnpj}/pca/{ano}/{seq}/itens` | `GET /modulo-pgc/2_consultarPgcDetalheCatalogo` e `1_consultarPgcDetalhe` |
| Autenticação | nenhuma | nenhuma | nenhuma (só os GET; POST, PATCH e DELETE exigem token) | nenhuma |
| Abrangência | todos os órgãos que publicam PCA no PNCP | idem, todas as classes | um plano (órgão, ano, sequencial) | só órgãos do SISG (federais no Compras.gov.br) |
| Filtro de classe | **sim** (`codigoClassificacaoSuperior`) | **não** | não; só `categoria` (1 = Material) | **sim** no `2_` (`tipo` + `codigo`); não no `1_` |
| Página máxima | 500 (OpenAPI e medido) | 500 (OpenAPI) | sem máximo no OpenAPI; 2000 aceito e devolveu os 1800 itens | 500 (OpenAPI) |
| Envelope | `data[]` por plano com `itens[]`, `totalRegistros` (itens), `totalPaginas` | igual ao T1 | array puro, sem total. Total em `.../itens/quantidade` | `resultado[]`, `totalRegistros`, `totalPaginas` |
| Volume medido | 6.018 itens 7830/2026, 935 planos, 325 órgãos, 13 páginas de 500 (5,2 MB) | 21.593 itens num único dia de 2025. Os dias de outubro/2026 não responderam | Galeão: 256 itens (274 KB). Maior plano visto: 1.800 itens (1,6 MB) | 1.714 linhas 7830/2026, 983 itens distintos, 70 órgãos, 154 UASG |
| Latência | fria 46 a 57 s na página 1; quente 0,2 a 3 s | 500 após cerca de 50 s (janela de um dia de out/2026); 42 s (um dia de 2025) | 0,2 a 0,4 s | 0,4 a 3,2 s |
| Confiável para completude | **não**: a paginação repete e pula itens (ver T1) | não medido (não respondeu) | **sim** no que foi conferido | não: linhas duplicadas e cobertura menor |

**Recomendação:**
- **Descoberta diária:** a consulta por classe (T1), só para listar planos e `dataAtualizacaoGlobalPCA`.
- **Itens de cada plano:** a integração por plano (T3), que é estável e rápida.
- **Incremental:** `/pca/atualizacao` (T2) não serve hoje. Sem `cnpj` ele estoura em 50 s, e com `cnpj` não acrescenta
  nada ao par T1 + T3.
- **PGC (T4):** só como enriquecimento futuro (DFD, projeto de compra, status da contratação), nunca como fonte de
  carga do PCA.

Detalhes e evidência abaixo.

## T1: consulta por ano e classe

`GET https://pncp.gov.br/api/consulta/v1/pca/?anoPca=2026&codigoClassificacaoSuperior=7830&pagina=N&tamanhoPagina=T`

- **Parâmetros (OpenAPI):** `anoPca` e `codigoClassificacaoSuperior` obrigatórios; `pagina` ≥ 1; `tamanhoPagina` de 10 a
  500. A `contract-matrix.md` diz "20 a 500". O mínimo do contrato é 10.
- **Totais (09/10, 14:42):** `totalRegistros = 6018` e `totalPaginas = 13` com 500, ou 301 com 20. `totalRegistros`
  conta **itens**, não planos. A página de 20 trouxe 2 planos com 9 e 11 itens.
- **Campos do plano:** `idPcaPncp`, `orgaoEntidadeCnpj`, `orgaoEntidadeRazaoSocial`, `codigoUnidade`, `nomeUnidade`,
  `anoPca`, `dataPublicacaoPNCP`, `dataAtualizacaoGlobalPCA`.
- **Campos do item:** `numeroItem`, `categoriaItemPcaNome`, `classificacaoCatalogoId`, `nomeClassificacaoCatalogo`,
  `classificacaoSuperiorCodigo`, `classificacaoSuperiorNome`, `pdmCodigo`, `pdmDescricao`, `codigoItem`, `descricaoItem`,
  `unidadeFornecimento`, `quantidadeEstimada`, `valorUnitario`, `valorTotal`, `valorOrcamentoExercicio`,
  `unidadeRequisitante`, `dataDesejada`, `grupoContratacaoCodigo`, `grupoContratacaoNome`, `dataInclusao`,
  `dataAtualizacao`.
- **Preenchimento em 6.018 linhas:** `pdmCodigo` 4.137, `codigoItem` 4.128 e `descricaoItem` 4.505.

Latência:

| Consulta | Fria | Quente | Tamanho |
|---|---|---|---|
| página 1, `tamanhoPagina=20` | 46,4 s | 0,20 s | 16 KB |
| página 1, `tamanhoPagina=500` | 9,3 s (logo depois da de 20) | 0,34 s | 439 KB |
| página 1, `tamanhoPagina=500`, varredura das 14:42 | 57,1 s | | 439 KB |
| páginas 2 a 13, `tamanhoPagina=500`, na sequência | 0,4 a 2,7 s | | 411 a 454 KB (a 13 tem 14 KB) |
| página 150, `tamanhoPagina=20` | 6,6 s | | 18 KB |

- **Leitura:** o custo está na primeira página. Ela conta o total, e o resto vem em cache. A varredura das 13 páginas
  levou cerca de 81 s de relógio, dos quais 57 s foram a primeira página.
- **Planos com `dataAtualizacaoGlobalPCA` recente (09/10 14:45):** 78 nas últimas 24 h, 269 em 7 dias e 483 em 30 dias.
  A issue #289 cita 53 em 7 dias e 231 em 30 dias. A origem daquela contagem não está registrada aqui.
- **Itens com `dataAtualizacao` nos últimos 7 dias:** 223.

**A paginação não é estável:**
- A varredura de 13 páginas de 500 devolveu 6.018 linhas, mas só 6.009 pares `(idPcaPncp, numeroItem)` distintos.
- Os 9 repetidos aparecem na fronteira entre páginas consecutivas, com conteúdo idêntico. Eram 10 planos partidos
  entre duas páginas.
- Conferido na integração (T3):
  - o plano `18401059000157-0-000011/2026` tem 19 itens 7830, e a T1 trouxe 13: faltaram 169, 173, 174, 758, 762 e 766;
  - o plano `08969291000132-0-000001/2026` tem 22, e a T1 trouxe 21: faltou o 320.
- **Conclusão:** a ordenação do servidor empata e a paginação por offset pula itens dos planos partidos. Uma varredura
  da T1 não prova que um item saiu da fonte, e não pode ser a única base para inativar.

**Galeão (`00394429000100-0-000004/2026`, UASG 120645):**
- A T1 traz 32 itens 7830: de 399 a 423, 435, 441, 444, 446 e 449 a 451.
- 24 deles têm PDM 2640, e o plano tem `dataAtualizacaoGlobalPCA = 2026-09-21T11:31:57`.
- O banco tem de 399 a 412 (issue #289).

**Prós:** é o único filtro por classe no PNCP; tem dado de plano e item na mesma resposta; 13 requisições cobrem o ano.

**Contras:**
- a primeira página fria leva de 46 a 57 s, perto do limite em que a T2 devolve 500;
- a paginação pula itens;
- cada página de 500 tem cerca de 440 KB.

## T2: atualização global

`GET https://pncp.gov.br/api/consulta/v1/pca/atualizacao?dataInicio=AAAAMMDD&dataFim=AAAAMMDD&pagina=N&tamanhoPagina=T`

- **Parâmetros (OpenAPI):** `dataInicio` e `dataFim` (`yyyyMMdd`) obrigatórios; `cnpj` e `codigoUnidade` opcionais;
  `tamanhoPagina` de 10 a 500. O envelope e os campos são os mesmos da T1.
- **`dataFim` é exclusivo (00:00 do dia):** com `cnpj` do CEFET-MG (plano atualizado em 07/10 às 11:32):
  - `dataInicio=20261007&dataFim=20261007` deu 204;
  - `20261007..20261008` deu 200;
  - `20261008..20261009` deu 204.

  Com `dataInicio = dataFim`, a janela é vazia. Um dia D é `dataInicio=D&dataFim=D+1`. O pedido original
  (`20261008..20261008`) deu 204 por isso, não por falta de dado.
- **`codigoUnidade` sem `cnpj`:** 422 "Obrigatório que o CNPJ do órgão seja informado."

Sem `cnpj`:

| Janela | Status | Tempo |
|---|---|---|
| 20261007..20261008 (um dia), duas tentativas | 500 "Erro ao processar a consulta." | 50,6 s e 51,7 s |
| 20261008..20261009 (um dia) | 500 | 50,5 s |
| 20261001..20261008, 20260901..20260930, 20260101..20260131 | 500 | cerca de 50 s cada |
| 20250310..20250311 (um dia de 2025) | 200: `totalRegistros = 21593`, 2.160 páginas de 10 | 41,9 s (página 2: 0,35 s) |

- **Leitura:** o servidor corta em cerca de 50 s. Em 2025, um dia coube no limite. Os dias de outubro/2026 não couberam.
- Quando responde, o endpoint traz todas as classes e todos os anos de PCA atualizados no período: 21.593 itens num
  dia, cerca de 44 páginas de 500.
- Não há filtro de classe nem de ano.

Com `cnpj`:
- **CEFET-MG, 07/10:** `totalRegistros = 2021`, 0,6 s com 500 e 347 KB. São todos os itens do plano, de todas as classes.
- **Prós:** responde rápido.
- **Contras:**
  - exige saber o CNPJ antes;
  - devolve o plano inteiro, não só o que mudou nem só a classe;
  - para os 325 órgãos com itens 7830, seriam 325 requisições por dia, cerca de 5,5 min a 1 req/s, quase todas 204.

**Prós:** é o único endpoint pensado para incremental.

**Contras:**
- sem `cnpj`, hoje não responde (500 em 50 s);
- não filtra classe;
- com `cnpj`, não traz nada que a T1 (descoberta) mais a T3 (itens) já não tragam.

## T3: integração, GET público por plano

Base: `https://pncp.gov.br/api/pncp/v1/orgaos/00394429000100/pca/2026/4`

| Chamada | Status | Tempo | Resultado |
|---|---|---|---|
| `/consolidado` | 200 | 0,24 s | `quantidade = 256`, `valorTotal`, `dataAtualizacao`, `dataAtualizacaoGlobalPCA = 2026-09-21T11:31:57`, `usuario = "Compras.gov.br"`, `municipio`, `uf`, `numeroControlePNCP` |
| `/itens/quantidade` | 200 | 0,19 s | 256 |
| `/itens/quantidade?categoria=1` | 200 | 0,22 s | 191 |
| `/itens?categoria=1&pagina=1&tamanhoPagina=50` | 200 | 0,28 s | 50 itens, 56 KB |
| `/itens?categoria=1&pagina=1&tamanhoPagina=500` | 200 | 0,32 s | 191 itens, 210 KB |
| `/itens?pagina=1&tamanhoPagina=500` | 200 | 0,39 s | 256 itens, 274 KB |
| `/orgaos/00394429000100/pca/120645/2026/sequenciaisplano` | 200 | 0,23 s | `sequencialPlano = 4`, `sequencialUltimoItemInserido = 475` |
| `/api/pncp/v1/categoriaItemPcas` | 200 | 0,19 s | 1 Material, 2 Serviço, 3 Obra… |

**Comparação com a T1 para o Galeão:**
- os mesmos 32 itens 7830, sem item a mais nem a menos;
- `valorTotal`, `valorUnitario`, `pdmCodigo`, `codigoItem` e `dataAtualizacao` iguais;
- `quantidade` igual a `quantidadeEstimada`, e `descricao` igual a `descricaoItem`.

**Nomes que mudam da T1 para a T3:**

| T1 | T3 |
|---|---|
| `quantidadeEstimada` | `quantidade` |
| `descricaoItem` | `descricao` |
| `nomeClassificacaoCatalogo` | `nomeClassificacao` |
| `dataPublicacaoPNCP` | `dataPublicacaoPncp` |

**Campos que só a T3 tem:** `catalogoId`, `nomeCatalogo`, `categoriaItemPcaid`, `cnpj`, `codigoUnidade`,
`nomeUnidade`, `sequencialPca` e `anoPca` repetidos por item.

**Plano grande (`18401059000157-0-000011/2026`, 1.800 itens):**
- `tamanhoPagina=1000` trouxe 1.000 itens, e a página 2 trouxe os 800 restantes;
- `tamanhoPagina=2000` trouxe os 1.800 em 0,44 s e 1,6 MB;
- 19 itens 7830.

**Prós:**
- completa e estável no que foi conferido;
- leva de 0,2 a 0,4 s;
- não tem paginação problemática até 2.000 itens;
- `consolidado` dá `dataAtualizacaoGlobalPCA` por 463 bytes.

**Contras:**
- não filtra classe: baixa o plano inteiro (todas as categorias) e filtra 7830 no cliente;
- precisa da lista de planos, que vem da T1;
- não tem total no envelope.

**Volume de uma carga completa por plano:** não medido. Seriam 935 requisições, cerca de 16 min a 1 req/s. O tamanho
total depende do tamanho dos planos, e o que foi visto vai de 256 a 1.800 itens.

## T4: PGC Compras.gov.br

OpenAPI conferido em `https://dadosabertos.compras.gov.br/v3/api-docs`:

- **`1_consultarPgcDetalhe`:** `orgao` (CNPJ, obrigatório), `anoPcaProjetoCompra` (obrigatório), `codigoUasg`
  (opcional), `pagina`, `tamanhoPagina` (10 a 500). O pedido original citava "UASG 120645, ano 2026". Os nomes reais são
  `codigoUasg` e `anoPcaProjetoCompra`, e `orgao` é obrigatório.
- **`2_consultarPgcDetalheCatalogo`:** `anoPcaProjetoCompra`, `tipo` (`Material` | `Servico`) e `codigo` (classe para
  material, grupo para serviço), todos obrigatórios.
- O OpenAPI não descreve o `orgao`. A resposta mostrou que ele é o CNPJ com 14 dígitos.

Medido:

| Chamada | Status | Tempo | Resultado |
|---|---|---|---|
| `1_` `orgao=00394429000100&anoPcaProjetoCompra=2026&codigoUasg=120645&tamanhoPagina=500` | 200 | 0,57 s (fria), 0,40 s | 227 linhas, 141 itens distintos, 475 KB |
| `2_` `anoPcaProjetoCompra=2026&tipo=Material&codigo=7830`, 4 páginas de 500 | 200 | de 1,4 a 3,2 s por página | 1.714 linhas, cerca de 3,6 MB |

**Achados:**
- **Linhas duplicadas e idênticas:**
  - no Galeão, cada um dos 32 itens 7830 aparece 2 vezes, com todos os campos iguais;
  - no catálogo 7830, há 1.714 linhas para 983 chaves `(orgao, codigoUasg, numeroItemPncp)`.
- **Cobertura menor que a do PNCP:**
  - nos 70 órgãos que aparecem no PGC 7830, a T1 tem 3.458 itens, e o PGC tem 905 deles;
  - o PGC tem 78 chaves que a T1 não trouxe, o que pode ser em parte a paginação instável da T1. Não foi conferido
    item a item.
- **Liga com o PNCP:** `numeroItemPncp` corresponde a `numeroItem` do PNCP. No Galeão, os números batem com os 32 da T1.
- **Campos que o PNCP não tem:**
  - DFD (`descricaoObjetoDfd`, `nivelPrioridadeDfd`, `dataPrevistaFormalizacaoDemanda`, `codigoAreaDfd`);
  - projeto de compra (`tituloProjetoCompra`, `dataInicioProcessoCompra`, `dataFimProcessoCompra`);
  - `statusContratacaoExecucao`, `itemSustentavel` e as datas de atualização do artefato, do projeto, do DFD e do item.
- **`statusContratacaoExecucao`:** `null` em 736 das 1.714 linhas. O significado dos códigos (1, 11, 4, 2…) não está
  no OpenAPI.

**Prós:** filtra por classe; é rápido; traz o contexto de planejamento (DFD e projeto de compra) que o PNCP não publica.

**Contras:** só cobre o SISG; tem linhas duplicadas; cobre bem menos que o PNCP; tem códigos de status sem domínio
documentado.

## T5: contratos (OpenAPI)

Arquivos versionados em [`openapi/`](./openapi/), baixados em 09/10/2026 às 14:31:

| Arquivo | Origem | Tamanho original | SHA-256 do original |
|---|---|---|---|
| `pncp-integracao-v3-api-docs-2026-10-09.json` | `https://pncp.gov.br/pncp-api/v3/api-docs` | 406.753 B | `aa12199e3b8718ba41f16ca5e711864f81bcae422d1e307a3d0eea15105497d9` |
| `pncp-consulta-v3-api-docs-2026-10-09.json` | `https://pncp.gov.br/api/consulta/v3/api-docs` | 37.943 B | `0b745eb89dd54b6336b09b5f4baf3ddc13342cca23b16a4a1ed4e30d01fdb1ca` |
| `compras-dadosabertos-v3-api-docs-2026-10-09.json` | `https://dadosabertos.compras.gov.br/v3/api-docs` | 148.511 B | `5386cf3a4f577397dcd9da282ed3a97c47b413282678a48f2eb14b80a3822167` |

Os arquivos estão formatados (indentação de 2). O SHA-256 é do JSON como veio do servidor.

**Treina × produção (integração):**
- `https://treina.pncp.gov.br/pncp-api/v3/api-docs` tem 406.753 B, o mesmo tamanho, e SHA-256
  `ca0ed5711ea6fa87e9ca07aec14ed0bbdcae9cda9b8051fc9d2cb8372ff793ca`.
- A comparação campo a campo mostra que a **única** diferença está nos `example` de campos de data. São 122 valores,
  `2026-10-07T17:28:23` no treina e `2026-10-08T13:25:37` em produção, e parecem ser o horário de subida de cada
  ambiente.
- Paths, parâmetros, schemas e segurança são idênticos. Por isso o treina não foi versionado à parte.
- Pela decisão do Marcelo, o treina entra só como contrato e não foi consultado para dado.

**Endpoints de PCA na integração** (`servers: /api/pncp`). Os GET são públicos; o resto exige `security`:

| Método | Path | Parâmetros |
|---|---|---|
| GET | `/v1/orgaos/{cnpj}/pca/{ano}/consolidado` | — |
| GET | `/v1/orgaos/{cnpj}/pca/{ano}/consolidado/unidades` | `pagina`, `tamanhoPagina` |
| GET | `/v1/orgaos/{cnpj}/pca/{ano}/quantidade` | — |
| GET | `/v1/orgaos/{cnpj}/pca/{ano}/csv` | — |
| GET | `/v1/orgaos/{cnpj}/pca/{ano}/valorescategoriaitem` | `categoriaItem` |
| GET | `/v1/orgaos/{cnpj}/pca/{uasg}/{ano}/sequenciaisplano` | — |
| GET | `/v1/orgaos/{cnpj}/pca/{ano}/{sequencial}/consolidado` | — |
| GET | `/v1/orgaos/{cnpj}/pca/{ano}/{sequencial}/itens` | `categoria`, `pagina`, `tamanhoPagina` (mínimo 1, sem máximo) |
| GET | `/v1/orgaos/{cnpj}/pca/{ano}/{sequencial}/itens/quantidade` | `categoria` |
| GET | `/v1/orgaos/{cnpj}/pca/{ano}/{sequencial}/itens/plano` | — |
| GET | `/v1/orgaos/{cnpj}/pca/{ano}/{sequencial}/itens/contratacao` | `numeroContratacao` (obrigatório), `pagina`, `tamanhoPagina` |
| GET | `/v1/orgaos/{cnpj}/pca/{ano}/{sequencial}/valorescategoriaitem` | `categoriaItem` |
| GET | `/v1/categoriaItemPcas`, `/v1/categoriaItemPcas/{id}` | `statusAtivo` |
| POST/PATCH/DELETE | inserir, retificar e excluir plano e itens; `categoriaItemPcas` | exigem token (fora do nosso uso) |

**Endpoints de PCA na consulta** (`servers: /api/consulta`), todos GET e públicos:

| Path | Obrigatórios | Opcionais | `tamanhoPagina` |
|---|---|---|---|
| `/v1/pca/` | `anoPca`, `codigoClassificacaoSuperior`, `pagina` | `tamanhoPagina` | 10 a 500 |
| `/v1/pca/atualizacao` | `dataInicio`, `dataFim`, `pagina` | `cnpj`, `codigoUnidade` (exige `cnpj`, medido), `tamanhoPagina` | 10 a 500 |
| `/v1/pca/usuario` | `anoPca`, `idUsuario`, `pagina` | `codigoClassificacaoSuperior`, `cnpj`, `tamanhoPagina` | 10 a 500 |

Os três devolvem `PaginaRetornoPlanoContratacaoComItensDoUsuarioDTO`.

## Recomendação de fonte

| Uso | Fonte | Por quê |
|---|---|---|
| **Descoberta de planos com itens da classe** | T1 `/api/consulta/v1/pca/` (13 páginas de 500 por classe e ano) | É o único filtro por classe no PNCP. Dá `idPcaPncp` e `dataAtualizacaoGlobalPCA` de cada plano. Lida com deduplicação. Não serve sozinha para provar ausência. |
| **Itens de um plano (carga e atualização)** | T3 `/api/pncp/v1/orgaos/{cnpj}/pca/{ano}/{seq}/itens?tamanhoPagina=2000`, filtrando `classificacaoSuperiorCodigo` no cliente | É completa e estável, leva de 0,2 a 0,4 s e não pula item. Resolve os itens que a T1 pula. |
| **Backfill** | T1 para listar os 935 planos, depois a T3 plano a plano em fatias com orçamento de tempo | São cerca de 13 + 935 requisições, uns 16 min a 1 req/s. A gravação é em lote por plano. |
| **Incremental diário** | T1 (descoberta), comparando `dataAtualizacaoGlobalPCA` com o banco, e depois a T3 só nos planos novos ou alterados | Pelos números de 09/10, são de 38 (média de 7 dias: 269) a 78 (últimas 24 h) planos por dia. A T2 global não responde hoje, e a T2 com `cnpj` é redundante. |
| **Reconciliação mensal** | T3 em todos os planos conhecidos, mais a comparação de contagem com a T1 | A ausência só se prova pela T3 (o plano inteiro). Um item some do banco só se a T3 do plano não o trouxer, ou se o plano sumir da T1 em duas varreduras seguidas e a T3 confirmar. |
| **Enriquecimento (futuro, fora da 0012)** | T4 PGC `2_consultarPgcDetalheCatalogo` | DFD e projeto de compra para órgãos SISG, com deduplicação obrigatória. |

**O que reavaliar se mudar:**
- se a T2 global voltar a responder dentro de 50 s para um dia de 2026, ela pode substituir a T1 como detector diário.
  Mesmo assim, traz todas as classes e precisa de filtro no cliente;
- se a T1 passar a ter ordenação estável, ela pode voltar a ser a fonte de itens.

**Riscos de operação medidos:**
- a primeira página fria da T1 leva até 57 s. É espera de I/O, não CPU da Edge Function, mas consome o relógio da
  invocação. Precisa de nova tentativa;
- o cache do servidor dura minutos: a página 1 que levou 9 s às 14:32 levou 57 s às 14:42.
