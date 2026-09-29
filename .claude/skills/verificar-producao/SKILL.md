---
name: verificar-producao
description: Consultas somente leitura para conferir produção depois de merge/deploy ou investigar incidente (migrations aplicadas, ACL, execuções de coleta e sync, readiness). Use com o MCP do Supabase (read_only).
---

# Verificar produção (somente leitura)

Use `execute_sql` do MCP do Supabase (somente leitura). Não corrija nada em produção: reporte ao usuário com evidência.

1. **Migrations aplicadas:** `list_migrations` do MCP, ou
   `select version, name from supabase_migrations.schema_migrations order by version desc limit 10;`
2. **ACL** (só `SELECT`: os `*_acl_check.sql` são blocos `DO`, que o MCP somente leitura e o hook recusam; eles
   rodam no Postgres descartável via `scripts/validar-migrations.sh`). Grant de escrita para `authenticated` com RLS
   ligado e sem policy não abre nada, então a consulta olha RLS desligado e as policies que realmente liberam acesso:
   ```sql
   select 'rls_desligado' as achado, n.nspname||'.'||c.relname as objeto, null as detalhe
     from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname in ('public','private') and c.relkind in ('r','p') and not c.relrowsecurity
   union all
   select 'policy_' || lower(p.cmd), p.schemaname||'.'||p.tablename,
          p.policyname || ' roles=' || array_to_string(p.roles, ',') || ' using=' || coalesce(left(p.qual, 60), '-')
     from pg_policies p
    where p.schemaname in ('public','private')
     and p.roles && array['anon','public','authenticated']::name[]
   order by 1, 2;
   ```
   Esperado: nenhuma `rls_desligado`; policies de escrita só com checagem de `app_metadata.licitagym_role` ou de dono
   (`auth.uid()`); leitura para `anon`/`public` só onde for dado público por decisão registrada (em 29/09/2026:
   `legislacao` e `legislacao_embeddings`, ainda sem decisão registrada).
   Funções executáveis por `anon`: `select p.oid::regprocedure from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and has_function_privilege('anon', p.oid, 'EXECUTE');` (compare com o esperado da migration).
3. **Sync do PNCP:**
   ```sql
   select resource_type, modo, status, iniciada_em, finalizada_em, last_heartbeat_at,
          now() - last_heartbeat_at as parado, total_erros, erro_principal
     from private.pncp_sync_run order by iniciada_em desc limit 20;
   ```
   Alerta: `status` em andamento com heartbeat parado há mais de 15 min. `incompleta` é normal (checkpoint esperando o
   próximo job, que a marca `retomada` e preenche `retomada_por_id`); só é alerta se continuar `incompleta` depois da
   janela do próximo agendamento daquele `resource_type`.
4. **Coletas externas (Sistema S):**
   ```sql
   select fonte, modo, status, started_at, finished_at, erros, detalhe_erros
     from private.coleta_externa_run order by started_at desc limit 20;
   ```
   Alerta: última execução com sucesso de uma fonte há mais de 8 dias.
5. **Volume:** `select fonte, count(*), max(created_at) from public.licitacoes_externas group by 1;`
6. **Edge Functions:** `get_logs` do MCP (serviço `edge-function`) e o readiness:
   `curl -s -o /dev/null -w '%{http_code}' "<SUPABASE_URL>/functions/v1/api-dashboard-oportunidades?action=readiness"`
   (200). Sem token, as `api-*` devem responder 401.
7. **Advisors:** `get_advisors` (security e performance) depois de migration.

Colunas e tabelas mudam: confirme com `list_tables` antes de concluir que algo não existe.
