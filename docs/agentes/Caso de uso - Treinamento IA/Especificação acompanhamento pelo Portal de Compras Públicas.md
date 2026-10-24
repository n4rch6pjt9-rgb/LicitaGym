# Especificação: acompanhamento pelo Portal de Compras Públicas

Oct 8, 2026 · @Marcelo Rosas

## Contexto e objetivo

A tela de acompanhamento passa a ler também o Portal de Compras Públicas quando ele for o portal indicado no edital, e a se atualizar sozinha conforme as datas e a situação do processo no portal.

Hoje a rota `acompanhamento` da função `api-dashboard-oportunidades` consulta só o PNCP. O PNCP recebe os dados do portal com atraso e não recebe parte deles. No caso de referência (Piraúba/MG, Pregão 33/2026, PNCP `18554147000199-1-000140/2026`, processo `513820` no portal), em 08/10/2026:

|  | PNCP e LicitaGym | Portal |
| --- | --- | --- |
| Situação | Divulgada no PNCP | Aguardando Início da Sessão Pública |
| Documentos | 1 (edital) | 4 (edital e 3 da impugnação) |
| Última alteração | 24/09/2026 10:55 | impugnação protocolada depois dessa data |
| Limites de impugnação e esclarecimento | não tem | 05/10/2026 23:59 |
| Abertura da sessão | não tem | 08/10/2026 10:00 |

O campo "Atualizado em" da tela é um texto com ícone, não um botão. Ele mostra `dataAtualizacaoGlobal` do PNCP, por isso fica parado em 24/09/2026 mesmo com novidades no portal.

Na base há 175 oportunidades com link para esse portal, 26 delas abertas. É a segunda origem mais comum, atrás do Comprasnet.

## Princípio: portal oficial primeiro

O PNCP é o meio, não o fim. O portal oficial indicado no edital é a fonte principal de cada dado que conseguirmos extrair dele; o PNCP preenche o que faltar ou o que a extração não trouxer. Cada dado mostra a origem.

- Só dado aberto: páginas e chamadas públicas, sem login. Decidido em 14/10/2026, encerra o ponto sobre termos de uso.
- O ganho principal é o chat da sessão, a fase real e os prazos curtos, que o PNCP não recebe. Documentos chegam ao PNCP com atraso e lacunas que variam por portal.

Dois casos de referência:

|  | Piraúba/MG, processo 513820 | Casa Militar/GO, contratação 114655 |
| --- | --- | --- |
| Portal oficial | Portal de Compras Públicas | SISLOG (Sistema de Logística de Goiás) |
| PNCP | `18554147000199-1-000140/2026` | `01409580000138-1-002061/2025` |
| `linkSistemaOrigem` no PNCP | preenchido | vazio; `usuarioNome` = "SISLOG - Sistema de Logística de Goiás" e `numeroCompra` = 114655 |
| Documentos | portal 4, PNCP 1 (faltavam os 3 da impugnação) | portal 51, PNCP 47 (faltam 3 propostas ajustadas e 1 pedido de inabilitação) |
| Atraso medido dos documentos | data de alteração do PNCP parada em 24/09 com novidades no portal | minutos a horas; ata gerada 14/11/2025 15:18, no PNCP 16:06 |
| Chat da sessão | só no portal | só no portal: 1.068 mensagens de 02/09 a 14/11/2025 |
| Situação no PNCP | "Divulgada no PNCP" | "Divulgada no PNCP" mesmo homologado, com `existeResultado` verdadeiro |

No 114655 o chat traz o que decide o certame: convocações com prazo de 4 horas para proposta ajustada, janela de 10 minutos para intenção de recurso, inabilitações com motivo, lotes fracassados e declarações de vencedor.

Na base, 686 oportunidades PNCP não têm `link_sistema_origem` (80 abertas). Por isso o portal oficial precisa ser resolvido também por outros campos, conforme a Fonte de dados.

## Escopo

Entra nesta entrega:

- Ler do portal oficial situação, datas, quadro de informações, documentos, chat da sessão e situação dos itens. Dois adaptadores nesta entrega: Portal de Compras Públicas e SISLOG.
- Resolver o portal oficial de cada oportunidade PNCP, inclusive quando `linkSistemaOrigem` vem vazio.
- Mostrar esses dados na tela de acompanhamento, junto com os do PNCP e com a origem marcada.
- Job agendado que atualiza as oportunidades abertas desse portal, com frequência definida pela fase do processo.
- Botão manual de atualizar e botão "Ver no portal".

Fica fora:

- Outros portais (Comprasnet, BLL, BNC, Licitar Digital, Licitanet e demais sistemas estaduais). O desenho deve permitir incluí-los depois, um adaptador por portal, na ordem de oportunidades abertas na base.
- Qualquer ação com login no portal: enviar proposta, lance, impugnação ou mensagem.
- Baixar e indexar o conteúdo dos PDFs do portal. Nesta entrega guardamos só nome, tipo e link.
- Correção do fuso de `data_fim` no coletor do PNCP (hoje gravado 3 horas adiantado). É um defeito separado, registrado em Pontos em aberto.

## Fonte de dados

A URL do processo no portal não precisa ser montada: o PNCP a entrega em `linkSistemaOrigem`, e o banco já a guarda em `licitacoes_externas.link_sistema_origem`.

Formato da URL, com o caso de referência:

`https://www.portaldecompraspublicas.com.br/processos/MG/Prefeitura-Municipal-de-Pirauba-4946/RPE-115-2026-2026-513820`

| Trecho | Significado |
| --- | --- |
| `MG` | UF do órgão |
| `Prefeitura-Municipal-de-Pirauba-4946` | Nome do comprador com hífens e um número, provavelmente o código do comprador no portal (não confirmado) |
| `RPE` | Sigla do tipo de licitação (Registro de Preços Eletrônico; `PE` em pregão comum) |
| `115-2026` | Número do processo no portal. Não é o número do edital (33/2026) |
| `2026` | Ano |
| `513820` | Código interno da licitação no portal (`codigoLicitacao`) |

O código interno é o último grupo de dígitos do caminho. Ele não pode ser deduzido de nenhum campo do PNCP, só do link. Aceitar os hosts `www.portaldecompraspublicas.com.br` e `portaldecompraspublicas.com.br`.

Endpoints públicos, base `https://compras.api.portaldecompraspublicas.com.br`. Todos responderam sem login, com `access-control-allow-origin: *`, em 08/10/2026:

| Dado | Método e caminho |
| --- | --- |
| Detalhe (situação, datas, informações) | `GET /v2/licitacao/{UF}/{comprador}/{processo}`, o mesmo caminho da URL depois de `/processos/` |
| Documentos do processo | `GET /v2/licitacao/{codigo}/documentos/processo` |
| Documentos dos fornecedores | `GET /v2/licitacao/{codigo}/documentos/fornecedores` |
| Chat da sessão | `GET /v1/licitacao/{codigo}/chat` |
| Itens | `GET /v2/licitacao/{codigo}/itens?pagina=1` |
| Arquivo anexado | `GET https://arquivos.portaldecompraspublicas.com.br/v1/download/{idArquivo}` |
| Relatório gerado pelo portal | `POST https://conteudo.api.portaldecompraspublicas.com.br/v1/arquivo/download` |

O detalhe só responde pelo caminho completo: `GET /v2/licitacao/{codigo}` devolve 404.

Relatórios gerados (atas, termos, "Pedidos de Impugnação") não têm link direto. O fluxo observado no HAR é:

1. `POST` com `{"codigoGeradorArquivo":0,"codigoTipoGerador":2,"codigoUsuarioEntidade":10,"parametros":"Impugnacao,513820","reprocessar":false}`. A resposta traz `codigoGeradorArquivo` e `codigoSituacao` 1.
2. Repetir o mesmo `POST` com o `codigoGeradorArquivo` recebido até vir `codigoSituacao` 4 e a `url` do PDF. No teste levou 2 segundos.

O valor de `parametros` vem pronto em cada item da lista de documentos.

### Resolução do portal oficial

A ordem para achar o portal de cada oportunidade, parando no primeiro que responder:

1. `linkSistemaOrigem` da compra no PNCP, depois `link_sistema_origem` da linha.
2. `usuarioNome` do detalhe da compra no PNCP (`/api/consulta/v1/orgaos/{cnpj}/compras/{ano}/{seq}`, sem captcha), mais `numeroCompra`. Ex.: "SISLOG - Sistema de Logística de Goiás" com 114655 vira `https://sislog.go.gov.br/PanelAquisicao/DetalhesLicitacao?idLicitacao=114655`.
3. Endereço indicado no aviso ou no edital. No 114655: "Contratação SISLOG nº 114655" e `https://sislog.go.gov.br/`.
4. Correção manual na tela.

O coletor PNCP não grava `usuarioNome` hoje: nenhuma das 686 linhas sem link o tem no `raw`. Gravar o campo e fazer backfill entra nesta entrega. O caminho `/api/pncp/v1/.../compras/{ano}/{seq}/portal`, usado pela página do PNCP, exige hCaptcha e responde 422 sem ele; não serve ao job.

### SISLOG

Um GET público traz tudo, sem login (HAR de 14/10/2026, cerca de 611 KB de HTML):

| Dado | Onde |
| --- | --- |
| Dados, prazos, avisos, mensagens, esclarecimentos, impugnações e lista de documentos | `GET https://sislog.go.gov.br/PanelAquisicao/DetalhesLicitacao?idLicitacao={numero}` |
| Documento gerado pelo órgão | `POST /PanelAquisicao/GerarPDFDocumentoView?d={chave}&sei=false`, corpo `{"d":"{chave}","sei":false}`; devolve HTML |
| Documento enviado por fornecedor | `GET /PanelAquisicao/GerarPDFDocumentoView?d={chave}&sei=false` |
| Arquivo de esclarecimento ou impugnação | link direto em `https://sislog.sistemas.go.gov.br/arquivos/ArquivosOfertaCompra/{numero}/...` |

A chave de cada documento está no `onclick` do link (`imprimirDocumento` ou `imprimirDocumentoExterno`), com aspas escritas como `&#x27;`. A lista não traz data por documento; a hora vem do chat ou da primeira vez que o job viu o documento. Mensagens trazem data e hora em Brasília (`dd/mm/aaaa hh:mm:ss`) e não têm paginação: as 1.068 vieram na mesma página.

## Mapeamento de campos

Os quadros "Datas" e "Informações" do portal vêm todos da chamada de detalhe. Os campos de data do detalhe e do chat vêm em UTC (sufixo `Z`); a tela mostra em horário de Brasília. A data dos documentos (`dataHora`) vem como texto em horário de Brasília, no formato `24/09/2026-09:54:08`.

### Datas

| Marco na tela do portal | Campo no detalhe | Valor no caso de referência (Brasília) | Existe no PNCP |
| --- | --- | --- | --- |
| Data de Publicação | `dataHoraPublicacao` | 24/09/2026 09:54 | Sim, mas 10:55 |
| Início das Propostas | `dataHoraInicioRecebimentoPropostas` | 25/09/2026 10:00 | Sim, igual |
| Limite p/ Impugnações | `dataHoraLimiteImpugnacoes` | 05/10/2026 23:59 | Não |
| Limite p/ Esclarecimentos | `dataHoraLimiteEsclarecimentos` | 05/10/2026 23:59 | Não |
| Limite p/ Recebimento das Propostas | `dataHoraFinalRecebimentoPropostas` | 08/10/2026 09:59 | Sim, igual |
| Abertura das Propostas | `dataHoraAbertura` | 08/10/2026 10:00 | Não |
| Fechamento (não aparece no quadro) | `dataHoraFechamento` | vazio | Não |

O marco verde do portal só indica que a data passou. Às 10:51 de 08/10/2026 todos os marcos estavam verdes, mas a situação ainda era "Aguardando Início da Sessão Pública" e o chat estava vazio. A fase real vem de `statusProcesso` e do chat.

### Informações

| Campo na tela do portal | Campo no detalhe | Existe no PNCP |
| --- | --- | --- |
| Situação (cabeçalho) | `statusProcesso.codigo` e `statusProcesso.descricao` | Não com esse detalhe |
| Tipo | `tipoLicitacao` + `tipoJulgamento` | Parcial |
| Tratamento da Fase de Lances | `tratamentoFasesLances` | Sim (modo de disputa) |
| Operação | `operacao` | Não |
| Pregoeiro | `nomeOperador`, com o rótulo em `labelOperador`. `nomePregoeiro` vem vazio | Não |
| Autoridade Competente | `nomeAutoridadeCompetente` | Não |
| Apoio | `nomeApoio` (lista) | Não |
| Origem dos Recursos | `origemRecurso` | Não |
| Legislação Aplicável | `legislacaoAplicavel` | Sim (amparo legal) |

### Documentos, chat e itens

| Dado | Campos úteis | Observação |
| --- | --- | --- |
| Documento | `nome`, `tipo`, `dataHora`, `url`, `idArquivo`, `tipoDownLoad`, `parametros`, `codigoPncp` | `url` preenchida = download direto. `url` vazia com `parametros` = relatório gerado. `codigoPncp` preenchido indica documento que também vai ao PNCP |
| Mensagem do chat | `dataHoraFrase`, `apelido`, `frase` | `apelido` é "Sistema", "Pregoeiro" ou o apelido do fornecedor. A resposta traz também `codigoUltimaFrase` |
| Item | `codigo`, `descricao`, `quantidade`, `unidade`, `valorReferencia`, `melhorLance`, `situacao.descricao`, `participacao.descricao` | Paginado por `pagina` |

No processo encerrado usado como comparação (`486428`), os documentos incluem Ata de Propostas, Ata Parcial, Ata Final, Termo de Adjudicação, Termo de Homologação, Vencedores e Ranking nos Itens. O chat traz abertura de itens, lances, adjudicação e homologação com horário.

## Rota de acompanhamento

A resposta de `acompanhamento` ganha uma seção `portal`, preenchida quando o link de origem for do Portal de Compras Públicas. As seções do PNCP não mudam.

Arquivos afetados em `supabase/functions`:

| Arquivo | Mudança |
| --- | --- |
| `_shared/portal-compras-publicas.ts` (novo) | Extrair o código e o caminho do link; cliente dos endpoints; normalização para os tipos do LicitaGym |
| `_shared/edital-url.ts` | Incluir os dois hosts do portal em `ALLOWED_ORIGEM_HOSTS`, aceitando só caminhos que comecem com `/processos/` |
| `api-dashboard-oportunidades/acompanhamento.ts` | Chamar o portal em paralelo com o PNCP; montar a seção `portal`; devolver `url_portal`; aceitar o parâmetro de atualização forçada |
| `api-dashboard-oportunidades/types.ts` e `validation.ts` | Tipos da seção `portal` e o parâmetro `atualizar` |

Comportamento:

1. Resolver o link: primeiro `linkSistemaOrigem` da compra no PNCP, depois `link_sistema_origem` da linha. Se o host não for do portal, a seção `portal` vem com `disponivel: false` e nada mais muda.
2. Chamar detalhe, documentos do processo, documentos dos fornecedores, chat e itens em paralelo, cada um com erro isolado, no mesmo padrão `Promise.allSettled` já usado para o PNCP. Falha do portal nunca derruba a resposta do PNCP.
3. Usar o `UnifiedHttpClient` existente, com limite de concorrência por host e tempo máximo de 20 segundos por chamada.
4. Converter todas as datas para UTC com fuso explícito antes de devolver.
5. Devolver `consultado_em` (hora da consulta) separado de `atualizado_em` (mudança mais recente entre PNCP e portal).
6. Parâmetro `atualizar=true` ignora o cache de 5 minutos. Limitar a uma atualização forçada por oportunidade a cada 30 segundos.

Forma da seção nova:

```json
{
  "portal": {
    "disponivel": true,
    "origem": "portaldecompraspublicas",
    "codigo_licitacao": 513820,
    "url_portal": "https://www.portaldecompraspublicas.com.br/processos/MG/...",
    "consultado_em": "2026-10-08T13:51:27Z",
    "situacao": { "codigo": 13, "descricao": "Aguardando Início da Sessão Pública" },
    "datas": { "publicacao": "...", "inicio_propostas": "...", "limite_impugnacoes": "...",
               "limite_esclarecimentos": "...", "fim_propostas": "...", "abertura": "...", "fechamento": null },
    "informacoes": { "tipo": "...", "fase_lances": "...", "operacao": "...", "operador": "...",
                     "autoridade": "...", "apoio": [], "origem_recursos": "...", "legislacao": "..." },
    "documentos": { "dados": [], "total": 4, "erro": null },
    "chat": { "dados": [], "total": 0, "ultima_frase": 0, "erro": null },
    "itens": { "dados": [], "total": 12, "erro": null }
  }
}
```

Nomes de fornecedores e mensagens do chat são dados de terceiros: devolver como texto puro e nunca interpretar como HTML.

## Atualização automática

Um job único roda a cada minuto e consulta só as oportunidades cuja próxima consulta já venceu. A frequência de cada oportunidade depende da fase, calculada pelas datas e pela situação no portal.

Segue o modelo já usado no projeto (`docs/pncp/cron-sync-jobs.md`): pg\_cron chama uma Edge Function com `Authorization: Bearer <SYNC_CRON_SECRET>` e `verify_jwt = false`.

| Item | Definição |
| --- | --- |
| Função nova | `sync-portal-compras-publicas` |
| Job pg\_cron | `licitagym-sync-portal-compras-publicas`, expressão `* * * * *` |
| Seleção | Linhas de `portal_acompanhamento` com `proxima_consulta_em <= now()` em qualquer fase, inclusive `encerrado` (uma vez por dia), ordenadas pela mais atrasada |
| Lote | Até 10 oportunidades por execução, 2 em paralelo, orçamento de 45 segundos |
| Concorrência | Trava por execução, para duas rodadas não se sobreporem |
| Entrada de novas oportunidades | Ao gravar `link_sistema_origem` de host do portal, criar a linha em `portal_acompanhamento` com consulta imediata |

Fases e frequências. Os intervalos são uma proposta inicial, a ajustar com o uso:

| Fase | Como identificar | Intervalo | O que pode mudar |
| --- | --- | --- | --- |
| `propostas` | Antes de `fim_propostas` | 6 horas | Documentos novos (impugnação, esclarecimento, retificação), datas |
| `vespera_limites` | 24 horas antes de `limite_impugnacoes` ou `limite_esclarecimentos`, até 24 horas depois | 1 hora | Respostas publicadas |
| `aguardando_sessao` | De 1 hora antes de `abertura` até o chat ter a primeira mensagem ou a situação mudar | 5 minutos | Situação, início do chat |
| `sessao` | Chat com mensagens e `fechamento` vazio | 2 minutos | Chat, melhor lance por item |
| `pos_sessao` | Sem mensagem nova no chat há 2 horas, até homologar | 1 hora | Atas, adjudicação, homologação, documentos de fornecedores |
| `encerrado` | Homologado, fracassado ou revogado, e o PNCP com `existeResultado` verdadeiro | 24 horas | Recurso tardio, homologação, atas, aditivos. O portal continua a fonte principal (no 114655 os aditivos saíram 7 meses depois) |

Regras:

- A fase é recalculada a cada consulta. Se a data de abertura mudar no portal, a agenda acompanha.
- Uma mudança é detectada comparando com a consulta anterior: `statusProcesso.codigo`, as datas, a lista de documentos (`idArquivo` ou `parametros`) e `codigoUltimaFrase`.
- Cada mudança grava um evento em `portal_eventos` e atualiza `atualizado_em`. São esses eventos que alimentam a linha do tempo da tela.
- Erro do portal: repetir com espera crescente (1, 5, 15 e 60 minutos) e registrar `ultimo_erro`. Depois de 24 horas de falha, marcar a oportunidade como "portal indisponível" na tela.
- Com a tela aberta numa oportunidade em fase `sessao`, o frontend chama a rota a cada 60 segundos. Nas outras fases, só ao abrir a tela ou pelo botão.
- Enviar `User-Agent` identificando o LicitaGym e respeitar o limite de concorrência por host.

Carga estimada com as 26 oportunidades abertas hoje: 5 chamadas por consulta. No pior caso, todas em sessão ao mesmo tempo, são 65 chamadas por minuto. No caso comum, a maioria em `propostas`, são cerca de 520 chamadas por dia.

## Modelo de dados

Duas tabelas novas guardam o estado entre consultas. Nenhuma coluna existente muda.

`portal_acompanhamento`, uma linha por oportunidade acompanhada:

| Coluna | Tipo | Uso |
| --- | --- | --- |
| `licitacao_id` | bigint, chave primária, referência a `licitacoes_externas.id` | Oportunidade |
| `origem` | text | `portaldecompraspublicas` (permite outros portais depois) |
| `codigo_licitacao` | bigint | Código interno no portal |
| `caminho` | text | Trecho da URL depois de `/processos/`, usado na chamada de detalhe |
| `fase` | text | Uma das seis fases |
| `situacao_codigo`, `situacao_descricao` | integer, text | Última situação lida |
| `datas` | jsonb | Os sete marcos, em UTC |
| `informacoes` | jsonb | Quadro de informações |
| `documentos` | jsonb | Última lista de documentos |
| `ultima_frase` | bigint | `codigoUltimaFrase` da última leitura do chat |
| `consultado_em`, `atualizado_em`, `proxima_consulta_em` | timestamptz | Controle da agenda |
| `tentativas`, `ultimo_erro` | integer, text | Controle de falhas |

`portal_eventos`, uma linha por mudança detectada:

| Coluna | Tipo | Uso |
| --- | --- | --- |
| `id` | bigint, identidade | Chave |
| `licitacao_id` | bigint | Oportunidade |
| `tipo` | text | `situacao`, `data`, `documento`, `chat` |
| `ocorrido_em` | timestamptz | Hora do evento no portal, quando houver; senão, hora da detecção |
| `detectado_em` | timestamptz | Hora em que o job percebeu |
| `titulo`, `detalhe` | text, jsonb | Texto para a linha do tempo e o dado bruto |
| `chave` | text, única por oportunidade | Evita duplicar o mesmo evento |

As duas tabelas ficam com RLS ligado e leitura só pelas funções de backend; conferir se é a mesma política de `licitacoes_externas`. Índice em `portal_acompanhamento (proxima_consulta_em)` sem filtro de fase; inclui `encerrado`.

Mensagens do chat entram em `portal_eventos` com `tipo = chat`. Se o volume incomodar, separar em tabela própria.

## Tela

A tela de acompanhamento mantém as abas atuais e passa a misturar as duas origens, cada item com um selo "PNCP" ou "Portal".

| Elemento | Mudança |
| --- | --- |
| Selo de situação | Mostrar a situação do portal quando existir ("Aguardando Início da Sessão Pública"), ao lado da situação do PNCP. Hoje a tela mostra "Recebendo propostas" depois do fim do prazo |
| Botões do cabeçalho | Acrescentar "Ver no portal" ao lado de "Ver edital (PNCP)" |
| "Atualizado em" | Virar botão de atualizar. Mostrar a mudança mais recente entre PNCP e portal, com data e hora, e "consultado há X min" |
| Faixa de datas (nova) | Os seis marcos do portal, com o próximo marco em destaque. Marco concluído depende da situação, não só da data |
| Quadro de informações (novo) | Tipo, fase de lances, operação, pregoeiro, autoridade, apoio, origem dos recursos, legislação |
| Aba Linha do tempo | Eventos do PNCP e de `portal_eventos` em ordem de data, mais recentes primeiro, com filtro por origem |
| Aba Documentos | Lista principal vem do portal oficial; o PNCP acrescenta só o que faltar, sem repetir (mesmo documento nos dois = uma linha, com os dois selos). Se a extração do portal falhar, a aba mostra a lista inteira do PNCP com o aviso "Portal oficial indisponível, exibindo PNCP". Relatório gerado abre sob demanda |
| Aba Itens | Acrescentar situação e melhor lance do portal enquanto o PNCP não tiver resultado |
| Sem portal | Oportunidade de portal sem adaptador continua como hoje, com "Ver no portal" quando o portal oficial for conhecido |

O código do frontend (`licitagym-dashboard`) não está no repositório analisado. Os nomes de componentes ficam para quem implementar.

## Critérios de aceite

Testar com as oportunidades de referência 114655 (SISLOG) e (linha 257, processo `513820`) e com o processo encerrado `486428`.

- [ ] O código `513820` e o caminho são extraídos do link de origem, com e sem `www`. Link de outro host devolve `portal.disponivel = false`.
- [ ] A rota devolve a seção `portal` com situação, sete datas, quadro de informações, 4 documentos, chat e 12 itens para a referência.
- [ ] Todas as datas saem em UTC e a tela mostra `fim_propostas` como 08/10/2026 09:59 e `abertura` como 08/10/2026 10:00.
- [ ] Com o portal fora do ar, a rota responde 200 com os dados do PNCP e `erro` preenchido só nas partes do portal.
- [ ] A aba Documentos mostra os 3 documentos da impugnação com selo "Portal" e o edital uma única vez.
- [ ] O relatório "Pedidos de Impugnação" abre pelo fluxo de dois passos.
- [ ] Para o `486428`, a linha do tempo mostra as mensagens de adjudicação e homologação e os documentos incluem Ata Final e Termo de Homologação.
- [ ] O job cria a linha em `portal_acompanhamento` para toda oportunidade aberta com link do portal e calcula a fase correta em cada um dos seis casos (teste unitário com datas simuladas).
- [ ] Um documento novo no portal gera um evento em `portal_eventos` e muda `atualizado_em`. Rodar o job de novo não duplica o evento.
- [ ] O botão de atualizar ignora o cache e muda "consultado há" na tela. Dois cliques em menos de 30 segundos fazem uma consulta só.
- [ ] "Ver no portal" abre a página do processo em nova aba.
- [ ] Uma oportunidade de portal sem adaptador (ex.: Comprasnet) continua como hoje, com "Ver no portal" quando o portal for conhecido.
- [ ] Para o PNCP `01409580000138-1-002061/2025`, sem `linkSistemaOrigem`, o portal é resolvido por `usuarioNome` + `numeroCompra` como `sislog.go.gov.br/PanelAquisicao/DetalhesLicitacao?idLicitacao=114655`.
- [ ] Para o 114655, a rota devolve dados, prazos, 1.068 mensagens, 1 esclarecimento, 0 impugnações e 51 documentos com chave.
- [ ] A aba Documentos do 114655 mostra 51 linhas: 47 com selos Portal e PNCP e 4 só Portal (3 propostas ajustadas e o pedido de inabilitação).
- [ ] Com o SISLOG fora do ar, a aba Documentos do 114655 mostra os 47 do PNCP e o aviso "Portal oficial indisponível, exibindo PNCP".
- [ ] A linha do tempo do 114655 mostra convocações, inabilitações, lotes fracassados, declarações de vencedor e adjudicações do chat, com hora de Brasília convertida para UTC.
- [ ] O 114655 fica em fase `encerrado` (homologado em 14/11/2025, `existeResultado` verdadeiro) e continua sendo consultado uma vez por dia.
- [ ] O backfill grava `usuarioNome` nas linhas PNCP sem link de origem, e a contagem por sistema de origem das 80 abertas fica disponível.
- [ ] Testes em `tests/supabase/functions`, usando como fixtures as respostas reais gravadas dos dois processos.

## Pontos em aberto e riscos

| Ponto | Situação | Como resolver |
| --- | --- | --- |
| Paginação do chat | Portal de Compras Públicas: o processo encerrado devolveu 50 mensagens; não sei se há mais nem qual parâmetro traz as seguintes. SISLOG: sem paginação, as 1.068 vieram na página | Gravar um HAR de um processo em sessão, carregando mais mensagens, ou observar o `513820` quando a sessão abrir |
| Códigos de `statusProcesso` | Só o código 13 foi observado | Coletar os códigos ao longo do `513820` e de processos encerrados. Até lá, a fase usa datas, chat e `fechamento`, e a descrição é mostrada como texto |
| Permissão de uso da API | Resolvido em 14/10/2026: só dado aberto, sem login, em qualquer portal | Nenhuma ação. Manter User-Agent identificado e os limites de concorrência por host |
| Mudança sem aviso | O formato pode mudar a qualquer momento | Validar o formato de cada resposta; em formato inesperado, registrar erro e manter o último dado bom |
| Bloqueio por volume | Limite de requisições do portal desconhecido | Começar com os intervalos propostos, medir respostas 429 e 403, e ajustar |
| Documento duplicado | A regra para reconhecer o mesmo edital nos dois lados não foi testada em volume | Começar por `codigoPncp` preenchido mais nome normalizado; revisar com casos reais |
| Número no segmento do comprador (`4946`) | Suposição de que é o código do comprador | Sem impacto: o caminho é usado inteiro, como veio no link |
| Fuso de `data_fim` | A linha 257 guarda `2026-10-08 09:59+00`; o correto é 12:59 UTC (09:59 de Brasília) | Corrigir no coletor do PNCP, em tarefa separada |
| Erro 1101 do dashboard | O Worker `licitagym-dashboard` devolveu "Worker threw exception" uma vez em 08/10/2026 13:42 UTC (Ray ID `a47591bf6eb4c279`) e voltou ao normal | Ver os logs do Worker na Cloudflare |
| Data dos documentos no SISLOG | A lista não traz data por documento, e o anúncio no chat pode vir horas depois do anexo (recursos do 114655: PNCP 10:54, chat 14:33) | Usar a hora em que o job viu o documento pela primeira vez; mostrar a data do PNCP quando houver |
| Portais sem adaptador | 80 oportunidades abertas sem link de origem e vários portais fora desta entrega | Depois do backfill de usuarioNome, priorizar o próximo adaptador pela contagem de abertas |

Evidências usadas: API de consulta do PNCP para a compra 140/2026, respostas da API do portal para `513820` e `486428`, o edital do Pregão 33/2026, o HAR da página do processo e o código de `supabase/functions/api-dashboard-oportunidades` no repositório `n4rch6pjt9-rgb/LicitaGym`.

Evidências do 114655 (14/10/2026): HAR do PNCP da compra `01409580000138-1-002061/2025`, API de arquivos do PNCP (47 documentos com data), HAR e HTML da página do SISLOG, aviso, edital e termo de julgamento e homologação baixados do SISLOG, e a base `licitacoes_externas` (hosts de `link_sistema_origem` e `raw` sem `usuarioNome`).
