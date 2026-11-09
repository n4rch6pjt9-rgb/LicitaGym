# Schemas para consultas — Portal de Compras MG (catálogo SIAD)

Catálogo de materiais e serviços do Estado de Minas Gerais, **fora do CATMAT federal**. Consulta pública, sem login.

- **Tela:** https://www1.compras.mg.gov.br/n/catalogo/itemmaterialouservico
  ("Materiais e serviços > Consulta a itens de materiais ou itens de serviços")
- **Base:** `https://www1.compras.mg.gov.br/servico/catalogo/itemmaterialservico/Consulta`
- **Coletor:** `services/coletor-externo/coletor/compras_mg_catalogo.py` (CLI, JSON + CSV, não grava no banco)
- **Medido em:** 09/11/2026, no DevTools da tela e por sondagem do endpoint. Não há documentação oficial publicada.

Os grupos e as classes seguem a numeração FSC, a mesma do CATMAT (78 recreação e desporto, 7830 ginástica). Os
códigos de item (`codigo`, 9 dígitos) e de material (`materialOuServico.codigoFormatado`, 8 dígitos) são do SIAD.
**Não são `codigoItem` nem `codigoPdm` do CATMAT** e não devem ser misturados com eles.

---

## `GET /recuperarDadosIniciais`

Listas de domínio da tela. O coletor só usa `grupos`.

| Campo | Forma | Observação |
|---|---|---|
| `grupos` | `[{id, codigo, descricao}]` | 84 grupos. **`id` é interno e diferente de `codigo`** (grupo 78 → id 72; grupo 72 → id 66) |
| `classes` | `[{id, codigo, descricao}]` | mesmo padrão |
| `situacoes` | `[{id, descricao}]` | `ATIVO`, `SUSPENSO_PARA_COMPRA` |
| `tiposGrupo` | `[{id, descricao}]` | `MATERIAL`, `SERVICO` |
| `tipoPesquisa` | `[{id, descricao}]` | modo de busca por texto (`CONSIDERAR_TUDO`, ...); o coletor não usa |
| `naturezaDespesa`, `elementoItemDespesa` | listas | não usadas |

## `POST /pesquisar`

Corpo (classe Java `ParametrosPesquisaRest`). **Campo desconhecido dá 4xx** (`Unrecognized field ... not marked as
ignorable`). A mensagem de erro lista seis propriedades: `ordenacoes`, `reqId`, `filtros`, `textoConfirmacao`,
`page`, `sizePerPage`. O coletor manda as cinco abaixo (`textoConfirmacao` não foi testado):

```json
{
  "reqId": 2,
  "ordenacoes": [{"sortName": "id", "sortOrder": "asc"}],
  "sizePerPage": 100,
  "page": 1,
  "filtros": {"situacoes": ["ATIVO"], "tiposGrupo": "MATERIAL", "idGrupo": "72"}
}
```

| Campo | Observação |
|---|---|
| `page` | começa em 1 |
| `sizePerPage` | a tela usa 100. Valor máximo **não medido**; o coletor limita a 1..100 |
| `filtros` | objeto (lista dá erro). `idGrupo` é o **id interno** do grupo, em string. `idGrupo: "78"` devolve o grupo 84 |
| `ordenacoes` | lista de `OrdenacaoRest {sortName, sortOrder}` (só esses dois campos). `sortName` é propriedade da entidade Hibernate: `id` e `codigo` funcionam, `codigoFormatado` dá `QueryException`. `asc`/`desc` aceitos em qualquer caixa |

**Paginação instável sem ordenação.** A tela manda `ordenacoes: []`. Assim, as páginas repetiram itens e a coleta do
grupo 78 trouxe 1273 de 1363. Com `sortName: "id"` vieram 1363 de 1363, sem código repetido. Sempre ordenar por `id`.

Resposta:

```json
{"resultado": {"total": 1363, "dados": [ { "...item..." } ]}}
```

Erro do servidor vem como `{"mensagem": "...", "identificadorErro": "..."}` (sem `resultado`). O coletor trata ausência de `resultado.dados` ou de `total` inteiro como erro.

### Campos do item usados no CSV

| Campo API | Coluna CSV |
|---|---|
| `codigo` | `codigo_item` (código SIAD, 9 dígitos) |
| `id`, `versao` | `id_interno`, `versao` |
| `situacao.descricao` | `situacao` |
| `ehMaterialOuServico.id` | `tipo` |
| `materialOuServico.classe.codigoGrupoFormatado` / `.codigoNomeFormatado` | `grupo`, `classe` |
| `materialOuServico.codigoFormatado` / `.nome` | `codigo_material`, `nome_material` |
| `materialOuServico.naturezaDespesa.nome` | `natureza_despesa` |
| `especificacaoCompleta` | `especificacao` |
| `especificacaoComplementar` | `especificacao_complementar` (texto quebrado em linhas de 70 colunas, como vem) |
| `sinonimos` | `sinonimos` (separados por `;`, espaços de preenchimento removidos) |
| `marcaReferencia`, `linhasFornecimentoFormatadas` | `marca_referencia`, `linhas_fornecimento` |
| `sustentavel`, `ehGenerico`, `ehItemComum`, `possuiRefMelhorPreco` | `sim`/`nao`; nulo fica vazio |
| `quantidadeItensSimilares` | `qtd_itens_similares` |

O item completo fica no JSON bruto; `payload_hash` é `coletor.proveniencia.hash_payload(item)`.

## Contagens medidas (09/11/2026, situação ATIVO)

| Grupo (id) | Total |
|---|---|
| 78 (72) | 1363: 7830 = 516, 7820 = 490, 7810 = 351, 7835 = 6 |
| 84 (78) | 1907 |
