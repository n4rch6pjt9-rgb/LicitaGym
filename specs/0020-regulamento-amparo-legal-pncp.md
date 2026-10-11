# 0020: Regulamento das compras PNCP a partir do amparo legal oficial

- **Status:** aprovada (Marcelo, 11/10/2026; decisão em "Decisões")
- **Issue:** nenhuma. Pré-requisito da #252 (PR #317, decisão 1 da spec 0019: regulamento nulo bloqueia as tarefas do
  catálogo) e da seção 3 da spec 0018 (decisão 4).
- **Área:** migrations, coletor (`services/coletor-externo/coletor/pncp.py` + script de backfill)
- **Depende do ok do Marcelo:** sim. Migration de produção (amplia uma constraint) e backfill de 1.651 linhas.

## Problema

`licitacoes_externas.regulamento` está nulo em todas as 1.656 linhas: 1.651 do PNCP, 3 do SEST SENAT e 2 da SFIEC
(produção, só leitura, 11/10/2026). Por isso a #252 não cria tarefa nenhuma. O PNCP informa a lei de cada compra no
**detalhe** (`/api/consulta/v1/orgaos/{cnpj}/compras/{ano}/{seq}`, campo `amparoLegal` com `codigo`, `nome` e
`descricao`). Exemplo conferido em 11/10: PE 114655/2025 → `"Lei 14.133/2021, Art. 28, I"`. O coletor já chama esse
detalhe, mas não guarda o `amparoLegal`: o `raw` gravado é o item da busca, e nenhuma linha tem a chave.

A tabela de domínio oficial (`/api/pncp/v1/amparos-legais`, com `normativoBase`) devolveu 504/503 em 11/10. Fica como
conferência futura, não como dependência.

## Desenho

1. **Valor original ao lado do normalizado.** Coluna nova `licitacoes_externas.amparo_legal jsonb`, com `{codigo,
   nome, descricao}` exatamente como o PNCP devolve.
2. **Regra no banco, uma só.** A função `public.regulamento_do_amparo(nome text)` lê o número da lei no nome oficial:
   - `14.981` → `LEI_14981`;
   - `13.303` → `LEI_13303`;
   - `14.133` → `LEI_14133`;
   - outro nome (MP, decreto, outra lei) → `OUTRO`;
   - nome vazio → nulo.

   A ordem importa: 14.981 e 13.303 vêm antes de 14.133, porque o nome pode citar mais de uma lei. Um gatilho em
   `licitacoes_externas` (`before insert or update of amparo_legal`) grava `regulamento` quando `amparo_legal` chega.
   Sem `amparo_legal`, o regulamento não muda; o RCA do Sistema S continua como está.
3. **Constraint.** `licext_regulamento_chk` passa a aceitar `LEI_14981` e `LEI_13303`, além de `RLC`, `RCA`,
   `LEI_14133` e `OUTRO`. É drop e add (destrutivo, só amplia): todos os valores atuais continuam válidos.
4. **Coleta nova.** `identificacao_do_detalhe` passa a devolver `amparo_legal` quando o detalhe traz `amparoLegal.nome`.
   Sem ele, a chave fica fora e não apaga valor gravado, no mesmo padrão do `valor_total`.
5. **Backfill:** `python -m coletor.backfill_regulamento_pncp`, copiado de `backfill_valor_total_pncp.py`.
   - Lê as linhas PNCP com `amparo_legal` nulo, consulta o detalhe e grava **só** `amparo_legal`; o gatilho deriva o
     regulamento.
   - Sem `--apply` não grava nada (dry-run), mas mostra a contagem por regulamento que seria derivado.
   - Falha de consulta não grava nada e é contada.
   - `DELAY_SEGUNDOS >= 1` e o cliente PNCP do coletor (backoff, `Retry-After`).
   - **Rodar em produção é do Marcelo** (ou com o ok dele), depois do merge.

## Critérios de aceite

| ID | Dado / Quando / Então | Teste que prova |
|---|---|---|
| CA-1 | **Dado** os nomes "Lei 14.133/2021, Art. 28, I", "Lei 14.981/2024, Art. 2º", "Lei 13.303/2016, Art. 29, II", "MP 1.221/2024, Art. 2º" e vazio, **quando** `regulamento_do_amparo` roda, **então** devolve `LEI_14133`, `LEI_14981`, `LEI_13303`, `OUTRO` e nulo. | SQL `supabase/tests/regulamento_amparo_check.sql` |
| CA-2 | **Dado** uma linha com `regulamento = 'RCA'` e `amparo_legal` nulo, **quando** outra coluna é atualizada, **então** continua `RCA`; **dado** `amparo_legal` gravado, **então** `regulamento` é derivado dele. | SQL `regulamento_amparo_check.sql` |
| CA-3 | **Dado** a constraint ampliada, **então** `LEI_14981` e `LEI_13303` são aceitos e um valor fora da lista é recusado. | SQL `regulamento_amparo_check.sql` |
| CA-4 | **Dado** um detalhe com `amparoLegal`, **quando** `identificacao_do_detalhe` roda, **então** devolve `amparo_legal` com `codigo`, `nome` e `descricao`; sem `amparoLegal` (ou sem `nome`), a chave não aparece. | pytest `services/coletor-externo/tests/test_pncp_regulamento.py` |
| CA-5 | **Dado** o backfill sem `--apply`, **então** nada é gravado e o resumo traz a contagem por regulamento; com `--apply`, grava só `amparo_legal`; consulta que falha não grava e entra em `falha_consulta`. | pytest `test_pncp_regulamento.py` |
| CA-6 | **Dado** os mesmos nomes do CA-1, **então** o espelho Python usado no resumo do dry-run (`regulamento_do_amparo`) dá o mesmo resultado da função SQL. | pytest `test_pncp_regulamento.py` |

## Fora de escopo

- Regulamento do Sistema S (`paradigma.py` já grava RCA na seleção) e de outras fontes.
- Conferir `codigo` contra a tabela de domínio oficial (`normativoBase`): fica para quando o endpoint responder.
- Rodar o backfill em produção (é do Marcelo, depois do merge).

## Impacto em dados

- **Migration:** sim, `supabase/migrations/20261011110100_regulamento_amparo_legal.sql`:
  - coluna nova (aditiva);
  - função `immutable` e gatilho;
  - `licext_regulamento_chk` refeita (drop/add que só amplia a lista; valores atuais: todos nulos).
- **Tabelas/funções tocadas:**
  - `licitacoes_externas` (`amparo_legal`, gatilho, constraint);
  - quem escreve: o coletor PNCP e o script de backfill;
  - quem lê `regulamento`: `tarefas_equipe_liberar` (#317) e a spec 0018.
- **ACL/RLS:** função nova com `revoke` de PUBLIC, `anon` e `authenticated`, e `grant` só para `service_role`; o
  gatilho roda com o dono da tabela. A coluna nova herda a ACL de `licitacoes_externas`.
- **Backfill:** sim, pelo script, em dry-run primeiro. A contagem por regulamento (antes e depois) vai no PR quando
  rodar.
- **Edge Functions republicadas no merge:** todas (sem mudança em função).
- **Contrato com o Dashboard:** inalterado.
- **Dado oficial × derivado:**
  - `amparo_legal` é oficial (PNCP);
  - `regulamento` é derivado dele por regra escrita;
  - sem `amparo_legal`, nada é presumido.

## Decisões

Do Marcelo, 11/10/2026:
1. **Amparo por MP fica `OUTRO`** (ex.: MP 1.221/2024, convertida na Lei 14.981). Sem catálogo, a tarefa do catálogo
   não nasce.

## Perguntas em aberto

Nenhuma.
