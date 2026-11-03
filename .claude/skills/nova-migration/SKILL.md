---
name: nova-migration
description: Como escrever uma migration do LicitaGym (idempotente, ACL explícita, RLS, checagem). Use antes de criar ou alterar qualquer arquivo em supabase/migrations/.
---

# Nova migration

Leia também `.github/instructions/database-migrations.instructions.md`.

1. **Nome:** `supabase/migrations/<AAAAMMDDHHMMSS>_<assunto>.sql`, com timestamp maior que o da última migration
   (`ls supabase/migrations | tail -3`). Nunca edite uma migration já mergeada: crie outra.
2. **Cabeçalho:** contexto (por quê), o que muda, quem lê/escreve, como verificar. Tudo dentro de `begin; ... commit;`.
3. **Idempotência** (a migration pode rodar duas vezes):
   - `create table if not exists`, `add column if not exists`, `create index if not exists`;
   - `create or replace function`; `drop policy if exists` antes de `create policy`;
   - constraint nova dentro de `do $$ ... if not exists (select 1 from pg_constraint ...) ... $$`;
   - carga de dados com `on conflict ... do nothing` (não sobrescreve o que o admin editou) ou `do update` quando o
     dado vem de arquivo versionado.
4. **Segurança** (padrão de `20260929130000_acl_sistema_s_catalogos.sql` e `20260930100000_catalogo_empresa_catmat.sql`):
   - `alter table ... enable row level security` em toda tabela nova;
   - `revoke all on table ... from anon, authenticated, PUBLIC;` e depois só os `grant` necessários
     (`authenticated` leitura quando o Dashboard lê direto; escrita só `service_role`);
   - funções: `security invoker` (ou `definer` com justificativa), `set search_path = public, pg_temp`,
     `revoke execute ... from PUBLIC, anon, authenticated` e `grant execute ... to service_role`;
   - papel de admin só por `app_metadata.licitagym_role`, nunca `user_metadata`.
5. **Checagem:** tabela/função nova entra num `supabase/tests/<assunto>_acl_check.sql` (DO block que faz
   `raise exception 'ACL CHECK FALHOU: ...'` e termina com `raise notice 'SUCESSO: ...'`).
6. **Destrutivo** (`drop table/column`, `alter ... type`, `set not null`, `truncate`, `delete`): só com justificativa
   escrita no PR e plano de volta. Prefira aditivo.
7. **Validar:** skill `validar-migrations` (a CI roda o mesmo no job `migrations`). Depois peça ao agente
   `revisor-migration`. Se cair num critério de "branch Supabase sob demanda" do CLAUDE.md (destrutivo, backfill
   grande, RLS de tenant, extensão, objeto fora do stub), peça ao Marcelo a branch antes do merge.
8. **Produção:** o merge na `main` aplica a migration pela integração do Supabase. Diga isso no PR. Depois do merge:
   skill `verificar-producao` e `get_advisors` (security); achado novo vira issue.
