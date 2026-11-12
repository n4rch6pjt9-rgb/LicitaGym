---
name: dry-run-classificacao
description: "Monta a contagem antes/depois (dry-run) que todo PR de mudança de classificação precisa trazer: termos de escopo, padrões e exclusões CATMAT, categorias de objeto, tipo de órgão, marca, regra de prioridade. Só leitura. Use antes de abrir o PR, quando o diff tocar essas regras."
disable-model-invocation: true
---

# Dry-run de classificação (contagem antes/depois)

Regra do projeto (`CLAUDE.md`, `.github/instructions/catmat.instructions.md`): mudança de classificação sem contagem
antes e depois no texto do PR é achado. Modelo de como fica: seção "Dry-run (contagem antes/depois)" da
`specs/0045-credenciamento-nunca-vira-lead.md`.

**Somente leitura.** Use `execute_sql` do MCP do Supabase (somente leitura; o hook `bloquear-destrutivo.mjs` recusa
escrita). Não grave, não rode `objeto_reclassificar()` nem `licitacao_match_atualizar()` para "ver o efeito":
isso muda produção. Contagem vem de consulta, nunca de estimativa (`AGENTS.md`: zero alucinação).

## 1. O que a mudança altera → o que medir

| Mudança | Medir "antes" (e "depois") |
|---|---|
| `escopo_termos`, `fn_escopo_item`, `fn_escopo_pca` | itens por `nivel` e `familia` em `escopo_item_calc` |
| `catmat_pdm_palavras`, `catmat_pdm_exclusoes`, `lg_normalizar`, `lg_regex_ramos`, regra de casamento | casamentos por `codigo_pdm` e `origem` em `licitacao_match` |
| `objeto_categorias` | licitações por `objeto_categoria` em `licitacoes_externas` |
| regra de prioridade (coletor `avaliar`, `reclassificar_escopo_pncp`) | licitações por `prioridade` gravada em `licitacoes_externas` |
| `orgao_tipo_regras`, `orgao_tipo_override`, `orgao_tipos` | órgãos por `tipo_orgao` e `grupo_tipo` em `orgaos` |
| `marca_aliases` | marcas resolvidas por `private.marca_resolver(marca, cnpj)` (migration `20261004002000`) sobre os valores de marca que a mudança afeta |

Se a mudança cabe em mais de uma linha, meça todas.

## 2. Antes (agora, em produção)

Registre a data e a hora da medição. Consultas já testadas:

```sql
-- escopo por item
select nivel, familia, count(*) as itens from public.escopo_item_calc group by 1,2 order by 3 desc;

-- casamento CATMAT por texto (e se está estável: pendentes devem ser poucos)
select codigo_pdm, origem, count(*) from public.licitacao_match group by 1,2 order by 3 desc;
select (select count(*) from public.licitacao_match_pendente) as pendentes,
       (select carregado_em is not null from public.licitacao_match_estado) as carregado;

-- categoria do objeto
select objeto_categoria, count(*) from public.licitacoes_externas group by 1 order by 2 desc;

-- prioridade gravada
select coalesce(prioridade,'(nulo)') as prioridade_gravada, count(*) as licitacoes
from public.licitacoes_externas group by 1 order by 2 desc;

-- tipo de órgão
select tipo_orgao, grupo_tipo, count(*) from public.orgaos group by 1,2 order by 3 desc;
```

- **Prioridade efetiva:** a view `licitacoes_externas_prioridade_efetiva` dá `42501 permission denied for function
  pncp_instante_brt` pelo MCP (verificado em 12/11/2026). Meça a prioridade **gravada** e escreva no PR que a efetiva
  não foi medida e por quê.
- `escopo_item_calc.nivel` nulo é resultado calculado sem casamento, não "ainda não calculado".
- Se `licitacao_match_pendente` não estiver perto de zero, o "antes" ainda vai mexer: anote o número ou espere.

## 3. Depois (o efeito esperado), na ordem de preferência

1. **Branch de preview do PR** (check Supabase Preview), depois que a migration for aplicada nela: o mesmo SELECT do
   passo 2 na branch. O MCP configurado no repositório aponta para produção; o usuário roda na preview.
2. **SQL somente leitura que simula a regra nova sobre as mesmas linhas**, sem gravar (como a spec 0045 fez): por
   exemplo, o padrão novo contra `lg_normalizar(descricao)` de `licitacao_itens`, ou o `case` novo sobre
   `licitacoes_externas`. Diga no PR que é simulação.
3. **Reclassificador do coletor em dry-run** (`python -m coletor.reclassificar_escopo_pncp`, dry-run por padrão;
   `--apply` só com ok do Marcelo). Precisa de `service_role`: quem roda é o usuário. Anexe o relatório
   (`transicoes_prioridade`).

O que não puder ser medido entra como **"não medido"**, com o motivo. Nunca preencha o "depois" por palpite.

## 4. Conferir contra as regras de negócio

O "depois" não pode violar `.claude/rules/regras-negocio.md`. Mostre, no próprio dry-run, a contagem do que não deve
entrar: academia ao ar livre, contrato de serviço (credenciamento, locação, manutenção, obra) e item que só casa por
termo de busca como `forte`. Se algum entrar, é bloqueante. O Termo de Referência manda; divergência com o CATMAT é
achado, não descarte.

## 5. Saída para o PR

Cole no texto do PR, numa seção própria:

```markdown
## Dry-run (contagem antes/depois)
Medido em AAAA-MM-DD HH:MM (BRT), produção, somente leitura. Depois = <preview | simulação SQL | reclassificador | não medido: motivo>.

| <dimensão> | antes | depois | Δ |
|---|---|---|---|
| ... | ... | ... | ... |

Entram (até 10 ids, para conferência): ...
Saem (até 10 ids): ...
Não medido: ...
Fora de escopo que NÃO entrou (ar livre, serviço): ...
```

## 6. Depois do merge

Repita o "antes" em produção (skill `verificar-producao`), compare com o "depois" prometido e anote a diferença no PR.
Se a regra de casamento mudou, confirme `licitacao_match_pendente` voltando a zero.
