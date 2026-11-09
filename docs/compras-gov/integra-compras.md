# Integra Compras (Serpro): chat da sessão do Compras.gov.br

Fonte: documentação oficial em `apicenter.estaleiro.serpro.gov.br/documentacao/integra-compras` (guia de utilização,
lida em 23/10/2026). Contrato: Vectra Hub Ltda, pedido 615074. Spec: `specs/0039-robo-de-lances-e-chat-da-sessao.md`.
Cliente: `supabase/functions/_shared/serpro.ts`. Leia este arquivo antes de mudar o cliente.

## Autenticação
- `POST https://gateway.apiserpro.serpro.gov.br/token`, `Authorization: Basic base64(consumerKey:consumerSecret)`,
  corpo `grant_type=client_credentials`. Token de 1 h.
- Chaves só em secret do Supabase: `SERPRO_CONSUMER_KEY` e `SERPRO_CONSUMER_SECRET` (cadastradas pelo Marcelo).

## Endpoints (somente leitura)
| Método | Caminho | O que devolve |
|---|---|---|
| GET | `/integra-compras/v1/chat/{chaveCompra}` | mensagens do chat da sessão |
| GET | `/integra-compras/v1/chat/{chaveCompra}/diligencias` | mensagens do chat de diligências |

`chaveCompra`: 17 dígitos = UASG (6) + modalidade (2) + número (5) + ano (4). Exemplo de demonstração:
`99998803000012026`.

`ordem` é **obrigatório**: sem ele a API responde 400 "Required parameter 'ordem' is not present" (consulta real de
08/11/2026). O guia só o mostra no exemplo de `curl` (`&ordem={ordem}`, que deveria ser `?ordem=`), sem descrever.
É a **ordenação** das mensagens: aceita `ASC` e `DESC` (maiúsculo ou minúsculo) e recusa `0` e `1` com 400
(teste do Marcelo, 08/11/2026). O cliente manda `?ordem=ASC`, da mais antiga para a mais recente.

## Paginação
Página de 20 mensagens. O 206 traz os cabeçalhos `Page` (começa em 0), `Page-Size`, `Pages-Count` e
`Register-Count`; a página seguinte se pede com `page=N` (`pagina` é ignorado). Teste do Marcelo em 08/11/2026: compra
18017805000292026 com 76 mensagens em 4 páginas. O cliente lê de `page=0` até `Pages-Count - 1` (teto de 50 páginas) e
conta **cada página** como uma chamada cobrada em `integra_compras_run.chamadas`. Falha numa página do meio grava o que
já veio das anteriores; 206 sem `Pages-Count` para e registra aviso.

## Códigos HTTP
- 200 e 206: lista de mensagens. **Cobrados.**
- 404: compra sem mensagens. **Cobrado.** Não é erro.
- 401: token expirado; o cliente renova uma vez.
- 403, 502 e outros: erro registrado em `private.integra_compras_run`; nada é apagado.
- Manutenção da base nos fins de semana.

## Resposta (exemplo oficial, cópia em `tests/supabase/fixtures/integra_compras_chat_exemplo.json`)
Uma **lista** (não um objeto). Cada item:

| Campo | Tipo | Observação |
|---|---|---|
| `chaveCompra` | objeto | `idUasgIdentificacao`, `idModalidade`, `numero`, `ano`, `numeroUasg` |
| `identificadorItem` | texto, opcional | ausente = mensagem da compra; `"1"` = item 1 |
| `chaveMensagem` | uuid | identificador único da mensagem (chave de idempotência) |
| `texto` | texto | |
| `categoria` | texto com código numérico (`"2"`, `"11"`) | significado dos códigos não documentado no guia; guardado sem tradução |
| `dataHora` | texto `AAAA-MM-DD HH:MM:SS.mmm` | sem fuso; tratado como horário de Brasília (UTC-3); original guardado em `data_hora_fonte` |
| `tipoRemetente` | texto com código (`"0"`) | significado não documentado no guia; guardado sem tradução (ver "Remetente deduzido") |

## Remetente deduzido (só na tela)
O banco guarda `tipo_remetente` como veio. A aba Sessão do Dashboard (PR #117) rotula o código com um mapa
**deduzido do conteúdo**, não oficial, e avisa isso no badge. Evidência: 163 mensagens de 2 compras
(`18017805000292026` e `45102305000112026`), lidas em 08/11/2026:

| Código | Rótulo na tela | Categorias vistas | O que as mensagens dizem |
|---|---|---|---|
| `0` | Sistema | 2, 4, 5, 7, 8, 11, 12 | avisos automáticos: sessão aberta, item aberto/encerrado, convocação de anexos, recursos |
| `1` | Licitante | 13, 14 | 14: falas do fornecedor ("Sra. Pregoeira, necessitamos de mais tempo"); 13: aviso automático de anexos enviados pelo fornecedor |
| `3` | Pregoeiro | 9 | falas do pregoeiro ("suspenso para almoço") |

Código fora do mapa aparece na tela como "Remetente N". Quando o Serpro mandar a tabela, o mapa da tela segue a
tabela oficial.

## Em aberto
- Tabela oficial de códigos de `categoria` e `tipoRemetente` (pedir na OAS ou ao Serpro). Até lá, o alerta de
  convocação (K-5) usa o texto da mensagem e a tela usa o mapa deduzido acima.
- Nada sobre paginação em aberto (ver "Paginação" acima).
