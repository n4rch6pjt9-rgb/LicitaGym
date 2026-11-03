---
paths:
  - "**/*pncp*"
  - "**/*pncp*/**"
  - "**/*contratac*"
  - "**/*pca*"
  - "**/*irp*"
---
<!-- GERADO de .github/instructions/pncp.instructions.md por scripts/ci/sincronizar-regras-claude.sh. Não edite aqui. -->
# PNCP — ingestão e hidratação

Referência obrigatória: `docs/pncp/schemas-consultas-pncp.md`.

## Ao revisar
- **Discovery ≠ Hydration**: sinalizar collector monolítico que mistura busca, detalhes, itens, resultados, atas, contratos, documentos e persistência sem fronteiras recuperáveis.
- **Paginação por família**: `contratacoes/*` ≤ 50; `instrumentoscobranca` ≤ 100; `atas/*` e `contratos/*` ≤ 500. PCA tem contrato próprio — não extrapolar. Limite global é [IMPORTANTE].
- **Nomes de parâmetros** exatamente como no schema (ex.: `dataInicial`, `codigoModalidadeContratacao`). Parâmetro inventado é [BLOQUEANTE].
- **Falha de página** intermediária → execução `partial`/`failed`, nunca página vazia.
- **Idempotência**: reprocessar não duplica contratações, itens, atas, contratos ou relações; identidade pela chave oficial (ex.: número de controle PNCP, CNPJ + ano + sequencial).
- **Normalização em camadas**: DTO HTTP → validação → normalizer → modelo interno → persistência. Formato PNCP não deve vazar pelo domínio.
- **Identificação da licitação**: preservar UASG, número da compra, modalidade, órgão, unidade compradora e ids oficiais.
- **Reconciliação**: permitir comparar descoberto × hidratado × persistido × documentos.
- **Checkpoint** em processos extensos.
- Dados estruturados antes de documentos.
