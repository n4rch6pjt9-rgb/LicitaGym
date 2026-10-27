# PCA: validação da leitura antes da inativação (etapa 2)

A leitura de itens pela Integração precisa comprovar identidade e quantidade antes de entregar dados ao
processador. Uma lista com duas ocorrências do mesmo `numeroItem` não comprova dois itens distintos.

## Contrato

- Cada `numeroItem` deve ser inteiro positivo e seguro para representação numérica no JavaScript.
- Identificadores repetidos interrompem o plano, inclusive entre páginas, com conteúdo idêntico ou conflitante.
- A quantidade deve ser inteiro não negativo e seguro. Ausência, booleanos, coleções, frações e valores
  fora da faixa segura são erros, mesmo com HTTP 200.
- Mantém-se compatibilidade com inteiros decimais textuais compostos apenas por dígitos. Isso é uma regra
  de compatibilidade da implementação, não uma afirmação de que a fonte oficial envie strings.
- Zero explícito continua sendo quantidade válida. Não se exige sequência contígua de identificadores.
- A quantidade deve coincidir com a leitura validada inteira, antes do filtro por classe.
- Os valores originais dos itens são preservados; a validação não modifica o payload.

A rejeição acontece antes da gravação de itens e da inativação no processador da fila, inclusive no motivo
`ausente`. O tratamento existente registra erro na fila, conta tentativa e sinaliza reprocessamento do plano.
O arquivamento de respostas já recebidas continua existindo e não é uma aprovação da carga.

## Verificação

Os testes em `tests/supabase/functions/sync_pncp_pca_fila_test.ts` cobrem repetição entre páginas, valores
inválidos, zero explícito, identificadores não contíguos e preservação dos itens persistidos no processamento
normal e na reconciliação. Dados sintéticos, sem acesso de rede aos testes.

Não há alteração de banco, RPC, status público, retry ou adiamento anti-starvation. Esta etapa não altera
o caminho legado sem `rotina` nem acrescenta proteção por dono da reserva; esses achados permanecem pendentes.
