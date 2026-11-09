# 0053: Guardar o catálogo de produtos do Sistema S e sugerir o de-para com o CATMAT

- **Status:** rascunho (aguarda a 0051 para K-5)
- **Alimenta:** spec-mãe 0032, fase 3 (regras do estudo nos agentes): o agente de edital compara CATMAT × TR (NX-T29)
  e o agente de preço compara pela assinatura do produto, não pelo CATMAT cadastrado. Em edital do Sistema S, o
  produto do catálogo da entidade é a âncora que falta.
- **Repositório:** LicitaGym
- **Issue:** nenhuma
- **Área:** migrations | coletor (`services/coletor-externo`) | catmat
- **Depende do ok do Marcelo:** sim (migration, carga de dado e decisão de produto)

## Leitura obrigatória antes de implementar

| # | Arquivo | Por quê |
|---|---|---|
| 5 | `specs/0032-agentes-dentro-da-tarefa.md`, `docs/produto/nexor-agentes-edital-juridico.md` | fase 3; NX-T29 (CATMAT × TR × valor) |
| 7 | `.claude/rules/database-migrations.md`, `.claude/rules/coletor.md`, `.claude/rules/catmat.md`, `.claude/rules/python-ingestion.md` | convenções da área |
| 8 | `services/coletor-externo/coletor/catalogo_paradigma.py`, `services/coletor-externo/coletor/paradigma.py` (`catalogo_com_avisos`, `FONTES`, `FONTES_MURAL_AUTORIZADO`), `services/coletor-externo/tests/test_catalogo_paradigma.py` | extrator do catálogo (PR #490) |
| 8 | `services/coletor-externo/coletor/catmat_ancoras.py` | casamento determinístico de texto com o CATMAT, já usado na classificação |
| 8 | `services/coletor-externo/coletor/destino.py` | cliente Supabase do coletor (`env`, gravação com `service_role`) |
| 8 | `supabase/migrations/20260925120000_sistema_s_coleta_externa.sql`, `supabase/migrations/20260929130000_acl_sistema_s_catalogos.sql` | tabelas e ACL do Sistema S (`fontes_externas`) |
| 8 | `public.catalogo_de_para`, `public.catalogo_ponte` (schema em produção) | modelos parecidos com outro propósito: `catalogo_de_para` liga produto do **tenant** a item de licitação/PCA; `catalogo_ponte` liga item CATMAT a item de PCA |
| 9 | `docs/compras-gov/schemas-consultas.md` | hierarquia CATMAT (`codigoItem` ≠ `codigoPdm`) e espelho `catalogo_itens` |
| 10 | skills `nova-migration`, `validar-migrations`, `verificar-producao`; agentes `revisor-codigo`, `revisor-migration`, `revisor-seguranca` | |

## Problema (medido em 08/11/2026, MCP somente leitura e execução do extrator)

| Fato | Evidência |
|---|---|
| O catálogo do Sistema S não está no banco | nenhuma tabela de catálogo de entidade; `catalogo_produtos` é o catálogo do tenant |
| Sesc DN tem 131 produtos nas categorias de academia, todos com código interno | extrator do PR #490 em 08/11/2026: `PT030 - EQUIP CONDICIONAMENTO FISICO` 52, `ES1205 - EQUIP E MAT ESPORTIVO` 79 |
| Itens de licitação do Sistema S quase nunca trazem o código do catálogo | 11 fontes, 548 licitações e 5.321 itens; só `sfiec` tem `catalogo_codigo_item` (149 itens, 84 códigos distintos, nenhum no formato de 15 dígitos do Sesc DN) |
| Edital do Sistema S traz só o PDM, e o CATMAT cadastrado na compra pode não descrever o equipamento | PE Sesc 126135/2026 (Pregão 11/2026 no ComprasGov): 11 de 14 itens com CATMAT de outro equipamento (graviton, esteira infantil, step de EVA) |
| Espelho CATMAT disponível para o casamento | `catalogo_itens`: 1.788 itens ativos, 596 na classe 7830 |
| Quanto do catálogo do Sesc DN casa com algum item CATMAT | não medido |
| Todo item dos portais Paradigma no banco guarda o id do produto do portal (`raw.nCdProduto`) | 10 fontes Paradigma, 5.321 itens, 100% com `nCdProduto` (findes: 6 itens sem produto) |
| Dentro de um portal, as unidades compradoras usam o mesmo catálogo | mesmo `nCdProduto` em 2 ou mais unidades: FIEB 106 de 420 produtos (17 unidades), FIRJAN 68 de 191 (22 unidades), Sesc BA 12 de 114 (11 unidades) |
| Entre portais, o `nCdProduto` não identifica o mesmo produto | ids repetidos entre portais (0 a 7 por fonte) são coincidência: 11163 é "PUXADOR" no Sesc RJ e "MESA AUXILIAR" no SEST SENAT; 17374 é "BANCO FIXO" na FIRJAN e "ESPALDAR" no Sesc/Senac RS |
| Algumas entidades põem o próprio código na descrição do item | Sesc/Senac RS (`002-001-029-137 CAIXA PARA SALTO PEQUENA`), SFIEC (`MC0600716-WALL BALL...`) |
| Se o código interno (`sCdProdutoEmpresa`) é nacional no Sesc ou no Sistema S | não medido: o Sesc DN não tem licitação no banco e os outros portais ainda não tiveram o catálogo coletado |

## Contrato

| ID | Contrato | Entrada | Saída | Erros | Quem |
|---|---|---|---|---|---|
| K-1 | Tabela `public.sistema_s_catalogo_produtos` (migration) | — | um produto por (`fonte`, `id_produto_fonte`): `codigo_entidade` (`sCdProdutoEmpresa`), `descricao`, `tipo`, `categoria_codigo`, `categoria_nome`, `id_categoria`, `payload_hash`, `primeira_coleta_em`, `ultima_coleta_em`; `fonte` com FK para `fontes_externas.slug` | — | RLS ligada sem policy; `service_role` lê e grava; `anon` e `authenticated` sem acesso |
| K-2 | `python -m coletor.catalogo_paradigma ... --gravar` | fonte e categorias | upsert em K-1 por (`fonte`, `id_produto_fonte`); `payload_hash` muda só se o dado mudou; produto que sumiu do portal não é apagado (fica com `ultima_coleta_em` antiga) | catálogo cortado (aviso de paginação): sai 3 e não grava nada; categoria inexistente: sai 2 | operador (Marcelo), com `SUPABASE_SERVICE_ROLE_KEY` em variável de ambiente |
| K-3 | Tabela `public.sistema_s_catalogo_catmat` (migration) | — | sugestões por produto: `codigo_item_catmat` (texto) e/ou `codigo_pdm`, `nivel` (`catmat_item`, `pdm`), `score`, `evidencia` (termos casados), `metodo_versao`, `status` (`sugerido`, `confirmado`, `rejeitado`), `revisado_por`, `revisado_em`, `nota` | `nivel = catmat_item` exige código do item; `nivel = pdm` exige PDM e item nulo; `rejeitado` exige nota | RLS ligada sem policy; `service_role` lê e grava |
| K-4 | `python -m coletor.catalogo_sistema_s_catmat` (sugestão) | produtos de K-1 e espelho `catalogo_itens` | sugestões determinísticas (mesmo texto → mesma sugestão). Regra principal (decisão de 08/11): no PDM 2640, casar o nome do produto com o atributo **"TIPO:"** da descrição do item CATMAT (ex.: 460540 "TIPO: FLEXORA DEITADA"); com um item, `nivel = catmat_item`; com vários itens do mesmo TIPO, `nivel = pdm` com os itens candidatos na evidência; demais PDMs pelo casamento de texto de `catmat_ancoras.py`. Nunca grava `confirmado`; não sobrescreve linha `confirmado` ou `rejeitado` | espelho CATMAT vazio: erro, nunca "sem sugestão" | operador |
| K-5 | Matriz de uso do catálogo (`python -m coletor.matriz_catalogo_sistema_s`, saída CSV fora do repositório) | itens de certames homologados ou encerrados dos portais Paradigma no banco + catálogo de cada portal (K-2) | por fonte e unidade compradora: `nCdProduto`, código interno, descrição do item, nº de certames; resumo de quantos produtos são compartilhados entre unidades do mesmo portal e quantos códigos internos se repetem entre portais com a mesma descrição | fonte sem catálogo coletado: marcada "sem catálogo", nunca "zero em comum" | operador; leitura com `service_role` |

## Critérios de aceite

| ID | Contrato | Dado / Quando / Então | Teste que prova |
|---|---|---|---|
| CA-1 | K-1, K-3 | **Dado** as tabelas, **então** RLS ligada, nenhuma policy, `anon` e `authenticated` (de qualquer tenant) sem nenhum privilégio, `service_role` com select, insert e update e sem delete | SQL `supabase/tests/sistema_s_catalogo_check.sql` |
| CA-2 | K-3 | **Dado** uma sugestão `nivel = catmat_item` sem código do item, ou `rejeitado` sem nota, **quando** gravada, **então** `check_violation` | mesmo check |
| CA-3 | K-2 | **Dado** a mesma lista de produtos, **quando** gravada duas vezes, **então** o número de linhas não muda e `payload_hash` também não; mudando a descrição de um produto, só ele muda | pytest `services/coletor-externo/tests/test_catalogo_paradigma.py` |
| CA-4 | K-2 | **Regressão do PR #490:** **dado** aviso de paginação (página repetida), **quando** roda com `--gravar`, **então** sai 3 e nada é gravado | mesmo pytest |
| CA-5 | K-4 | **Dado** o mesmo catálogo e o mesmo espelho, **quando** a sugestão roda duas vezes, **então** as sugestões são iguais (código, nível, score) e nenhuma é `confirmado` | pytest `services/coletor-externo/tests/test_catalogo_sistema_s_catmat.py` |
| CA-6 | K-4 | **Dado** uma linha `confirmado` ou `rejeitado`, **quando** a sugestão roda de novo, **então** a linha não muda | mesmo pytest |
| CA-7 | K-4 | **Dado** o espelho CATMAT vazio ou inacessível, **quando** a sugestão roda, **então** erro com saída diferente de zero, sem gravar "sem sugestão" | mesmo pytest |
| CA-8 | K-4 | **Dado** o produto "FLEXORA DEITADA" e um único item do PDM 2640 com "TIPO: FLEXORA DEITADA", **então** a sugestão é `nivel = catmat_item` com esse item; com dois itens do mesmo TIPO, `nivel = pdm` com os dois na evidência | pytest `services/coletor-externo/tests/test_catalogo_sistema_s_catmat.py` |
| CA-9 | K-5 | **Dado** dois portais com o mesmo `nCdProduto` e descrições diferentes, **quando** a matriz roda, **então** eles não contam como produto compartilhado; o mesmo código interno com a mesma descrição em dois portais conta | pytest `services/coletor-externo/tests/test_matriz_catalogo_sistema_s.py` |

## Skills e agentes por contrato

| Contrato | Desenho e leitura | Implementação | Teste | Revisão antes do PR | Depois do merge |
|---|---|---|---|---|---|
| K-1, K-3 | `/spec` | skill `nova-migration` | SQL `_check` + skill `validar-migrations` | `revisor-migration` + `revisor-seguranca` (ACL/RLS) | `verificar-producao` + `get_advisors` |
| K-2, K-4, K-5 | `/spec` | `/implement` (TDD) | pytest | `revisor-codigo` + `revisor-seguranca` (`service_role` no coletor) | `verificar-producao` (contagem das tabelas) |

## Fora de escopo

- Tela de revisão do de-para (o Dashboard): primeiro por SQL; a tela vem depois (decisão de 08/11).
- Ligar o produto do Sistema S ao item da licitação (`licitacao_itens.catalogo_codigo_item`) e ao produto do tenant.
- Uso pelos agentes (NX-T29, agente de preço): entra na fase 3 da 0032 depois desta base.
- Casamento por modelo de linguagem: a regra do projeto é casamento determinístico ancorado no CATMAT.
- Coleta agendada (Cloud Run Job ou cron).

## Impacto em dados

- **Migration:** sim, `supabase/migrations/<timestamp>_sistema_s_catalogo.sql` (aditiva, idempotente; duas tabelas).
- **Tabelas/views/funções tocadas:** `sistema_s_catalogo_produtos` e `sistema_s_catalogo_catmat` (novas). Escrita só
  pelo coletor (`service_role`); leitura só `service_role` por enquanto.
- **ACL/RLS:** RLS ligada sem policy nas duas; `revoke all` de `anon`, `authenticated` e `public`; `service_role` com
  select, insert e update (sem delete: produto que sumiu do portal fica com a data da última coleta).
- **Backfill/reprocessamento:** carga inicial do Sesc DN (131 produtos, contagem de 08/11/2026) pelo K-2 depois do
  merge, com a contagem antes (0) e depois no PR.
- **Edge Functions republicadas no merge:** todas (regra do repositório); nenhuma muda.
- **Contrato com o Dashboard:** inalterado.
- **Dado oficial × derivado:** o produto e o código interno vêm do catálogo público da entidade, com fonte e data da
  coleta. O de-para com o CATMAT é derivado e fica `sugerido` até alguém confirmar; o código CATMAT vem do espelho
  oficial (`catalogo_itens`), nunca digitado.

## Decisões do Marcelo (08/11/2026)

- **Fontes e código entre regionais:** antes de decidir, fazer a matriz (K-5) com todos os certames homologados do
  Sistema S no banco, por unidade compradora, ids e descrições dos itens, para saber se as entidades usam o mesmo
  catálogo. A carga de K-1 começa pelo Sesc DN; as outras fontes entram conforme a matriz.
- **Quem confirma o de-para:** por SQL agora; tela depois.
- **Nível da sugestão:** casar pelo atributo "TIPO:" dos itens do PDM 2640, onde está a maioria dos casamentos.
- **Reaproveitar tabela existente:** avaliar antes de criar. Avaliação (08/11):
  - `catalogo_de_para` não serve. A linha exige `tenant_id`, `produto_id` com FK para `catalogo_produtos` (produto do
    tenant) e `fonte` in (`pca`, `licitacao`) com o item de PCA ou de licitação. O alvo aqui é o CATMAT, não um item de
    certame, e o produto do Sistema S não é de tenant.
  - `catalogo_ponte` (item CATMAT → entidade, `tipo_correspondencia` exata/provável/incerta, `evidencia`) é a mais
    próxima, mas `entidade_id` é uuid, não tem `status`, `score`, `revisado_por` nem `metodo_versao`, e hoje é usada
    só pela ligação do PCA (`link-catmat-pca`, 4.501 linhas, todas `pca_item`). Acrescentar revisão ali mexe no caminho
    do PCA.
  - Proposta: tabela nova (K-3), com o mesmo vocabulário de `catalogo_ponte` para o nível de correspondência. Confirmar.

### Decisões de 08/11/2026 (segunda rodada)

- **Escopo CATMAT para testar a cobertura:** classe 7830, PDMs 2640 (Aparelho / Equipamento para Condicionamento
  Físico) e 7115 (Esteira Elétrica). Outras classes e PDMs ficam para depois da medição.
- **Tabela nova para o de-para:** confirmada.
- **Catálogo por portal:** o catálogo do Sesc DN não serve para os outros (o id de produto é de cada portal; ver
  "Problema"). K-1 e K-2 passam a guardar o catálogo completo de cada portal, com chave (`fonte`, `id_produto_fonte`).
- **Coleta para a matriz:** antes de K-5, estudar o que cada mural expõe. Esse estudo é a spec
  `specs/0051-estudo-murais-sistema-s.md`, com a planilha `specs/murais_sistema_s.xlsx`. K-5 depende dela.

## Perguntas em aberto

Nenhuma nesta spec até o resultado da 0051.
