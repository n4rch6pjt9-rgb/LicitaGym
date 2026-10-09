---
description: Implementa uma spec aprovada com TDD (testes dos critérios de aceite primeiro, depois o código) até um PR em draft
argument-hint: <caminho da spec, ex. specs/0001-slug.md>
---

Implemente a spec **$ARGUMENTS** com TDD. Sem merge, sem deploy, sem escrita em produção.

1. **Pré-condições.** Leia a spec, `CLAUDE.md`, `AGENTS.md` e as instructions da área. Pare e pergunte se:
   o status não é `aprovada`; há "Perguntas em aberto"; ou "Depende do ok do Marcelo: sim" e o ok não está registrado
   na spec ou na issue. Crie uma branch a partir da `main` atual (`claude/<slug>`), nunca trabalhe na `main`.
2. **Red.** Para cada CA, escreva o teste no arquivo que a spec indica, nomeado com o ID (`CA-1: ...`). Rode só esses
   testes e mostre que falham pelo motivo certo (comportamento ausente, não erro de import ou de sintaxe). Faça commit
   dos testes (`test(<area>): CA-1..CA-n da spec NNNN`).
3. **Green.** Escreva o mínimo de código para os testes passarem, seguindo as convenções do `CLAUDE.md`. Migration:
   siga a skill `nova-migration`; nunca edite uma migration já mergeada. Não mude um teste de CA para fazê-lo passar;
   se o CA estiver errado, pare e proponha a correção da spec.
4. **Checagens** (as mesmas da CI; rode só as da área tocada e mostre a saída):
   - `deno check` de cada `supabase/functions/<funcao>/index.ts` alterada;
   - `deno test tests/supabase --allow-read --allow-write --allow-env --no-prompt`;
   - `pytest tests/ -q` e/ou `cd services/coletor-externo && python -m pytest -q`;
   - migration: skill `validar-migrations` (tem que terminar em `Tudo OK.`).
5. **Revisão.** Rode o agente `revisor-codigo`; `revisor-migration` se houver migration; `revisor-seguranca` se tocar
   auth, `service_role`, segredo ou ACL. Corrija o que for bloqueante e diga o que ficou de fora e por quê.
6. **Spec.** Atualize o status para `em implementação` e marque cada CA com o teste que o cobre.
7. **PR em draft** pelo template `.github/pull_request_template.md`: liste os CAs com o resultado dos testes, preencha
   "Impacto em produção" a partir do "Impacto em dados" da spec e a seção "Depois do merge" com as consultas da skill
   `verificar-producao`. Pare aqui: o merge é do Marcelo.
