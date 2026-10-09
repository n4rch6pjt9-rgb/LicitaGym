# 0007: Auditar as tabelas das migrations contra os campos das APIs oficiais

- **Status:** rascunho
- **Issue:** nenhuma. Pedido do Marcelo em 09/10, depois da #281: "por que deduplicação, se todas as APIs vêm de
  dadosabertos.compras.gov.br? Inclua uma spec de análise entre o que está nas migrations e a API". Relacionada: #282.
- **Área:** pncp, coletor, migrations, docs
- **Depende do ok do Marcelo:** sim. As decisões de fonte (qual API é a oficial para cada dado) são de produto.

## Problema

**1. Nem toda tabela vem de dadosabertos.compras.gov.br.** O repositório usa duas famílias de API oficial. Levantado no
código em 09/10:

| Tabela | Quem grava | API oficial |
|---|---|---|
| `pca_planos`, `pca_itens` | Edge `sync-pncp-pca` | **PNCP Consulta**: `https://pncp.gov.br/api/consulta/v1/pca/` (`_shared/pncp/consulta-client.ts:16,239`) |
| `pca_pgc_itens` | Python `coletor/compras_pgc.py` | **Compras.gov**: `dadosabertos.compras.gov.br/modulo-pgc/2_consultarPgcDetalheCatalogo` (`compras_pgc.py:31-32`). Vazia em produção em 09/10 (0 linhas) |
| `contratacoes_atas` | Edge `sync-pncp-contratacoes-atas` | PNCP Consulta `/atas` |
| `atas_rp_itens` | Python `coletor/compras_arp.py` | Compras.gov `/modulo-arp/2_consultarARPItem` |
| `contratacoes_editais`, `contratacoes_itens` | Edge `sync-pncp-contratacoes-*` | PNCP Consulta `/contratacoes/publicacao` |
| `licitacoes_externas`, `licitacao_itens` (fonte PNCP) | Python `coletor/pncp.py` | PNCP Search + `/api/pncp/v1/.../itens` |
| `licitacao_resultados` | Python `coletor/pncp.py` | PNCP `/api/pncp/v1/.../itens/{n}/resultados` |
| `resultados_itens_14133` | não encontrado quem grava | documentada como Compras.gov `/modulo-contratacoes/3_consultarResultadoItensContratacoes_PNCP_14133` |
| `precos_praticados_itens` | Python `coletor/compras_precos.py` | Compras.gov `/modulo-pesquisa-preco/1_consultarMaterial` |

**2. A deduplicação PNCP × PGC parte de uma premissa não verificada.**
- **A regra** (`docs/bi-cruzamento-apis.md:78`, view `v_bi_pca_radar`): o mesmo item planejado aparece nas duas APIs e
  é casado por órgão + UASG + ano + `numero_item_pncp`.
- **A própria doc se contradiz** (`bi-cruzamento-apis.md:11-12`): o PGC seria "órgãos do SISG" e o PNCP PCA "entes
  federados". Se os públicos fossem disjuntos, não haveria o que deduplicar.
- **O que não existe no repositório:**
  - documento que afirme que o PGC publica no PNCP;
  - teste que case as duas fontes;
  - prova de que `numeroItemPncp` (PGC) = `numeroItem` (PNCP) e de que `codigoUnidade` (PNCP) = `codigoUasg` (PGC),
    incluindo formato e zeros à esquerda.
- **Defeitos de lógica encontrados na view, além da #282** (chave nula):
  - o `NOT EXISTS` olha `pca_pgc_itens` inteira, sem o filtro de escopo. Um item do PGC fora do escopo derruba o
    mesmo item do PNCP dentro do escopo, e o item some do radar;
  - a chave única do PGC inclui `codigo_item_catalogo`, então vários itens do PGC podem ter o mesmo
    `numero_item_pncp`. Quantidade e valor não batem com o item único do PNCP.

**3. Ninguém confere o de-para campo da API → coluna.**
- **Schemas no repositório:**
  - Compras.gov: só a lista de paths (`docs/compras-gov/comprasgov_schema_77endpoints.json`, sem campos);
  - PNCP: de-para parcial à mão (`docs/pncp/schemas-consultas-pncp.md`).
- **O que fica sem conferência:**
  - os 37 campos do `FtPgcDetalheDTO` (PGC) não estão documentados;
  - `orgao` do PGC: o código assume CNPJ, mas `docs/pncp/contract-matrix.md:126` descreve o parâmetro como nome.
- **Lacunas já vistas:**
  - **campo da API que não é gravado:** `numeroItemPncp` no PCA do PNCP;
  - **coluna sem origem na API:** `pca_itens.prioridade`, nunca preenchida pelo normalizer.

## Abordagem

Análise primeiro, correção depois. Esta spec entrega a **matriz de proveniência** e os testes que a mantêm
verdadeira. Correções de schema ou de view viram specs ou issues próprias, cada uma com o seu ok.

**1. Snapshot dos contratos oficiais**, versionado em `docs/fontes/openapi/`, com data e SHA-256:
- Compras.gov: `https://dadosabertos.compras.gov.br/v3/api-docs` (OpenAPI, inclui os DTOs com campos);
- PNCP Consulta: `https://pncp.gov.br/api/consulta/v3/api-docs`;
- PNCP integração/search: só se a URL oficial do OpenAPI existir. Se não existir, fica registrado como "sem contrato
  público" e entra na matriz como tal.

O download é feito uma vez, por script com timeout e retry. Os testes leem só o snapshot e nunca chamam a API.

**2. Inventário do que o código grava**, extraído dos normalizers:
- `_shared/pncp/normalize.ts`;
- `coletor/compras_*.py`;
- `coletor/pncp.py`.

E das migrations: as colunas de cada tabela, no banco descartável do `validar-migrations.sh`.

**3. Matriz `docs/fontes/matriz-proveniencia.md`**, uma linha por coluna de tabela de dado oficial:

`tabela.coluna | fonte (API, endpoint, DTO.campo) | transformação | tipo na API × tipo na coluna | status`

O status é um destes:
- `ok`;
- `campo não gravado`;
- `coluna sem origem`;
- `tipo divergente`;
- `derivado` (calculado, com a regra);
- `não verificado`.

**4. Pares de fontes que se sobrepõem.** Para cada par (PCA PNCP × PGC, atas PNCP × ARP, resultados PNCP × Compras
14.133, compras via Search × Consulta), a matriz registra:
- a chave de casamento usada hoje;
- a premissa;
- a evidência: documento oficial ou amostra real, com data.

**5. Amostra real da sobreposição PCA.**
- Com o PGC carregado só para as classes 7830/7220 de 2026, rodar uma consulta só leitura contando, entre PNCP e PGC,
  os itens casados pela chave da view e os que ficaram sem casar.
- O objetivo é provar ou refutar a premissa da deduplicação com número.
- Carregar o PGC é ação do Marcelo, pelo Cloud Run Job ou manual, e fica registrado no PR.

## Critérios de aceite

| ID | Dado / Quando / Então | Teste que prova |
|---|---|---|
| CA-1 | **Dado** o snapshot OpenAPI em `docs/fontes/openapi/`, **quando** o teste lê o arquivo, **então** o SHA-256 confere com o registrado em `docs/fontes/openapi/INDEX.md`, e cada endpoint usado no código (paths de `consulta-client.ts` e `coletor/compras_*.py`) existe no snapshot. Endpoint usado e ausente no snapshot faz o teste falhar. | pytest `tests/test_fontes_endpoints.py` |
| CA-2 | **Dado** um normalizer que lê o campo `X` da resposta, **quando** `X` não existe no DTO do snapshot do endpoint, **então** o teste falha com `endpoint, campo`. | pytest `tests/test_fontes_campos.py` (Python) e Deno `tests/supabase/fontes_campos_test.ts` (normalize.ts) |
| CA-3 | **Dado** as migrations aplicadas no banco descartável, **quando** o check roda, **então** toda coluna das tabelas de dado oficial listadas na matriz tem uma linha na matriz. Coluna nova sem linha faz o check falhar. | SQL `supabase/tests/fontes_matriz_check.sql` (lê a matriz exportada em CSV gerado no build do teste) ou pytest equivalente |
| CA-4 | A matriz lista, para cada par de fontes sobrepostas, a chave de casamento, a premissa e a evidência (com data) ou "não verificado". Nenhuma premissa sem evidência aparece como verificada. | revisão + pytest que valida o formato (`status` dentro do domínio) |
| CA-5 | **Dado** o PGC carregado (7830/7220, 2026), **quando** a consulta de sobreposição roda, **então** o PR registra os números de casados por chave, itens do PGC sem par e itens do PNCP sem par, e a conclusão sobre a premissa da deduplicação. | consulta só leitura registrada no PR (`scripts/fontes/sobreposicao_pca.sql`) |
| CA-6 | Os dois defeitos de lógica da view (escopo no `NOT EXISTS` e vários itens do PGC por `numero_item_pncp`) ficam registrados na #282 com caso de teste proposto. | link na #282 |

## Fora de escopo

- Mudar view, migration, normalizer ou coletor. Cada achado da matriz vira issue ou spec própria, como a #282.
- Escolher a fonte "vencedora" de cada dado. Isso é decisão do Marcelo, tomada com a matriz em mãos.
- Coletar endpoints novos.

## Impacto em dados

- **Migration:** não.
- **Tabelas, views e funções:** só leitura, pelo banco descartável e por consultas só leitura em produção, feitas
  pelo MCP ou pelo Marcelo.
- **ACL/RLS:** nenhum.
- **Backfill:** não. A carga do PGC para o CA-5 é a coleta normal do coletor, feita pelo Marcelo.
- **Edge Functions republicadas no merge:** nenhuma muda. O merge só traz docs e testes.
- **Contrato com o Dashboard:** inalterado.
- **Dado oficial x derivado:** é o próprio objeto da spec. A matriz separa o campo oficial da transformação e do
  derivado.

## Perguntas em aberto

1. **Escopo da primeira entrega:** começar só pelo PCA (PNCP × PGC, o que motivou a pergunta) ou cobrir todas as
   tabelas de dado oficial da tabela acima?
2. **Onde o PGC entra no produto:** o PGC (`pca_pgc_itens`) deve fazer parte do radar? Ele está vazio em produção. Se
   a fonte oficial de PCA for só o PNCP, o ramo do PGC sai da view e a deduplicação deixa de existir.
3. **Rede para o snapshot:** testado em 09/10, a sessão cloud **não** alcança os dois portais (o proxy devolve 403 em
   `dadosabertos.compras.gov.br` e `pncp.gov.br`). Duas saídas: o Marcelo libera os dois hosts na política de rede do
   ambiente, ou baixa os dois `/v3/api-docs` e anexa ao PR.
4. **Frequência:** o teste de contrato (CA-1/CA-2) roda só na CI do PR, ou também num job semanal que baixa o
   OpenAPI de novo e abre issue quando a API oficial muda?
