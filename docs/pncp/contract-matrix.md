# Matriz de contratos PNCP (CLA-34)

Fonte definitiva: Swagger e manual oficial. Status `verified` = confirmado no OpenAPI ou manual v1.0.

| recurso | camada | método | path | auth | params obrigatórios | paginação | chave natural | lacunas |
|---------|--------|--------|------|------|---------------------|-----------|---------------|---------|
| PCA listagem (itens por classificação) | consulta | GET | `/api/consulta/v1/pca/` | nenhuma | `anoPca`, `codigoClassificacaoSuperior`, `pagina` | `tamanhoPagina` (20–500; omitir = ~200); retorno `paginasRestantes`, `totalRegistros`, `data[]` com `idPcaPncp` + `itens[]` | `idPcaPncp` (`{CNPJ14}-0-{seq6}/{ano}`) | CATMAT grupo/classe ou CATSER seção. ⚠️ Medido em 09/10/2026: `tamanhoPagina` vai de 10 a 500 no OpenAPI; `totalRegistros` conta itens; a paginação repete e **pula itens** na fronteira entre páginas (não serve para provar ausência); página 1 fria de 46 a 57 s. Uso: descoberta de planos (spec 0012) |
| PCA órgão (índice Search) | search | GET | `/api/search/` | nenhuma | `tipos_documento=pcaorgao`, `pagina` | `tam_pagina`, `anos`, `ordenacao=-data` | `orgao_cnpj` + `ano` | **Lastro de período:** `data_publicacao_pncp`, `data_atualizacao_pncp` — decide se roda carga anual |
| PCA atualização global | consulta | GET | `/api/consulta/v1/pca/atualizacao` | nenhuma | `dataInicio`, `dataFim`, `pagina` | `tamanhoPagina` (20–500); ⚠️ params `dataInicio`/`dataFim` (não `dataInicial`) | `idPcaPncp` | ⚠️ Medido em 09/10/2026: `dataFim` é exclusivo (00:00); sem `cnpj` dá 500 em ~50 s para um dia de 2026; `codigoUnidade` exige `cnpj`. Não usado (spec 0012) |
| PCA por usuário | consulta | GET | `/api/consulta/v1/pca/usuario` | nenhuma | `anoPca`, `idUsuario`, `pagina` | `tamanhoPagina` (20–500) | `idPcaPncp` | `idUsuario` é portal PNCP, não usuário Monitor |
| PCA detalhe órgão | integração | GET | `/api/pncp/v1/orgaos/{cnpj}/pca/{ano}/{sequencial}` | nenhuma no GET (medido 09/10/2026; POST/PATCH/DELETE exigem token) | `cnpj`, `ano`, `sequencial` | — | `cnpj` + `ano` + `sequencial` | uso para enriquecimento, não listagem global |
| PCA itens | integração | GET | `/api/pncp/v1/orgaos/{cnpj}/pca/{ano}/{sequencial}/itens` | nenhuma no GET (medido 09/10/2026) | path | `pagina`, `tamanhoPagina` (OpenAPI: mínimo 1, sem máximo; 2000 aceito e devolveu 1.800 itens; teto real não medido); resposta é **array puro**, sem total; `categoria` (1 = Material) é o único filtro | `(idPcaPncp, numeroItem)` | Nomes diferentes da consulta: `quantidade`, `descricao`, `nomeClassificacao`, `dataPublicacaoPncp` (consulta: `quantidadeEstimada`, `descricaoItem`, `nomeClassificacaoCatalogo`, `dataPublicacaoPNCP`); valores iguais no plano do Galeão. Fonte dos itens no sync por fila (spec 0012) |
| PCA quantidade de itens | integração | GET | `/api/pncp/v1/orgaos/{cnpj}/pca/{ano}/{sequencial}/itens/quantidade` | nenhuma no GET (medido 09/10/2026) | path; `categoria` opcional | — | — | Número puro (todas as categorias sem `categoria`). Confere que a leitura paginada dos itens não foi truncada (spec 0012) |
| Contratações publicação | consulta | GET | `/api/consulta/v1/contratacoes/publicacao` | nenhuma | `dataInicial`, `dataFinal`, `codigoModalidadeContratacao`, `pagina` | `tamanhoPagina` (10–**50**) | `numeroControlePNCP` / `cnpj`+`ano`+`sequencial` | exige modalidade por consulta |
| Contratações proposta | consulta | GET | `/api/consulta/v1/contratacoes/proposta` | nenhuma | `dataFinal`, `codigoModalidadeContratacao`, `pagina` | `tamanhoPagina` (10–**50**) | idem | — |
| Contratações atualização | consulta | GET | `/api/consulta/v1/contratacoes/atualizacao` | nenhuma | `dataInicial`, `dataFinal`, `codigoModalidadeContratacao`, `pagina` | `tamanhoPagina` (10–**50**) | idem | preferível para incremental |
| Contratação detalhe | consulta | GET | `/api/consulta/v1/orgaos/{cnpj}/compras/{ano}/{sequencial}` | nenhuma | path | — | `cnpj`+`anoCompra`+`sequencialCompra` | — |
| Atas vigência | consulta | GET | `/api/consulta/v1/atas` | nenhuma | `dataInicial`, `dataFinal`, `pagina` | `tamanhoPagina` (10–500) | `numeroControlePNCPAta` | envelope `PaginaRetornoAtaRegistroPrecoPeriodoDTO` |
| Atas atualização | consulta | GET | `/api/consulta/v1/atas/atualizacao` | nenhuma | `dataInicial`, `dataFinal`, `pagina` | `tamanhoPagina` (10–500) | idem | idem |
| Contratos publicação | consulta | GET | `/api/consulta/v1/contratos` | nenhuma | `dataInicial`, `dataFinal`, `pagina` | `tamanhoPagina` (10–500) | `numeroControlePNCP` contrato | — |
| Contratos atualização | consulta | GET | `/api/consulta/v1/contratos/atualizacao` | nenhuma | `dataInicial`, `dataFinal`, `pagina` | `tamanhoPagina` (10–500) | idem | — |
| Instrumentos cobrança inclusão | consulta | GET | `/api/consulta/v1/instrumentoscobranca/inclusao` | nenhuma | `dataInicial`, `dataFinal`, `pagina` | `tamanhoPagina` (10–**100**) | — | probe 2026-09-19: 500 → 400 |
| IRP listagem global | consulta | — | — | — | — | — | — | **LACUNA**: manual consulta v1.0 não expõe listagem IRP |
| IRP detalhe | integração | GET | `/api/pncp/v1/orgaos/{cnpj}/irp/{ano}/{sequencial}` | credencial órgão | path | — | `cnpj`+`ano`+`sequencial` | ingestão exige descoberta por órgão monitorado |
| IRP itens | integração | GET | `/api/pncp/v1/orgaos/{cnpj}/irp/{ano}/{sequencial}/itens` | credencial órgão | path + `pagina` | `pagina`, `tamanhoPagina` | `(irp_key, numeroItem)` | — |
| Órgãos | integração | GET | `/api/pncp/v1/orgaos/{cnpj}` | variável | `cnpj` | — | `cnpj` (14 dígitos) | — |
| Unidades | integração | GET | `/api/pncp/v1/orgaos/{cnpj}/unidades/{codigoUnidade}` | variável | path | — | `cnpj`+`codigoUnidade` | — |
| Catálogos | integração | GET | `/api/pncp/v1/catalogos`, `/v1/catalogos/{id}` | variável | — | — | `id` | — |
| CATMAT grupo | compras.gov | GET | `/modulo-material/1_consultarGrupoMaterial` | nenhuma | — | `pagina` | `codigoGrupo` | Dados Abertos Compras.gov.br |
| CATMAT classe | compras.gov | GET | `/modulo-material/2_consultarClasseMaterial` | nenhuma | `codigoGrupo` | `pagina` | `(codigoGrupo, codigoClasse)` | verified |
| CATMAT PDM | compras.gov | GET | `/modulo-material/3_consultarPdmMaterial` | nenhuma | `codigoGrupo`, `codigoClasse` | `pagina`, `tamanhoPagina` | `codigoPdm` | verified |
| CATMAT item | compras.gov | GET | `/modulo-material/4_consultarItemMaterial` | nenhuma | `codigoGrupo`, `codigoClasse` | idem | `codigoItem` | chave em `catalogo_itens.codigo_catmat` |
| CATMAT natureza despesa | compras.gov | GET | `/modulo-material/5_consultarMaterialNaturezaDespesa` | nenhuma | `codigoPdm` | idem | `(codigoPdm, codigoNaturezaDespesa)` | pode retornar vazio |
| CATMAT unidade fornecimento | compras.gov | GET | `/modulo-material/6_consultarMaterialUnidadeFornecimento` | nenhuma | `codigoPdm` | idem | `(codigoPdm, siglaUnidadeFornecimento, numeroSequencial)` | verified |
| CATMAT características | compras.gov | GET | `/modulo-material/7_consultarMaterialCaracteristicas` | nenhuma | `codigoItem` | idem | `(codigoItem, codigoCaracteristica, codigoValorCaracteristica)` | verified |
| Categoria PCA | integração | GET | `/api/pncp/v1/categoriaItemPcas`, `/{id}` | variável | — | — | `id` | — |
| Usuário PNCP | integração | GET/POST | `/api/pncp/v1/usuarios`, `/login` | credencial | `login` ou `cpfCnpj` | — | `id` usuário PNCP | **MVP: não ingerir** (PII/CPF — CLA-40) |
| Legislação | scrape | GET | `https://www.gov.br/pncp/pt-br/pncp/legislacao` | nenhuma | — | — | `url_canonica` + `sha256` | sem API REST; hash de página + arquivos |

## Chaves naturais confirmadas

- **PCA órgão (Search):** portal `https://pncp.gov.br/app/pca/{CNPJ14}/{ano}` (`item_url` vem como `/pca/...` — prefixar `/app`)
- **PCA plano (Consulta):** `idPcaPncp` = `{CNPJ14}-{segmento}-{seqPad}/{ano}` (ex.: `06740278000181-0-000005/2026`); portal `https://pncp.gov.br/app/pca/{CNPJ14}-{segmento}-{seqPad}/{ano}`; integração `GET /orgaos/{cnpj}/pca/{ano}/{sequencial}/itens` com `sequencial` = parte numérica de `seqPad` (ex.: `5`)
- **PCA item:** `(id_pca_pncp, numero_item)`
- **Compra/edital:** `numeroControlePNCP` = `{CNPJ14}-1-{seqCompraPad}/{anoCompra}`; portal `https://pncp.gov.br/app/editais/{cnpj}/{anoCompra}/{sequencialCompra}` (`sequencialCompra` = numérico de `seqCompraPad`, ex.: `000015` → `15`)
- **Ata:** `numeroControlePNCPAta` = `{CNPJ14}-1-{seqCompraPad}/{anoCompra}-{seqAtaPad}`; portal `https://pncp.gov.br/app/atas/{cnpj}/{anoCompra}/{sequencialCompra}/{sequencialAta}` (4 segmentos — **não** 3)
- **Contrato:** `numeroControlePNCP` = `{CNPJ14}-2-{seqContratoPad}/{anoContrato}`; portal `https://pncp.gov.br/app/contratos/{cnpj}/{anoContrato}/{sequencialContrato}` (`sequencialContrato` alinha com campo homônimo da Consulta)
- **IRP:** `{cnpj, ano, sequencial}` — sem listagem consulta; gate ativo até endpoint público existir

## Gate de migrations

Migrations de domínio (`pca_*`, `irp_*`, `contratacoes_*`) só avançam com linha `verified` acima. IRP sync permanece desabilitado até estratégia de descoberta documentada.

## Dados Abertos Compras — inventário de endpoints

Base: `https://dadosabertos.compras.gov.br`. Sem autenticação. Envelope paginado comum:
`{ resultado[], totalRegistros, totalPaginas, paginasRestantes }`.

Fontes: catálogo de endpoints e **resultados de chamadas reais** registrados no workspace de
exploração (React/Vite), mais `compras_gov_schemas.json` e
[schemas-consultas.md](./schemas-consultas.md). Onde o catálogo escrito à mão e o teste real
divergem, **vale o teste** — ver "Conflitos de parâmetro" abaixo.

Status: `testado-ok` = chamada real bem-sucedida registrada; `testado-falha` = erro reproduzido;
`testado-vazio` = HTTP 200 sem registros; `nao-testado` = só catalogado.
Nenhum é `verified` contra o Swagger ao vivo — **o gate de migrations continua valendo.**

### 01 — CATÁLOGO MATERIAL (CATMAT)

| # | path `/modulo-material/…` | params | status | volume real |
|---|---|---|---|---|
| 1 | `1_consultarGrupoMaterial` | `pagina`, `codigoGrupo`, `statusGrupo` | testado-ok | 73 grupos |
| 2 | `2_consultarClasseMaterial` | `pagina`, `codigoGrupo`, `codigoClasse`, `statusClasse`, `bps` | testado-ok | **711** reg / 2 pág |
| 3 | `3_consultarPdmMaterial` | `pagina`, `statusPdm`, `codigoPdm`, `codigoGrupo`, `codigoClasse`, `bps` | testado-ok | **20.433** / 2.044 pág (10/pág) |
| 4 | `4_consultarItemMaterial` | `pagina`, `tamanhoPagina`, `codigoItem`, `codigoGrupo`, `codigoClasse`, `codigoPdm`, `descricaoItem`, `statusItem`, `bps`, `codigo_ncm` | testado-ok | **344.898** / 34.490 pág (~9,5 h) |
| 5 | `5_consultarMaterialNaturezaDespesa` | `pagina`, `codigoPdm`, `codigoNaturezaDespesa`, `statusNaturezaDespesa` | testado-ok ⚠️ | **22** / 1 pág — ver lacuna 5 |
| 6 | `6_consultarMaterialUnidadeFornecimento` | `pagina`, `codigoPdm`, `statusUnidadeFornecimentoPdm` | testado-ok | **38.096** / 3.810 pág (~1 h) |
| 7 | `7_consultarMaterialCaracteristicas` | `pagina`, `codigoItem` | testado-ok | **1.732.820** / 17.329 pág (100/pág, ~4,8 h) |

### 02 — CATÁLOGO SERVIÇO (CATSER)

Hierarquia de 6 níveis (seção → divisão → grupo → classe → subclasse → item), contra 3 do material.
Todos `nao-testado`.

| # | path `/modulo-servico/…` | params |
|---|---|---|
| 1 | `1_consultarSecaoServico` | `pagina`, `codigoSecao`, `statusSecao` |
| 2 | `2_consultarDivisaoServico` | `pagina`, `codigoSecao`, `codigoDivisao`, `statusDivisao` |
| 3 | `3_consultarGrupoServico` | `pagina`, `codigoDivisao`, `codigoGrupo`, `statusGrupo` |
| 4 | `4_consultarClasseServico` | `pagina`, `codigoGrupo`, `codigoClasse`, `statusGrupo` |
| 5 | `5_consultarSubClasseServico` | `pagina`, `codigoClasse`, `codigoSubclasse`, `statusSubclasse` |
| 6 | `6_consultarItemServico` | `pagina`, `tamanhoPagina`, `codigoSecao`, `codigoDivisao`, `codigoGrupo`, `codigoClasse`, `codigoSubclasse`, `codigoCpc`, `codigoServico`, `exclusivoCentralCompras`, `statusServico` |
| 7 | `7_consultarUndMedidaServico` | `pagina`, `codigoServico`, `statusUnidadeMedida` |
| 8 | `8_consultarNaturezaDespesaServico` | `pagina`, `codigoServico`, `codigoNaturezaDespesa`, `statusNaturezaDespesa` |

### 03 — PESQUISA DE PREÇO

| # | path `/modulo-pesquisa-preco/…` | status | observação |
|---|---|---|---|
| 1 | `1_consultarMaterial` | testado-ok | filtro real usado: `tipo=codigoPdm&codigo=1005` e `tipo=codigoItemCatalogo&codigo=233523` |
| 1.1 | `1.1_consultarMaterial_CSV` | **testado-falha** | 500 com filtro, 404 sem filtro — 0% sucesso |
| 2 | `2_consultarMaterialDetalhe` | testado-ok | filtro real: `codigoItemCatalogo=233523` (params batem com o do 1) |
| 2.1 | `2.1_consultarMaterialDetalhe_CSV` | **testado-falha** | 500 com e sem filtro — 0% sucesso |
| 3 | `3_consultarServico` | nao-testado | |
| 3.1 | `3.1_consultarServico_CSV` | nao-testado | presumir quebrado como 1.1/2.1 até provar |
| 4 | `4_consultarServicoDetalhe` | nao-testado | |
| 4.1 | `4.1_consultarServicoDetalhe_CSV` | nao-testado | idem |

Params catalogados (1 a 4): `pagina`, `codigoMaterial`/`codigoServico`, `codigoGrupo`, `codigoClasse`,
`codigoPdm`, `dataInicial`, `dataFinal`, `codigoUasg`, `codigoOrgao` — **contraditos pelos testes**,
ver abaixo.

Implementado em [`supabase/sql/precos_praticados.sql`](../../supabase/sql/precos_praticados.sql),
consumindo JSON (nunca o CSV).

### 04 — PGC (Plano de Gerenciamento de Contratações)

| # | path `/modulo-pgc/…` | params reais nos testes | status |
|---|---|---|---|
| 1 | `1_consultarPgcDetalhe` | `pagina`, `tamanhoPagina`, `orgao`, `anoPcaProjetoCompra` | testado-vazio ⚠️ |
| 1.1 | `1.1_consultarPgcDetalhe_CSV` | idem | testado-ok (1.298 bytes) |
| 2 | `2_consultarPgcDetalheCatalogo` | `pagina`, `tamanhoPagina`, `anoPcaProjetoCompra`, `tipo`, `codigo` | testado-ok |
| 2.1 | `2.1_consultarPgcDetalheCatalogo_CSV` | idem | testado-ok |
| 3 | `3_consultarPgcAgregacao` | `pagina`, `orgao`, `ano` | testado-vazio |
| 3.1 | `3.1_consultarPgcAgregacao_CSV` | idem | testado-ok (300 bytes) |

`orgao` é o **nome** do órgão, não o código — com acentuação e separador `·`
(`"Câmara Municipal de Linhares · ES"`). Filtro por nome literal é frágil e não dá chave estável.

`FtPgcDetalheDTO` traz `codigoPdmMaterial`, `codigoItemCatalogo`, `valorUnitarioItem` e
`numeroItemPncp` na mesma linha — é uma fonte de PCA mais rica que a API Consulta do PNCP usada hoje.

### 05 a 11 — demais módulos

| módulo | endpoints | status |
|---|---|---|
| 05 UASG | `/modulo-uasg/` `1_consultarUasg`, `1.1_…_CSV`, `2_consultarOrgao`, `2.1_…_CSV` | UASG testado-ok (100 reg/pág, inclusive `statusUasg=false`); Órgão testado-ok, mas `statusOrgao=false` volta vazio |
| 06 LEGADO (Lei 8.666) | `1_consultarLicitacao`, `1.1_…_Id`, `2_consultarItemLicitacao`, `3_consultarPregoes`, `4_consultarItensPregoes`, `5_consultarComprasSemLicitacao` | testado (ver DTOs `TbVw*`) |
| 07 CONTRATAÇÕES (Lei 14.133) | `1_consultarContratacoes_PNCP_14133` (+`_Id`), `2_consultarItensContratacoes…`, `3_consultarResultadoItensContratacoes…` | nao-testado — ponte Compras↔PNCP via `numeroControlePNCP` + `codItemCatalogo` + `codigoPdm` |
| 08 ARP | `1_consultarARP` (+`_Id`), `2_consultarARPItem`, `3_consultarUnidadesItem`, `4_consultarEmpenhosSaldoItem`, `5_consultarAdesoesItem` | nao-testado — saldo de adesão/empenho não existe na API Consulta do PNCP |
| 09 CONTRATOS | `1_consultarContratos` (+`_Id`), `2_consultarContratosItem` | nao-testado |
| 10 FORNECEDOR | `1_consultarFornecedor` (`cpfCnpj`, `nomeFornecedor`, `codigoUasg`) | nao-testado — **PII** |
| 11 OCDS | `1_releases` | nao-testado |

### Conflitos de parâmetro — resolver antes de escrever sync

1. **Pesquisa de preço.** Três versões incompatíveis do mesmo contrato: o catálogo lista
   `codigoMaterial`/`codigoPdm`/`codigoClasse` como params separados; o teste que funcionou no
   endpoint 1 usou o par **`tipo`+`codigo`** (`tipo=codigoPdm&codigo=1005`); o do endpoint 2 usou
   `codigoItemCatalogo=233523` direto. O par `tipo`+`codigo` reaparece no PGC 2, então é convenção
   da API — mas não está uniformizada.
2. **PGC.** O catálogo lista `anoPgc`, `codigoOrgao`, `codigoUasg`, `codigoUnidade`; os testes que
   funcionaram usaram `orgao` (nome) e `anoPcaProjetoCompra`. Nenhum teste usou os nomes catalogados.

### Lacunas e armadilhas confirmadas empiricamente

1. **CSV de preço está quebrado** (1.1 e 2.1): 500 com filtro, 404 sem, 0% de sucesso. Consumir JSON
   e converter no cliente. Presumir o mesmo para 3.1/4.1 até prova em contrário.
2. **Tamanho de página não é uniforme** — 10 (PDM, item, unidade), 50 (natureza), 100
   (características), ~500 (classe). Um loop de paginação genérico erra a conta.
3. **Volume exige fila, não Edge Function.** 1,73 M características e 344 k itens não cabem no
   `fetchWithTimeout` de 45 s de `_shared/pncp/retry.ts`. Usar `private.job_queue` com checkpoint
   por página. No recorte LicitaGym (classe 7830) o número cai muito, mas o sync deve assumir o
   caso geral.
4. **A conclusão de "PGC Detalhe sem dados" não se sustenta.** O JSON foi testado com Linhares,
   MEC e Saúde; o CSV **do mesmo endpoint** foi testado com Barueri/2025 e devolveu 1.298 bytes de
   dados reais. Órgãos diferentes: a comparação não prova nada. O teste decisivo está em
   [`scripts/probe-compras-api.ps1`](../../scripts/probe-compras-api.ps1), que roda os três
   testes decisivos que faltaram (A: PGC JSON com os params do CSV que funcionou; B: natureza
   de despesa com e sem filtro; C: os três contratos de parâmetro do endpoint de preço lado
   a lado).
5. **`5_consultarMaterialNaturezaDespesa` devolveu 22 registros marcados "COMPLETO"** — para 20.433
   PDMs. Ou a chamada estava filtrada por PDM, ou o endpoint exige filtro. Se o sync foi escrito
   com essa premissa, ele acha que terminou: é a explicação mais provável para
   `catmat_pdm_naturezas_despesa` estar vazia no banco.
6. **PGC Agregação: JSON 0 registros vs CSV 300 bytes com params idênticos.** Aqui a comparação é
   válida, mas 300 bytes é quase certamente só a linha de cabeçalho — CSV de tabela vazia, não
   divergência entre endpoints.
7. **`statusNaturezaDespesa` é string `"1"`/`"0"`**, não boolean, e `nomeNaturezaDespesa` pode ser
   nulo — contraria o padrão booleano das outras tabelas CATMAT.
8. **`idCompra` muda de tipo entre os dois endpoints de preço** (`integer/int64` em
   `FtPesqPrecoCompraMaterialDTO`, `string` em `...DetalheDTO`). Valores de 17 dígitos estouram
   `Number.MAX_SAFE_INTEGER`; `JSON.parse` em Deno perde precisão antes de qualquer código nosso.
   Detalhe em `supabase/sql/precos_praticados.sql`, nota 1.
9. **`codigoPdm` não tem tipo único:** `int64` nos DTOs de material, `string` nos de preço,
   ARP-unidades e espelho PNCP, `int32` em `VwFtArpItemDTO`. Zero à esquerda quebra junção em
   silêncio. Normalizar dos dois lados.
10. **PII espalhada, além do endpoint de usuários.** `UsuariosDTOResponse` expõe `senha` em DTO de
    resposta. `TbVwCompraItensSemLicitacaoDTO` tem `nu_cpf_vencedor` e três CPFs de responsáveis;
    `TbVwItemLicitacaoDTO` tem `cpf_vencedor`; `VwFtFornecedorDTO` tem `cpf`;
    `FtPesqPrecoCompraMaterialDTO.niFornecedor` pode ser CPF de pessoa física. A decisão CLA-40 em
    [security-mvp.md](./security-mvp.md) cobria só `/usuarios` — **precisa ser reaberta**.
11. `VwKpisGeralDTO` tem uma propriedade literalmente chamada `"2026-04-26"` — bug no Swagger deles.

## Cruzamentos entre domínios

O mapa de junções entre tabelas (FKs reais, junções polimórficas, candidatas não materializadas e
lacunas de integridade) está em [cruzamentos.md](./cruzamentos.md). A seção *Dados Abertos Compras*
desta matriz ainda não existe: o Swagger não pôde ser lido, e o gate acima vale — sem linha
`verified`, sem migration de domínio.

## Referências

- [cruzamentos.md](./cruzamentos.md) — junções entre tabelas (FK, lógicas, candidatas, PCA↔CATMAT)
- [schemas-consultas-pncp.md](./schemas-consultas-pncp.md) — mapeamento OpenAPI Consulta → Postgres
- [Swagger Consulta](https://pncp.gov.br/api/consulta/swagger-ui/index.html)
- [Swagger Integração](https://pncp.gov.br/api/pncp/swagger-ui/index.html)
- [Manual API Consultas v1.0](https://www.gov.br/pncp/pt-br/pncp/copy_of_manuais/ManualPNCPAPIConsultasVerso1.0.pdf)
- [Swagger Compras.gov.br — CATÁLOGO MATERIAL](https://dadosabertos.compras.gov.br/swagger-ui/index.html#/01%20-%20CAT%C3%81LOGO%20-%20MATERIAL)
