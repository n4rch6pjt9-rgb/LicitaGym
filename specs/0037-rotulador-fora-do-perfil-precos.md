# 0037: Rotular "fora do perfil" nos preços homologados com modelo de IA e conferência humana por amostra

- **Status:** aprovada (22/10, pelo Marcelo, depois das respostas às perguntas); emenda do rótulo `pdm_divergente` aprovada em 23/10; fase 0 em implementação
- **Alimenta:** spec-mãe 0032, fase 3 (referência praticada do agente de preço usa a marcação "fora do perfil" da
  0031) | módulo 9 "Preços e BI" de `docs/produto/ESCOPO.md`
- **Repositório:** os dois (backend vai ao ar antes do front): LicitaGym (rótulo, tabela, `api-precos`) e Dashboard
  (selo e botão "Ocultar fora do perfil" na /precos e no PDF)
- **Issue:** nenhuma (conversa com o Marcelo de 22/10 sobre o HAR do Pregão 5/2026 da UASG 930992)
- **Área:** coletor | migrations | edge-functions | dashboard-contrato | dashboard-tela
- **Depende do ok do Marcelo:** sim (migration nova, decisão de produto, custo de modelo, dado de produção)

## Leitura obrigatória antes de implementar

Leia nesta ordem e marque o que leu no PR. Arquivo que não existe mais é sinal de spec desatualizada: pare e avise.

| # | Arquivo | Por quê | Carrega sozinho? |
|---|---|---|---|
| 1 | `CLAUDE.md` do repositório | como roda, testa e entrega; o que não fazer | sim, no início da sessão |
| 2 | `AGENTS.md` (backend) | zero alucinação, fontes, identificadores oficiais | sim, importado pelo `CLAUDE.md` |
| 3 | `.claude/rules/regras-negocio.md` | regras de produto decididas | sim |
| 4 | `docs/produto/ESCOPO.md` | módulo 9 e módulo 3 (agentes na tarefa) | não: ler |
| 5 | `specs/0032-agentes-dentro-da-tarefa.md` (fase 3) e `specs/0031-precos-estimado-homologado-auditoria.md` (item 9 da proposta e decisões de 21/10) | onde o rótulo entra e a decisão "fora do perfil não entra na /precos" | não: ler |
| 6 | esta spec, inteira | contrato, CAs, fora de escopo | não: ler |
| 7 | `.claude/rules/coletor.md`, `.claude/rules/python-ingestion.md`, `.claude/rules/database-migrations.md`, `.claude/rules/edge-functions.md` | convenções das áreas | só ao abrir arquivo da pasta |
| 8 | `supabase/functions/api-precos/precos.ts` e o README da função | contrato atual das amostras | não: ler |
| 9 | `services/coletor-externo/coletor/ia.py` (classe `Gemini`, `extrair_campos` com JSON) e `coletor/escopo.py` (`classificar`, `excluir_compra`) | chamada ao modelo que já existe e as regras de escopo que viram sinal | não: ler |

## Problema

A base de preços mistura produtos diferentes quando o órgão cadastra o item no código CATMAT errado, e nada no
recorte avisa isso.

**Evidência medida em 22/10:**
- A compra **93099205000052026** é o Pregão 5/2026 da UASG 930992, um consórcio de manejo de resíduos sólidos (CE).
  Seu objeto é "máquinas, implementos e tratores para equipar as Centrais Municipais de Resíduos".
- Os itens 10 e 11 dessa compra entraram no **PDM 7115** como esteira ergométrica: o item 486803 a R$ 39.000 e o
  item 373980 a R$ 52.000, ambos com marca TCMAQ.
- As propostas do HAR do portal mostram o que foi comprado de fato: esteira transportadora de 6 m (Lippel ETL 6000,
  "ESTEIRA 6M"). Uma esteira de academia ofertada a R$ 4.998,99 foi desclassificada por inexequível.
- O PDM 7115, em 12 meses, tem 57 preços, mediana R$ 13.850 e p75 R$ 18.990. Os dois preços ficam a 2,8× e 3,8× da
  mediana. A regra de 10× da tela não os pega, e eles entram calados na média e no p75.
- Tamanho da base em 22/10: 29.876 linhas, 6.659 compras, 29.800 pares compra × item, 41 PDMs, de 01/12/2021 a
  20/10/2026. Nenhuma linha está sem `objeto_compra`.

**Escala do problema e por que o preço não basta:**
- Quantas linhas estão fora do perfil: **não medido** (é a fase 0).
- Numa amostra de 300 objetos, muitas compras legítimas têm objeto genérico ("aquisição de material permanente",
  "equipamentos médico-hospitalares", fisioterapia). Por isso uma regra só por objeto ou só por preço erra para os
  dois lados.

## Definição

**Fora do perfil** quer dizer que o **produto comprado não é o produto do PDM/item CATMAT**. Exemplo: esteira
transportadora de resíduos cadastrada como esteira ergométrica.

**Não** é fora do perfil:
- O mesmo produto comprado por comprador de outro ramo: hospital, fisioterapia, quartel, escola, presídio
  (confirmado pelo Marcelo em 22/10: "pode acontecer").
- O preço alto ou baixo sozinho. Isso é o "confira" da tela, que já existe.
- Item de academia ao ar livre ou fora do escopo comercial. Isso é escopo, assunto do `coletor/escopo.py`.

### Emenda de 23/10: erro de classificação na fonte (`pdm_divergente`)

O órgão erra o PDM/item CATMAT com frequência, e a **descrição detalhada do item (o texto copiado do termo de
referência) desempata**. A fase 0 (execução pqfms, 160 itens) misturou duas perguntas: produto fora do mercado e
produto do mercado cadastrado no PDM errado. Ficam três rótulos com efeito, mais `incerto`:

| Rótulo | Quando | Nas métricas do PDM |
|---|---|---|
| `no_perfil` | a descrição detalhada descreve o produto do PDM, de qualquer comprador; variação do mesmo produto também (caneleira de peso no PDM de caneleira, ainda que o item CATMAT diga "proteção") | entra |
| `pdm_divergente` | a descrição detalhada descreve **outro produto do mercado** (fitness, esporte, recreação). Grava `produto_real` (ex.: escada de agilidade no PDM de escada horizontal; kit de bandeirolas no PDM de acessório de condicionamento físico) | sai com "Ocultar" (contamina a mediana do PDM). Remanejar para o PDM certo fica para spec própria |
| `fora_do_perfil` | o produto não é do mercado (esteira transportadora de resíduos, capacho de entrada, ferragem de construção) | sai com "Ocultar" |

**Ordem de evidência** (a primeira clara decide): descrição detalhada > marca/fabricante/modelo > objeto da compra >
descrição do item CATMAT > nome do PDM. Preço muito acima da mediana pode ser kit ou lote (erro de unidade): é o
"confira" da tela, não muda o rótulo. Prompt `0037.2`.

## Contrato

| ID | Contrato | Entrada | Saída | Erros | Quem |
|---|---|---|---|---|---|
| K-1 | Tabela `public.precos_rotulo_perfil` (migration nova, aditiva) | `id_compra`, `id_item_compra` (PK composta, a mesma de `precos_praticados_itens`; `numero_item_compra` vai junto só para leitura) | `rotulo` (`no_perfil` \| `pdm_divergente` \| `fora_do_perfil` \| `incerto`), `produto_real` (até 120 caracteres; só no `pdm_divergente`, obrigatório nele), `motivo` (até 240 caracteres, cita o trecho que decidiu), `sinais` (`text[]` dentre `objeto`, `descricao`, `marca`, `comprador`, `preco`), `modelo`, `versao_prompt`, `hash_entrada`, `rotulado_em`, `revisao` (`null` \| `confirmado` \| `corrigido`), `rotulo_revisado`, `revisado_em` | CHECK nos valores de `rotulo`, `revisao` e `sinais`; FK lógica conferida no rotulador (linha sem preço correspondente não é gravada) | escrita: `service_role` (coletor); leitura: `service_role` (`api-precos` depois do `requireUserAuth`). RLS ligada, nenhum grant a `anon`/`authenticated` |
| K-2 | Coletor `python -m coletor.main --coleta perfil-precos [--pdms ...] [--limite N] [--dry-run] [--refazer]` | pares compra × item sem rótulo, ou com `hash_entrada` diferente do atual, ou todos com `--refazer` | grava K-1; log com contagem por rótulo, tokens de entrada e saída e custo estimado; `--dry-run` não grava nada | resposta fora do JSON esperado depois de `FICHA_TENTATIVAS`: o par fica sem rótulo e conta como `erros` (nunca vira `incerto` inventado); erro de configuração do Vertex encerra com código ≠ 0 | desenvolvedor / Cloud Run Job |
| K-3 | Prompt do rotulador (`coletor/perfil_precos.py`, `VERSAO_PROMPT`) | **uma chamada por compra**, com o `objeto_compra`, o nome da UASG e, por item: código e nome do PDM, código e `descricao_item` CATMAT, `descricao_detalhada_item`, marca, unidade, preço unitário e a mediana do mesmo PDM + unidade em 12 meses (só como sinal). **Sem** fornecedor, CNPJ ou CPF | JSON `{"itens":[{"id":<id_item_compra>,"rotulo":...,"produto_real":str\|null,"motivo":str,"sinais":[...]}]}` (`pdm_divergente` sem `produto_real` é resposta inválida), validado contra schema; temperatura 0 | item da resposta que não existe na entrada é descartado e logado | rotulador |
| K-4 | `api-precos` `action=amostras` (aditivo) | igual a hoje | por amostra: `perfil: {rotulo, motivo, revisao} \| null` (`null` = ainda não rotulado) | iguais aos de hoje | usuário autenticado |
| K-5 | `api-precos`, parâmetro novo `perfil` nas quatro ações (aditivo) | `perfil=todos` (padrão, igual a hoje) ou `perfil=sem_fora` | `resumo` traz sempre `n_fora_do_perfil`, `n_pdm_divergente` e `n_perfil_incerto` do recorte **com** todos. Com `sem_fora`, as linhas `fora_do_perfil` e `pdm_divergente` (pelo `rotulo_revisado` quando houver, senão pelo `rotulo`) saem de **todas** as contas do recorte: n, média, mediana, percentis, mín–máx, unidades, item com mais amostras, diferença estimado → homologado, amostras, itens e cidades. `incerto` e não rotulado continuam | 400 `perfil inválido: use todos ou sem_fora` | usuário autenticado |
| K-7 | /precos (Dashboard) | rótulo por amostra (K-4) e `n_fora_do_perfil` (K-5) | selo "fora do perfil?" na linha e no cartão da amostra, com o motivo no `title` e por extenso no cartão; botão **"Ocultar fora do perfil (N)"** junto dos filtros, com N = `n_fora_do_perfil` + `n_pdm_divergente`, só quando N > 0; o selo do `pdm_divergente` diz "PDM divergente: <produto_real>", desligado por padrão; ligado grava `perfil=sem_fora` na URL, entra nos chips de filtros aplicados e refaz resumo, amostras, itens e cidades com as métricas recalculadas | o erro da API aparece como hoje | usuário autenticado |
| K-8 | Relatório PDF da /precos | recorte com `perfil` | no quadro "Recorte": "Fora do perfil: N ocultados" ou "Fora do perfil: N mostrados (não ocultados)"; com `sem_fora`, as estatísticas do PDF são as recalculadas; a metodologia explica o rótulo (modelo, conferência por amostra) | — | usuário autenticado |
| K-6 | Referência praticada do agente de preço (0032 fase 3) | amostras do item/PDM + unidade | exclui `fora_do_perfil` da referência e mostra no achado quantas saíram e o motivo de cada uma | — | agente de preço |

Por que uma chamada por compra: o objeto e o comprador são da compra. São 6.659 chamadas para a base inteira (29.876
linhas; a chave é `id_compra` + `id_item_compra`, porque o mesmo número de item pode ter mais de uma linha), e as
próximas rodadas só rotulam o que é novo ou mudou (`hash_entrada` = SHA-256 da entrada normalizada + `VERSAO_PROMPT`).

## Proposta

### Fase 0: medir, sem gravar

1. Rodar K-2 com `--dry-run --limite 50` sobre uma amostra estratificada por PDM, incluindo a compra-âncora
   93099205000052026.
2. O PR traz a distribuição por rótulo, os tokens de entrada e saída por chamada e o **custo projetado da base
   inteira** com o preço do `GEN_MODEL` vigente (`gemini-3.8-flash` em 22/10).
3. O backfill completo só roda com o ok do Marcelo sobre esse custo.

### Fase 1: rotulador e tabela

1. Escrever a migration K-1 e o rotulador K-2/K-3, reaproveitando a classe `Gemini` (`_config` com
   `response_mime_type="application/json"`, como `extrair_campos`) e o `_retry` dela.
2. Usar as regras de `coletor/escopo.py` como sinal no prompt, nunca como decisão sozinha. Exemplo: `classificar(objeto)`
   sem `classes_catmat` devolve `None` no objeto da compra-âncora, enquanto `classificar_texto_item` dá "forte" na
   descrição CATMAT do item. A contradição é justamente o sinal.

### Fase 2: conferência humana por amostra (portão)

1. Sortear 30 pares: os 10 `fora_do_perfil` de maior preço, 10 `incerto` e 10 `no_perfil` aleatórios, e acrescentar
   os casos do gabarito (CA-6).
2. O Marcelo confere cada um aqui na conversa. A decisão dele é gravada em `revisao`/`rotulo_revisado`.
3. **Critério para seguir:** no máximo 1 erro entre os 10 `fora_do_perfil` (alarme falso), nenhum erro nos casos do
   gabarito e no máximo 3 erros nos 30.
4. Se não passar, ajustar o prompt (`VERSAO_PROMPT` sobe), rodar `--refazer` e conferir uma amostra nova.

### Fase 3: uso

1. Implementar K-4 e K-5 na `api-precos`.
2. Implementar K-6 no agente de preço da 0032.

### Fase 4: Dashboard (depois do backend no ar)

K-7 e K-8. O padrão mostra tudo, como hoje: nada some sem o operador clicar em "Ocultar fora do perfil".

### Depois desta spec (não entra aqui)

Embeddings do texto + HDBSCAN para os pares `incerto`, aprendendo com os vizinhos já rotulados e conferidos. Sem
K-means, que não aponta anomalia (decisão de 22/10).

## Critérios de aceite

| ID | Contrato | Dado / Quando / Então | Teste que prova |
|---|---|---|---|
| CA-1 | K-1 | **Dado** a migration aplicada, **quando** `anon` ou `authenticated` faz `select` em `precos_rotulo_perfil`, **então** recebe erro de permissão; `service_role` lê e escreve. | SQL `supabase/tests/precos_rotulo_perfil_check.sql` |
| CA-2 | K-1 | **Dado** um `insert` com `rotulo='talvez'` ou `sinais={'cor'}`, **quando** grava, **então** o CHECK recusa. | SQL (mesmo arquivo) |
| CA-3 | K-2/K-3 | **Dado** o modelo falso respondendo `fora_do_perfil` para os itens 10 e 11 da compra-âncora, **quando** o rotulador roda, **então** grava os dois com `motivo` não vazio, `modelo`, `versao_prompt` e `hash_entrada`, e faz **uma** chamada para a compra. | pytest `services/coletor-externo/tests/test_perfil_precos.py` |
| CA-4 | K-2 | **Dado** um par já rotulado com o mesmo `hash_entrada`, **quando** roda de novo sem `--refazer`, **então** não chama o modelo; **dado** que a marca mudou, **então** rotula de novo. | pytest (mesmo arquivo) |
| CA-5 | K-2/K-3 | **Dado** o modelo falso devolvendo JSON inválido em todas as tentativas, **quando** roda, **então** nada é gravado para a compra, o resumo conta 1 erro e nenhum rótulo `incerto` é inventado; **dado** um item na resposta que não estava na entrada, **então** ele é descartado e logado. | pytest (mesmo arquivo) |
| CA-6 | K-3 | **Dado** o gabarito `tests/fixtures/perfil-precos-casos.json`, **quando** o script de avaliação roda **com o modelo real** (fora da CI), **então** acerta: compra-âncora itens 10 e 11 = `fora_do_perfil`; "Aquisição de esteira elétrica para a academia do 25º BPM/M" = `no_perfil`; "itens para fisioterapia (esteira elétrica, bicicleta horizontal...)" = `no_perfil` (mesmo produto, outro comprador). | `python -m coletor.perfil_precos --avaliar` (resultado anexado ao PR) |
| CA-7 | K-3 | **Dado** uma amostra de fornecedor pessoa física, **quando** o prompt é montado, **então** não contém nome, CPF nem CNPJ do fornecedor. | pytest (mesmo arquivo) |
| CA-8 | K-2 | **Dado** `--dry-run`, **quando** roda, **então** não grava nada e o log traz a contagem por rótulo, os tokens e o custo estimado. | pytest (mesmo arquivo) |
| CA-9 | K-4 | **Dado** uma amostra com rótulo e outra sem, **quando** `action=amostras`, **então** a primeira traz `perfil.rotulo` e `perfil.motivo`, e a segunda `perfil: null`; o resto da resposta não muda. | Deno `tests/supabase/api-precos/perfil_test.ts` |
| CA-10 | K-5 | **Dado** um recorte com 1 `fora_do_perfil` e 1 `incerto`, **quando** `action=resumo` sem `perfil`, **então** vêm `n_fora_do_perfil=1` e `n_perfil_incerto=1`, e mediana, média e percentis são **iguais** aos de antes da spec. | Deno (mesmo arquivo) |
| CA-10b | K-5 | **Dado** o PDM 7115 com a compra-âncora rotulada `fora_do_perfil`, **quando** `action=resumo&perfil=sem_fora`, **então** `n` cai 2, a mediana e o p75 são os das linhas restantes, e `n_fora_do_perfil` continua 2; `action=amostras&perfil=sem_fora` não traz os itens 10 e 11; uma linha `fora_do_perfil` com `rotulo_revisado='no_perfil'` **continua** no cálculo. | Deno (mesmo arquivo) + SQL `supabase/tests/precos_rotulo_perfil_check.sql` |
| CA-10c | K-5 | **Dado** `perfil=nada`, **quando** qualquer ação, **então** 400 com a mensagem do contrato. | Deno (mesmo arquivo) |
| CA-12 | K-7 | **Dado** o resumo com `n_fora_do_perfil=2`, **quando** a /precos abre, **então** aparece o botão "Ocultar fora do perfil (2)" desligado e a amostra rotulada mostra o selo com o motivo; **quando** o botão é clicado, **então** a URL ganha `perfil=sem_fora`, surge o chip do filtro e o resumo e as amostras são pedidos de novo com `perfil: 'sem_fora'`; **dado** N=0, **então** o botão não aparece. | vitest `src/test/precos-perfil.test.tsx` (Dashboard) |
| CA-13 | K-8 | **Dado** o recorte com `perfil=sem_fora` e 2 ocultados, **quando** o PDF é gerado, **então** o quadro "Recorte" traz "Fora do perfil: 2 ocultados" e as estatísticas são as recalculadas. | vitest `src/test/precos-pdf.test.ts` (Dashboard) |
| CA-11 | K-6 | **Dado** a referência do PDM 7115 com a compra-âncora rotulada `fora_do_perfil`, **quando** o agente de preço calcula, **então** os dois preços saem da referência e o achado cita "2 preços fora do perfil" com o motivo. | Deno do agente de preço (arquivo definido na 0032 fase 3) |

## Skills e agentes por contrato

| Contrato | Desenho e leitura | Implementação | Teste | Revisão antes do PR | Depois do merge |
|---|---|---|---|---|---|
| K-1 | `/spec` | skill `nova-migration` | SQL check | `revisor-migration` + `revisor-seguranca` | `validar-migrations` antes; `verificar-producao` + `get_advisors` depois |
| K-2, K-3 | `/spec` | `/implement` (TDD) | pytest + `--avaliar` | `revisor-codigo` | `verificar-producao` |
| K-4, K-5 | `/spec` | `/implement` | Deno | `revisor-codigo` + `revisor-seguranca` | `verificar-producao` |
| K-6 | 0032 fase 3 | `/implement` | Deno | `revisor-codigo` | `verificar-producao` |
| K-7, K-8 | `/spec` | agente `frontend-dashboard` | vitest | `revisor-codigo` + `revisor-seguranca` + agente `ux-ui-licitagym` | `run-dashboard` (claro, escuro, celular) antes; `deploy-dashboard` depois |

## Fora de escopo

- Ocultar por padrão: o padrão mostra tudo, e só o botão do operador oculta (decisão de 22/10, que mantém o espírito
  da decisão de 21/10 de nada sair sozinho).
- K-means, HDBSCAN e embeddings (ficam para os `incerto`, em spec própria).
- Rotular propostas não homologadas ou coletar o portal de acompanhamento: os endpoints públicos exigem token de
  hCaptcha por chamada, e o captcha não é contornado.
- Corrigir o código CATMAT na fonte: o dado oficial fica como veio, e o rótulo é derivado e separado.

## Impacto em dados

- **Migration:** sim, `supabase/migrations/<timestamp>_precos_rotulo_perfil.sql`. Aditiva e idempotente
  (`create table if not exists`, CHECKs, RLS ligada, sem grants a `anon`/`authenticated`).
- **Tabelas/views/funções tocadas:**
  - `precos_rotulo_perfil` (nova): o coletor escreve; a `api-precos` lê.
  - `precos_praticados_itens`: só leitura, nada muda.
  - As funções do recorte (`precos_praticados_recorte`, `_amostras`, `_resumo`, `_itens_pdm`, `_municipios`) ganham
    o parâmetro `p_perfil` (padrão `'todos'`) e o join no rótulo. São `create or replace`, com retorno aditivo; as
    assinaturas antigas continuam respondendo igual.
- **ACL/RLS:** tabela nova só com `service_role`.
- **Backfill/reprocessamento:** sim. Fase 0 em dry-run (50 compras, com custo projetado no PR); backfill das 6.659
  compras só com o ok do Marcelo.
- **Edge Functions republicadas no merge:** `api-precos`, e todas as demais pelo workflow.
- **Contrato com o Dashboard:** aditivo (`perfil` por amostra, contagens no resumo, parâmetro `perfil`). Nada quebra no
  front atual; o PR do Dashboard (K-7, K-8) vai depois do backend no ar.
- **Dado oficial x derivado:** preço, item CATMAT, objeto, marca e UASG são oficiais. O rótulo, o motivo e os sinais
  são derivados por modelo, guardados com modelo, versão do prompt e data, e conferidos por amostra.

## Decisões do Marcelo

- 22/10: o rótulo é gerado por modelo e conferido por amostra (cerca de 30 casos), em vez de rotular 100 à mão.
- 22/10: K-means fica fora (não aponta anomalia). Agrupamento por densidade e embeddings ficam para os casos `incerto`.
- 22/10: a /precos e o PDF mostram o rótulo e têm o botão "Ocultar fora do perfil", que recalcula as métricas. Isso
  revê a decisão de 21/10 (0031) de não marcar linha na /precos; continua valendo que nada some sem o operador.
- 22/10: a conferência da amostra da fase 2 é feita na conversa (eu mostro os casos, o Marcelo responde), sem tela de
  admin.
- 22/10: comprador de saúde, fisioterapia, quartel ou presídio comprando o mesmo produto é no perfil.
- 22/10: o modelo roda no Vertex AI do projeto GCP do LicitaGym, com os créditos do Marcelo (como o coletor já faz,
  `coletor/ia.py`). Não há teto fixo em reais; a fase 0 mede o consumo e o PR mostra a projeção antes do backfill.
- 23/10: o órgão erra a classificação na fonte e a descrição detalhada (TR) desempata. Entra o rótulo
  `pdm_divergente` (produto do mercado no PDM errado, com `produto_real`), separado do `fora_do_perfil` (produto fora
  do mercado); o botão "Ocultar" tira os dois das métricas (ver "Emenda de 23/10").

## Perguntas em aberto

Nenhuma. As quatro perguntas do rascunho foram respondidas em 22/10 (ver Decisões).
