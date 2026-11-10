# 0052: Estruturar o catálogo do Sistema S como o CATMAT e deixar cada tenant escolher os itens

- **Status:** rascunho (plano; aguarda as respostas das perguntas em aberto)
- **Alimenta:** spec-mãe 0032, fase 3 (agentes de edital e de preço ancorados no produto) e o filtro de oportunidades
  do Sistema S. Estende a `specs/0053-catalogo-sistema-s-de-para-catmat.md` (K-1 e K-3 dela viram a base daqui) e usa
  o estudo da `specs/0051-estudo-murais-sistema-s.md`.
- **Repositório:** os dois (backend vai ao ar antes do front)
- **Issue:** nenhuma
- **Área:** migrations | coletor (`services/coletor-externo`) | edge-functions | catmat | dashboard-tela
- **Depende do ok do Marcelo:** sim (migrations, tenant/RLS, decisão de produto)

## Ideia em uma frase

Cada portal Paradigma do Sistema S tem um catálogo próprio em árvore **Portal → Classe → Produto**, o equivalente ao
**Grupo → Classe → PDM → Item** do CATMAT. Guardar essa árvore no banco e deixar o tenant marcar nós dela (com herança
e exclusão, como faz hoje `catalogo_empresa_catmat`) resolve três coisas de uma vez: o coletor passa a saber o que
coletar sem lista fixa no código, o item da licitação casa com o produto por id (sem texto) e cada tenant vê só o
que vende.

## Leitura obrigatória antes de implementar

| # | Arquivo | Por quê |
|---|---|---|
| 1 | `specs/0053-catalogo-sistema-s-de-para-catmat.md`, `specs/0051-estudo-murais-sistema-s.md`, `specs/murais_sistema_s.xlsx` | tabelas de produto e de-para já desenhadas; o que cada mural expõe |
| 2 | `supabase/migrations/20260930100000_catalogo_empresa_catmat.sql` | modelo a copiar: regra por nível, herança para baixo, `incluido = false` exclui nó herdado, `chave` gerada |
| 3 | `supabase/functions/api-catmat/` | navegação da árvore e registro de nó pelo admin (padrão da API nova) |
| 4 | `specs/0033-tenant-explicito.md` (Fora de escopo, item 6), `specs/0024-syncs-nacionais-catalogo-cron.md` (decisão 5) | `catalogo_empresa_catmat` sem `tenant_id` já está anotado como pendência |
| 5 | `supabase/functions/_shared/tenant.ts` | filtro por empresa de quem chama; vínculo inválido → 403 |
| 6 | `services/coletor-externo/coletor/paradigma.py` (`CATEGORIAS_MAPEADAS`, `CATEGORIAS_POR_FONTE`, `classes_catalogo`, `catalogo_com_avisos`, `produtos_escopo`), `coletor/catalogo_paradigma.py` | hoje a lista de categorias é fixa no código e casa por nome exato |
| 7 | `supabase/migrations/20260925120000_sistema_s_coleta_externa.sql`, `20260929130000_acl_sistema_s_catalogos.sql` | `fontes_externas` e ACL do Sistema S |
| 8 | `.claude/rules/database-migrations.md`, `.claude/rules/coletor.md`, `.claude/rules/catmat.md`, `.claude/rules/edge-functions.md` | convenções |
| 9 | skills `nova-migration`, `validar-migrations`, `verificar-producao`, `ux-ui-licitagym`, `run-dashboard`; agentes `revisor-codigo`, `revisor-migration`, `revisor-seguranca` | |

## Problema (medido em 09/11/2026: MCP somente leitura, endpoint público da FIEB e HAR do Marcelo)

| Fato | Evidência |
|---|---|
| A seleção do CATMAT não é por tenant | `catalogo_empresa_catmat`: 179 regras, sem coluna `tenant_id` (catálogo único da plataforma) |
| As categorias do Sistema S estão fixas no código e casam por nome exato | `CATEGORIAS_MAPEADAS` (padrão) e `CATEGORIAS_POR_FONTE` (fiems, fiemt) em `paradigma.py` |
| Com nome fixo, o catálogo de um portal some calado | FIEB: as categorias padrão "EQUIPAMENTOS ESPORTIVOS" e "ESPORTIVO" não existem lá; `produtos_escopo()` devolveu 0 produtos (o aviso do #494 apareceu). FIEMS e FIEMT ficaram com 0 pelo mesmo motivo até o #493 |
| A árvore de cada portal é Classe → Produto, com id de classe próprio | FIEB, `PesquisarCatalogoProdutoClasses`: "ACADEMIA" → 226 EQUIPAMENTOS PARA ACADEMIA, 391 e 446 (manutenção/reforma); "ESPORT" → 401, 192 MATERIAL ESPORTIVO, 458 UNIFORMES |
| Tamanho das classes varia muito | FIEB: classe 226 = 123 produtos (todos tipo produto), 192 = 1.031, 401 = 0 |
| Cada portal tem a própria árvore | Sesc DN usa código de classe (`PT030`, `ES1205`; 131 produtos, 0053); FIEMS classe 20; FIEMT classes 9, 91, 172, 191 |
| O item da licitação já aponta para o produto do catálogo | `licitacao_itens.raw.nCdProduto` nas fontes Paradigma: produtos distintos por fonte — fieb 420, sesc_senac_rs 293, fiergs 240, firjan 191, sescsp 170, sestsenat 120, sescba 114, sescrj 93, sfiec 84, fiesc 13, findes 0 (6 itens) |
| O item não traz a classe | 0 itens com `raw.nCdClasse` em todas as fontes: a classe do item só sai do catálogo (pelo `nCdProduto`) |
| O id do produto só vale dentro do portal | ids iguais entre portais são coincidência (0053, "Problema") |
| Se o código interno (`sCdProdutoEmpresa`) tem hierarquia (prefixo = grupo) | não medido (FIEMS `003.00045`, FIEMT 15 dígitos, Sesc DN 15 dígitos sugerem que sim) |

## Modelo proposto (equivalência com o CATMAT)

| CATMAT | Sistema S (por portal) | Onde fica |
|---|---|---|
| Grupo | Portal (`fontes_externas.slug`) | já existe |
| Classe | Classe do catálogo do portal (`nCdClasse`, `sDsClasse`) | K-1 (nova) |
| PDM | não existe no Paradigma; o papel é feito pelo de-para com o PDM CATMAT | K-3 (0053) |
| Item | Produto (`nCdProduto`, `sCdProdutoEmpresa`, descrição, tipo) | K-2 (0053 K-1, com FK para a classe) |
| `catalogo_empresa_catmat` | Seleção do tenant por nível (portal, classe, produto), com herança e exclusão | K-4 (nova) |

## Contrato

| ID | Contrato | Entrada | Saída | Erros | Quem |
|---|---|---|---|---|---|
| K-1 | Tabela `public.sistema_s_catalogo_classes` (migration) | — | uma linha por (`fonte`, `id_classe_fonte`): `nome`, `codigo` (quando o portal tem, ex. `PT030`), `primeira_coleta_em`, `ultima_coleta_em`, `qtd_produtos` da última coleta | — | RLS sem policy; só `service_role` |
| K-2 | Tabela de produtos da 0053 (K-1 de lá) com FK (`fonte`, `id_classe_fonte`) para K-1 | — | como na 0053 | — | idem |
| K-3 | De-para produto ↔ CATMAT (0053 K-3 e K-4) | — | como na 0053 | — | idem |
| K-4 | Tabela `public.catalogo_tenant_sistema_s` (migration) | — | regras por tenant: `tenant_id`, `nivel` (`portal`, `classe`, `produto`), `fonte`, `id_classe_fonte`, `id_produto_fonte`, `incluido`, `nome_snapshot`, `observacao`, autoria e datas; `chave` única por tenant | combinação de nível inválida → `check_violation` | RLS ligada; escrita e leitura só pela API (K-6) |
| K-5 | Função `public.sistema_s_produtos_efetivos(p_tenant uuid)` | tenant | produtos incluídos pela herança (portal → classe → produto), descontadas as exclusões | tenant inexistente → erro | `service_role` |
| K-6 | Edge Function `api-catalogo-sistema-s` (ações `arvore`, `registrar`, `remover`, `listar_regras`) | portal/classe para navegar; nó para registrar | árvore com contagem de produtos e marcação do tenant | sem vínculo ou empresa desativada → 403; papel `operacao` → 403 em `registrar`/`remover`; nó que não existe em K-1/K-2 → 400 | `await requireUserAuth` + `_shared/tenant.ts`; admin do tenant grava |
| K-7 | Coletor: categorias por fonte vindas do banco | união das classes marcadas por algum tenant ativo (K-4) | `produtos_escopo` usa as classes de K-1 por **id**, não por nome; `CATEGORIAS_POR_FONTE` vira só semente da primeira carga | nenhuma classe marcada para a fonte → aviso e coleta só por texto (como hoje), nunca catálogo vazio calado | coletor (`service_role`) |
| K-8 | Coleta da árvore (estende o `catalogo_paradigma.py` da 0053 K-2) | fonte | grava todas as classes (K-1) e os produtos das classes marcadas por algum tenant (K-2) | aviso de paginação → não grava (regra da 0053) | operador e, depois, cron semanal |
| K-9 | Filtro de oportunidades do Sistema S por tenant | tenant | item de licitação entra quando (`fonte`, `raw.nCdProduto`) está em K-5; senão segue a regra de texto atual | — | `api-dashboard-oportunidades` (filtrando pela empresa de quem chama) |
| K-10 | Tela "Catálogo Sistema S" no Dashboard (ao lado de `/catmat`) | — | navegar Portal → Classe → Produto, marcar/desmarcar, ver o de-para CATMAT sugerido | estados de carregando, vazio e erro | Dashboard |

## Critérios de aceite

| ID | Contrato | Dado / Quando / Então | Teste que prova |
|---|---|---|---|
| CA-1 | K-1, K-4 | **Dado** as tabelas, **então** RLS ligada, `anon` e `authenticated` sem privilégio, `service_role` com select/insert/update | SQL `supabase/tests/catalogo_tenant_sistema_s_check.sql` |
| CA-2 | K-5 | **Dado** o tenant A com a classe 226 da FIEB incluída e um produto dela excluído, **quando** pede os efetivos, **então** vêm os outros produtos da classe e não o excluído; o tenant B, sem regra, não recebe nada | mesmo check |
| CA-3 | K-6 | **Dado** um usuário do tenant A, **quando** lê ou grava regra mandando `tenant_id` do tenant B, **então** 403 e nada muda | Deno `tests/supabase/functions/api_catalogo_sistema_s_test.ts` |
| CA-4 | K-6 | **Dado** papel `operacao`, **quando** chama `registrar`, **então** 403 | mesmo teste |
| CA-5 | K-7 | **Regressão (FIEB com 0 produtos, 09/11):** **dado** classe marcada por id, **quando** o portal muda o nome da classe, **então** a coleta continua pelo id e registra o nome novo em K-1 | pytest `services/coletor-externo/tests/test_paradigma.py` |
| CA-6 | K-7 | **Dado** fonte sem nenhuma classe marcada, **quando** coleta, **então** aviso no log e coleta só por texto | mesmo pytest |
| CA-7 | K-9 | **Dado** item da FIEB com `nCdProduto` incluído para o tenant A, **então** aparece para A e não para B; o mesmo `nCdProduto` em outro portal não conta | Deno `tests/supabase/functions/api_dashboard_oportunidades_test.ts` |
| CA-8 | K-10 | **Dado** a tela, **então** estados de carregando, vazio e erro; `operacao` vê sem botão de marcar | vitest no Dashboard |

## Skills e agentes por contrato

| Contrato | Desenho | Implementação | Teste | Revisão antes do PR | Depois do merge |
|---|---|---|---|---|---|
| K-1, K-4, K-5 | `/spec` | skill `nova-migration` | SQL `_check` + skill `validar-migrations` | `revisor-migration` + `revisor-seguranca` (RLS de tenant) | `verificar-producao` + `get_advisors` |
| K-6, K-9 | `/spec` | `/implement` (TDD) | Deno | `revisor-codigo` + `revisor-seguranca` (`service_role`, tenant) | `verificar-producao` |
| K-7, K-8 | `/spec` | `/implement` (TDD) | pytest | `revisor-codigo` | contagem antes/depois por fonte no PR |
| K-10 | `ux-ui-licitagym` | `/implement` no Dashboard | vitest + skill `run-dashboard` | `revisor-codigo` | conferir na tela |

## Fase 0: estudo de reutilização do catálogo por entidade (antes de qualquer migration)

O desenho de K-1/K-2 depende de saber se os portais compartilham catálogo. Se dois portais usam a mesma base, o
catálogo se guarda uma vez e os dois apontam para ela; se são independentes, guarda-se por portal. Hoje isso não está
medido.

**O que já se sabe (09/11/2026, MCP somente leitura, `licitacao_itens.raw` das 11 fontes Paradigma com item):**
- Por **id de produto**, nenhum par de portais compartilha base. Há 15 coincidências de `nCdProduto` entre pares
  (fieb × sesc_senac_rs 8, fieb × firjan 2, firjan × sfiec 2, firjan × sesc_senac_rs 1, sescba × sestsenat 1,
  sescrj × sestsenat 1), e **nenhuma** com a mesma descrição.
- Isso vale também entre portais no mesmo host SaaS (`egov.paradigmabs.com.br`: sesc_senac_rs, sescrj, sescba): cada
  um tem base própria.
- O item da licitação **não traz** `sCdProdutoEmpresa`. Reutilização de **codificação** (o mesmo código interno em
  bases diferentes, ex. Sesc regional copiando o padrão do Sesc DN) **não foi medida**.
- Ressalva: a amostra é só de itens no escopo (viés para academia) e é pequena.

**Hipóteses a testar:**

| # | Hipótese | Como se confirma |
|---|---|---|
| H1 | Os Sesc regionais (SP, RJ, BA, RS) reutilizam a codificação do Sesc DN (classe com código `PT030`, código interno de 15 dígitos) | mesmo `sCdProdutoEmpresa` com a mesma descrição, ids diferentes |
| H2 | Senac compartilha com Sesc onde o portal é único (sesc_senac_rs) e não nos outros | classes e códigos de sesc_senac_rs × sescdn |
| H3 | As federações da indústria (FIEB, FIEMS, FIEMT, FIERGS, Firjan, Findes, FIESC, SFIEC) são independentes entre si | sem código nem nome de classe em comum além do acaso |
| H4 | Sest Senat é independente | idem |

**Passos (só endpoint público, sem login, `DELAY_SEGUNDOS >= 1`, mesma cobertura de robots/WAF do coletor):**

1. **Inventário:** para cada um dos 12 portais do Paradigma, registrar entidade, host (próprio ou SaaS) e `nCdEmpresa`.
2. **Catálogo inteiro por portal** (método trocado na execução): o autocomplete `PesquisarCatalogoProdutoClasses`
   devolve no máximo 5 classes e busca por substring, então a varredura A–Z não funciona. No lugar,
   `PesquisarCatalogoProdutos` com `nCdClasse: 0` e `nCdTipo: 0` devolve o catálogo inteiro, 100 por página
   (`nPaginaDe`/`nPaginaAte`). Por produto: `nCdProduto`, `sCdProdutoEmpresa`, `sDsProduto`, `nCdClasse`,
   `sDsClasse`, tipo, `sDsCatalogos`, `sDsEmpresas`, unidade. Isso substitui a amostra de três classes: a matriz usa
   o catálogo todo.
3. **Matriz portal × portal** com cinco medidas:
   - (a) mesma classe: id e nome;
   - (b) mesmo produto: id e descrição (base compartilhada);
   - (c) mesmo código interno com a mesma descrição (codificação reutilizada);
   - (d) mesma descrição com código diferente (texto copiado);
   - (e) máscara do código interno (`003.00045`, 15 dígitos, etc.).
4. **Veredito por portal:**
   - `base compartilhada com X` (b);
   - `codificação de X` (c);
   - `independente` (nem b nem c acima do acaso, isto é, mais de 5% dos produtos do menor catálogo do par).

**Saída:**
- arquivo de coleta fora do repositório, porque dado de coleta não se versiona;
- resumo da matriz e veredito nesta spec;
- o modelo de K-1/K-2 escolhido:
  - **por portal**, se tudo der independente;
  - **por origem de catálogo**, com o portal apontando para a origem, se houver base compartilhada;
  - **código de referência** em K-2 para a busca cruzada, se houver só codificação reutilizada.

**Depois disso:** a fase 1 só começa com o veredito registrado aqui.

### Resultado da fase 0 (09/11/2026)

Execução: endpoint público `PesquisarCatalogoProdutos`, sem login, uma thread por host, intervalo de 1 s, FIEMG fora
(WAF). Arquivos de coleta fora do repositório (scratchpad da sessão).

| Portal | Produtos | Classes | Tipos | Máscara do código interno |
|---|---|---|---|---|
| fieb | 138.959 | 173 | Produto 116.806 / Serviço 22.153 | `99999999` (100%) |
| fiems | 34.293 | 37 | Produto 34.288 / Serviço 5 | `99999`, `999999` |
| fiemt | 14.545 | 246 | Produto 12.433 / Serviço 2.112 | 15 dígitos |
| fiesc | 14.616 | 2.953 | Produto 12.802 / Serviço 1.814 | `99999999` |
| findes | 18.411 | 179 | Produto 15.028 / Serviço 3.383 | `99999`, `9999` |
| firjan | 37.889 | 457 | Produto 37.889 | `999999` |
| sesc_senac_rs | 23.639 | 641 | Produto 23.036 / Serviço 603 | `999-999-999-999` |
| sescba | 19.728 | 398 | 5 tipos (inclui "Fundo Rotativo") | `9.9.999`, `99.999.99` |
| sescdn | 22.331 | 340 | Produto 20.822 / Serviço 1.509 | 15 dígitos, `AA` + 13 dígitos |
| sescrj | 21.935 | 297 | Produto 21.935 | `99999999` |
| sescsp | 119.192 | 2.433 | todos "Solicitação de cadastro de produto" | `99.99.99.999-9` |
| sestsenat | 39.603 | 65 | Produto 16.417 / Serviço 23.186 | 12 dígitos, `A` + 11 dígitos |
| **total** | **505.141** | | | |
| fiergs | não medido | | | HTTP 403 (bloqueio; não se contorna) |
| sfiec | não medido | | | HTTP 500 no catálogo sem classe |

Matriz portal × portal (66 pares):
- (b) mesmo id + descrição: **0 em todos os pares**;
- (c) mesmo código interno + descrição: **0 em todos os pares**;
- mesmo código sem a mesma descrição: no máximo 189 (fiems × sesc_senac_rs, 0,8%), coincidência numérica;
- (d) mesma descrição: no máximo 1,1% do menor catálogo (sescrj × sescsp 239; sescsp × sestsenat 446), nomes
  genéricos;
- (a) classe com mesmo id + nome: 1 em fieb × fiemt, 0 nos demais.

Hipóteses: **H1 refutada** (Sesc regionais não usam a codificação do Sesc DN; cada um tem máscara própria);
**H2 confirmada** (sesc_senac_rs tem catálogo próprio, sem relação com sescdn); **H3 confirmada** para as 6
federações medidas; **H4 confirmada**.

Ressalvas:
- sescsp marca todo produto com o tipo "Solicitação de cadastro de produto": o filtro por tipo (produto ×
  serviço) não funciona nesse portal;
- fiergs e sfiec ficam sem veredito.
- **Robots (09/11/2026, depois da medição):** os hosts SaaS `egov.paradigmabs.com.br` (sesc_senac_rs, sescba,
  sescrj) e `scr360.paradigmabs.com.br` (sescsp) têm `Disallow: /` no robots.txt. A fase 0 baixou o catálogo desses
  quatro pelo override do mural (05/10). Pela decisão do Marcelo de 09/11 (não contornar robots), os arquivos desses
  quatro foram apagados e eles **não entram** no catálogo. O `egov-br.paradigmabs.com.br` (sescdn) **não tem**
  robots.txt (404), nem `X-Robots-Tag` nem meta robots em `/sescdn/Default.aspx` (conferido em 09/11): o Sesc DN não
  está bloqueado e entra. O veredito acima fica como registro; o catálogo da fase 1 cobre os 8 portais sem bloqueio
  (fieb, fiems, fiemt, fiesc, findes, firjan, sescdn, sestsenat; sfiec quando o endpoint responder).

**Veredito: todos os 12 portais medidos são `independente`. Modelo de K-1/K-2: por portal**, sem tabela de origem
compartilhada nem código de referência entre portais. A busca cruzada entre portais fica com o de-para CATMAT
(K-3).

## Fases (cada uma é um PR; a ordem importa)

1. **Base do catálogo (K-1, K-2, K-8 manual).** Migration das classes e produtos; coleta manual de todas as classes
   dos 12 portais do cron e dos produtos das classes de academia já conhecidas (FIEB 226, FIEMS 20, FIEMT 9/91/172/191,
   Sesc DN PT030/ES1205). Contagem por fonte no PR.
2. **Seleção por tenant (K-4, K-5, K-6).** Migration da seleção, função de efetivos e API. Semente: a seleção atual
   (as classes fixas do código) vira regra do tenant Konnen.
3. **Coletor lê a seleção (K-7).** Some a lista fixa; a classe passa a ser buscada por id. Dry-run antes/depois por
   fonte no PR.
4. **Filtro de oportunidades (K-9).** O item do Sistema S entra pelo produto; o texto continua como segunda regra.
5. **De-para CATMAT (K-3, da 0053).** Sugestão determinística e confirmação por SQL.
6. **Tela (K-10)** no Dashboard, depois do backend publicado.

## Fora de escopo

- `tenant_id` em `catalogo_empresa_catmat` (CATMAT por tenant): mesma ideia, spec própria (pendência da 0033, item 6);
  o fluxo Grupo → PDM → Item do CATMAT fica como está (decisão de 09/11).
- Portais fora do Paradigma (Sesc CE, SE, RN, DF, PE, PI, MT, AL, TO, SC): não têm este catálogo (estudo 0051).
- FIEMG (WAF) e FIEMT no runner (ConnectTimeout): bloqueio não se contorna.
- Casamento por modelo de linguagem.

## Impacto em dados

- **Migration:** sim, duas (fase 1: classes e produtos; fase 2: seleção por tenant), aditivas e idempotentes.
- **Tabelas/views/funções tocadas:** `sistema_s_catalogo_classes`, `sistema_s_catalogo_produtos`,
  `sistema_s_catalogo_catmat`, `catalogo_tenant_sistema_s` (novas); `sistema_s_produtos_efetivos` (nova). Escrita do
  catálogo só pelo coletor; escrita da seleção só pela `api-catalogo-sistema-s`.
- **ACL/RLS:** RLS ligada em todas; `revoke all` de `anon`, `authenticated` e `public`; só `service_role`. A API filtra
  pelo tenant de quem chama (`_shared/tenant.ts`). É RLS de tenant: pede branch Supabase sob demanda (CLAUDE.md).
- **Backfill/reprocessamento:** carga das classes e produtos (contagem antes 0 e depois, por fonte); semente da
  seleção do tenant Konnen a partir das classes fixas de hoje.
- **Edge Functions republicadas no merge:** todas (regra do repositório); mudam `api-catalogo-sistema-s` (nova) e
  `api-dashboard-oportunidades` (fase 4).
- **Contrato com o Dashboard:** muda na fase 4 (filtro) e na 6 (tela nova); backend antes do front.
- **Dado oficial × derivado:** classe, produto e código interno vêm do catálogo público do portal, com data da coleta.
  A seleção é escolha do tenant. O de-para CATMAT é derivado e fica `sugerido` até alguém confirmar.
- **Volume e custo (09/11/2026):** banco hoje 1.791 MB (`licitacao_itens` 598 MB / 284 mil linhas, medido). Catálogo
  dos 8 portais sem bloqueio de robots = 320.647 produtos (medido; 505.141 com os 4 bloqueados, que ficam fora); só colunas, sem `raw`: estimado 150 a 200 MB (não medido). Embedding
  só sob demanda (decisão de 09/11): custo de vetor e de Vertex AI proporcional ao catálogo do cliente, não ao
  catálogo inteiro.

## Decisões do Marcelo

- 09/11/2026: FIEB entra pela classe 226 (EQUIPAMENTOS PARA ACADEMIA); a 192 (MATERIAL ESPORTIVO, 1.031 produtos)
  fica fora por enquanto.
- 09/11/2026: o banco do CATMAT está completo. Um tenant novo escolhe pelo **Grupo** e, a partir dele, os PDMs e os
  itens. Esse fluxo do CATMAT fica como está e esta spec não o redesenha. O Sistema S segue o mesmo padrão de seleção
  (nível alto → filhos, com herança e exclusão).
- 09/11/2026: antes de desenhar as tabelas do Sistema S, fazer o estudo de extração por entidade (fase 0). Os
  catálogos divergem, e é preciso saber quem reutiliza o catálogo de quem e quem é independente.
- 09/11/2026: **embedding sob demanda, nunca do catálogo inteiro.** Só ganham vetor os produtos do Sistema S ligados ao
  catálogo de um cliente (seleção do tenant), na hora em que a seleção é feita. O catálogo completo (505.141 produtos
  nos 12 portais medidos) fica só em colunas, sem vetor.
- 09/11/2026 (pergunta 1): **não contornar robots.txt** nem resolver captcha, no catálogo e em qualquer coleta nova.
  Os quatro portais em hosts com `Disallow: /` (sescsp, sesc_senac_rs, sescrj, sescba) ficam fora do catálogo; o
  sescdn (`egov-br`, sem robots.txt) entra.
- 09/11/2026 (pergunta 2): **sem herança** pelo CATMAT. O de-para serve de **referência de preço homologado entre os
  catálogos** e aparece na oportunidade relacionada: na aba Itens, a coluna CATMAT do item do Sistema S (hoje "—")
  mostra o CATMAT do de-para, marcado como derivado.
- 09/11/2026 (perguntas 3 e 4): sem nível "grupo" por prefixo (a fase 0 mostrou máscara própria por portal); só o
  admin do tenant marca.
- 09/11/2026 (pergunta 5): **funciona como o CATMAT.** O catálogo do portal fica completo no banco; a sincronização
  traz só as oportunidades que têm itens do catálogo parametrizado pelo tenant.
- 09/11/2026 (pergunta 6): classes de serviço (FIEB 391 e 446) ficam fora; serviço nunca vira lead.

## Perguntas em aberto

Nenhuma: as seis foram respondidas em 09/11/2026 (ver "Decisões do Marcelo").
