# 0018: Criar as tarefas padrão quando a oportunidade entra numa etapa do pipeline

- **Status:** aprovada (Marcelo, 10/10/2026; decisões 1 a 10 em "Decisões"; sem pergunta em aberto)
- **Issue:** Dashboard #29 (mãe). Depende da LicitaGym #252 (instância de tarefas por certame, `tarefas_equipe`) e do PR #308
  (aderência e portão comercial: schema de `pipeline_etapas` e `pipeline_oportunidades`).
  Tela: Dashboard #72 (tarefas da equipe) e a futura `/configuracoes/pipeline`.
- **Área:** migrations (tabela nova + mudança em `pipeline_mover`), edge-functions (`api-pipeline`), dashboard-contrato
- **Depende do ok do Marcelo:** sim. Decisão de produto (qual tarefa nasce em qual etapa), migration de produção e
  mudança no comportamento de mover card.

## Problema

O Marcelo perguntou em 10/10: "existe uma configuração de default de tarefas por etapa?". **Não existe.** Medição em
produção, só leitura, 10/10/2026:

| O quê | Produção |
|---|---|
| Catálogo de tarefas 14.133 (`tarefas_catalogo`, ativas) | 84 tarefas em 12 fases (F01 11, F02 5, F03 5, F04 5, F05 7, F06 4, F07 8, F08 12, F09 9, F10 8, F11 7, F12 3) |
| Eventos (`processo_eventos`) | 44. Uma tarefa sem `evento_abertura` |
| Instância de tarefa por certame (`tarefas_equipe`, #252) | **não existe** |
| Etapas do pipeline da Konnen (`pipeline_etapas`) | 13 (as padrão) |
| Licitações no pipeline | 0 |

O que existe e como se relaciona:
- **Etapas do pipeline** (`pipeline_etapas`, `20261006020000`): onde a equipe está. Nascem 13 por empresa (gatilho
  `tenants_pipeline_semear_etapas`) e o admin edita. O card só muda de etapa por ação humana (`pipeline_mover`).
- **Catálogo 14.133** (`20260927100000`, `docs/tarefas/catalogo-tarefas-14133.md`): o que a lei permite ou exige do
  fornecedor, por **fase do certame** (F01–F12) e liberado por **evento** (ex.: `ATA_HABILITACAO`), com prazo legal,
  condição e artigo. Consultado por `catalogo_tarefas_da_fase()` e `catalogo_tarefas_do_evento()`.
- **#252** cria a instância por certame (`tarefas_equipe`: certame, tarefa, responsável, prazo, status), disparada pelo
  andamento do certame, e diz que ela "não abre nem trava etapa".

Falta a ponte: **ao entrar numa etapa, a equipe recebe as tarefas daquela etapa**, sejam do catálogo, sejam escritas
pela empresa (ex.: "pedir cotação ao fabricante" em Preparando proposta).

## Desenho

### 0. Perspectiva: o fornecedor

Todas as tarefas desta spec são **do fornecedor** (a empresa cliente do LicitaGym), nunca do órgão licitante:
- o catálogo 14.133 já é assim (`docs/tarefas/catalogo-tarefas-14133.md`, seção 5): `tarefas_catalogo.ator` só aceita
  `licitante`, `contratado` ou `licitante_ou_contratado` (produção, 10/10: 45, 32 e 7);
- os atos do órgão (29 dos 44 eventos, ex.: convocação para habilitação, resultado, convocação para assinar) entram
  como **eventos** que abrem a janela ou contam o prazo da tarefa do fornecedor, não como tarefa;
- as tarefas escritas pela empresa (`origem = empresa`) também são da equipe do fornecedor;
- a tarefa nasce para a equipe da empresa dona do pipeline (`tenant_id`), quando ela move o card.

### 1. Modelo de tarefas por etapa (configuração da empresa)

Tabela nova `public.pipeline_etapa_tarefas` (uma linha = uma tarefa padrão de uma etapa):

| Coluna | Uso |
|---|---|
| `id` | identidade |
| `tenant_id`, `etapa_id` | FK `(tenant_id, etapa_id) → pipeline_etapas(tenant_id, id)`, `on delete cascade` |
| `origem` | `catalogo` ou `empresa` |
| `tarefa_codigo` | FK `tarefas_catalogo(codigo)`, obrigatório quando `origem = catalogo`, nulo quando `empresa` |
| `titulo`, `descricao` | obrigatório quando `origem = empresa`; quando `catalogo`, vem do catálogo (não copiado) |
| `prazo_horas` | só `empresa`: prazo contado da entrada na etapa (nulo = sem prazo). Tarefa do catálogo usa o prazo legal |
| `ordem`, `ativo` | ordenação e desligar sem apagar |
| `created_at`, `updated_by` | rastro mínimo |

- Única por `(etapa_id, tarefa_codigo)` quando `origem = catalogo` (índice único parcial).
- RLS ligada, sem policy para o cliente; só `service_role` (a `api-pipeline` confere o papel), como as outras tabelas
  do pipeline.
- Tenant novo: o gatilho que semeia as 13 etapas passa a semear também o modelo padrão (seção 2). `on conflict do
  nothing`: não desfaz edição do admin.

### 2. Modelo padrão das 13 etapas (aprovado pelo Marcelo em 10/10)

Ligação etapa → **tarefas** do catálogo (não fase inteira: a F01 mistura esclarecimento/impugnação com montagem da
proposta). Códigos conferidos na árvore de `docs/tarefas/catalogo-tarefas-14133.md` em 10/10. Só **proposta**: decide o
Marcelo: aprovado em 10/10 sem tarefa da empresa no padrão (decisão 1).

| Etapa padrão | Tarefas do catálogo | Por quê |
|---|---|---|
| Nova, Triagem, Em análise, Interessante | nenhuma do catálogo (as da empresa estão na seção 2b) | ainda não se decidiu participar |
| Qualificação | F01-T01 e T03 a T06 (registrar edital, pedir esclarecimento, impugnar, acompanhar resposta, reabertura de prazo). F01-T02 sai: virou o gate da seção 2a | esclarecimento e impugnação vencem 3 dias úteis antes da abertura |
| Preparando proposta | F01-T07 a T10 (vistoria, garantia de proposta, declarações, montar e cadastrar a proposta) | |
| Documentação | F01-T11 (habilitação antecipada) e F04-T01 a T05 (documentos de habilitação, diligência) | |
| Proposta enviada, Disputa | F02-T01 a T05 (lances, empate, preferência ME/EPP) e F03-T01 a T05 (negociação, exequibilidade, garantia adicional) | |
| Aguardando resultado | F05-T01 a T07 (intenção e razões de recurso, vista, contrarrazões) | prazos recursais curtos |
| Vencida | F06-T01, T04 e F07-T01 a T07 (homologação, assinatura, garantia contratual, publicação no PNCP) | |
| Perdida | F05-T01 a T05 (recorrer do resultado) e F06-T03 (recorrer de anulação/revogação) | |
| Descartada | nenhuma | |

### 2b. Fase 1, Prospecção e Triagem: tarefas da empresa no modelo padrão (decisão 6)

As etapas da fase 1 (Nova, Triagem, Em análise, Interessante) não recebem tarefa do catálogo 14.133: ainda não se decidiu
participar. Recebem tarefas `origem = empresa` semeadas no modelo padrão (o admin edita), sempre do fornecedor e
atribuídas ao papel admin (decisão 3):

| Etapa | Tarefa da empresa (padrão) | Apoio automático (decisão 7: em Triagem, Em análise e Interessante, os **agentes**) |
|---|---|---|
| Nova | nenhuma | — |
| Triagem | **Confirmar a aderência item a item** (descrição, especificação e quantidade contra o catálogo da empresa) | **agente de aderência** (PR #308, `aderencia.ts`): produto × item por atributo, veredito `atende`, `supera`, `nao_atende`, `nao_comprovado`, `ausente` ou `ambiguo`; o selo `catmat_match` é só a pré-triagem |
| Triagem | **Conferir as restrições de participação por lote** (lote exclusivo ME/EPP contra o porte da empresa; marca de referência; norma de certificação exigida; assistência técnica local) | agente de edital (#307), com os sinais que faltam listados na seção 2c; porte da empresa pelo CNPJ |
| Em análise | **Ler o edital** (exigências técnicas, amostra, atestados, prazo de entrega) | **agente de edital** (PR #307, `edital.ts`): localiza no texto indexado amostra, visita técnica, atestado de capacidade, garantia de proposta e contratual, laudo/certificação (INMETRO/ABNT), marca/modelo e prazo de entrega, cada achado com trecho e página; calcula o limite de impugnação (3 dias úteis antes da abertura, só fins de semana: feriados não verificados). **Agente jurídico** (`juridico.ts`): sugere a peça (esclarecimento, impugnação, demonstração de exequibilidade) com o artigo da 14.133. Gate de prazo mínimo (seção 2a) |
| Em análise | **Conferir o preço de referência contra o piso da empresa** | **agente de preço** (`preco.ts`): referência praticada do item (mínimo de 5 amostras homologadas), faixa de exequibilidade e piso da empresa (`catalogo_precos`: preço de tabela menos desconto máximo, #254) |
| Em análise | **Montar o dossiê por item antes da sessão** (catálogo ou ficha, manual e certificado de conformidade específicos do modelo, em português; declarações; atestado compatível com nota fiscal; balanço) | agente de edital lista o exigido por item com trecho e página; a empresa anexa. Motivo: no caso da seção 2c, a convocação dá **4 horas** para mandar tudo |
| Em análise | **Confirmar o frete até o local de entrega** | sem agente: distância (`calculate-distance-webrouter`) só como indicador aproximado ("frete não verificado") |
| Interessante | **Decidir GO, GO condicionado ou NO-GO** (decisão humana, com motivo) | **recomendação** (PR #308, `decisao.ts`): `go`, `go_condicionado`, `no_go` ou `monitorar`, explicável e **sem pontuação**; a decisão humana pode divergir e é ela que vale (#250) |

Como os agentes funcionam hoje (PRs #307 e #308, conferido em 10/10): são **determinísticos** (`metodo = regra`, sem modelo
de IA), gravam cada execução em `agente_execucoes` com hash do contexto e `REGRA_VERSAO`, e todo achado tem fonte (chunk,
página e trecho). A equipe revisa e aprova ou rejeita (`analise_revisar`): o agente apoia, a tarefa continua sendo da
equipe.

**Pré-requisito: o edital indexado.** Os agentes de edital e jurídico leem `licitacao_chunks`. Em produção, 10/10: das
**66** licitações abertas e em escopo, só **11** têm chunks; **52** têm documento ainda `pendente` de download. O download
(`pncp.py --baixar-pendentes`) e a indexação (`indexador.py`) rodam em lote, sem disparo por licitação. Proposta: ao entrar
em **Triagem**, a licitação vai para uma fila (`private.job_queue`, hoje sem uso) que baixa os documentos, indexa e roda
os agentes; enquanto não termina, a tarefa mostra "análise em preparação" e, se não houver documento, "sem documento"
(`situacao = sem_documento`), nunca uma análise vazia como se estivesse completa. Os agentes são regra (podem rodar sob
demanda); o OCR do indexador usa o Gemini (spec 0016 trata o laboratório local, não este fluxo).

**Antes do merge dos agentes (#307):** a `api-agentes` resolve a empresa pelo fallback antigo ("único tenant ativo"). Ela
precisa usar `_shared/tenant.ts` (#314: vínculo desligado, conta sem vínculo e empresa desativada → 403).

Sinais automáticos da triagem (aderência, comprador, PCA ligado, histórico do órgão, distância, regulamento, prazo
mínimo, documento de habilitação vencendo antes da sessão) são **cálculo do sistema**, não tarefa: ficam numa spec
própria de sinais de triagem, que reaproveita o que já existe (catálogo da empresa, `orgao_tipos`, `link-pca-edital`,
BI de preços, `calculate-distance-webrouter`, #253).

**Score (decisão 6):** vale a regra canônica de `docs/revenue-intel/instrucoes-canonicas.md` (seções 21 a 24). Pesos PCA
40, Histórico 25, Preço 15, Prazo 10, Distância 10; **sem score numérico** até as fórmulas internas serem aprovadas;
componente ausente nunca vale zero nem tem o peso redistribuído. Até lá, a triagem mostra fatores, evidências e
prioridade **Alta, Média ou Baixa**. O modelo de 9 componentes do documento "Revenue Intelligence v1.0" (que soma 110,
não 100) não é adotado.

### 2a. Gate de prazo mínimo de propostas (monitoramento, não tarefa)

Decisão 5: o prazo mínimo entre a divulgação do edital e a abertura (14.133, art. 55) é obrigação do **órgão**. O sistema
confere sozinho, a partir da publicação; não é tarefa do fornecedor. A `F01-T02` "Conferir prazo mínimo de propostas"
deixa de ser criada pela etapa.

- **Entradas (PNCP):** data de divulgação no PNCP, data fim de recebimento de propostas (abertura), objeto (bens ×
  serviços/obras), critério de julgamento, regime de execução; e o regulamento (seção 3).
- **Regra:** dias úteis contados com exclusão do dia do começo e inclusão do vencimento, só dias com expediente no órgão
  (art. 183, III). Mínimos do art. 55: bens 8 (menor preço/maior desconto) ou 15; serviços e obras comuns 10, especiais 25,
  contratação integrada 60, semi-integrada/demais 35; maior lance 15; técnica e preço/melhor técnica 35. Na 14.981, a
  **metade** (art. 2º, II).
- **Estados:** `dentro_do_prazo` (com a folga em dias úteis), `abaixo_do_minimo`, `nao_verificado` (falta entrada, ou a
  folga é tão pequena que um feriado local não verificado mudaria o resultado: sem calendário de feriados, não se afirma).
- **Reavaliação:** edital retificado reabre o prazo (art. 55, § 1º): o gate roda de novo a cada nova versão/retificação.
- **Efeito:** `abaixo_do_minimo` gera alerta na oportunidade e sugere a tarefa `F01-T04` "Impugnar o edital" (essa sim,
  do fornecedor). Não muda prioridade nem fase sozinho.
- **Exemplo conferido em 10/10:** Pregão Eletrônico nº 114655/2025 (Estado de Goiás, Casa Militar; academia; PNCP
  `01409580000138-1-002061/2025`): divulgado 15/08/2025, abertura 03/09/2025 09:00, bens e menor preço → mínimo 8 dias
  úteis; 13 contados → `dentro_do_prazo` (folga 5; feriados locais não verificados). A plataforma do órgão (sislog-GO) registra outra data, a publicação no DOE em 19/08/2025 08:00; contada dela, a folga cai para 2 (10 dias úteis). O gate usa a divulgação no PNCP e mostra a data usada.
- **Onde mora:** cálculo determinístico na ingestão/reconciliação (não nesta spec de tarefas). Vira PR próprio, com
  testes dos incisos do art. 55 e da 14.981.

Tarefa com `parent_codigo` (ex.: F04-T02 "↳ Regularidade fiscal") entra com a mãe. F07-T08 (empresa estrangeira) e
F08–F12 (execução, alteração, extinção, sanção, ata) ficam fora do pipeline comercial no v1; a condição do catálogo
decide as que não se aplicam ao certame.

### 2c. Caso real: PE 114655/2025 (Casa Militar de Goiás, academia), do edital ao aditivo

Lido em 10/10 a partir dos documentos públicos do certame: edital, TR, ETP, chat da sessão na plataforma do órgão
(sislog-GO), termo de julgamento e homologação, e os dois termos aditivos. Nada desses arquivos foi copiado para o
repositório; aqui só as contagens e as citações (cláusula e página).

**O certame.** Lei 14.133 e Decreto GO 10.247/2023. Pregão eletrônico, menor preço por lote, modo aberto, 9 lotes, 77
itens, R$ 3.373.060,18 (a soma dos lotes bate com o total do edital).
- Lotes 04, 06, 07, 08 e 09 são **exclusivos ME/EPP** (TR 10.8), R$ 231.933,12, entre eles o **piso emborrachado**
  (lote 08, 360 m²).
- **Marca de referência** admitida nos lotes 01 a 03 (TR 6.3, art. 41). O ETP (7.1, p. 60) lista 12 marcas, entre elas a
  Konnen. Outra marca precisa de laudo de equivalência (art. 42, TR 10.15.5).
- Sem amostra física. Por item, a proposta leva catálogo ou ficha, manual, ano de fabricação, garantia, peso e código
  (TR 6.4 a 6.7), com tolerância de 5% nas dimensões (TR 6.5).
- **Certificado de conformidade** por equipamento nos lotes 01 a 03, numa norma do rol: ABNT ISO 20957, ASTM F2276,
  F2216, F1250, F3104 ou F3105, ou EN 957 (TR 6.8).
- **Declarações:**
  - visita técnica ou renúncia (TR 10.17 e 10.18);
  - infraestrutura de assistência técnica em Goiânia (TR 10.15.2);
  - sustentabilidade (ETP 6.17.1).
- **Habilitação:**
  - atestado de fornecimento compatível; nos lotes 01 a 03, de equipamento elétrico ou articulado (TR 10.14 e 10.15.1);
  - balanço dos 2 últimos exercícios, com LG, LC e SG ≥ 1, ou capital/PL de 10% do lote (TR 10.10).
- **Execução:**
  - entrega e instalação no 11º andar, com acesso por escada;
  - frete e montagem inclusos;
  - até 150 dias da ordem de fornecimento (TR 7.1, 7.2 e 10.3.2);
  - garantia de 3 anos nos lotes 01 a 03 e de 1 ano nos demais (TR 7.5.1).
- **Preço unitário acima do estimado não é adjudicado**, mesmo com o total do lote abaixo (TR 3.4).
- Esclarecimento e impugnação até 29/08/2025 às 23:59:59 (3 dias úteis antes da abertura, edital 13.1; a plataforma
  confirma). Houve 1 esclarecimento e nenhuma impugnação.

**O julgamento (chat da sessão: 1.067 mensagens, de 03/09 a 14/11/2025).**
- No lote 01 foram cerca de 10 inabilitações em sequência, do lance de R$ 500 mil para cima. Venceu quem ofertou o
  **valor estimado** (R$ 1.445.259,47).
- Lotes 03, 04 e 06 terminaram fracassados (R$ 322.043,04).
- Valor adjudicado: R$ 2.829.574,87.
- **Motivos de inabilitação:**
  - certificado ausente, genérico ou em outra língua;
  - manual ou prospecto incompleto;
  - dimensão ou peso fora da tolerância;
  - marca fora do rol sem laudo;
  - material diferente do especificado (PVC em vez de uretano; borracha injetada em vez de vulcanizada);
  - falta da declaração de visita técnica ou da de assistência local;
  - atestado incompatível ou sem nota fiscal;
  - balanço incompleto;
  - preço unitário acima do estimado;
  - não mandar a proposta ajustada e a habilitação no **prazo de 4 horas** da convocação (edital 7.14, 8.1 e 8.14).
- Convocação e diligência saem só no chat da plataforma, nunca no PNCP.

**O contrato.** Em 23/06/2026, os dois contratos receberam acréscimo quantitativo (art. 124, I, b, e art. 125), pelo
mesmo preço unitário homologado:
- lote 01: + R$ 333.377,26 (≈23%);
- lote 02: + R$ 112.000,00 (≈10,18%).

O valor contratado passou do homologado. A coleta de contratos e termos aditivos é a #316.

**O que o caso muda nesta spec:**
- Duas tarefas novas no modelo padrão da seção 2b: **restrições de participação por lote** (Triagem) e **dossiê por
  item antes da sessão** (Em análise).
- A aderência (Triagem) é por item e atributo, não por categoria: material, dimensões e peso com ±5%, componentes (rodas,
  tela). O agente de aderência (#308) precisa ler esses atributos no TR.
- A Triagem decide **por lote**: a oportunidade pode seguir com parte dos lotes. O motivo do descarte fica por lote.

**Sinais que faltam aos agentes** (vão para os PRs #307 e #308, não para esta spec):
- exclusividade ME/EPP por lote;
- marca de referência citada e laudo de equivalência;
- norma de certificação exigida e idioma do documento;
- assistência técnica numa cidade;
- declaração de visita técnica ou renúncia;
- teto do preço unitário;
- restrição de acesso no local de entrega (andar, escada).

### 3. Criação das tarefas ao entrar na etapa

Na mesma transação de `pipeline_mover` (inclusive `pipeline_adicionar`, que entra na primeira etapa), para cada
licitação que **entrou** numa etapa:

1. lê o modelo ativo da etapa (`pipeline_etapa_tarefas`);
2. cria a instância em `tarefas_equipe` (#252) com `origem_etapa_id` e `origem_modelo_id`, **atribuída ao papel admin
   da empresa** (`responsavel_papel = 'admin'`, `responsavel_user_id` nulo): aparece na fila de todos os admins ativos
   até um admin definir o operador (decisão 3);
3. **idempotente:** uma instância por `(tenant_id, licitacao_id, tarefa_codigo)` para tarefa do catálogo e por
   `(tenant_id, licitacao_id, origem_modelo_id)` para tarefa da empresa. Voltar para a etapa, ou a mesma tarefa já
   criada pelo evento do certame (#252), não duplica;
4. sair da etapa **não apaga nem fecha** tarefa, inclusive ao chegar em Perdida ou Descartada; fechar é ação da equipe (decisão 2).

Regras que valem já no #252 e continuam aqui:
- **Condição do catálogo** (`tarefas_catalogo.condicao`) avaliada com o contexto do certame (`inversao_fases`,
  `modo_disputa`, `srp`...). Chave ausente no contexto → a tarefa é criada com o selo **"condição não verificada"**,
  nunca descartada como "não se aplica".
- **Prazo legal:** contado do `prazo_evento` quando a data do evento é conhecida. Evento sem data, ou prazo em dias
  úteis sem calendário de feriados → **"prazo não calculado"**. Nenhuma data inventada.
- **Regulamento (decisão 4):** tarefas do catálogo só para `LEI_14133` e `LEI_14981`. Na 14.981 (calamidade, aplica a
  14.133 com ajustes, art. 23), o gate de prazo mínimo (seção 2a) usa a **metade** dos mínimos do art. 55 da 14.133
  (Lei 14.981, art. 2º, II); o envio da proposta (`F01-T10`) não muda (vai até o evento `DATA_ABERTURA`). Demais regimes (13.303, RLC, RCA, SEST SENAT, sem regulamento) recebem só as tarefas
  `origem = empresa`, com o aviso "regulamento sem catálogo". 10.847 (dispensa para contratar a EPE) não tem disputa:
  nenhuma tarefa do catálogo. Pré-requisito: `licitacoes_externas.regulamento` preenchido pelo `amparoLegal` do detalhe
  do PNCP (hoje nulo em todas as linhas), com os valores `LEI_14981` e `LEI_13303` acrescentados ao check.

### 4. Certame × etapa

As duas fontes convivem e não se sobrepõem:
- o **evento do certame** (#252) libera a tarefa quando a lei abre a janela;
- a **etapa** cria a tarefa quando a equipe decide entrar naquele trabalho.

Se as duas apontarem para a mesma tarefa do catálogo, existe **uma** instância (regra 3 do item 3), com as duas origens
registradas. A etapa nunca altera prazo legal nem fecha tarefa do certame.

### 5. API e telas

- `api-pipeline` (admin da empresa ou desenvolvedor): `etapa_tarefas_listar` (`etapa_id`) e `etapa_tarefas_salvar`
  (lista completa da etapa; valida `tarefa_codigo` contra o catálogo ativo). Operação só lê.
- Dashboard `/configuracoes/pipeline`: por etapa, escolher tarefas do catálogo (agrupadas por fase, com artigo) e
  escrever tarefas da empresa. Cartão do Kanban mostra "N tarefas abertas"; a lista fica na #72.

### Ordem dos PRs

0. LicitaGym PR #308: aderência e portão comercial (migration `20261010100400_pipeline_portao_resultado.sql`, trigger
   `pipeline_oportunidades_portao`). Mergeado antes desta spec (decisão 10).
1. LicitaGym #252: `tarefas_equipe` (pré-requisito, em PR próprio e antes desta spec: decisão 9). Pode correr em
   paralelo ao #308: não toca `pipeline_*` nem `api-pipeline`.
2. LicitaGym: `pipeline_etapa_tarefas` + semente padrão + criação em `pipeline_mover` + checks SQL (este desenho).
3. LicitaGym: ações `etapa_tarefas_*` na `api-pipeline`.
4. Dashboard: `/configuracoes/pipeline` (etapas e tarefas por etapa) e contagem no card; lista na #72.

## Critérios de aceite

| ID | Dado / Quando / Então | Teste que prova |
|---|---|---|
| CA-1 | **Dado** a etapa Documentação com F04-T01 a T05 no modelo, **quando** `pipeline_mover` leva a licitação para ela, **então** `tarefas_equipe` tem uma instância por tarefa ativa do modelo cuja condição não é falsa, com `origem_etapa_id` preenchido. | SQL `supabase/tests/pipeline_etapa_tarefas_check.sql` |
| CA-2 | **Dado** a licitação que já passou por Documentação, **quando** volta para ela, **então** nenhuma tarefa é duplicada. | SQL `pipeline_etapa_tarefas_check.sql` |
| CA-3 | **Dado** uma tarefa do catálogo já criada pelo evento do certame (#252), **quando** a etapa pede a mesma tarefa, **então** continua uma instância só. | SQL `pipeline_etapa_tarefas_check.sql` |
| CA-4 | **Dado** contexto do certame sem a chave da condição (ex.: `inversao_fases` ausente), **quando** a tarefa é criada, **então** ela existe com o selo "condição não verificada". | SQL `pipeline_etapa_tarefas_check.sql` |
| CA-5 | **Dado** prazo em dias úteis sem calendário, ou evento sem data, **quando** a tarefa é criada, **então** o prazo fica "não calculado" (sem data). | SQL `pipeline_etapa_tarefas_check.sql` |
| CA-6 | **Dado** a licitação que sai de Documentação para Disputa, **quando** move, **então** as tarefas criadas em Documentação continuam abertas. | SQL `pipeline_etapa_tarefas_check.sql` |
| CA-7 | **Dado** licitação de regulamento próprio (Sistema S), **quando** entra numa etapa, **então** só as tarefas `origem = empresa` são criadas. | SQL `pipeline_etapa_tarefas_check.sql` |
| CA-8 | **Dado** uma empresa nova, **quando** é criada, **então** recebe as 13 etapas e o modelo padrão; reaplicar a semente não desfaz edição do admin. | SQL `pipeline_etapa_tarefas_check.sql` |
| CA-9 | **Dado** um usuário de operação, **quando** chama `etapa_tarefas_salvar`, **então** 403; admin da empresa salva. | Deno `tests/supabase/functions/api_pipeline_test.ts` |
| CA-10 | **Dado** `tarefa_codigo` inexistente ou inativo, **quando** `etapa_tarefas_salvar`, **então** 400 e nada é gravado. | Deno `api_pipeline_test.ts` |
| CA-11 | **Dado** `anon` e `authenticated`, **quando** leem `pipeline_etapa_tarefas` por REST, **então** sem acesso. | SQL `pipeline_etapa_tarefas_check.sql` (ACL) |
| CA-12 | **Dado** a empresa A, **quando** move card, **então** nenhuma tarefa é criada para a empresa B nem lê o modelo de B. | SQL `pipeline_etapa_tarefas_check.sql` |
| CA-13 | **Dado** o modelo padrão, **quando** é semeado ou salvo pela `api-pipeline`, **então** nenhuma tarefa do catálogo com `ator` fora de `licitante`, `contratado` e `licitante_ou_contratado` é aceita (o check recusa). | SQL `pipeline_etapa_tarefas_check.sql` |
| CA-14 | **Dado** uma licitação que entra numa etapa com modelo, **quando** as tarefas são criadas, **então** todas ficam com `responsavel_papel = 'admin'` e `responsavel_user_id` nulo. | SQL `pipeline_etapa_tarefas_check.sql` |
| CA-15 | **Dado** uma tarefa na fila do admin, **quando** um admin a atribui a um membro de operação da mesma empresa, **então** ela passa a esse usuário; operação tentando atribuir recebe 403; atribuir a usuário de outra empresa recebe 400. | Deno `tests/supabase/functions/api_pipeline_test.ts` (ou a função da #252 que atribui) |
| CA-16 | **Dado** uma empresa nova, **quando** recebe o modelo padrão, **então** Triagem, Em análise e Interessante têm as tarefas `origem = empresa` da seção 2b e nenhuma tarefa do catálogo; Nova não tem tarefa. | SQL `pipeline_etapa_tarefas_check.sql` |
| CA-17 | **Dado** uma licitação sem chunks, **quando** entra em Triagem, **então** vai para a fila de download, indexação e agentes, e as tarefas mostram "análise em preparação" até a execução terminar; sem documento, a execução fica `sem_documento` e nenhum achado é inventado. | SQL `pipeline_etapa_tarefas_check.sql` + Deno `tests/supabase/functions/api_agentes_test.ts` |
| CA-18 | **Dado** uma empresa nova, **quando** recebe o modelo padrão, **então** Triagem tem "Conferir as restrições de participação por lote" e Em análise tem "Montar o dossiê por item antes da sessão", ambas `origem = empresa` e do papel admin. | SQL `pipeline_etapa_tarefas_check.sql` |

## Fora de escopo

- A própria `tarefas_equipe` e a liberação por evento do certame (#252).
- Calendário de feriados e prazo em dias úteis (continua "prazo não calculado").
- Fechar ou cancelar tarefa automaticamente ao sair da etapa ou ao chegar em Perdida/Descartada (decisão 2: não fecha).
- Tarefas de execução de contrato (F08–F12) no pipeline comercial.
- Catálogo para regulamento do Sistema S.
- Notificação (e-mail, WhatsApp) de tarefa criada.
- Alerta de convocação e diligência com prazo de horas: sai só no chat da plataforma do órgão (no caso da seção 2c,
  4 horas), que não coletamos. Fica como ideia de fonte nova, sem issue.
- Contratos e termos aditivos (valor contratado atual além do homologado): #316.
- Sinais novos dos agentes listados na seção 2c (PRs #307 e #308).

## Impacto em dados

- **Migration:** sim. Tabela nova `pipeline_etapa_tarefas` (aditiva, idempotente), semente do modelo padrão para os
  tenants existentes (`on conflict do nothing`), extensão de `pipeline_semear_etapas` e de `pipeline_mover` (criação
  das tarefas na mesma transação). Depende da tabela `tarefas_equipe` do #252.
- **Tabelas/funções tocadas:** `pipeline_etapa_tarefas` (nova), `pipeline_mover`, `pipeline_semear_etapas`,
  `tarefas_equipe` (escrita), `tarefas_catalogo` e `processo_eventos` (leitura).
- **ACL/RLS:** tabela nova só `service_role`, RLS ligada sem policy; funções `security definer` com `search_path` fixo,
  como as do pipeline. Check `supabase/tests/pipeline_etapa_tarefas_check.sql`.
- **Backfill:** só a semente do modelo padrão (hoje 1 empresa, 13 etapas). Nenhuma tarefa retroativa: hoje há 0
  licitações no pipeline.
- **Edge Functions republicadas no merge:** todas; muda a `api-pipeline`.
- **Contrato com o Dashboard:** novas ações `etapa_tarefas_*`; `pipeline_listar` pode ganhar `tarefas_abertas` por card.
- **Dado oficial x derivado:** tarefa, prazo legal e artigo vêm do catálogo (fonte: Lei 14.133, conferido no catálogo);
  a ligação etapa → tarefa é configuração da empresa. Nenhum prazo é inventado.

## Decisões

Do Marcelo, 10/10/2026:
1. **Modelo padrão da seção 2 aprovado** como está: tarefas do catálogo por etapa; tarefa da empresa no padrão só na
   fase 1 (decisão 6),
   (a empresa acrescenta as suas pela configuração).
2. **Tarefas continuam abertas** ao sair da etapa, inclusive em Perdida e Descartada. Fechar ou cancelar é ação da
   equipe.
3. **Responsável: sempre o admin.** A tarefa nasce para o papel admin da empresa (fila de todos os admins, sem pessoa
   escolhida, porque a empresa pode ter mais de um admin), e o admin define depois o operador. Só admin (ou o
   desenvolvedor) atribui ou reatribui; operação vê as tarefas atribuídas a ela e as conclui.

4. **Regimes com catálogo: Lei 14.133 e Lei 14.981.** Na 14.981, o prazo mínimo de propostas é a metade do art. 55 da
   14.133 (vale no gate da decisão 5). Comparativo dos regimes, com artigos e fontes oficiais, conferido em 10/10: 13.303
   (estatais) tem rito próprio (impugnação 5 dias úteis, art. 87, § 1º; recurso único em 5 dias úteis após a
   habilitação, art. 59, § 1º); 10.847 é dispensa para contratar a EPE (art. 6º); Sistema S tem RLC (Sesc/Senac) e RCA
   (SESI/SENAI, 2023) próprios. Amostra de 8 das 43 licitações PNCP sem normativo no `raw`: as 8 têm `amparoLegal` Lei
   14.133 no detalhe do PNCP.

5. **Prazo mínimo de propostas é gate, não tarefa.** O sistema confere o art. 55 a partir da publicação do edital
   (seção 2a); a `F01-T02` sai do modelo. Abaixo do mínimo, alerta e sugestão de impugnar (`F01-T04`).

6. **Fase 1 (Prospecção e Triagem):** as etapas Triagem, Em análise e Interessante recebem tarefas da empresa no
   modelo padrão (seção 2b): confirmar aderência item a item; ler o edital; conferir preço de referência contra o piso;
   confirmar frete; decidir GO, GO condicionado ou NO-GO. Os sinais automáticos da triagem são outra spec. **Score:
   segue a regra canônica** (sem score numérico até aprovar as fórmulas; prioridade Alta/Média/Baixa com evidências).

7. **Apoio da fase de análise são os agentes.** Triagem → agente de aderência; Em análise → agentes de edital,
   jurídico e preço; Interessante → recomendação sem pontuação. Pré-requisito: edital indexado (fila ao entrar em
   Triagem). A tarefa continua da equipe; o agente entrega achados com fonte para revisão.

8. **Caso real registrado (seção 2c).** O PE 114655/2025 vira o exemplo da fase 1. O modelo padrão ganha duas
   tarefas da empresa: restrições de participação por lote (Triagem) e dossiê por item antes da sessão (Em análise,
   CA-18). Contratos e aditivos: #316.

9. **Ordem: #252 antes, depois esta spec.** `tarefas_equipe` entra em PR próprio; os PRs desta spec (seção "Ordem dos
   PRs", passos 2 a 4) começam depois do merge do #252.

10. **#308 antes desta spec.** O #308 muda `pipeline_etapas` e `pipeline_oportunidades` e cria o trigger
    `pipeline_oportunidades_portao`; a mudança em `pipeline_mover` desta spec nasce sobre esse schema. Ordem: #308 e #252
    (em paralelo), depois esta spec. Spec aprovada.

## Perguntas em aberto

Nenhuma.
