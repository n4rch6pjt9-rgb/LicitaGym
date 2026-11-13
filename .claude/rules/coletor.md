---
paths:
  - "coletor/**"
  - "services/coletor-externo/**"
---
<!-- GERADO de .github/instructions/coletor.instructions.md por scripts/ci/sincronizar-regras-claude.sh. Não edite aqui. -->
# Coletor — sinalizar como Alto

O escopo é decidido pelo texto do item no Termo de Referência (e no edital), contra o catálogo de produtos do cliente; o CATMAT é sinal de apoio, porque o órgão erra o enquadramento com frequência. Produtos, não serviços.

## Lead e classificação
- Contrato de serviço nunca vira lead: credenciamento, locação, manutenção (inclusive com fornecimento de peças), obra, oficineiros.
- Um termo de busca sozinho não torna a linha `forte`. Exigir o casamento do texto do item (TR/edital) com o produto, não a frase da busca; o CATMAT apoia.
- `forte`: polia, espaldar.
- `fraco`: pilates, "aparelho para condicionamento físico" genérico, colchonete.
- `Puxador` é positivo só na categoria acessórios.
- Academia ao ar livre está fora de escopo: termos de "ar livre" no texto do TR ou do edital desqualificam o item (ver `.claude/rules/regras-negocio.md`).
- Mudança de `classificar` / termos / taxonomia sem dry-run no texto do PR (contagem antes e depois, por categoria).

## Prioridade
- `leads` = recebendo proposta.
- `monitorar` = em julgamento, suspensa, adjudicação ou recurso.
- `historico` = encerrada ou homologada.
- Status desconhecido nunca vira `leads`.
- Fallback silencioso que troca a prioridade é Alto. Exemplo: API ou documento falhou e o código grava `encerradas` / `historico` como se o certame tivesse encerrado.

## Histórico, fornecedor e RAG
- Marca, preço por item CATMAT e mapa de fornecedor (revenda ou fabricante) só de certames homologados, com o certame na linha; aparecem no BI, em `/precos` e na aba Inteligência de Preços, sempre com fonte e data (decisão de 09/10, spec 0009).
- CPF e CNPJ em documentos de edital são públicos. Não mascarar no RAG.
- Embedding: `text-multilingual-embedding-002`, 768 dimensões. Outro modelo sem plano de reindex aprovado no PR é Alto.

## Coleta
- Idempotente: reexecutar o mesmo input não duplica compra, item, arquivo nem chunk.
- `DELAY_SEGUNDOS` >= 1. Default abaixo de 1 é Alto.
- Tipo de arquivo pelos bytes (magic number), não pela extensão nem por `mimetypes.guess_type` sozinho.
- `SUPABASE_SERVICE_ROLE_KEY` e credenciais GCP só em secret. Nada de chave no código.
