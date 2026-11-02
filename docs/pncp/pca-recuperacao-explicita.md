# Recuperação explícita de planos PCA

O incremental não reinicia automaticamente uma fila com cinco tentativas.
A marca reprocessar indica que a carga precisa ser refeita; ela não remove esse limite.

Uma chamada autenticada do sync pode solicitar um novo ciclo para IDs selecionados:

    {"ano":2026,"rotina":"backfill","recuperar_esgotados":["99000001000101-0-000004/2026"]}

O ID acima é sintético; substituir pelos IDs revisados da fila real no ambiente autorizado.
A operação aceita de 1 a 100 IDs do ano e não pode ser combinada com somente_retomada.
Não reabre reserva viva nem filas de outros IDs/anos. O resultado informa esgotados_reabertos.
Os crons existentes não enviam esse campo e continuam respeitando o limite.

A RPC privada pca_fila_reabrir_esgotados exige service_role e uma execução PCA de fila ativa
do ano informado. Não é um comando para executar em produção durante homologação.
