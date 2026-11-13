---
description: Implementa uma spec aprovada com TDD (testes dos critérios de aceite primeiro, depois o código) até um PR em draft
argument-hint: <caminho da spec, ex. specs/0001-slug.md>
---

Implemente a spec **$ARGUMENTS** com TDD. Sem merge, sem deploy, sem escrita em produção.

1. **Pré-condições.** Leia a spec inteira e, em seguida, **cada arquivo da seção "Leitura obrigatória", na ordem da
   tabela**. Arquivo citado que não existe mais: pare e avise (a spec está desatualizada). Pare e pergunte também se
   o status não é `aprovada`, se há "Perguntas em aberto", ou se "Depende do ok do Marcelo: sim" e o ok não está
   registrado na spec ou na issue. Crie uma branch a partir da `main` atual (`claude/<slug>`), nunca trabalhe na `main`.
2. **Quem faz o quê.** Siga a seção "Skills e agentes por contrato": use a skill ou o agente indicado para cada `K-n`
   (por exemplo, `nova-migration` para a migration e o agente `frontend-dashboard` para a tela). Contrato entre os dois
   repositórios: o PR do backend vai primeiro.
3. **Red.** Para cada CA, escreva o teste no arquivo que a spec indica, nomeado com o ID (`CA-1: ...`). Rode só esses
   testes e mostre que falham pelo motivo certo (comportamento ausente, não erro de import ou de sintaxe). Faça commit
   dos testes (`test(<area>): CA-1..CA-n da spec NNNN`).
4. **Green.** Escreva o mínimo de código para os testes passarem, seguindo as convenções do `CLAUDE.md`. Migration:
   siga a skill `nova-migration`; nunca edite uma migration já mergeada. Não mude um teste de CA para fazê-lo passar;
   se o CA estiver errado, pare e proponha a correção da spec.
5. **Checagens** (as mesmas da CI; rode só as da área tocada e mostre a saída):
   - `deno check` de cada `supabase/functions/<funcao>/index.ts` alterada;
   - `deno test tests/supabase --allow-read --allow-write --allow-env --no-prompt`;
   - `pytest tests/ -q` e/ou `cd services/coletor-externo && python -m pytest -q`;
   - migration: skill `validar-migrations` (tem que terminar em `Tudo OK.`);
   - Dashboard: `npx vitest run`, `npx tsc --noEmit`, `npm run build` e a skill `run-dashboard` nas rotas tocadas.
6. **Revisão.** Rode os revisores que a seção "Skills e agentes por contrato" indica para cada `K-n`, no mínimo
   `revisor-codigo`; `revisor-migration` se houver migration; `revisor-seguranca` se tocar auth, `service_role`,
   tenant, segredo ou ACL; `ux-ui-licitagym` se mudar tela. Corrija o que for bloqueante e diga o que ficou de fora
   e por quê.
7. **Spec.** Atualize o status para `em implementação`, marque cada CA com o teste que o cobre e confirme a leitura
   obrigatória (lista no PR).
8. **PR em draft** pelo template `.github/pull_request_template.md`: liste os arquivos lidos, os CAs com o resultado
   dos testes, os revisores rodados e o resultado de cada um, preencha "Impacto em produção" a partir do "Impacto em
   dados" da spec e a seção "Depois do merge" com o que a coluna "Depois do merge" pede (`verificar-producao`,
   `deploy-dashboard`). Pare aqui: o merge é do Marcelo.
