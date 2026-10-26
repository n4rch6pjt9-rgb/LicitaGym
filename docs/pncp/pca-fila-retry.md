# PCA: retry e adiamento da fila (#289, etapa 1)

Contrato de `private.pca_fila_enfileirar`, `private.pca_fila_reservar` e `processarFila`.

| Evento | Estado esperado |
|---|---|
| Redescoberta com data igual, anterior ou ausente | Preserva status, tentativas, erro, atualizado_em e disponivel_em. Não reinicia recuo nem relógio de abandono. |
| Data oficial estritamente maior que a data já conhecida | Fora de worker vivo, inicia ciclo pendente com zero tentativas e erro limpo. Preserva o adiamento existente. |
| Uma das datas desconhecida | Não há prova de versão nova para zerar tentativas. |
| Redescoberta durante processamento recente | Preserva cabeçalho/data usados pelo worker e seu relógio. A próxima descoberta pode enfileirar a versão maior depois que ele terminar. |
| Falha real | Conta tentativa. Erro só volta após dez minutos e abaixo do limite. |
| Worker abandonado há mais de quinze minutos | Reserva recupera abaixo do limite e conta uma tentativa de abandono. |
| Cinco ou mais tentativas, inclusive pendente | Não reserva; aparece como esgotado em situacaoFila. |
| Pausa por orçamento / rate limit | Adia só o interrompido por 20 / 30 minutos; não consome tentativa. |
| Falha ao gravar o adiamento | Registra pca_fila_adiamento_falhou e ainda tenta devolver os demais reservados. Mantém a exceção original de pausa. O interrompido pode depender da recuperação de abandono. |
| UPDATE de adiamento sem linha afetada | É falha, sem log falso de sucesso. |

O limite é por ciclo de uma versão conhecida, não um bloqueio permanente de toda versão futura do plano.
Datas mais antigas não fazem regredir o cabeçalho/data da fila. `chain_id` e classes continuam sendo metadados de
descoberta; `atualizado_em` conserva sua função de relógio de estado, não de última redescoberta.

## Validação

- `tests/supabase/functions/sync_pncp_pca_fila_test.ts`: pausa real no processador, devolução, saúde e fake das RPCs.
- `supabase/tests/pca_plano_fila_check.sql`: contrato legado atualizado, ACL, ausência e recuperação de lock.
- `supabase/tests/pca_fila_starvation_289_check.sql`: FIFO, preservação e expiração do adiamento, limite em
  pendentes, versão nova, worker vivo, abandono e recuo. O sufixo `_check.sql` inclui o teste no runner existente.

Banco descartável, dados sintéticos, nenhuma chamada às APIs oficiais nos testes unitários.

## Compatibilidade e implantação

As assinaturas das RPCs e os status não mudam. A etapa altera a migration anti-starvation do PR #444 em revisão,
sem criar outra versão da mesma definição em paralelo. Ela deve ser aplicada antes da função que escreve
`disponivel_em`. Antes de qualquer implantação, conferir se esse timestamp já foi aplicado em algum ambiente:
se tiver sido, a correção das RPCs precisa de uma nova migration, não da edição de histórico aplicado.

Não há implantação, alteração de cron ou reprocessamento de registros reais nesta etapa. Uma reversão de código
não exige remover a coluna aditiva. Restaurar as RPCs anteriores reintroduziria os defeitos de retry/adiamento;
se houver problema operacional, interromper novos disparos sob procedimento aprovado e preparar uma migration
de correção. Nenhum rollback destrutivo é necessário para esta alteração.

## Limites desta etapa

Proteção por dono da reserva e exclusão entre legado/fila pertencem à etapa 3. Integridade de quantidade/itens e
inativação pertencem à etapa 2. Completion/continuation/inativação do caminho legado pertencem à etapa 4.
