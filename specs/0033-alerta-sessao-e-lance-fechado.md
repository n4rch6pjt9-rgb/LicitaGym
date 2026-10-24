# 0033: Montar e guardar a proposta da empresa, avisar a sessão de disputa e a convocação para o lance fechado

- **Status:** rascunho
- **Issue:** nenhuma (pedido do Marcelo em 20/10: "se foi falta de verificação ou já no limite, precisamos do alerta")
- **Área:** edge-functions | migrations | dashboard-contrato | extensão de navegador (nova)
- **Depende do ok do Marcelo:** sim (migration, decisão de produto e componente novo no navegador do operador)

## Problema

No SESC-CE, Pregão Eletrônico 11/2026 (UASG 451023, LicitaGym #157, modo **aberto-fechado**, sessão em 14/10/2026 às
8h30), a KONNEN foi convocada para o lance final fechado no Grupo 1 e no Grupo 2. O Compras.gov registra **"Convocação
ignorada"** nos dois (campo da etapa fechada = 5, `IGNOROU_CONVOCACAO_PARTICIPACAO_FASE_FECHADA`). Fonte: páginas de
acompanhamento e HAR capturados pelo Marcelo em 14/10.

| Grupo | Posição | Valor da KONNEN | 1º colocado |
|---|---|---|---|
| G1 | 4ª | R$ 1.082.670,00 | R$ 792.720,00 |
| G2 | **2ª** | R$ 1.826.500,00 | R$ 1.517.509,69 |

Não se sabe se foi decisão (preço no limite) ou falta de aviso. Nos dois casos o produto não ajudou:

- nada lembra a sessão;
- nada registra o lance final decidido antes;
- nada avisa a convocação.

**Escala, medida em 20/10:** 303 oportunidades em `leads`/`monitorar` têm `modo_disputa_nome = 'Aberto-Fechado'` no PNCP,
e mais 10 têm 'Fechado-Aberto'.

**Restrições já decididas:** o LicitaGym não loga no Compras.gov e não contorna captcha. As telas públicas de
acompanhamento (propostas, chat, anexos) exigem hCaptcha, e a sala de disputa exige o fornecedor logado. Por isso o aviso
em tempo real só pode rodar no navegador de quem opera a sessão.

## Solução em duas partes

**A. Servidor (só dados públicos):**

1. Tarefa "Sessão de disputa" no cartão do pipeline, com a data e a hora da sessão e o modo de disputa.
2. Lembretes na véspera, 1 h antes e 15 min antes, por **e-mail**, **push no celular** (PWA) e **notificação no
   navegador**. O texto muda conforme o modo:
   - **Aberto-Fechado:** "haverá lance final fechado, de cerca de 5 min, para o 1º colocado e quem estiver até 10% acima dele (mínimo de 3)".
   - **Fechado-Aberto** e **Aberto:** texto próprio de cada um.
3. **Lance final decidido antes da sessão**, por item ou grupo, ao lado do piso da empresa. "Não baixar mais" é uma
   resposta válida e fica registrada.

**B. Extensão do navegador do operador (convocação em tempo real):**

1. Observa a sala de disputa aberta pelo próprio operador, já logado.
2. Ao detectar convocação para a etapa fechada, para o desempate ou para o envio de anexos (prazo), toca um som e mostra
   uma notificação. Também manda o evento ao LicitaGym, que repassa por push.
3. Mostra o lance final que foi decidido antes.
4. Não guarda senha, não lê cookies, não dá lance, não clica em nada e não contorna captcha. Só lê a página e avisa.

**C. Aba "Chat" do certame (decisão do Marcelo, 20/10):**

1. **Extensão (fonte principal).** Com o certame aberto no Compras.gov, a extensão grava as mensagens que a página
   carregou. Isso vale para o acompanhamento público, depois de o operador resolver o captcha, e para a sala de disputa
   logada. As mensagens são gravadas por item ou grupo, sem duplicar: a chave é `chaveMensagemNaOrigem`.
2. **Importar captura (reserva).** Um botão "Importar captura" aceita o HAR ou a página salva. Foi o caminho usado no
   SESC-CE em 14/10, que trouxe as 10 mensagens mais recentes de cada item.
3. **Ata publicada (depois do certame).** Se a ata trouxer as mensagens, o coletor completa o histórico sem captcha.
   Conferir numa ata real antes de implementar.
4. **O que o agente tira do chat:**
   - convocações com prazo ("você foi convocado para enviar anexos… até 14:30");
   - prazos ditos pelo pregoeiro ("prazo de entrega de 90 dias corridos");
   - pedidos de documento ("habilitação conforme itens 13.1 e 14");
   - agrupamentos ("a proposta do Grupo 3 pode anexar aqui").

   Cada um vira aviso, prazo de tarefa ou checklist. Quando a mensagem é para a própria empresa, o alerta da parte B
   dispara na hora.

Quem mandou a mensagem vem do campo `tipoRemetente` do Compras.gov (fornecedor, pregoeiro ou sistema). O LicitaGym nunca
busca o chat pelo servidor.

**D. Proposta da empresa na etapa "Preparando proposta" (decisão do Marcelo, 20/10):**

**Por quê.** No SESC-CE não há registro de com que modelos a KONNEN concorreu no G1 e no G2. Nos grupos, o Compras.gov
não mostra marca nem modelo de ninguém, e anexos só são pedidos ao 1º colocado: os da KONNEN voltam vazios nos três
itens. O que a empresa ofertou só existe no acesso dela ao Compras.gov ou em arquivo solto. Sem isso não dá para
comparar com o vencedor, aprender o preço por item dentro de um lance de grupo, nem responder "com o que concorremos e
por quanto".

**Onde entra.** No pipeline da KONNEN, a etapa "Preparando proposta" (fase `proposta`) já libera a tarefa
**14133-F01-T10 "Montar e cadastrar a proposta"**. Esta parte dá conteúdo a essa tarefa e liga o resultado da sessão a
ela.

**O que existe no banco (medido em 20/10, tenant 1):**

| Objeto | Situação |
|---|---|
| `catalogo_produtos` | 3 produtos (K-RUN, Air Bike HB007, Arc Runner HR007), quase sem atributos. O Catálogo Profissional 2026 da KONNEN tem cerca de 216 códigos de modelo em 80 páginas |
| `catalogo_de_para` (item da licitação → produto, com score, atributos ok/falha/não informados, status e revisão) | 0 linhas. O painel de de-para do protótipo de 19/10 rodou no navegador, contra a tabela de produtos em CSV, sem gravar |
| `catalogo_precos` (preço de tabela e desconto máximo, que dão o piso) | 0 linhas |
| `licitacao_itens` do #157 | 14 itens, sem CATMAT e sem a informação de grupo (G1 = itens 1 a 8, G2 = itens 9 a 13). O estimado sigiloso foi gravado como **0**, e não como ausente |

**Fluxo:**

1. **Catálogo no banco.** Importar o catálogo da empresa em `catalogo_produtos` e `catalogo_produto_atributos`:
   código, nome, linha, medidas (C × L × A), peso, carga, tela e programas. Pode vir do PDF do fabricante ou da tabela
   em CSV, com a fonte gravada em `fonte_documento`. O preço vem só da tabela que a empresa enviar e fica em
   `catalogo_precos`, sigiloso.
2. **De-para sugerido.** Para cada item, a regra do painel (conceitos PT/EN, medidas, peso e carga) sugere o produto e
   grava em `catalogo_de_para` com status `sugerido`, a aderência e os atributos que batem, falham ou não foram
   informados. Quem revisa confirma ou troca, e o status vira `confirmado` com `revisado_por`.
   - Exemplo SESC G2: V9T, RR970, U7, HC007, ECE5 e PS460B.
   - O RR970 sai com a tela marcada como **falha** (11,6" contra os 15,6" pedidos).
3. **Proposta montada e guardada.** Para cada item vão:
   - produto, marca e modelo;
   - descrição ofertada;
   - quantidade;
   - preço unitário e total, com o piso ao lado.

   Itens de um mesmo grupo têm subtotal e total do grupo. A proposta gera o documento no modelo do edital (por exemplo, o
   Anexo II do SESC), com os dados do cadastro da empresa e a lista do que falta no cadastro. Cada versão fica guardada,
   e a enviada é marcada com data e quem enviou.
4. **Valor depois dos lances.** Em lance por grupo, o pregoeiro pede a proposta "de acordo com o valor da fase de
   lances". A proposta recalcula os itens a partir do total final do grupo pela regra escolhida (hoje: desconto linear
   igual em todos os itens), e quem assina pode ajustar item a item, sem passar do total.
5. **Resultado ligado à proposta.** Após a sessão, pela extensão ou pela captura importada, grava-se por item ou grupo:
   - posição;
   - valor inicial e final;
   - situação na etapa fechada (por exemplo, "Convocação ignorada");
   - vencedor e diferença para ele.

   Do concorrente entra o que é público: no item avulso, marca e modelo de cada um; no grupo, só os do vencedor, quando
   ele manda o PDF da proposta. Onde não houver, fica ausente. Nada é inventado.

## Critérios de aceite

| ID | Dado / Quando / Então | Teste que prova |
|---|---|---|
| CA-1 | **Dado** um cartão no pipeline com modo de disputa conhecido e sessão futura, **quando** ele entra no pipeline, **então** existe uma tarefa "Sessão de disputa" com prazo igual à data da sessão e o modo no título | Deno `tests/supabase/functions/api_pipeline_sessao_test.ts` |
| CA-2 | **Dado** a tarefa do CA-1, **então** existem 3 lembretes agendados (véspera, 1 h e 15 min antes), e criar a tarefa de novo não duplica | SQL `supabase/tests/lembretes_disputa_check.sql` |
| CA-3 | **Dado** lembretes agendados, **quando** a data da sessão muda na fonte ou o cartão é descartado, **então** os lembretes são reagendados ou cancelados | Deno + SQL |
| CA-4 | **Dado** um lembrete vencido, **quando** o job de envio roda, **então** ele sai por e-mail e push para o responsável da tarefa e os admins da empresa, e fica marcado como enviado (não reenvia) | Deno `alertas_envio_test.ts` (provedores simulados) |
| CA-5 | **Dado** modo "Aberto-Fechado", **então** o texto do lembrete explica o lance final fechado; **dado** modo "Aberto", **então** o texto não menciona etapa fechada | Deno |
| CA-6 | **Dado** um lance final salvo por item ou grupo, **então** o lembrete de 15 min mostra o valor, ou "lance final não decidido" quando falta | Deno |
| CA-7 | **Dado** um usuário de outra empresa, **quando** lê ou grava o lance final, **então** recebe 403; o lance final nunca aparece em achado nem em log | Deno (controle de acesso) |
| CA-8 | **Dado** o HTML da sala de disputa com a convocação para a etapa fechada (fixture capturada em sessão real), **quando** a extensão processa, **então** dispara a notificação local e envia o evento `{compra, item, tipo: "etapa_fechada", prazo}` | teste da extensão com fixture HTML |
| CA-9 | **Dado** o evento do CA-8, **então** o corpo enviado não contém cookie, token do Compras.gov, CPF nem dado além dos quatro campos | teste da extensão |
| CA-10 | **Dado** a fixture de "você foi convocado para enviar anexos… prazo HH:MM", **então** a extensão avisa com o prazo | teste da extensão |
| CA-11 | **Dado** o HAR do SESC-CE de 14/10 (fixture versionada sem cookies nem tokens), **quando** importado na aba Chat do #157, **então** grava 31 mensagens em G1, G2 e item 14 com hora e remetente; importar de novo não duplica | Deno `api_alertas_chat_test.ts` |
| CA-12 | **Dado** mensagens já gravadas, **quando** a extensão manda as mesmas mais uma nova, **então** só a nova é gravada (chave `chaveMensagemNaOrigem`) | Deno |
| CA-13 | **Dado** a mensagem "convocado para enviar anexos… Prazo para encerrar o envio: 14:30:00 do dia 14/10/2026", **então** o agente gera o evento `convocacao.anexos` com prazo 2026-10-14T14:30 (horário de Brasília) e fornecedor | Deno `agentes_chat_test.ts` |
| CA-14 | **Dado** a mensagem "prazo de entrega são de 90 dias corridos", **então** o agente gera `prazo.entrega` = 90 dias corridos, com a mensagem como fonte | Deno `agentes_chat_test.ts` |
| CA-15 | **Dado** um usuário de outra empresa, **quando** lê ou importa o chat do certame, **então** recebe 403 | Deno (controle de acesso) |
| CA-16 | **Dado** o catálogo de exemplo (fixture com V9T, RR970, ECU7, HC007, ECE5 e PS460B, com medidas e telas), **quando** importado, **então** `catalogo_produtos` e `catalogo_produto_atributos` gravam os 6 com `fonte_documento`; reimportar não duplica | pytest ou Deno do importador |
| CA-17 | **Dado** o item 13 do #157 (ECE5: 1849 × 812 × 1800 mm, 119,6 kg), **quando** o de-para roda, **então** sugere o ECE5 com aderência `atende` e grava `catalogo_de_para` com status `sugerido` | Deno `catalogo_de_para_test.ts` |
| CA-18 | **Dado** o item 10 (TFT de 15,6") e o RR970 (11,6"), **então** a sugestão traz `tela` em `atributos_falha` e a aderência não é `atende` | Deno |
| CA-19 | **Dado** uma sugestão, **quando** o revisor confirma, **então** o status vira `confirmado` com `revisado_por` e `revisado_em`; trocar o produto grava nova linha e não apaga a anterior | Deno + SQL |
| CA-20 | **Dado** a tarefa 14133-F01-T10 de um cartão em "Preparando proposta", **quando** a proposta é salva, **então** cada item grava produto, marca, modelo, quantidade e preço unitário em centavos, e os itens do mesmo grupo somam o total do grupo | Deno `api_proposta_test.ts` |
| CA-21 | **Dado** um preço abaixo do piso vigente, **então** o item mostra o aviso "abaixo do piso"; **dado** produto sem preço vigente, **então** mostra "piso não cadastrado" e não calcula | Deno |
| CA-22 | **Dado** o total final de um grupo menor que o da proposta, **quando** recalcula, **então** aplica o mesmo desconto em todos os itens, arredonda ao centavo e a soma bate com o total final | Deno (cálculo determinístico, regra de arredondamento escrita) |
| CA-23 | **Dado** a proposta e o cadastro da empresa, **quando** o documento é gerado, **então** ele usa o modelo do edital e lista os campos que faltam (ex.: representante legal) em vez de preencher com texto inventado | Deno + snapshot |
| CA-24 | **Dado** a captura do #157, **quando** importada, **então** o resultado da KONNEN fica ligado à proposta guardada: G1 4ª (R$ 1.082.670,00, "Convocação ignorada"), G2 2ª (R$ 1.826.500,00, "Convocação ignorada"), item 14 6ª (R$ 11.500,00 por unidade, "Não convocado") | Deno com fixture |
| CA-25 | **Dado** um grupo, **então** a marca e o modelo dos concorrentes ficam ausentes, salvo o vencedor que enviou PDF; **dado** o item 14, **então** gravam as 11 marcas e modelos públicos | Deno |
| CA-26 | **Dado** um item com orçamento sigiloso, **então** o estimado fica ausente e aparece "Sigiloso", nunca R$ 0,00 (regressão: os 14 itens do #157 estão com 0) | SQL `supabase/tests/itens_sigiloso_check.sql` + Deno |
| CA-27 | **Dado** um usuário de outra empresa, **quando** lê a proposta, o piso ou o de-para, **então** recebe 403; piso e preço nunca aparecem em achado de agente nem em log | Deno (controle de acesso) |

## Fora de escopo

- Dar lance automático ou clicar por conta do operador.
- Logar no Compras.gov pelo servidor, guardar credencial ou contornar captcha.
- Portais além do Compras.gov (Portal de Compras Públicas, BLL, Licitações-e): fase seguinte da extensão.
- WhatsApp: fica para depois, se e-mail e push não bastarem.

## Impacto em dados

- **Migration:** sim, aditiva e idempotente.
  - `lembretes_disputa` (tenant, cartão, quando, canal, enviado_em).
  - `lances_finais` (tenant, licitação, item ou grupo, valor em centavos, "não baixar", autor, data). Sigiloso como o
    piso: RLS sem policy, leitura só por Edge Function.
  - `push_inscricoes` (usuário, endpoint, chaves).
  - `certame_mensagens` (licitação, item ou grupo, `chave_origem` única, data e hora, remetente, texto, fonte
    extensão/captura/ata, tenant que capturou). O chat é público no Compras.gov, mas quem capturou e quando fica por
    empresa.
- **Edge Functions:**
  - `api-pipeline`: tarefa da sessão.
  - `api-alertas` (nova): inscrição de push, lance final, evento da extensão.
  - `sync-alertas` (cron): envio dos lembretes.
- **Contrato com o Dashboard:** muda. Bloco "Sessão de disputa" na tarefa, campo de lance final, pedido de permissão de
  notificação e página de instalação da extensão.
- **Dado oficial x derivado:** o modo de disputa e a data vêm do PNCP; lembretes, lance final e eventos da extensão são
  do LicitaGym.

## Perguntas em aberto

1. **Data da sessão:** usar `data_fim` (fim do recebimento de propostas)? No #157, fim das propostas e abertura são o
   mesmo horário (14/10, 8h30). Confirmar se vale para todos os portais.
2. **Captura da sala de disputa:** a extensão precisa de uma fixture real. Na próxima sessão, salvar o HTML ou HAR da sala
   com o fornecedor logado, de preferência no momento de uma convocação.
3. **Quem recebe:** o responsável da tarefa mais os admins, ou também toda a operação?
4. **Piso:** o papel operação vê o piso ao lado do lance final, ou só o admin?
5. **Em que momento a tarefa nasce:** ao entrar no pipeline ou só a partir de uma etapa (ex.: "Proposta")?
6. **Chat compartilhado ou por empresa:** o chat capturado por uma empresa aparece para as outras que acompanham o mesmo
   certame? O dado é público, mas a captura é de quem a fez.
7. **Ata com o chat:** conferir numa ata publicada se as mensagens vêm junto (fonte 3 da parte C).
