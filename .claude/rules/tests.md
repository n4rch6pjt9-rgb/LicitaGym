---
paths:
  - "tests/**"
  - "**/test_*.py"
  - "**/*_test.py"
  - "**/*.test.ts"
  - "**/*_test.ts"
---
<!-- GERADO de .github/instructions/tests.instructions.md por scripts/ci/sincronizar-regras-claude.sh. Não edite aqui. -->
# Testes

## Ao revisar
- Mudança funcional relevante sem teste é [IMPORTANTE]; correção de bug P0/P1 sem teste de regressão é [BLOQUEANTE].
- Suíte unitária **não** pode depender de PNCP/Compras.gov reais. Testes live ficam separados (marcador/pasta própria).
- Sem `sleep` real em teste unitário; mockar relógio/backoff.
- Fixtures pequenas, determinísticas e com payload representativo da API oficial — sem secrets nem dados pessoais.
- Asserções devem verificar o comportamento, não apenas "não lançou exceção".

## Cobertura esperada por tipo de mudança
- **Cliente HTTP/collector**: 200 com dados, 200 vazio válido, 429 (+ `Retry-After`), 502/503/504, timeout, erro de conexão, JSON inválido, envelope inválido — provando erro ≠ vazio.
- **Paginação**: 1 página, várias, última parcial, página repetida, erro em página intermediária, page size máximo por endpoint.
- **Retry**: sucesso imediato, transitório → sucesso, falha até o limite, sem retry em erro permanente.
- **Idempotência**: rodar duas vezes o mesmo input não duplica.
- **Persistência**: insert, update, unchanged, conflict, nullable, FK.
- **CATMAT**: E5/E6 por `codigoPdm`, E7 por `codigoItem`, fixture com `codigoValorCaracteristica = NULL`, core 78/7830 e extensão 72/7220.
- **Cálculos financeiros**: casos de borda e regra de arredondamento explícita.
