# Testes mínimos para os fluxos críticos sem cobertura

Levantamento de 08/10/2026 (Etapa 1 do preparo AI-native). É uma proposta: cada item vira uma spec (`/spec`) e é implementado
com `/implement`. A ordem é por risco: o que já quebrou em produção ou toca autenticação vem primeiro.

## Como está hoje

| Suíte | Arquivos | Testes |
|---|---|---|
| Deno `tests/supabase/**` | 59 | 433 passam, 1 ignorado |
| pytest `tests/` (scripts) | 17 | 176 |
| pytest `services/coletor-externo/tests` | 51 | 1.427 (+3 skipped) |
| SQL `supabase/tests/*_check.sql` | 40 | 37 passam, 3 pendentes (#262) |

Os handlers `sync-pncp-*` são cobertos só por busca de texto no código (`readSync`). Os clientes PNCP têm teste de
comportamento com `_harness.ts`.

## Proposta (P1 primeiro)

| # | Fluxo | O que testar (mínimo) | Onde | Por quê |
|---|---|---|---|---|
| 1 | **Saúde: 401 do cron** | Spec `specs/0001-saude-cron-401.md` | SQL check + Deno | Incidente de 08/10: sync PNCP parada, com o alerta misturado a outros erros |
| 2 | **`sync-pncp-contratacoes-itens`** | Handler com cliente falso: página com erro → execução `concluida_com_erros`/`falhou`, nunca "0 itens" com sucesso; idempotência do upsert por chave oficial | Deno `tests/supabase/functions/sync_pncp_contratacoes_itens_test.ts` | Sem nenhum teste; importa `_shared_prod` (retry de 31 linhas) e não passa em `deno check` |
| 3 | **`api-pncp-irp` e `api-pncp-contratacoes` (GET)** | Sem JWT → 401; JWT inválido → 401; com JWT → usa o cliente do usuário, nunca `service_role` | Deno, mesmo padrão de `api_pncp_auth_order_sec_edge_test.ts`, mas chamando o handler | O GET não chama auth explícito e depende da RLS; hoje só há busca de texto |
| 4 | **Isolamento de tenant no pipeline** | Dois tenants e dois usuários: usuário A não lê nem move oportunidade de B; vínculo com empresa inativa não cai em outra (#263); `portal.ts` e `sync-portal-compras` filtram por tenant | Deno `api_pipeline_test.ts` (repo falso com 2 tenants) + SQL check | Gate obrigatório antes de ligar tenants (ver CLAUDE.md) |
| 5 | **Handlers `sync-pncp-pca`, `-editais`, `-atas`, `-contratos`, `-orgaos`** | Um teste de comportamento por handler: lock ocupado → 409/sem nova execução; página com erro → execução parcial; heartbeat atualizado | Deno, reaproveitando `tests/supabase/functions/_shared/pncp/_harness.ts` | `orgaos` precisou de três correções (#238, #247); hoje só há busca de texto |
| 6 | **`classificar_aparelho.py`** | Casos do dicionário v0.3: cada nó IN com 1 exemplo positivo; nós OUT nunca IN; determinismo (mesma entrada → mesma saída) | pytest `services/coletor-externo/tests/test_classificar_aparelho.py` | 155 linhas sem teste; decide Musculação/Cárdio/Acessórios |
| 7 | **`scripts/saude-alerta.sh`** | `DRY_RUN=1` + `SAUDE_JSON` de fixture: crítico → título com o nome da verificação; tudo ok → fecha a issue | Deno ou bats, sem rede | Abre e fecha a `alerta-operacional`; nunca foi testado |
| 8 | **`_shared_prod/`** | Em vez de testar: trocar os imports de `analyze-public-material`, `link-pca-edital` e `sync-pncp-contratacoes-itens` para `_shared/` e apagar a cópia | Deno check + testes existentes | Cópia desatualizada; o `http.ts` copiado compara o segredo do cron com `===` |
| 9 | **Typecheck pendente** | Corrigir os 4 entrypoints de `.github/ci/deno-check-pendentes.txt` | `scripts/ci/deno-check-funcoes.sh` | A CI já checa os demais; a lista só pode diminuir |

## Regras para os testes novos

- Teste unitário não chama API real: Deno sem `--allow-net`, e pytest com fixture ou `responses`.
- Toda correção P0/P1 leva teste de regressão nomeado com a issue.
- Teste de controle de acesso sempre tem o caso negativo (anon, sem papel, outro tenant).
