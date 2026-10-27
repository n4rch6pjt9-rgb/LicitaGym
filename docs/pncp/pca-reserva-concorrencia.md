# PCA: posse das reservas e concorrência (etapa 3)

## Contrato

A migration `20261026230000_pca_reserva_posse.sql` acrescenta `reserva_token uuid` à fila privada.
Cada reserva, inclusive recuperação por abandono, gera outro token. A assinatura da RPC de reserva, os limites
de retry, o recuo e o adiamento anti-starvation permanecem. O resultado da reserva é ordenado por criado_em/id.

Finalização, erro, adiamento e devolução exigem id, status processando e o token recebido na reserva.
Após a leitura HTTP, o processador confere a posse antes de gravar. A checagem TypeScript não é a única defesa:
triggers de pca_planos/pca_itens validam o token e travam a linha da reserva durante a transação da escrita.
O cliente de cada plano é independente e transmite x-pca-reserva e x-pca-run-id. Não se compartilham headers
mutáveis entre planos. Esses headers não substituem autenticação, service_role, ACLs ou RLS.

A trava anual `pca_adquirir_execucao` serializa a aquisição entre fila, legado, disparos manuais e classes
diferentes do mesmo ano. Mantém as chaves anteriores para não misturar formatos de continuation.
Uma execução recente de outro caminho retorna already_running com o ID existente.
Uma execução stale do outro caminho é encerrada antes de iniciar a nova; a continuation anterior fica na
própria chave, sem convertê-la ao formato do novo caminho. Outros coletores continuam na RPC original.

As escritas com x-pca-run-id também travam/validam a execução como executando. Uma execução substituída
perde autorização para a próxima escrita de planos/itens. Uma escrita já em andamento pode terminar antes
da recuperação, porque segura os locks até seu commit. Isso evita recuperar a posse no meio dessa instrução.

## Compatibilidade e implantação futura

Esta etapa depende da etapa 2, ainda local. Não há merge, deploy ou alteração operacional nesta entrega.

Antes de implantar, interromper os novos disparos PCA e aguardar o término dos workers da versão anterior.
A versão anterior não usa token nos updates da fila: coexistência de versões antigas e novas não é garantida.
Aplicar a nova migration antes do código e só depois retomar os disparos. Não editar migrations já aplicadas.
Código novo sem a migration falha; código antigo com os triggers pode ter escritas rejeitadas.
Validar o estado real das execuções e reservas no plano de implantação.

Um rollback precisa dessa mesma interrupção e de uma migration posterior que reverta os guards antes de
restaurar o cliente antigo. Não remover a coluna ou apagar histórico como atalho.
Ferramentas de manutenção que escrevem planos/itens sem token são bloqueadas enquanto o plano está reservado.

## Validação e limites

Testes Deno cobrem perda de posse durante HTTP, finalização atrasada, pausa após recuperação, transporte real
dos headers no cliente Supabase e escolha da RPC por tipo de coletor.
O check SQL roda também sob service_role, verifica ACL, tokens diferentes após recuperação, rejeição de
escritor antigo, escrita válida e exclusão anual nas duas direções. As sessões reais sobrepostas verificam
a serialização anual e o bloqueio da recuperação até o commit da escrita.

A carga inteira de um plano continua usando várias transações. Esta etapa protege planos e itens e o estado
da reserva; não transforma histórico e projeções CATMAT/PDM em uma transação única.
Completion, continuation e inativação anual do caminho legado permanecem como próximo bloco da auditoria.

Referências dos mecanismos usados:
- [Headers globais do cliente Supabase](https://supabase.com/docs/reference/javascript/initializing).
- [Transações e request.headers no PostgREST](https://docs.postgrest.org/en/v12/references/transactions.html).
