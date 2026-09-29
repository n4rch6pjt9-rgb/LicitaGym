## O que muda e por quê

<!-- Contexto em 2 a 5 linhas. Cite a issue/PR relacionado. -->

## Impacto em produção

- [ ] **Aplica migration no merge** (integração Supabase ↔ GitHub): `supabase/migrations/...`
- [ ] **Publica Edge Function no merge** (`deploy-supabase-functions.yml`): quais?
- [ ] **DDL destrutivo** (`drop`, `alter ... type`, `set not null`, `truncate`, `delete`) — justificativa e plano de volta:
- [ ] Depende de outro PR (pilha): #
- [ ] Nenhum dos itens acima

## Verificação

- [ ] CI verde (`deno check`, `deno test`, pytest)
- [ ] `scripts/validar-migrations.sh` → `Tudo OK.` (se tem migration)
- [ ] Checagem de ACL nova/atualizada em `supabase/tests/*_check.sql` (se cria tabela/função)
- [ ] Revisado pelos agentes `revisor-migration` / `revisor-seguranca` (se aplicável)
- [ ] Sem segredo, `.env`, HAR, CSV, zip ou dado de coleta no diff

## Depois do merge

<!-- Consultas/checagens em produção (skill verificar-producao), ou "nada". -->
