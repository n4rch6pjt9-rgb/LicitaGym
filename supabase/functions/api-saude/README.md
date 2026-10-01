# api-saude

Saúde operacional da ingestão: lê `private.saude_operacional_resumo()` (migration `20261001100000_saude_operacional.sql`).

| Ação | Corpo | Resposta |
|---|---|---|
| `resumo` | `{"action": "resumo"}` | `status_geral` (`ok`\|`atencao`\|`critico`, o pior), `contagem`, `verificacoes[]` (`verificacao`, `status`, `valor`, `unidade`, `atencao`, `critico`, `mensagem`, `detalhe`) |

**Acesso:** `Authorization: Bearer <SYNC_CRON_SECRET>` (workflow `.github/workflows/saude.yml`) ou JWT de usuário com
`app_metadata.licitagym_role = 'admin'`. Usuário comum: `403`. Sem credencial: `401`.

**Limiares:** em `private.saude_limiares` (editar não exige deploy). `critico` nulo = a verificação só informa.

**Alertas:** o workflow `saude.yml` chama esta função a cada 30 min, junto com o readiness da
`api-dashboard-oportunidades` e o Dashboard, e abre/atualiza a issue com o rótulo `alerta-operacional` quando há
crítico; fecha a issue quando tudo volta a não crítico.
