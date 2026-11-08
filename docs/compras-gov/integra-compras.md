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
`99998803000012026`. O guia mostra também `&ordem={ordem}` no exemplo de `curl`, sem descrever o parâmetro; o
cliente não usa até a OAS confirmar.

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
| `tipoRemetente` | texto com código (`"0"`) | significado não documentado no guia; guardado sem tradução |

## Em aberto
- Tabela de códigos de `categoria` e `tipoRemetente` (pedir na OAS ou ao Serpro). Até lá, o alerta de convocação
  (K-5) usa o texto da mensagem.
- Significado de `ordem` e de 206 (paginação?).
