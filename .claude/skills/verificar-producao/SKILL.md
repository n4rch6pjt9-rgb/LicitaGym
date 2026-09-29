---
name: verificar-producao
description: Consultas somente leitura para conferir produção depois de merge/deploy ou investigar incidente (migrations aplicadas, ACL, execuções de coleta e sync, readiness). Use com o MCP do Supabase (read_only).
---

# Verificar produção (somente leitura)

Use `execute_sql` do MCP do Supabase (somente leitura). Não corrija nada em produção: reporte ao usuário com evidência.

1. **Migrations aplicadas:** `list_migrations` do MCP, ou
   `select version, name from supabase_migrations.schema_migrations order by version desc limit 10;`
2. **ACL:** rode o conteúdo do `supabase/tests/<assunto>_acl_check.sql` correspondente (é um DO block só de leitura)
   e espere o `NOTICE ... SUCESSO`.
3. **Sync do PNCP:**
   ```sql
   select resource_type, modo, status, iniciada_em, finalizada_em, last_heartbeat_at,
          now() - last_heartbeat_at as parado, total_erros, erro_principal
     from private.pncp_sync_run order by iniciada_em desc limit 20;
   ```
   Alerta: `status` em andamento com heartbeat parado há mais de 15 min; `incompleta` sem `retomada_por_id`.
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
