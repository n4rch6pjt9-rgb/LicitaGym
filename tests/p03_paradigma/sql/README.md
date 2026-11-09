# LicitaGym P0.3-G5.1 — testes SQL

Coloque os dois arquivos `.sql` em `tests/p03_paradigma/sql/`, preservando o conteúdo existente.

**Não execute em produção.** O `test_versionamento.sql` realiza INSERT, UPDATE e DELETE de teste dentro de transação revertida, e requer PostgreSQL **descartável**, a migration G5.1 já aplicada e pelo menos um documento fixture em `public.licitacao_documentos`.

No ambiente descartável:

```bash
psql "$DATABASE_URL_TESTE" -v ON_ERROR_STOP=1 -f tests/p03_paradigma/sql/verificacao_readonly.sql
psql "$DATABASE_URL_TESTE" -v ON_ERROR_STOP=1 -f tests/p03_paradigma/sql/test_versionamento.sql
```

O teste valida dois hashes distintos, duplicação, bloqueio de UPDATE/DELETE, FK, hash, URI e tamanho. O `ROLLBACK` remove as versões de teste. **Não testa** papéis efetivos, corrida de workers, Storage remoto, nem criação de fixture. A verificação readonly inspeciona privilégios, mas não substitui testes reais de acesso por papel.

A migration proposta está no pacote anterior `licitagym_p03_g51.zip`; não está incluída aqui para evitar aplicação acidental. Não realizar commit/deploy/migration em produção.
