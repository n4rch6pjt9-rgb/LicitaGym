# 0038: Levar as rotas dos agentes ao desenho original: pergunta livre com resposta rastreável (edital, jurídico, preço)

- **Status:** aprovada (22/10, pelo Marcelo, depois das respostas às perguntas); fase 1 (print da tela) em andamento
- **Alimenta:** spec-mãe 0032 (agentes) | é a "spec própria" que a 0035 deixou para depois ("Perguntar ao edital em texto
  livre", 0035 l.244) | módulo 3 "Agentes na tarefa" de `docs/produto/ESCOPO.md`
- **Repositório:** os dois (backend vai ao ar antes do front)
- **Issue:** nenhuma (pedido do Marcelo de 22/10, com os protótipos `EditalAgentView`, `LegalAgentView`,
  `PriceAgentView` e o print da `/agentes/editais` em produção)
- **Área:** edge-functions | migrations | coletor | dashboard-contrato | dashboard-tela
- **Depende do ok do Marcelo:** sim (migration nova, modelo de IA dentro dos agentes, decisão de produto, custo)

## Leitura obrigatória antes de implementar

| # | Arquivo | Por quê | Carrega sozinho? |
|---|---|---|---|
| 1 | `CLAUDE.md`, `AGENTS.md`, `.claude/rules/regras-negocio.md` | como entregar; zero alucinação; regras de produto | sim |
| 2 | `docs/produto/ESCOPO.md` (módulo 3) | onde os agentes estão | não: ler |
| 3 | `specs/0032-agentes-dentro-da-tarefa.md`, `specs/0035-agentes-na-rota-propria.md`, `specs/0036-grupos-certame-e-regras-edital.md`, `specs/0031-precos-estimado-homologado-auditoria.md`, `specs/0037-rotulador-fora-do-perfil-precos.md` | decisões que esta spec respeita ou revê (seção "Decisões") | não: ler |
| 4 | esta spec, inteira | contrato, CAs, fora de escopo | não: ler |
| 5 | `supabase/functions/api-agentes/` (`validation.ts`, `repo.ts`) e `supabase/functions/_shared/agentes/` (`tipos.ts`, `edital.ts`, `juridico.ts`, `preco.ts`) | contrato e `Fonte` de hoje | não: ler |
| 6 | `services/coletor-externo/coletor/ia.py` (`responder`), `coletor/buscar.py`, migration de `match_licitacao_chunks_v2` | o RAG que já existe (só linha de comando) | não: ler |
| 7 | migration `20261011100500` (`norma_dispositivos`) | base legal: 65 artigos da Lei 14.133, 43 conferidos com o Planalto | não: ler |
| 8 | Dashboard: `src/components/agentes/AgenteRotaView.tsx` (ou onde estiver), `src/data/agentesApi.ts`, `opportunities/AnaliseAgentesTab.tsx`, e os protótipos `intelligence/EditalAgentView.tsx`, `LegalAgentView.tsx`, `PriceAgentView.tsx` | o que está no ar e o desenho de referência | não: ler |

## Problema

A rota `/agentes/editais` em produção (print de 22/10, Pregão Eletrônico 29/2026 da SSP-SP) entrega **menos do que o
desenho original** dos protótipos:

1. **Não dá para perguntar.** O centro da tela de referência é "Pergunte sobre este edital…" com perguntas
   sugeridas. Em produção só existem os alertas da análise por regra.
2. **O alerta não explica.** Os 4 cartões dizem "Exigência localizada no edital." O título ("Amostra exigida") e as
   páginas aparecem, mas não aparece o que o edital exige, nem por que é risco, nem o que fazer.
3. **A citação não ajuda a conferir.** A coluna da direita traz trechos crus do OCR, cortados no meio de palavra
   ("nte o preenchimento…"), longos, sem item/cláusula e sem botão para abrir a página. A citação também não fica
   ao lado do alerta que ela prova: é preciso rolar e casar pelo nome.
4. **A passagem para o jurídico perde a cláusula.** "Fundamentar no Agente Jurídico" só troca de rota
   (`?licitacao=`); o jurídico não recebe documento, página, item nem trecho.
5. **O jurídico e o preço não respondem perguntas.** O protótipo jurídico tem resposta estruturada (resumo,
   fundamentação, dispositivos com fonte oficial, pontos de revisão humana) e histórico. Em produção, o jurídico é a
   mesma lista de achados. O Agente de Preços mostra `SemDadosAindaView` fora do demo.

**Medido em 22/10 (backend):**
- Só **106 licitações** têm documento indexado (`licitacao_chunks`).
- A RPC `match_licitacao_chunks_v2` não filtra por licitação e não devolve página.
- A `Fonte` dos achados não tem item/cláusula.
- A base legal tem 65 artigos da Lei 14.133 (43 conferidos com o Planalto). Não há jurisprudência.
- Não há tabela de perguntas nem de histórico.

## Avaliação da estrutura de UI (protótipos × produção)

**O que o desenho original acerta e fica:**
- Três colunas: contexto à esquerda, trabalho no centro, prova à direita.
- A pergunta é o centro da tela.
- Resposta estruturada em blocos fixos.
- "Pontos que exigem revisão humana" separados da resposta.
- Fonte oficial com selo (Planalto) e se o texto foi conferido.
- Cada passagem entre agentes leva o contexto (cláusula, página, item).
- O preço separa o que é **cálculo** (motor) do que é **interpretação** (IA).

**O que o desenho original erra e muda nesta spec:**
- **A citação longe da afirmação.** A prova de cada afirmação aparece **colada** a ela (número da citação inline,
  `[1]`, `[2]`). A coluna da direita mostra as citações da resposta ativa e destaca a que o usuário clicou.
- **A passagem para o jurídico usa sempre a primeira citação** (`citations[0]`). Ela passa a ser **por alerta ou por
  citação**: cada uma tem o seu "Fundamentar".
- **"Categoria identificada" como botões que o usuário clica.** Isso parece filtro e contraria "sem múltipla
  escolha" (21/10). A categoria vira **rótulo informativo** devolvido pelo backend.
- **Jargão técnico na tela** ("Embeddings: SentenceTransformers • pgvector", "Seção 42 da Arquitetura"). Sai. No
  lugar entra **de onde veio**: "3 trechos de 2 documentos", "2 artigos conferidos com o Planalto".
- **Número sem fonte** ("Variação +1,8%", "Observações abaixo de R$ 1.900 referem-se a lotes acima de 50
  unidades"). Fica proibido: todo número vem do motor de cálculo (`api-precos`), e toda frase de interpretação cita
  o número que usa.
- **Estados ausentes.** Os protótipos só têm o "dia feliz". Esta spec exige quatro estados:
  - carregando;
  - documentos ainda não lidos (94% das licitações hoje), com o botão "Ler os documentos";
  - sem resposta na base: "não encontrei no edital", **nunca** uma resposta inventada;
  - erro.
- **Truncate e 3 colunas espremidas.** Seguem a regra de 22/10 (nenhuma rolagem lateral, nada cortado com "…"):
  - 3 colunas só a partir de 1280px;
  - abaixo disso, a coluna da esquerda vira um seletor no topo e as citações vão para baixo de cada resposta.

## Proposta

### Tela comum aos três agentes (K-10)

| Área | Edital | Jurídico | Preços |
|---|---|---|---|
| Topo | agente + oportunidade (busca, como hoje) | agente + vínculo com a oportunidade/cláusula, quando veio do edital | agente + recorte (PDM, item, unidade, período), como na /precos |
| Esquerda | documentos oficiais (lidos ou não; clicar abre o documento na página) + histórico de perguntas desta oportunidade | histórico de consultas da empresa (com estrela) + normas da base | amostras do recorte (as mesmas da /precos, com o selo "fora do perfil?") |
| Centro, em cima | caixa de pergunta + até 5 perguntas sugeridas (atalhos que preenchem a caixa, não filtros) | idem; chega preenchida quando vem de "Fundamentar" | idem; "o motor calcula, o agente interpreta" escrito uma vez, em uma linha |
| Centro, resposta | resposta com citações inline `[n]`; "Riscos e alertas" com o porquê; "Fundamentar no jurídico" por alerta | Resumo, Fundamentação, Dispositivos (com selo da fonte e "conferido"), Pontos para revisão humana, Nível de segurança | Interpretação com números do motor (mediana, p25–p75, N, fora do perfil) e alertas da regra 0,4×–2,5× (0031) |
| Centro, embaixo | análise por regra que já existe (alertas, Analisar de novo, enviada), agora com o "porquê" e a citação colada | achados do jurídico (como hoje) | referência praticada (0037 K-6) |
| Direita | citações da resposta ativa: documento, página, item/cláusula, trecho limpo (frase inteira, até ~300 caracteres) e "Abrir na página N" | dispositivos: norma, artigo, texto oficial, link para o Planalto | contratações da amostra mais próximas da mediana, com link do PNCP e do portal |

### Backend

1. **Perguntar ao edital** (K-1):
   - Busca nos chunks **só da licitação**, com página.
   - Resposta do modelo **obrigada** a citar os chunks recebidos.
   - Resposta sem citação válida vira "não encontrei no edital" (não é exibida).
   - A frase final é verificada: cada `[n]` precisa apontar para um chunk entregue ao modelo.
2. **Perguntar ao jurídico** (K-2):
   - Só sobre `norma_dispositivos`, mais o trecho da cláusula quando vem do edital.
   - Cada dispositivo citado precisa existir na base.
   - Dispositivo `conferido_oficial = false` aparece com o selo "não conferido".
   - Sem jurisprudência (fora de escopo).
3. **Perguntar ao preço** (K-3):
   - O modelo recebe **só** o resumo e as amostras calculados pela `api-precos` e escreve a interpretação.
   - Número que não está na entrada é rejeitado pela validação (comparação numérica do texto com a entrada).
4. **Item/cláusula na citação** (K-4):
   - `Fonte.chunk` ganha `item` (ex.: "8.4.2") e `trecho_limpo`, extraídos do texto do chunk no momento da resposta
     (regex de numeração de item; frase inteira em volta do trecho).
   - Sem item reconhecido, o campo vem `null` (não se inventa).
5. **Histórico** (K-5): tabela `agente_perguntas`, por empresa (tenant), com pergunta, agente, licitação (quando
   houver), resposta, citações, modelo, versão do prompt, quem perguntou, quando e estrela.
6. **Ler os documentos** (K-6): a mesma indexação do coletor, disparada para uma licitação do pipeline que ainda
   não tem chunks, com o estado "em leitura" na tela.

**Onde roda o modelo (decisão de 22/10):** num serviço no Cloud Run (`agente-perguntas`), em Python, reaproveitando
`ia.py` e `buscar.py` com os créditos do GCP. Ele é chamado só pela `api-agentes`, que continua fazendo
autenticação, empresa e pipeline e passa ao serviço só o necessário. O serviço não é público: aceita só chamadas
autenticadas da `api-agentes` (token de identidade do Google ou segredo compartilhado; escolhido na implementação,
com `revisor-seguranca`). Nenhuma chave do GCP vai para os segredos do Supabase.

## Contrato

| ID | Contrato | Entrada | Saída | Erros | Quem |
|---|---|---|---|---|---|
| K-1 | `api-agentes` `pergunta_edital` | `licitacao_id`, `pergunta` (até 500 caracteres) | `resposta` (texto com `[n]`) \| `null`; `motivo_sem_resposta` (`sem_documentos` \| `nao_encontrado`); `citacoes[]`: `{n, documento_id, documento_nome, pagina, item, trecho_limpo}`; `pergunta_id` | 400 validação; 404 fora do pipeline; 409 documentos em leitura; 429 depois de **50 perguntas por empresa por dia** (somando os três agentes; decisão de 22/10) | membro da empresa ou admin |
| K-2 | `api-agentes` `pergunta_juridico` | `pergunta`; opcional `clausula {licitacao_id, documento_id, pagina, item, trecho}` | `resumo`, `fundamentacao` (com `[n]`), `dispositivos[]`: `{n, norma, artigo, texto, conferido_oficial, url_oficial}`, `pontos_revisao[]`, `nivel` (`conforme` \| `possivel_divergencia` \| `sem_base_suficiente`), `categoria` (rótulo), `pergunta_id` | idem | idem |
| K-3 | `api-agentes` `pergunta_preco` | recorte da /precos (os mesmos filtros e `perfil`) + `pergunta` | `interpretacao` (só com números da entrada), `numeros_usados[]`, `alertas[]` da regra 0,4×–2,5×, `pergunta_id` | idem + 400 `pdm_fora_do_catalogo` | idem |
| K-4 | `Fonte.chunk` (aditivo, também nos achados de `analise_*`) | — | `item` \| `null`, `trecho_limpo`, `documento_nome` | — | — |
| K-5 | Tabela `agente_perguntas` + `api-agentes` `perguntas_listar`, `pergunta_favoritar` | tenant da sessão; filtro por agente/licitação | lista paginada, sem dados de outra empresa | 403 outra empresa | membro da empresa |
| K-6 | `api-agentes` `documentos_ler` | `licitacao_id` | estado `em_leitura` \| `lidos` \| `sem_documentos` | 404; 409 já em leitura; 403 para quem não é admin nem operação | admin e operação (decisão de 22/10) |
| K-7 | Passagem edital → jurídico | clique em "Fundamentar" num alerta ou numa citação | rota `/agentes/juridico?licitacao=…&documento=…&pagina=…&item=…` + trecho (no estado da navegação, não na URL) e pergunta pré-preenchida | — | — |
| K-8 | "Abrir na página N" | `documento_id`, `pagina` | abre o PDF do Storage (URL assinada) em nova aba, já na página (`#page=N`) | documento sem PDF: o botão não aparece | membro da empresa |
| K-11 | `api-agentes` `pergunta_enviar` | `pergunta_id` | nota na aba "Análise dos agentes" da oportunidade, com a pergunta, a resposta, as citações, quem enviou e quando; **sem** aprovar/rejeitar e sem virar achado | 404; 409 já enviada; 400 pergunta sem licitação (jurídico avulso) | membro da empresa |
| K-9 | Telas `/agentes/editais`, `/agentes/juridico`, `/agentes/precos` (sem dado de demo no bundle) | contratos acima + `analise_*` de hoje | layout da tabela "Tela comum" com os 4 estados; **aprovado por print antes da implementação** (como a 0036) | — | membro da empresa |

## Critérios de aceite

| ID | Contrato | Dado / Quando / Então | Teste que prova |
|---|---|---|---|
| CA-1 | K-1 | **Dado** a licitação do print (Pregão 29/2026 SSP-SP) com chunks, **quando** pergunta "Há exigência de amostra?", **então** a resposta cita `[n]` só com chunks dessa licitação, com página (11 ou 15) e item quando o texto tem numeração. | Deno `tests/supabase/api-agentes/pergunta_edital_test.ts` (modelo falso) + avaliação real anexada ao PR |
| CA-2 | K-1 | **Dado** o modelo falso citando `[7]` que não foi entregue, **quando** responde, **então** a API devolve `resposta: null, motivo_sem_resposta: "nao_encontrado"`. | Deno (mesmo arquivo) |
| CA-3 | K-1 | **Dado** uma licitação sem chunks, **então** `motivo_sem_resposta: "sem_documentos"`, sem chamar o modelo. | Deno |
| CA-4 | K-2 | **Dado** a cláusula de amostra vinda do edital, **quando** pergunta ao jurídico, **então** cada dispositivo devolvido existe em `norma_dispositivos`, e um não conferido vem com `conferido_oficial: false`; um artigo inventado pelo modelo é removido e o `nivel` cai para `sem_base_suficiente` se nada sobrar. | Deno `pergunta_juridico_test.ts` |
| CA-5 | K-3 | **Dado** o resumo do PDM 7115, **quando** a interpretação do modelo falso cita "R$ 15.000" que não está na entrada, **então** a resposta é recusada e refeita uma vez; na segunda falha vem `interpretacao: null`. | Deno `pergunta_preco_test.ts` |
| CA-6 | K-4 | **Dado** um chunk com "8.4.2 É obrigatória a realização de visita técnica…", **então** `item = "8.4.2"` e `trecho_limpo` começa no início da frase, sem palavra cortada. | Deno `_shared/agentes/citacao_test.ts` |
| CA-7 | K-5 | **Dado** perguntas de duas empresas, **quando** cada uma lista, **então** só vê as suas; `anon` e outra empresa recebem 403/vazio. | SQL `supabase/tests/agente_perguntas_check.sql` + Deno |
| CA-8 | K-7 | **Dado** um alerta "Amostra exigida", **quando** clica "Fundamentar no jurídico", **então** a rota tem `documento`, `pagina` e `item`, e a caixa do jurídico chega com a pergunta e o trecho da cláusula. | vitest `src/test/agentes-pergunta.test.tsx` (Dashboard) |
| CA-9 | K-9 | **Dado** cada um dos 4 estados (carregando, sem documentos, não encontrado, erro), **então** a tela mostra o texto do estado e nunca uma resposta vazia ou inventada; abaixo de 1280px não há rolagem lateral nem "…". | vitest + `run-dashboard` (claro, escuro, celular) |
| CA-11 | K-11 | **Dado** uma resposta do edital, **quando** "Enviar para a oportunidade", **então** a aba da oportunidade mostra a nota com pergunta, resposta e citações, sem botões de aprovar/rejeitar, e a contagem de achados não muda; enviar de novo dá 409. | Deno + vitest |
| CA-12 | K-1 | **Dado** 50 perguntas da empresa no dia, **quando** faz a 51ª, **então** 429 com a mensagem "Limite de 50 perguntas por dia atingido"; no dia seguinte (horário de Brasília) volta a responder. | Deno |
| CA-10 | K-9 | **Dado** o build de produção, **então** `check-bundle` passa: nada dos protótipos (`mockData`) entra no `dist/`. | `npm run build` |

## Skills e agentes por contrato

| Contrato | Desenho e leitura | Implementação | Teste | Revisão antes do PR | Depois do merge |
|---|---|---|---|---|---|
| K-1 a K-6 | `/spec` | `/implement` (TDD) | Deno + SQL | `revisor-codigo` + `revisor-seguranca` (tenant, `service_role`, custo) + `revisor-migration` (K-5) | `verificar-producao` |
| Serviço do modelo (se Cloud Run) | `/spec` | `/implement` | pytest | `revisor-codigo` + `revisor-seguranca` | `verificar-producao` |
| K-7 a K-9 | print aprovado pelo Marcelo | agente `frontend-dashboard` | vitest | `revisor-codigo` + `revisor-seguranca` + `ux-ui-licitagym` | `run-dashboard`, `deploy-dashboard` |

## Fases

1. **Print da tela (K-9)**: os três agentes nos 4 estados, aprovados pelo Marcelo antes de qualquer código de front.
2. **Edital**: K-4, K-1, K-5 e K-6, depois a tela do edital (K-7 e K-8).
3. **Jurídico**: K-2 e a tela do jurídico.
4. **Preços**: K-3 e a tela de preços (usa a 0037 para o "fora do perfil").

## Fora de escopo

- Resposta que não cita fonte da base (edital, `norma_dispositivos`, `api-precos`).
- Jurisprudência (TCU, tribunais) e base de normas além da Lei 14.133: spec própria quando houver base conferida.
- Leitor de documento embutido com o trecho destacado (o K-8 abre o PDF na página em nova aba).
- A pergunta virar achado. A resposta fica no histórico e pode ir para a oportunidade **como nota** (K-11); achado
  continua vindo da análise por regra com Analisar → Enviar → revisar (0032/0035).
- Peça jurídica (minuta), que continua na fase 4 da 0032.
- Chat com várias rodadas: é uma pergunta e uma resposta por vez, com histórico.

## Impacto em dados

- **Migration:** sim. A tabela `agente_perguntas` é aditiva, com RLS por empresa, grants só a `service_role`, e a
  leitura passa pela `api-agentes`. A RPC de busca de chunks **por licitação e com página** é nova; a
  `match_licitacao_chunks_v2` não muda.
- **Edge Functions republicadas:** `api-agentes`, e as demais pelo workflow.
- **Contrato com o Dashboard:** aditivo. Ações novas, e `Fonte.chunk` ganha campos.
- **Custo:** uma chamada de modelo por pergunta. É medido na fase 2 (tokens por pergunta) e tem limite por empresa
  por dia (K-1, 429).
- **Dado oficial × derivado:** documentos, `norma_dispositivos` conferidos e estatísticas da `api-precos` são a
  fonte. A resposta é derivada, guardada com modelo, versão do prompt e as citações que a sustentam.

## Decisões do Marcelo

- 22/10: as rotas dos agentes devem seguir a estrutura dos protótipos (3 colunas, pergunta no centro, citações
  verificáveis, passagem edital → jurídico com a cláusula), sem os dados de exemplo.
- 22/10: o modelo roda num serviço no Cloud Run, com os créditos do GCP.
- 22/10: a resposta pode ser enviada para a oportunidade como nota (sem aprovar/rejeitar, sem virar achado).
- 22/10: "Ler os documentos" fica para admin e operação.
- 22/10: limite de 50 perguntas por empresa por dia.
- 22/10: o Agente de Preços na rota própria entra (fase 4), depois da 0037.

## Perguntas em aberto

Nenhuma. As cinco perguntas do rascunho foram respondidas em 22/10 (ver Decisões).
