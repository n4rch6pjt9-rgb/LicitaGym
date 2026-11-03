---
name: merge-pilha
description: Merge de PRs empilhados do LicitaGym e do Dashboard na ordem certa, com checagens de produção entre um e outro. Use só quando o usuário pedir explicitamente o merge.
---

# Merge de PRs empilhados

**Merge na `main` do LicitaGym aplica em produção** (migrations pela integração do Supabase e Edge Functions pelo
`deploy-supabase-functions.yml`). Só com "ok" explícito do usuário para cada merge.

1. Liste a pilha: `gh pr view <n> --json baseRefName,headRefName,mergeable,statusCheckRollup`.
   A ordem é da base para o topo (o PR cuja base é `main` primeiro).
2. Para cada PR:
   - CI verde e `mergeable`; se não, pare e reporte;
   - `gh pr merge <n> --merge` (**merge commit**; não use squash nem rebase: o repositório apaga a branch no merge e
     o PR de cima ficaria com commits duplicados);
   - confira que o PR de cima foi retargetado para `main` (`gh pr view <n+1> --json baseRefName`);
   - se tiver migration: espere a integração aplicar e rode a skill `verificar-producao`;
   - se tiver Edge Function: acompanhe `gh run watch` do deploy e confira o smoke test.
3. Se um PR foi squashado por engano: `git rebase --onto origin/main <branch-de-baixo> <branch-de-cima>` e
   `git push --force-with-lease` (nunca na main), antes do próximo merge.
4. Nunca rode `supabase migration repair`: se a integração falhar, reporte ao usuário com a saída do log.
5. Dashboard: o merge não publica. O deploy é do usuário (`npm run cf:deploy`) depois que o backend estiver no ar.
