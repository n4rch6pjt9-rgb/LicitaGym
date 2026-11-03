# Specs

Uma spec descreve uma mudança antes do código: problema, critérios de aceite testáveis, o que fica fora e o
impacto em dados. Formato em `_template.md`, o mesmo das issues do repositório (contexto, critério de aceite com
evidência, fora de escopo, depende do ok).

Fluxo:
1. `/spec <ideia>` gera `specs/NNNN-slug.md` com status `rascunho` e lista as perguntas em aberto.
2. O Marcelo responde as perguntas e muda o status para `aprovada` (spec com migration ou decisão de produto só
   passa daqui com o ok dele).
3. `/implement specs/NNNN-slug.md` escreve primeiro os testes de cada critério (falhando), depois o código, roda
   as checagens da CI e os agentes revisores, e abre o PR em draft. Sem merge e sem deploy.

Numeração: próximo número livre com 4 dígitos (`ls specs`). Spec entregue fica no repositório como registro.
