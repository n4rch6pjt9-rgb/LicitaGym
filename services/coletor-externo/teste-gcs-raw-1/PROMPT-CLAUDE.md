Rode `bash testar-gcs-raw-1.sh <SHA de 40 hex do head do PR>` neste diretório.
O script clona https://github.com/n4rch6pjt9-rgb/LicitaGym.git nesse commit e executa o pytest de `services/coletor-externo`.
Cada passo imprime `OK` ou `FALHA`. Os passos de rede têm timeout de 20 segundos. O processo sai com código 1 se algum passo falhar.
A saída padrão de sucesso é a de `saida-esperada.txt`. Não grave no bucket nem no Supabase.
