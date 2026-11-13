---
name: validar-migrations
description: Valida todas as migrations e as checagens de ACL num Postgres descartável (Docker), incluindo idempotência das migrations novas. Use antes de abrir PR com migration e para reproduzir falha de migration.
---

# Validar migrations

```bash
scripts/validar-migrations.sh            # compara com origin/main
scripts/validar-migrations.sh <base>     # outra base (ex.: a branch de baixo numa pilha de PRs)
```

O script:
1. sobe `pgvector/pgvector:pg17` (major da produção; outra com `PG_IMAGE=...`) e aplica `supabase/tests/pre.sql`
   (stubs de roles, `auth.uid()`, `auth.jwt()`, `auth.users`, `storage.buckets/objects`, `storage.foldername`,
   `vector` e os default privileges do Supabase);
2. aplica todas as migrations em ordem (pula `202609180008_cron.sql`: `pg_cron` só existe no Supabase);
3. reaplica as migrations novas/alteradas em relação à base (tem que passar de novo: idempotência);
4. roda todos os `supabase/tests/*_check.sql`.

Saída esperada: `Tudo OK.` Qualquer `FALHA` impede o PR. `PENDENTE` é falha conhecida listada em
`supabase/tests/pendentes.txt` (com issue); se um pendente passar, vira `FALHA` até sair da lista. A CI
(`pr-quality.yml`, job `migrations`) roda o mesmo script em todo PR.

Para testar o comportamento de uma função (ex.: `licitacoes_ids_por_catmat`), depois do passo 2 insira dados de
teste mínimos e faça `select` — nunca use dados reais copiados de produção no repositório.

Se a migration nova precisar de um objeto do Supabase que o stub não tem, acrescente o stub em
`supabase/tests/pre.sql` (nunca em migration).

Alternativa mais fiel (mais pesada, ~2 GB): `supabase db start` com o CLI, que sobe o Postgres do Supabase e aplica as
migrations; depois `psql` nos `*_check.sql`.
