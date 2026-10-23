# 0039: Criar o robô de lances e o chat da sessão do Compras.gov.br

- **Status:** parada. Decisão do Marcelo em 23/10/2026: o código espera a fase 3 da 0032 terminar (regra de foco do
  `docs/produto/ESCOPO.md`). A spec fica escrita para ser revisada e aprovada nesse intervalo.
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
| 2 | Extensão só de leitura: lê a sala, mostra piso e próximo lance válido, grava a disputa | K-6, K-8 | baixo: não envia nada |
| 3 | Lance com confirmação: a extensão preenche o lance e o operador confirma com um clique | K-9 | médio |
| 4 | Lance automático dentro do piso, com autorização por certame | K-9, K-10 | alto: só depois de a etapa 3 rodar em pregões reais |

Cada etapa é um PR (ou um par backend + front). A etapa 1 mede o atraso das mensagens num pregão real. Esse número
decide se o alerta de convocação pode depender só da API ou precisa da extensão (SLA do contrato: faixa de 90% a 94%
de disponibilidade, paradas programadas excluídas, manutenção de fim de semana).

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

## Skills e agentes por contrato

| Contrato | Desenho e leitura | Implementação | Teste | Revisão antes do PR | Depois do merge |
|---|---|---|---|---|---|
| K-1, K-2, K-7 | `/spec` | skill `nova-migration` | `supabase/tests/sessao_mensagens_check.sql` | `revisor-migration` + `revisor-seguranca` | `validar-migrations` antes; `verificar-producao` + `get_advisors` depois |
| K-3, K-4, K-5 | `/spec` | `/implement` (TDD) | Deno / pytest | `revisor-codigo` + `revisor-seguranca` | `verificar-producao` |
| aba Sessão, sino | `/spec` | agente `frontend-dashboard` | vitest | `revisor-codigo` + `revisor-seguranca` + `ux-ui-licitagym` | `deploy-dashboard` |
| K-6, K-8 a K-10 | revisão desta spec depois da etapa 1 | a definir | a definir | `revisor-codigo` + `revisor-seguranca` | a definir |

## Fora de escopo

- Tudo da lista "Fica fora, por decisão de 23/10" em "Desenho".
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

## Perguntas em aberto

1. Serpro: guardar o texto do chat para avaliação e por quanto tempo está coberto pela cláusula 3.1.5? A cobrança é
   por chamada (documentação) ou por contratação monitorada (anexo do contrato, 3.1.5.7)?
2. Prazo de retenção do texto bruto (K-7). Proposta: 90 dias depois da homologação.
3. Atraso das mensagens na API durante a sessão ao vivo (medir na etapa 1).
4. Onde mora o código da extensão: pasta nova no repositório Dashboard ou repositório próprio.
5. Mudanças de regra a registrar no `ESCOPO.md` ao aprovar: módulo 10 (Robô de lances); "coleta que exige captcha"
   continua fora, e a fonte do chat passa a ser o Integra Compras; a linha 436 da matriz de segurança ganha a nota
   "lance só por código determinístico autorizado pelo operador, nunca pelo modelo".
6. O contrato está no CNPJ da Vectra Hub. Quando a LicitaGym tiver CNPJ próprio, precisa de contrato novo.
