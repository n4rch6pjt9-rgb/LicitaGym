---
applyTo: "coletor/**,services/coletor-externo/**"
---
# Coletor — sinalizar como Alto

O cliente vende produtos que casam com o CATMAT dele (equipamentos fitness). Não serviços.

## Lead e classificação
- Contrato de serviço nunca vira lead: credenciamento, locação, manutenção (inclusive com fornecimento de peças), obra, oficineiros.
- Um termo de busca sozinho não torna a linha `forte`. Exigir o casamento com o produto/CATMAT, não a frase da busca.
- `forte`: polia, espaldar.
- `fraco`: pilates, "aparelho para condicionamento físico" genérico, colchonete.
- `Puxador` é positivo só na categoria acessórios.
- Academia ao ar livre só conta junto com piso.
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
