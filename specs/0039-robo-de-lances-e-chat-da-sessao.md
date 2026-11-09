# 0039: Criar o robô de lances e o chat da sessão do Compras.gov.br

- **Status:** etapa 1 em implementação (retomada a pedido do Marcelo em 07/11/2026). As
  etapas 2 a 4 continuam paradas. Decisão de 23/10/2026: o código esperaria a fase 3 da 0032.
- **Alimenta:** módulos 5 (Alerta de disputa), 6 (Sessão do certame) e 7 (Inteligência de sessão) do
  `docs/produto/ESCOPO.md`, e um módulo novo, o 10 (Robô de lances). Não alimenta a 0032.
- **Repositório:** os dois, mais uma extensão de navegador (pasta nova, ver "Perguntas em aberto"). O backend vai ao
  ar antes do front.
- **Issue:** nenhuma. Pedido do Marcelo em 23/10/2026, na thread "Robô de lances no ComprasNet". Parecer de pesquisa:
  https://claude.ai/artifact/H8Ae49Mny1Jh3nadYdCwnk (cópia em `/mnt/project-files/pesquisa-robo-lances/`).
- **Área:** coletor | migrations | edge-functions | dashboard-contrato | dashboard-tela | extensão
- **Depende do ok do Marcelo:** sim. Há migration, decisão de produto, contrato pago com o Serpro e mudança de regra
  escrita (ESCOPO e matriz de segurança).

## Leitura obrigatória antes de implementar

Os itens 1 a 4 e 10 do template valem como estão. Arquivos específicos desta spec:

| # | Arquivo | Por quê |
|---|---|---|
| 5 | Parecer "Robô de lances no ComprasNet" (link acima) | base legal (IN SEGES 73/2022, TCU), o que fica fora e por quê |
| 7 | `.claude/rules/coletor.md`, `python-ingestion.md`, `database-migrations.md`, `edge-functions.md`, `tests.md` | convenções das áreas |
| 8 | `supabase/functions/_shared/agentes/preco.ts` (`pisoTenantCentavos`, `classificarExequibilidade`) | o piso do robô vem daqui; não criar segunda implementação |
| 8 | `specs/0036-grupos-certame-e-regras-edital.md` | no Compras.gov.br o lance é por grupo; piso por grupo depende dela |
| 8 | `specs/0018-tarefas-padrao-por-etapa.md` (linhas 223-224) | o caso real de convocação perdida no chat |
| 8 | `docs/seguranca/licitagym_rag_seguranca_prompt_injection.md` (linha 436) | "registrar lance: não expor ao modelo" continua valendo |
| 8 | Dashboard `src/components/layout/AppShell.tsx` | o sino de notificações (hoje só demo) |
| 9 | Documentação do Integra Compras: https://apicenter.estaleiro.serpro.gov.br/documentacao/integra-compras/ | endpoints, autenticação, códigos de retorno, cobrança |

## Problema

1. **O chat da sessão do Compras.gov.br não é lido.** A tela pública exige captcha, e coleta com captcha está fora de
   escopo (`ESCOPO.md`, "Fora de escopo"; `specs/0032:96`; `specs/0031:256`). Convocação, diligência e negociação
   saem só ali (`specs/0018:224`). No caso lido, perder o prazo de 4 horas de uma convocação levou à inabilitação
   (`specs/0018:223`). Os módulos 5, 6 e 7 estão parados por falta de fonte.
2. **Não há robô de lances.** O Marcelo decidiu em 23/10/2026 que o robô é um diferencial do produto. Hoje o
   operador dá cada lance à mão, ou usa só o lance automático nativo do portal (IN SEGES 73/2022, art. 19), que não
   faz lance intermediário nem acompanha vários itens com estratégia.
3. **Fonte oficial disponível:** o Integra Compras (Serpro + MGI) expõe, por API REST paga, o "chat de mensagens" e
   o "chat de diligências" do Compras.gov.br. Contrato de adesão assinado em 23/10/2026 pela Vectra Hub Ltda (pedido
   615074). Chaves ainda não liberadas (até 10 dias úteis). Preço, atraso das mensagens durante a sessão e o OAS de
   produção: não medidos.

## Desenho

- **Chat é dado global da plataforma** (decisão de 23/10): uma cópia por compra, sem `tenant_id`, como licitações e
  preços homologados. O que é da empresa fica por tenant: pipeline, alertas, estratégia e lances do robô, proposta.
  O MVP tem uma empresa só, e nenhum trabalho de várias empresas entra aqui além da estrutura de tenant que já existe.
- **Finalidade registrada:** avaliação dos certames (módulo 7) e acompanhamento da sessão (módulos 5 e 6). O contrato
  do Integra Compras (cláusula 3.1.5) só permite guardar o que for indispensável à atividade, com registro de acesso,
  finalidade e base legal. A spec guarda o mínimo: a mensagem bruta por prazo limitado, e o resultado da avaliação
  (motivo, contagem, desconto, trecho de prova) sem prazo. Ver K-1 e K-7.
- **Robô = extensão de navegador na sessão do próprio operador**, já logado no Compras.gov.br. O LicitaGym nunca
  guarda senha gov.br nem certificado, e o login e qualquer captcha são da pessoa. O robô lê a sala de disputa e dá
  lances pela tela, sob regra determinística. O modelo de IA não decide lance (matriz de segurança, linha 436, segue
  valendo: quem envia é código determinístico autorizado pelo operador, não o modelo).
- **Fica fora, por decisão de 23/10:** proxies, falsificação de impressão digital do navegador, quebra ou terceirização
  de captcha, API privada descoberta por interceptação de tráfego, operação 24 horas na nuvem com a credencial do
  cliente. Se o portal exigir algo que só uma pessoa faça, o robô para e devolve a decisão ao operador.
- **Rede de segurança:** o operador configura também o valor final mínimo nativo (IN 73, art. 19). Se a extensão
  cair, o sistema do governo continua dando lances até o piso.

## Etapas

| Etapa | Entrega | Contratos | Risco |
|---|---|---|---|
| 1 | Chat oficial: tabela, coletor do Integra Compras, aba Sessão, alerta de convocação | K-1 a K-5 | baixo: só leitura de fonte oficial |
| 2 | Extensão só de leitura: lê a sala, mostra piso e próximo lance válido, grava a disputa, confere o layout a cada sessão | K-6, K-8, K-11 | baixo: não envia nada |
| 3 | Lance com confirmação: a extensão preenche o lance e o operador confirma com um clique | K-9 | médio |
| 4 | Lance automático dentro do piso, com autorização por certame | K-9, K-10 | alto: só depois de a etapa 3 rodar em pregões reais |

Cada etapa é um PR (ou um par backend + front). A etapa 1 mede o atraso das mensagens num pregão real. Esse número
decide se o alerta de convocação pode depender só da API ou precisa da extensão (SLA do contrato: faixa de 90% a 94%
de disponibilidade, paradas programadas excluídas, manutenção de fim de semana).

## Implementação da etapa 1 (07/11/2026)

O backend desta spec já tinha entrado em 25/10 pelo Cursor (`api-disputa`, `_shared/serpro.ts`, migration
`20261025000000`). Conferido contra o exemplo oficial (`docs/compras-gov/integra-compras.md`), não funcionava com a API
real: esperava objeto em vez de lista, campos com outros nomes e caminho de diligências errado, e guardava o chat por
tenant. A etapa 1 corrige esse código em vez de criar outro:

- K-1 e K-2: migration `20261108120000_sessao_mensagens_global.sql` (tira `disputa_mensagens`, vazia em produção).
- K-3 e K-4: rotas `POST /api-disputa/sync-chat` e `GET /api-disputa/chat` (em vez de `sync-integra-compras` e
  `api-sessao`). Secrets: `SERPRO_CONSUMER_KEY` e `SERPRO_CONSUMER_SECRET` (nome já usado no código).
- PR #466 (mergeado em 08/11/2026): K-1, K-2, `sync-chat` e `chat`.
- Segundo PR (08/11/2026): coleta agendada e retenção.
  - K-3 agendado: Edge Function `sync-sessao-chat` (o `cron_chamar_edge` só chama a raiz de uma função, não
    `api-disputa/sync-chat`). A lógica de consulta e gravação foi para `_shared/sessao_chat.ts`, usada pelas duas.
    Alvos (`private.sessao_chat_alvos`): compras do pipeline de empresa ativa, fora das etapas perdida e descartada,
    com chave oficial, sem homologação e com `data_fim` entre 30 dias atrás e 2 h à frente.
    Custo: rodízio (quem foi consultado há mais tempo vem primeiro), compra consultada há menos de 55 min fica de fora
    (cerca de uma leitura por hora), teto de 300 chamadas por dia (Brasília, inclui as manuais; execução interrompida
    conta pelo pior caso), 10 compras por rodada e nenhuma compra nova depois de 90 s. Agenda: a cada 30 min, das 8h
    às 19h30, de segunda a sexta. Disparável pela tela de Syncs. A rota manual não tem teto diário, só o intervalo
    de 5 min por compra.
    A "amostra de homologados" fica para o módulo 7.
  - K-7: `private.sessao_mensagens_retencao()`, diária. `expira_em` = menor homologação das licitações consultadas
    com a chave + 90 dias; texto vencido vira nulo e a linha fica. A ligação com a licitação vem da coluna nova
    `integra_compras_run.licitacao_id`. Homologação desfeita na fonte tira o prazo de quem ainda tem texto.
    Limitação: compra que nunca homologa (deserta, fracassada, revogada) não expira. Ver pergunta 7.
- Aba Sessão (pedido do Marcelo em 08/11/2026): `GET /api-disputa/sessoes` lista as compras do pipeline da empresa
  com a situação da coleta (mesma janela de `private.sessao_chat_alvos`), a última consulta e o total de mensagens.
  Só lê, não chama o Integra Compras. A tela no Dashboard usa essa rota, `GET /chat` e `POST /sync-chat`.
- Alerta de convocação (K-5): ver "Etapa 1b" abaixo. O sino do Dashboard vem num PR do Dashboard depois do backend.

### Etapa 1b: alerta de convocação (K-5), decisões de 08/11/2026

Base: 163 mensagens reais de 2 compras (lidas em 08/11). Sem tabela oficial de `categoria`, a detecção é pelo texto
(`docs/compras-gov/integra-compras.md`, "Em aberto"). Os dois textos do sistema que viram alerta nesta entrega:

| Tipo | Texto do sistema (exemplo real, CNPJ mascarado) | O que o alerta guarda |
|---|---|---|
| `convocacao_anexos` | "Sr. Fornecedor JULIO CESAR GASPARINI JUNIOR LTDA, CNPJ NN.NNN.NNN/NNNN-NN, você foi convocado para enviar anexos para o item G1. Prazo para encerrar o envio: 12:12:00 do dia 14/10/2026." | item, razão social e CNPJ de quem foi convocado, `da_empresa` (CNPJ igual ao do tenant), prazo |
| `etapa_fechada` | "A etapa fechada foi iniciada para o item G2. Fornecedores convocados poderão enviar um lance único e fechado até às 08:54:46 do dia 14/10/2026." | item, prazo |

- Toda convocação vira alerta, inclusive de outro fornecedor, com a razão social (decisão de 08/11).
- Canal: só o sino do Dashboard nesta entrega; e-mail e push ficam para depois (decisão de 08/11).
- Prazo: hora de Brasília do texto (UTC−3) convertida para timestamptz. Texto sem prazo legível: `prazo = null`
  (nunca inventado). `vencido` é calculado na leitura (prazo < agora).
- Só mensagem com `data_hora` nas últimas 24 h vira alerta: a primeira leitura de uma compra traz o histórico
  inteiro, e convocação antiga não é alerta.
- Destino: cada tenant ativo com a licitação no pipeline, fora das etapas perdida e descartada (mesma regra de
  `private.sessao_chat_alvos`).
- Limite conhecido: na etapa fechada o prazo é de cerca de 5 minutos (exemplo real: mensagem às 11:49:46 UTC, prazo
  11:54:46 UTC). Com a coleta a cada 30 min e cerca de 1 leitura por hora por compra, esse alerta quase sempre chega
  vencido. A convocação de anexos teve 2 h de prazo no exemplo e é o caso que o alerta resolve. Encurtar o atraso é
  assunto da medição (pergunta 3) e da extensão (etapa 2).
- Geração idempotente: a cada consulta, as mensagens lidas (não só as novas) passam pela detecção e o insert ignora
  duplicata por `(tenant_id, chave_mensagem)`. Falha na geração não derruba a consulta (mensagens e chamadas cobradas
  ficam registradas, o run guarda o aviso e `alertas_gerados` volta `null`); a leitura seguinte refaz.
- Só mensagem do Sistema (`tipo_remetente = "0"`, mapa deduzido) vira alerta: o mesmo texto escrito por licitante
  ou pregoeiro no chat não vira (revisão de segurança de 08/11: um concorrente poderia forjar uma convocação).
- Variações aceitas: "Sr." ou "Sr(a).", com ou sem acento, "convocado(a)", CNPJ com ou sem máscara e alfanumérico
  (Receita, jul/2026). Convocação com cabeçalho desconhecido vira alerta sem fornecedor (não se perde).
- Convocado por CPF (pessoa física): o alerta nasce sem nome nem documento.
- Retenção (K-7): razão social e CNPJ do alerta somem junto com o texto bruto da mensagem (90 dias depois da
  homologação), na mesma rotina `private.sessao_mensagens_retencao()`.
- Mesma compra em duas licitações (fontes diferentes): a consulta é uma só, e cada tenant recebe o alerta ligado à
  licitação do pipeline dele.
- Limite conhecido também: quando o teto diário de chamadas (300) é atingido, nenhuma compra é lida até a meia-noite
  de Brasília, e uma convocação nesse intervalo não vira alerta a tempo.

| ID | Contrato | Entrada | Saída | Erros | Quem |
|---|---|---|---|---|---|
| K-5a | Tabela `public.sessao_alertas` (por tenant, RLS ligada, sem policy) | — | `tenant_id`, `licitacao_id`, `chave_mensagem` (único por tenant), `tipo`, `identificador_item`, `fornecedor_razao_social`, `fornecedor_cnpj`, `da_empresa`, `prazo`, `mensagem_em`, `criado_em`, `lido_em`, `lido_por` | — | escrita e leitura só `service_role` |
| K-5b | Detecção e geração em `_shared/sessao_alertas.ts`, chamada por `sincronizarCompra`; destinos em `private.sessao_alertas_destinos(bigint[])` | mensagens lidas da compra, licitações com a mesma chave, agora | alertas gravados para cada tenant destino | erro de banco não derruba a consulta: aviso no run e `alertas_gerados = null` | coleta (cron e rota manual) |
| K-5c | `GET /api-disputa/alertas` | `?nao_lidos=true` opcional | alertas do tenant, do mais novo para o mais velho (até 50), com `vencido` | 401 / 403 | membro do tenant |
| K-5d | `POST /api-disputa/alertas/lido` | `{ "id": n }` | `{ ok: true }`, grava `lido_em` e `lido_por` | 400 id inválido; 404 alerta de outro tenant ou inexistente | membro do tenant |

| CA | Contrato | Dado / Quando / Então | Teste |
|---|---|---|---|
| CA-7a | K-5b | **Dado** o texto real de convocação de anexos, **quando** a detecção roda, **então** devolve `convocacao_anexos`, item `G1`, a razão social, o CNPJ com 14 dígitos e prazo `2026-10-14T15:12:00Z`. Texto sem prazo legível devolve `prazo = null`; mensagem comum devolve nada. | Deno `tests/supabase/functions/_shared/sessao_alertas_test.ts` |
| CA-7b | K-5b | **Dado** o texto real de etapa fechada, **quando** a detecção roda, **então** devolve `etapa_fechada`, item `G2` e prazo `2026-10-14T11:54:46Z`. | idem |
| CA-7c | K-5b | **Dado** uma convocação nova nas últimas 24 h numa licitação do pipeline de dois tenants (um com o CNPJ convocado), **quando** a consulta grava, **então** nasce um alerta por tenant, com `da_empresa` verdadeiro só no dono do CNPJ; rodar de novo não duplica; convocação com mais de 24 h não vira alerta. | idem + `sync_sessao_chat_test.ts` |
| CA-7d | K-5c | **Dado** alertas de dois tenants, **quando** o membro do tenant A lista, **então** vê só os do A, com `vencido` correto; sem vínculo com tenant ativo, 403 (CA negativo de acesso). | Deno `tests/supabase/functions/api_disputa_alertas_test.ts` |
| CA-7e | K-5d | **Dado** um alerta do tenant B, **quando** o membro do tenant A marca como lido, **então** recebe 404 e o alerta continua não lido; o do próprio tenant grava `lido_em` e `lido_por`. | idem |
| CA-7f | K-5a | **Dado** a migration, **quando** `anon` ou `authenticated` leem ou escrevem `sessao_alertas`, **então** recebem erro de permissão; RLS ligada. | SQL `supabase/tests/sessao_alertas_check.sql` |

| CA | Teste |
|---|---|
| CA-1 | `supabase/tests/sessao_mensagens_check.sql` |
| CA-2 | `serpro_test.ts` e `api_disputa_test.ts` ("CA-2: ...") |
| CA-3 | `serpro_test.ts` e `api_disputa_test.ts` ("CA-3: ...") |
| CA-4 | `serpro_test.ts` ("CA-4: ...") |
| CA-5 | `serpro_test.ts` e `api_disputa_test.ts` ("CA-5: ...") |
| CA-6 | coberto por `lerTenantDoUsuario` (`_shared/tenant.ts`), sem teste novo |
| CA-7 | backend: CA-7a a CA-7f (Etapa 1b); sino: PR do Dashboard |
| CA-8 | `supabase/tests/sessao_chat_cron_retencao_check.sql` |
| CA-9 | Dashboard `src/test/sessao.test.tsx`; lista em `tests/supabase/functions/api_disputa_sessoes_test.ts` |
| K-3 agendado | `tests/supabase/functions/sync_sessao_chat_test.ts` |

## Contrato

| ID | Contrato | Entrada | Saída | Erros | Quem |
|---|---|---|---|---|---|
| K-1 | Tabela `public.sessao_mensagens` (global, RLS ligada, sem policy; leitura só por Edge Function) | — | `chave_compra` (texto de 17 dígitos, como o Integra Compras), `id_uasg`, `id_modalidade`, `numero`, `ano`, `identificador_item` (nulo = mensagem da compra), `chave_mensagem` (uuid da fonte, único), `tipo` (`mensagem` \| `diligencia`), `categoria`, `tipo_remetente`, `texto`, `data_hora` (timestamptz, ms), `fonte` (`integra_compras` \| `extensao`), `coletado_em`, `expira_em` | — | escrita: `service_role` (coletor e `api-sessao`); leitura: `api-sessao` |
| K-2 | Tabela `private.integra_compras_run` | — | uma linha por execução: compras consultadas, chamadas por código HTTP (200, 206, 404 são cobrados), mensagens novas, erro | — | `service_role` |
| K-3 | Coletor `sync-integra-compras` (Edge Function `sync-*` ou job do `coletor-externo`, decidir no `/implement`) | lista de compras alvo: certames do Compras.gov.br no pipeline e no radar com sessão prevista ou aberta, mais amostra de homologados (tamanho configurável, começa pequeno) | grava K-1 sem duplicar (`chave_mensagem`), grava K-2; respeita `Retry-After`, backoff, token de 1 h renovado | 401 renova token uma vez; 403 ou 502 registra e para a compra; 404 = "sem mensagens", não é erro | cron (`requireCronAuth`) |
| K-4 | `api-sessao` `action=mensagens` | `licitacao_id` | mensagens da compra em ordem de `data_hora`, por item e geral, com fonte | 400 / 401 / 403 / 404 | membro do tenant |
| K-5 | Alerta de convocação | mensagem nova de categoria ou texto de convocação, negociação, desempate ME/EPP, pedido de documentos ou abertura de item, em certame que o tenant tem no pipeline | notificação no sino do Dashboard e por e-mail (push no celular fica para depois) | — | tenant dono do pipeline |
| K-6 | Extensão de navegador (Chrome), etapa 2 | sessão do operador já logada na sala de disputa | lê itens, melhor lance, posição, tempo e chat; mostra piso (K-8) e próximo lance válido; envia eventos para `api-sessao` `action=evento_extensao` com `tenant_id` | sessão expirada ou tela mudou: avisa o operador e para | operador do tenant |
| K-7 | Retenção | `expira_em` | texto bruto apagado no prazo; resultado da avaliação (módulo 7) fica, sem dado pessoal | — | cron |
| K-8 | Estratégia por certame (etapa Proposta) | piso por item e por grupo (`pisoTenantCentavos`; regra de agregação do grupo escrita na spec da 0036), intervalo mínimo de diferença de valores lido do edital, modo de disputa, tipo de lance (ataque \| intermediário), janela de atuação | registro por certame e item, com versão | piso ausente = robô não atua no item | admin do tenant |
| K-9 | Envio de lance pela extensão, etapas 3 e 4 | estratégia K-8 + estado lido da sala | lance calculado em centavos, nunca abaixo do piso, respeitando o intervalo do edital; etapa 3 pede clique; etapa 4 envia sozinho só com K-10 | qualquer leitura incerta da tela: não envia | operador |
| K-10 | Autorização do robô por certame | aceite do admin do tenant: termo de responsabilidade (IN 73, art. 13, III), piso assinado, botão de desligar | trilha de auditoria por lance: valor, hora, regra aplicada, quem autorizou | sem aceite: só etapa 3 | admin do tenant |
| K-11 | Autoverificação de layout da extensão, etapa 2 | ao abrir a sala e a cada item aberto | confere os elementos de que o robô depende (botão de lance, melhor lance, posição, tempo, item) contra um contrato versionado de seletores; resultado `ok` ou `divergente` com a impressão da estrutura (sem dado do operador) vai para o backend como evento; divergência vira alerta para a equipe LicitaGym | divergência: a extensão para de atuar no certame e avisa o operador; o valor final mínimo nativo (art. 19) continua valendo | extensão do operador; alerta para admin da plataforma |

## Critérios de aceite

Só a etapa 1 tem CAs completos. As etapas 2 a 4 ganham CAs na revisão desta spec, depois da etapa 1 medir o atraso.

| ID | Contrato | Dado / Quando / Então | Teste que prova |
|---|---|---|---|
| CA-1 | K-1 | **Dado** a migration aplicada, **quando** `anon` ou `authenticated` fazem `select` em `sessao_mensagens`, **então** recebem erro de permissão. | SQL `supabase/tests/sessao_mensagens_check.sql` |
| CA-2 | K-3 | **Dado** a resposta de exemplo da documentação do Integra Compras (3 mensagens da compra 99998803000012026), **quando** o coletor processa duas vezes, **então** há 3 linhas, com `identificador_item` nulo na primeira e `"1"` nas outras. | Deno ou pytest com fixture da documentação |
| CA-3 | K-3 | **Dado** retorno 404, **quando** o coletor consulta, **então** grava zero mensagens e K-2 registra o 404 como cobrado, sem erro. | idem |
| CA-4 | K-3 | **Dado** retorno 401, **quando** o coletor consulta, **então** pede token novo uma única vez e repete a chamada. | idem |
| CA-5 | K-3 | **Dado** retorno 502 (manutenção da base), **quando** o coletor consulta, **então** K-2 registra erro e nenhuma mensagem é apagada ou inventada. | idem |
| CA-6 | K-4 | **Dado** um usuário sem vínculo com tenant ativo, **quando** chama `action=mensagens`, **então** recebe 403. | Deno `tests/supabase/api-sessao/*` |
| CA-7 | K-5 | **Dado** uma mensagem nova "convoca o fornecedor ... para envio de anexo" num certame do pipeline, **quando** o coletor grava, **então** nasce uma notificação para o tenant com link para a aba Sessão. | Deno |
| CA-8 | K-7 | **Dado** mensagens com `expira_em` no passado, **quando** a rotina de retenção roda, **então** o texto bruto é apagado e a contagem de K-2 continua igual. | SQL ou Deno |
| CA-9 | aba Sessão | **Dado** um certame sem mensagens, **quando** o operador abre a aba, **então** vê o estado vazio com a fonte e o horário da última consulta, nunca mensagem fictícia. | vitest `src/test/...` |
| CA-10 | K-11 | **Dado** uma sala em que o botão de lance mudou de seletor, **quando** a extensão abre o item, **então** ela marca `divergente`, não envia nem sugere lance, avisa o operador e grava o evento no backend. | etapa 2 (a definir) |
| CA-11 | K-11 | **Dado** um evento `divergente`, **quando** chega ao backend, **então** nasce um alerta para o admin da plataforma com a versão do contrato de seletores e a tela afetada. | etapa 2 (a definir) |

## Skills e agentes por contrato

| Contrato | Desenho e leitura | Implementação | Teste | Revisão antes do PR | Depois do merge |
|---|---|---|---|---|---|
| K-1, K-2, K-7 | `/spec` | skill `nova-migration` | `supabase/tests/sessao_mensagens_check.sql` | `revisor-migration` + `revisor-seguranca` | `validar-migrations` antes; `verificar-producao` + `get_advisors` depois |
| K-3, K-4, K-5 | `/spec` | `/implement` (TDD) | Deno / pytest | `revisor-codigo` + `revisor-seguranca` | `verificar-producao` |
| aba Sessão, sino | `/spec` | agente `frontend-dashboard` | vitest | `revisor-codigo` + `revisor-seguranca` + `ux-ui-licitagym` | `deploy-dashboard` |
| K-6, K-8 a K-11 | revisão desta spec depois da etapa 1 | a definir | a definir | `revisor-codigo` + `revisor-seguranca` | a definir |

## Fora de escopo

- Tudo da lista "Fica fora, por decisão de 23/10" em "Desenho".
- Monitorar o layout por cron na nuvem ou no computador logado no portal (exige guardar credencial e enfrentar
  captcha; a sala só existe com sessão aberta). A detecção é a K-11, dentro da sessão real do operador.
- Correção automática de seletor: o modelo (Gemini) pode sugerir o seletor novo a partir do evento K-11, mas a
  correção entra só por PR revisado e testado. Nada gerado por modelo vai para o código de lance sem revisão humana.
- Outros portais (Portal de Compras Públicas, BLL, Licitanet, Sistema S). O Portal de Compras Públicas tem plano
  próprio de leitura do chat público (`docs/superpowers/plans/2026-10-12-acompanhamento-portal-compras-publicas.md`).
- Responder ao pregoeiro pelo chat ou enviar documento. O robô só dá lance.
- Base de treino dos agentes com acervo de chats (módulo 8): espera a resposta do Serpro sobre a cláusula 3.1.5.
- Perfil de pessoas (pregoeiros, representantes) a partir do chat: proibido pelo anexo de LGPD do contrato (11.4).

## Impacto em dados

- **Migration:** sim, aditiva e idempotente: `sessao_mensagens`, `private.integra_compras_run`, tabela de estratégia
  (K-8, etapa 2) e de autorização e auditoria de lances (K-10, etapa 3).
- **ACL/RLS:** `revoke all` + grant mínimo a `service_role`; RLS ligada sem policy nas tabelas globais; tabelas do
  tenant com filtro por `_shared/tenant.ts`.
- **Segredos:** `INTEGRA_COMPRAS_CONSUMER_KEY` e `INTEGRA_COMPRAS_CONSUMER_SECRET` só em secret do Supabase,
  cadastrados pelo Marcelo. Nunca no repositório, em log ou em chat.
- **Edge Functions republicadas no merge:** todas (regra do repositório); novas: `api-sessao` e o coletor.
- **Contrato com o Dashboard:** muda (aba Sessão, sino de notificações). Backend vai ao ar antes.
- **Dado oficial x derivado:** mensagem, categoria, remetente e data e hora vêm do Integra Compras sem alteração; a
  classificação de alerta (K-5) e a avaliação (módulo 7) são derivadas por regra, com o trecho original como prova.
- **Custo:** cobrança por volume, mensal. Limite de consumo configurado na Área do Cliente do Serpro antes de ligar.

## Decisões do Marcelo

- 23/10/2026: o robô de lances é diferencial do produto; as regras do projeto mudam o necessário para permiti-lo.
- 23/10/2026: o Integra Compras foi contratado (Vectra Hub Ltda, pedido 615074) como fonte oficial do chat.
- 23/10/2026: o chat é dado global da plataforma, não do tenant. O MVP tem uma empresa só.
- 23/10/2026: a finalidade principal do chat é a avaliação dos certames.
- 23/10/2026: o código espera a fase 3 da 0032.
- 07/11/2026: retomada da etapa 1.
- 07/11/2026: mudança de layout do portal é detectada pela própria extensão (K-11), com alerta para a equipe;
  correção sugerida por modelo só entra por PR revisado.
- 08/11/2026: retenção do texto bruto do chat (K-7) = 90 dias depois da homologação; a avaliação fica, sem dado pessoal.
- 08/11/2026: alerta (K-5) para convocação de anexos e início da etapa fechada; toda convocação vira alerta, com a
  razão social de quem foi convocado; canal só o sino do Dashboard nesta entrega.

## Perguntas em aberto

1. Serpro: guardar o texto do chat para avaliação e por quanto tempo está coberto pela cláusula 3.1.5? A cobrança é
   por chamada (documentação) ou por contratação monitorada (anexo do contrato, 3.1.5.7)?
2. ~~Prazo de retenção do texto bruto (K-7).~~ Decidido em 08/11/2026: 90 dias depois da homologação.
3. Atraso das mensagens na API durante a sessão ao vivo (medir na etapa 1).
4. Onde mora o código da extensão: pasta nova no repositório Dashboard ou repositório próprio.
5. Mudanças de regra a registrar no `ESCOPO.md` ao aprovar: módulo 10 (Robô de lances); "coleta que exige captcha"
   continua fora, e a fonte do chat passa a ser o Integra Compras; a linha 436 da matriz de segurança ganha a nota
   "lance só por código determinístico autorizado pelo operador, nunca pelo modelo".
6. O contrato está no CNPJ da Vectra Hub. Quando a LicitaGym tiver CNPJ próprio, precisa de contrato novo.
7. Prazo do texto bruto de compra que nunca homologa (deserta, fracassada, revogada, anulada). Proposta: 180 dias
   depois do fim do recebimento de propostas. Até a decisão, o texto dessas compras fica.
