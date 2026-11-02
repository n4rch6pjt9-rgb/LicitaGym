# Check manual TX02 — RPC atômica PCA

Status: APROVADO em PostgreSQL 17.11 descartável em 31/10/2026; código de saída 0, duas fases concluídas e limpeza confirmada.

Arquivo: `pca_rpc_atomico_check.sql`.
Branch inspecionada: `test/pca-integrity-red-01`; HEAD lido: `c7dc627241f05f33b5db81118e003567de49a26a`.

## Precondições

- PostgreSQL descartável exclusivo, com banco de nome exato `licitagym_pca_tx_test`.
- Migrations desta branch previamente aplicadas, inclusive `20261027231110_pca_persistencia_atomica.sql` e a proteção de posse da reserva.
- Tabelas PCA, fila e execuções PCA vazias. O check recusa dados preexistentes.
- Sessão administrativa capaz de criar trigger e executar `SET ROLE service_role`. As chamadas verificadas usam `service_role`, sem helpers SECURITY DEFINER.
- Conexão local do harness identificada explicitamente; não herdar credenciais, service files ou destino padrão de produção.

O check exige `licitagym.harness=isolated-local` na sessão além do nome exato do banco. Esses sinais são travas contra enganos, não substituem verificar que a instância é descartável.

## Execução manual, somente após autorização

Na sessão do PostgreSQL local explicitamente selecionada, configurar `licitagym.harness=isolated-local` e executar o arquivo com `psql -X -v ON_ERROR_STOP=1`. O caminho de conexão e as credenciais não foram definidos neste documento. A execução exige autorização explícita.

Não usar `--single-transaction`, nem envolver o arquivo em transação externa. Usar uma sessão dedicada e encerrá-la após o check.

Este arquivo não aplica migrations. Foi colocado em `supabase/tests/manual/` porque contém COMMITs e exige banco exclusivo. O glob atual `supabase/tests/*_check.sql` não o executará automaticamente.

## Critérios e evidências exigidas

| Critério | Verificação |
| --- | --- |
| CA-8 real | Falha P0199 injetada no histórico depois da tentativa de reativação; ativo=false, valor=100, hash e snapshot completo preservados. |
| Entidade e histórico | Falhas no histórico do item e do plano não deixam alterações; compara histórico completo antes/depois. |
| Lote indivisível | Segunda unidade falha depois da primeira; primeira unidade e seu histórico são revertidos, segunda não persiste. |
| Sucesso e repetição | Reativação para valor=999, hash novo, evento único e snapshots completos; repetição retorna inalterado sem evento adicional; reativação com mesmo hash também exercitada. |
| Autorização | ACL das duas funções; header ausente/divergente, execução encerrada, token recuperado e token ausente rejeitados com SQLSTATE 40001, sem alteração de item/histórico. |
| Chamadas separadas | Plano e 100 itens são confirmados com COMMIT real; falha na chamada seguinte preserva dados e 101 eventos anteriores; rejeita lotes de 0 e 101 unidades. |

Os erros esperados são capturados pelo SQLSTATE exato. Erro inesperado ou ausência da falha esperada interrompe o check; não há aprovação baseada apenas em imprimir mensagens.

A fase 1 termina em ROLLBACK. A fase 2 confirma fixtures para provar a fronteira entre transações e depois limpa somente os registros identificados pelo contexto temporário do check. A mensagem final de sucesso só aparece depois de confirmar a limpeza.

## Limites e recuperação

Se o check falhar depois do primeiro COMMIT da fase 2, podem permanecer fixtures e o trigger de injeção. Descartar o banco exclusivo; não retomar a sincronização nem reaproveitar esse banco. A trava de dados vazios impede nova execução silenciosa sobre sobras.

O check não prova concorrência entre sessões, transporte PostgREST, exposição do schema private, nem a transição da fila para erro feita pelo worker TypeScript. Esses comportamentos precisam de validações próprias. O CA-8 Deno existente complementa o cenário de status da fila.

A divisão TypeScript de 101 unidades em 100+1 é verificada pela suíte Deno; este SQL verifica a fronteira transacional da RPC e o limite do servidor. Nenhum resultado aprovado em PostgreSQL foi presumido.

## Execução confirmada em 31/10/2026

153 migrations numeradas aplicadas; duas exclusões de cron conforme o harness existente. A migration TX02 foi reaplicada com sucesso. A trava rejeitou marcador incorreto. As duas fases e todos os critérios deste check passaram sem alteração do SQL. Estado final: planos=0,itens=0,historico=0,fila=0,runs=0,trigger=0. Contêiner exclusivo removido.

Evidências locais: C:\Users\marce\.codex\.chatgpt-projects\g-p-6aab2b32d9008191bec34fc66f7b4a09\pca-integrity-red-01\execution-20261031\attempt-02\RESULTADO.md e logs/check.log.

A primeira tentativa do executor falhou por incluir também o arquivo consolidado; foi descartada. A execução aprovada usou outro banco novo e o mesmo padrão 2*.sql do harness. Não houve commit, deploy ou acesso a produção.