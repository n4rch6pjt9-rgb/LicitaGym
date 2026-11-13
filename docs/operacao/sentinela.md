# Sentinela operacional

## Escopo e publicação

A saúde existente permanece em api-saude → scripts/saude-alerta.sh → issue alerta-operacional. O observador adicional gera somente resumo de execução; não envia mensagens, reexecuta jobs ou modifica dados. Merge/publicação seguem a autorização e o fluxo do repositório; código em PR não equivale a monitor ativo.

## Garantias implementadas

- API retorna erro quando não há verificações; consolidar lista vazia nunca produz ok. Status inesperado não é interpretado como ok.
- Antes de usar HTTP 200, o monitor valida JSON, data com fuso, idade, códigos, duplicatas, estados, contagem, estado geral e cobertura esperada.
- Resumo inválido mantém incidente aberto. Críticos são registrados antes de o processo terminar com erro; run verde não representa incidente crítico notificado com sucesso.
- Incidente já aberto continua sendo atualizado; comentário só muda quando muda o conjunto crítico. Falha ao consultar issues não equivale a ausência de incidente.
- Workflow saude.yml declara as dez verificações atuais. Mudança intencional de cobertura exige revisar SAUDE_VERIFICACOES_ESPERADAS. Tolerância de 90 minutos é configurável por SAUDE_MAX_IDADE_MINUTOS; não é SLA contratual.
- O observador consulta apenas execuções schedule da main para avaliar continuidade do monitor. Disparo manual não mascara cron atrasado.
- Sonda PNCP usa /contratacoes/proposta, parâmetros documentados e página de dez itens; 204 é vazio válido, HTML/JSON inválido não é saudável. Falha isolada é atenção, não declaração de queda global.

## Usar em observação

```bash
python3 scripts/sentinela_observar.py --github --pncp
python3 scripts/sentinela_observar.py --cloud-run
python3 scripts/sentinela_observar.py --status-licitacoes
```

Saída: JSON com horário UTC, verificação, estado e evidência mínima. Código 0 = sinais selecionados ok, 1 = crítico, 2 = atenção/não verificado. Nunca grava tokens nem exporta configuração de contêiner, logs brutos ou corpo de erros.

GitHub: pode ler o repositório público sem token, sujeito a rate limit; GH_TOKEN opcional deve ter somente leitura de Actions para esta finalidade. O workflow observador já usa github.token com actions:read.

Cloud Run: usar gcloud autenticado no ambiente autorizado com permissão de leitura das execuções dos jobs em licitagym/southamerica-east1. Usa token de curta duração do gcloud em memória, sem chave de service account. Sem CLI, credencial ou acesso, reporta atenção. Verifica preparar-triagem e coletor-precos. Apenas triagem tem janela de atualidade configurada: preços ainda não possui agenda confirmada. Conta de produção de outros coletores não deve ganhar permissões adicionais por conveniência.

O script lê o recurso REST v2 Execution. Data de atualização do job não representa execução. succeededCount/taskCount e completionTime confirmam tarefas concluídas, não quantidade de documentos ou preços persistidos. Dados e fila precisam ser conciliados separadamente.

Status Licitações: o HTML atual não foi validado como contrato estruturado com atualização confiável. Por isso a opção verifica acessibilidade e registra que o estado anunciado não foi corroborado. Não interrompe syncs nem classifica o PNCP a partir dessa página.

## O que ainda exige implantação ou contrato

| Gap | Situação |
|---|---|
| Resumo vazio, inválido, incompleto ou desatualizado | Implementado com regressões; depende de merge/publicação |
| Falha crítica com workflow aparentemente saudável | Script sai com falha após tratar incidente |
| Continuidade da rotina e sonda PNCP | Workflow observador separado; depende de merge/agenda |
| Pane do próprio GitHub Actions | Não coberta por outro workflow do mesmo provedor; executar observador em ambiente independente |
| Dois jobs Cloud Run | Observador pronto; falta identidade de leitura e execução agendada fora do ambiente local |
| Completude por documento, fila e checkpoint | Não inferida por execução do contêiner; falta contrato comum de eventos por execução |
| Catálogo de todos os conectores e SLAs | Inventariar agendas efetivas; não usar a mesma tolerância para todos |
| Sonda de download 422 | Continua separada da sonda de consulta; selecionar recurso verificável sem transformar documento inválido em queda geral |
| Conteúdo do Status Licitações | Falta contrato de estado/atualização confiável; acessibilidade apenas |
| Laboratório de IA e ROI | Fora da execução desta sentinela; avaliar em trilha própria |

## Validação e rollout

```bash
python3 -m unittest discover -s tests -p test_sentinela.py -v
deno test tests/supabase/functions/api_saude_test.ts --allow-read --allow-env --no-prompt
bash -n scripts/saude-alerta.sh
```

Testes de shell exigem bash/jq e usam DRY_RUN com dados sintéticos. Nenhum teste unitário chama PNCP/GCP ou envia issue.

Antes de liberar: CI e revisão, conferir configuração da cobertura e o efeito de retorno crítico no workflow. Depois do merge autorizado: confirmar API autenticada, resumo real e execução agendada. Não fechar incidente apenas porque o token foi corrigido; verificar os sinais reais.

Rollback: reverter o commit da sentinela pelo fluxo normal; não trocar secrets nem remover dados. O observador pode ser desabilitado independentemente da saúde existente.

Referências: https://docs.github.com/en/rest/actions/workflow-runs e https://cloud.google.com/run/docs/reference/rest/v2/projects.locations.jobs.executions . Contratos PNCP em docs/pncp/schemas-consultas-pncp.md.
