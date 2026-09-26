# Catálogo de tarefas do fornecedor — Lei 14.133/2021 (v1)

**Data:** 27/09/2026 · **Status:** proposta para review (PR) · **Escopo:** perspectiva do licitante/contratado, do edital ao fim do contrato.

O catálogo lista, fase a fase, **tudo o que a lei permite ou exige do fornecedor**, com o evento que abre a janela, o prazo legal, a condição de aplicabilidade e o artigo que fundamenta. A rota "Tarefas da equipe" consulta o catálogo e mostra só as tarefas liberadas naquele momento do certame. Nada é decidido por IA em tempo de execução: a regra está no banco.

| Número | Valor |
| --- | --- |
| Tarefas | 84 (7 são subtarefas) |
| Fases | 10 sequenciais + 2 transversais |
| Eventos (gatilhos) | 44 |
| Transições de fase | 19 |
| Artigos com texto armazenado | 62 |

## 1. Arquivos do PR

| Arquivo | O que é |
| --- | --- |
| `data/catalogo_tarefas_14133.yaml` | **Fonte de verdade.** Fases, eventos, transições e tarefas, editáveis por humano. |
| `data/lei14133_textos/*.md` | Texto dos 62 artigos citados, com URL de origem. |
| `scripts/gerar_seed_catalogo_tarefas.py` | Valida o YAML e gera o seed SQL. Falha alto: artigo sem texto, evento inexistente ou prazo incoerente abortam. |
| `supabase/migrations/20260927100000_catalogo_tarefas_licitacao.sql` | Schema, funções e RLS. |
| `supabase/migrations/20260927100100_seed_catalogo_tarefas_14133.sql` | Seed **gerado** (não editar à mão). Idempotente. |
| `tests/supabase/catalogo_tarefas_test.sql` | 9 asserções de regra (base legal, prazos-chave, inversão de fases, herança de condição). |

## 2. Modelo de dados

```
norma_dispositivos (norma, artigo) ──┐
                                     │ N:N
processo_fases ──< tarefas_catalogo >── tarefas_catalogo_base_legal
      │                 │  └─ parent_codigo (árvore)
      │                 └──< tarefas_catalogo_dependencias (requer | alternativa_a)
      └──< processo_fase_transicoes >── processo_eventos
                                               │
               evento_abertura / prazo_evento ─┘
```

**Colunas-chave de `tarefas_catalogo`:**

| Coluna | Para quê |
| --- | --- |
| `codigo` | `14133-Fxx-Tyy`, estável. Tarefa removida do YAML fica `ativo=false`, o código nunca é reaproveitado. |
| `fase_codigo`, `parent_codigo`, `ordem` | Posição na árvore. |
| `natureza` | `obrigacao` (omissão gera consequência), `faculdade`, `direito`, `acompanhamento`, `preparacao`. |
| `evento_abertura` | Evento que libera a tarefa ("quando é permitida"). |
| `prazo_quantidade` + `prazo_unidade` + `prazo_sentido` + `prazo_evento` | Prazo legal, ex.: 3 · dias_uteis · antes_de · DATA_ABERTURA. `definido_no_edital` quando a lei delega; `sem_prazo_legal` quando não há. |
| `condicao` | Quando a tarefa se aplica (ver §3). |
| `consequencia_omissao` | Preclusão, desclassificação, sanção. |
| `efeito_suspensivo` | Recurso/reconsideração suspende o ato (art. 168). |
| `versao` | Sobe sozinha quando descrição, prazo ou condição mudam no seed. |

## 3. Regra de condição (determinística)

`condicao` é um objeto `{chave: valor | [valores]}` comparado com o **contexto do certame**:

- valor igual (ou dentro da lista) → `true`;
- valor diferente → `false` (tarefa some);
- **chave ausente no contexto → `null` = "condição não verificada"**. A tarefa continua visível e marcada. Ausência nunca vira "não se aplica" (golden rule).

**Chaves de contexto v1:** `inversao_fases`, `objeto` (bens | servicos | obra_engenharia), `modo_disputa`, `srp`, `garantia_proposta`, `garantia_contratual`, `vistoria_prevista`, `intervalo_minimo_lances`, `posicao` (vencedor | remanescente), `servico_continuo`, `mao_de_obra_exclusiva`, `me_epp`, `estrangeira`, `empate`, `diferenca_5pct_segundo`, `proposta_abaixo_85pct`.

Uma filha sempre contém a condição da mãe (teste 3), então nunca aparece uma subtarefa de algo que não se aplica.

## 4. Como a rota usa

```sql
-- tarefas de uma fase para o contexto do certame
select * from public.catalogo_tarefas_da_fase('F07', '{"posicao":"remanescente","garantia_contratual":true}');

-- o que um evento libera (ex.: saiu o resultado da habilitação)
select * from public.catalogo_tarefas_do_evento('ATA_HABILITACAO', '{"inversao_fases":false}');
-- -> 14133-F05-T01 Manifestar intenção de recorrer (imediato)
--    14133-F05-T03 Pedir vista dos autos
```

**Inversão de fases (art. 17 § 1º):** as transições mudam (F01 → F04 → F02 → F03 → F05) e a intenção de recurso passa a abrir no resultado do julgamento (F05-T06/T07), não na ata de habilitação.

## 5. Decisões e limites do v1

- **Perspectiva do fornecedor.** Atos do órgão entram como eventos (gatilhos), não como tarefas.
- **Recursos antes da homologação.** A fase recursal (art. 165) vem antes da homologação (art. 71). Depois dela, as tarefas são de anulação/revogação (F06-T02/T03), remanescentes (F07-T04, F10-T08) e ata SRP (F12).
- **Dias úteis sem calendário.** O catálogo guarda a regra ("3 dias úteis antes da abertura"); o cálculo da data exige calendário de feriados do ente do órgão. Enquanto não existir, a data deve aparecer como **"prazo não calculado"**, nunca como data estimada.
- **LC 123/2006** só referenciada (F02-T04). Decretos, INs e regulamentos do Sistema S ficam para trilhas próprias.
- **Não é parecer jurídico.** Orienta a operação; casos concretos pedem advogado.

## 6. Pendências antes do merge

- [ ] **Conferir os textos com o Planalto.** Planalto, TCE-SP e normas.leg.br não abriram pela ferramenta de coleta; os textos vieram de LegJur, lei14133atualizada.com.br, contas.cnt.br e blogs jurídicos. Todos os artigos estão com `conferido_oficial = false`.
- [ ] Atenção especial: **art. 115** (trechos completados sem confirmação), **art. 165** ("lavratura"), **art. 90 §§ 8º e 9º**, **art. 96 § 1º IV** e **art. 105 parágrafo único** (incluídos por lei posterior).
- [ ] Revisão jurídica dos prazos e condições das 84 tarefas (tabela abaixo).
- [ ] Próximo PR: tabela de instâncias `tarefas_equipe` (certame, tarefa, responsável, prazo calculado, status) e contexto por certame.

## 7. Como atualizar

1. Editar `data/catalogo_tarefas_14133.yaml` (nunca o seed).
2. `python scripts/gerar_seed_catalogo_tarefas.py --check` e depois sem `--check`.
3. Rodar as migrations e `tests/supabase/catalogo_tarefas_test.sql` num banco local.
4. PR com review do Copilot.

## 8. Árvore completa

### F01 — Divulgação do edital (11)

| Código | Tarefa | Natureza | Abre com | Prazo | Condição | Base legal |
| --- | --- | --- | --- | --- | --- | --- |
| 14133-F01-T01 | Registrar edital e anexos | acompanhamento | Edital publicado | sem prazo legal | — | art. 54, caput; art. 54, § 1º |
| 14133-F01-T02 | Conferir prazo mínimo de propostas | acompanhamento | Edital publicado | sem prazo legal | — | art. 55, caput, I a IV |
| 14133-F01-T03 | Pedir esclarecimento | faculdade | Edital publicado | 3 dias úteis antes de: Data de abertura do certame | — | art. 164, caput |
| 14133-F01-T04 | Impugnar o edital | faculdade | Edital publicado | 3 dias úteis antes de: Data de abertura do certame | — | art. 55, caput; art. 67, §§ 1º e 2º; art. 164, caput |
| 14133-F01-T05 | Acompanhar resposta a esclarecimento/impugnação | acompanhamento | Resposta a esclarecimento ou impugnação | sem prazo legal | — | art. 164, parágrafo único |
| 14133-F01-T06 | Verificar reabertura de prazo após alteração do edital | direito | Edital alterado | sem prazo legal | — | art. 55, § 1º |
| 14133-F01-T07 | Agendar vistoria ou preparar declaração substitutiva | faculdade | Edital publicado | edital/convocação | vistoria_prevista=true | art. 63, § 2º; art. 63, § 3º; art. 63, § 4º |
| 14133-F01-T08 | Providenciar garantia de proposta | obrigacao | Edital publicado | edital/convocação | garantia_proposta=true | art. 58, caput e § 1º; art. 58, § 4º; art. 96, § 1º |
| 14133-F01-T09 | Preparar declarações obrigatórias | obrigacao | Edital publicado | edital/convocação | — | art. 63, I; art. 63, IV; art. 63, § 1º |
| 14133-F01-T10 | Montar e cadastrar a proposta | obrigacao | Edital publicado | edital/convocação | — | art. 17, § 2º; art. 59, II |
| 14133-F01-T11 | Preparar habilitação antecipada (inversão de fases) | obrigacao | Edital publicado | edital/convocação | inversao_fases=true | art. 17, § 1º; art. 63, II; art. 64, § 2º |

### F02 — Propostas e lances (5)

| Código | Tarefa | Natureza | Abre com | Prazo | Condição | Base legal |
| --- | --- | --- | --- | --- | --- | --- |
| 14133-F02-T01 | Participar da disputa de lances | faculdade | Sessão pública aberta | edital/convocação | — | art. 56, caput, I e II; art. 56, § 1º |
| 14133-F02-T02 | ↳ Respeitar intervalo mínimo entre lances | obrigacao | Sessão pública aberta | edital/convocação | intervalo_minimo_lances=true | art. 56, § 3º; art. 57, caput |
| 14133-F02-T03 | Apresentar nova proposta na disputa final (empate) | faculdade | Empate identificado | imediato | empate=true | art. 60, I; art. 60, § 1º |
| 14133-F02-T04 | Exercer preferência de ME/EPP | direito | Melhor proposta definida | edital/convocação | me_epp=true | art. 60, § 2º |
| 14133-F02-T05 | Disputar demais colocações (reinício da disputa) | faculdade | Melhor proposta definida | edital/convocação | diferenca_5pct_segundo=true | art. 56, § 4º; art. 90, § 2º |

### F03 — Julgamento (5)

| Código | Tarefa | Natureza | Abre com | Prazo | Condição | Base legal |
| --- | --- | --- | --- | --- | --- | --- |
| 14133-F03-T01 | Responder à negociação | faculdade | Convocação para negociação | edital/convocação | — | art. 61, caput; art. 61, § 1º; art. 61, § 2º |
| 14133-F03-T02 | Demonstrar exequibilidade da proposta | obrigacao | Diligência de exequibilidade | edital/convocação | — | art. 59, IV; art. 59, § 2º; art. 59, § 4º |
| 14133-F03-T03 | Reelaborar planilhas (obras e engenharia) | obrigacao | Resultado do julgamento | edital/convocação | objeto=obra_engenharia, posicao=vencedor | art. 56, § 5º |
| 14133-F03-T04 | Prestar garantia adicional (proposta < 85%) | obrigacao | Resultado do julgamento | edital/convocação | objeto=obra_engenharia, proposta_abaixo_85pct=true | art. 59, § 5º |
| 14133-F03-T05 | Analisar a proposta aceita do concorrente | acompanhamento | Resultado do julgamento | imediato | — | art. 59, caput, I a V |

### F04 — Habilitação (5)

| Código | Tarefa | Natureza | Abre com | Prazo | Condição | Base legal |
| --- | --- | --- | --- | --- | --- | --- |
| 14133-F04-T01 | Enviar documentos de habilitação | obrigacao | Convocação para habilitação | edital/convocação | posicao=vencedor | art. 62, caput, I a IV; art. 63, II; art. 155, IV |
| 14133-F04-T02 | ↳ Regularidade fiscal | obrigacao | Convocação para habilitação | edital/convocação | posicao=vencedor | art. 63, III |
| 14133-F04-T03 | ↳ Qualificação técnica (atestados) | obrigacao | Convocação para habilitação | edital/convocação | posicao=vencedor | art. 67, caput; art. 67, § 1º; art. 67, § 2º; art. 67, § 6º |
| 14133-F04-T04 | ↳ Qualificação econômico-financeira | obrigacao | Convocação para habilitação | edital/convocação | posicao=vencedor | art. 69, I e II |
| 14133-F04-T05 | Atender diligência de habilitação | obrigacao | Diligência de habilitação | edital/convocação | — | art. 64, caput, I e II; art. 64, § 1º |

### F05 — Recursal (7)

| Código | Tarefa | Natureza | Abre com | Prazo | Condição | Base legal |
| --- | --- | --- | --- | --- | --- | --- |
| 14133-F05-T01 | Manifestar intenção de recorrer | faculdade | Resultado da habilitação | imediato | inversao_fases=false | art. 165, I, b e c; art. 165, § 1º, I |
| 14133-F05-T02 | Apresentar razões de recurso | faculdade | Intenção de recurso registrada | 3 dias úteis após: Resultado da habilitação | inversao_fases=false | art. 165, I; art. 165, § 1º, I; art. 165, § 2º; art. 168, caput |
| 14133-F05-T03 | Pedir vista dos autos | direito | Resultado da habilitação | sem prazo legal | — | art. 165, § 5º |
| 14133-F05-T04 | Apresentar contrarrazões | faculdade | Recurso de outro licitante divulgado | 3 dias úteis após: Recurso de outro licitante divulgado | — | art. 165, § 4º |
| 14133-F05-T05 | Acompanhar decisão do recurso | acompanhamento | Decisão do recurso | sem prazo legal | — | art. 165, § 2º; art. 165, § 3º |
| 14133-F05-T06 | Manifestar intenção de recorrer (inversão de fases) | faculdade | Resultado do julgamento | imediato | inversao_fases=true | art. 17, § 1º; art. 165, § 1º, I |
| 14133-F05-T07 | Apresentar razões de recurso (inversão de fases) | faculdade | Intenção de recurso registrada | 3 dias úteis após: Resultado do julgamento | inversao_fases=true | art. 165, I; art. 165, § 1º, I; art. 168, caput |

### F06 — Homologação (4)

| Código | Tarefa | Natureza | Abre com | Prazo | Condição | Base legal |
| --- | --- | --- | --- | --- | --- | --- |
| 14133-F06-T01 | Acompanhar decisão da autoridade superior | acompanhamento | Processo na autoridade superior | sem prazo legal | — | art. 71, caput, I a IV |
| 14133-F06-T02 | Manifestar-se antes de anulação ou revogação | direito | Aviso de anulação ou revogação | edital/convocação | — | art. 71, § 1º; art. 71, § 2º; art. 71, § 3º |
| 14133-F06-T03 | Recorrer da anulação ou revogação | faculdade | Licitação anulada ou revogada | 3 dias úteis após: Licitação anulada ou revogada | — | art. 165, I, d; art. 168, caput |
| 14133-F06-T04 | Registrar resultado homologado (preço e vencedor) | acompanhamento | Adjudicação e homologação | sem prazo legal | — | art. 54, § 3º; art. 71, IV |

### F07 — Contratação (8)

| Código | Tarefa | Natureza | Abre com | Prazo | Condição | Base legal |
| --- | --- | --- | --- | --- | --- | --- |
| 14133-F07-T01 | Assinar o contrato | obrigacao | Convocação para assinar o contrato | edital/convocação | posicao=vencedor | art. 90, caput; art. 90, § 5º; art. 155, VI |
| 14133-F07-T02 | ↳ Pedir prorrogação do prazo de assinatura | faculdade | Convocação para assinar o contrato | edital/convocação | posicao=vencedor | art. 90, § 1º |
| 14133-F07-T03 | Prestar garantia contratual | obrigacao | Adjudicação e homologação | edital/convocação | garantia_contratual=true | art. 96, § 1º; art. 96, § 3º; art. 97, I; art. 98, caput e parágrafo único |
| 14133-F07-T04 | Responder convocação como remanescente | faculdade | Convocação de remanescente | edital/convocação | posicao=remanescente | art. 90, § 2º; art. 90, § 4º; art. 90, § 6º |
| 14133-F07-T05 | Controlar validade da proposta | acompanhamento | Adjudicação e homologação | edital/convocação | — | art. 90, § 3º; art. 155, V |
| 14133-F07-T06 | Pedir devolução da garantia de proposta | direito | Contrato assinado | 10 dias úteis após: Contrato assinado | garantia_proposta=true | art. 58, § 2º |
| 14133-F07-T07 | Confirmar publicação do contrato no PNCP | acompanhamento | Contrato assinado | 20 dias úteis após: Contrato assinado | — | art. 94, caput e I |
| 14133-F07-T08 | Registro em entidade profissional (empresa estrangeira) | obrigacao | Convocação para assinar o contrato | edital/convocação | estrangeira=true | art. 67, § 7º |

### F08 — Execução (12)

| Código | Tarefa | Natureza | Abre com | Prazo | Condição | Base legal |
| --- | --- | --- | --- | --- | --- | --- |
| 14133-F08-T01 | Executar conforme contrato | obrigacao | Início da execução | edital/convocação | — | art. 115, caput; art. 155, I, II, III e VII |
| 14133-F08-T02 | Atender determinações do fiscal | obrigacao | Notificação do fiscal | edital/convocação | — | art. 117, § 1º; art. 137, II |
| 14133-F08-T03 | Corrigir vícios às próprias custas | obrigacao | Notificação do fiscal | edital/convocação | — | art. 119, caput; art. 120, caput |
| 14133-F08-T04 | Manter encargos em dia | obrigacao | Início da execução | sem prazo legal | — | art. 121, caput e § 1º |
| 14133-F08-T05 | ↳ Comprovar quitação trabalhista (mão de obra exclusiva) | obrigacao | Início da execução | edital/convocação | mao_de_obra_exclusiva=true | art. 121, § 3º |
| 14133-F08-T06 | Protocolar requerimento e cobrar decisão | direito | Requerimento protocolado | 1 mês(es) após: Requerimento protocolado | — | art. 123, caput; art. 123, parágrafo único |
| 14133-F08-T07 | Registrar suspensão e prorrogar cronograma | direito | Suspensão ou paralisação | sem prazo legal | — | art. 96, § 2º; art. 115, § 5º; art. 137, § 2º, II e III |
| 14133-F08-T08 | Acompanhar recebimento provisório e definitivo | acompanhamento | Entrega ou conclusão | edital/convocação | — | art. 140, I e II; art. 140, § 1º; art. 140, § 4º |
| 14133-F08-T09 | Faturar e acompanhar pagamento | direito | Nota fiscal emitida | edital/convocação | — | art. 137, § 2º, IV; art. 141, caput; art. 141, § 3º; art. 143, caput |
| 14133-F08-T10 | Manter apólice de seguro-garantia vigente | obrigacao | Início da execução | sem prazo legal | garantia_contratual=true | art. 97, I; art. 97, parágrafo único |
| 14133-F08-T11 | Substituir profissional indicado (com aprovação) | faculdade | Início da execução | sem prazo legal | — | art. 67, § 6º |
| 14133-F08-T12 | Garantia de solidez da obra (5 anos) | obrigacao | Recebimento definitivo | 5 ano(s) após: Recebimento definitivo | objeto=obra_engenharia | art. 140, § 6º |

### F09 — Alteração e equilíbrio (9)

| Código | Tarefa | Natureza | Abre com | Prazo | Condição | Base legal |
| --- | --- | --- | --- | --- | --- | --- |
| 14133-F09-T01 | Avaliar alteração unilateral (limite 25%/50%) | obrigacao | Alteração unilateral | edital/convocação | — | art. 124, I; art. 125, caput; art. 137, § 2º, I |
| 14133-F09-T02 | ↳ Exigir reequilíbrio no mesmo aditivo | direito | Alteração unilateral | edital/convocação | — | art. 130, caput |
| 14133-F09-T03 | Pedir reequilíbrio econômico-financeiro | direito | Fato superveniente | edital/convocação | — | art. 92, XI; art. 124, II, d; art. 131, parágrafo único |
| 14133-F09-T04 | Pedir reajuste pelo índice contratual | direito | Aniversário da data-base | edital/convocação | — | art. 92, V; art. 92, § 3º |
| 14133-F09-T05 | Pedir repactuação (serviços com mão de obra) | direito | Aniversário da data-base | 1 ano(s) após: Aniversário da data-base | servico_continuo=true, mao_de_obra_exclusiva=true | art. 92, X; art. 135, caput; art. 135, § 3º |
| 14133-F09-T06 | Pedir revisão por mudança de tributo ou encargo legal | direito | Fato superveniente | sem prazo legal | — | art. 134, caput |
| 14133-F09-T07 | Decidir e negociar prorrogação | faculdade | Vigência perto do fim | edital/convocação | servico_continuo=true | art. 107, caput; art. 131, parágrafo único |
| 14133-F09-T08 | Propor alteração consensual | faculdade | Início da execução | sem prazo legal | — | art. 124, II, a, b e c |
| 14133-F09-T09 | Pedir indenização por desequilíbrio após extinção | direito | Contrato extinto | sem prazo legal | — | art. 131, caput |

### F10 — Extinção do contrato (8)

| Código | Tarefa | Natureza | Abre com | Prazo | Condição | Base legal |
| --- | --- | --- | --- | --- | --- | --- |
| 14133-F10-T01 | Pedir extinção do contrato (direito do contratado) | direito | Hipótese de extinção a favor do contratado | sem prazo legal | — | art. 137, § 2º, I a V; art. 137, § 3º, I |
| 14133-F10-T02 | Optar pela suspensão do cumprimento | direito | Hipótese de extinção a favor do contratado | sem prazo legal | — | art. 137, § 3º, II |
| 14133-F10-T03 | Defender-se na extinção unilateral | direito | Extinção unilateral intimada | edital/convocação | — | art. 137, caput; art. 138, I e § 1º |
| 14133-F10-T04 | Recorrer da extinção unilateral | faculdade | Extinção unilateral intimada | 3 dias úteis após: Extinção unilateral intimada | — | art. 165, I, e; art. 168, caput |
| 14133-F10-T05 | Cobrar ressarcimento (culpa da Administração) | direito | Contrato extinto | sem prazo legal | — | art. 138, § 2º |
| 14133-F10-T06 | Pedir liberação da garantia contratual | direito | Contrato extinto | sem prazo legal | garantia_contratual=true | art. 100, caput |
| 14133-F10-T07 | Propor extinção consensual ou mediação | faculdade | Início da execução | sem prazo legal | — | art. 138, II |
| 14133-F10-T08 | Responder convocação para remanescente de contrato rescindido | faculdade | Convocação de remanescente | edital/convocação | posicao=remanescente | art. 90, § 7º |

### F11 — Processo sancionatório (7)

| Código | Tarefa | Natureza | Abre com | Prazo | Condição | Base legal |
| --- | --- | --- | --- | --- | --- | --- |
| 14133-F11-T01 | Prevenir infrações (checklist) | preparacao | — | sem prazo legal | — | art. 155, I a XII |
| 14133-F11-T02 | Apresentar defesa em processo de multa | direito | Intimação para defesa em multa | 15 dias úteis após: Intimação para defesa em multa | — | art. 156, § 1º; art. 156, § 3º; art. 157, caput |
| 14133-F11-T03 | Defesa em processo de responsabilização | direito | Processo de responsabilização instaurado | 15 dias úteis após: Processo de responsabilização instaurado | — | art. 156, §§ 4º e 5º; art. 158, caput |
| 14133-F11-T04 | Recorrer de advertência, multa ou impedimento | faculdade | Sanção aplicada | 15 dias úteis após: Sanção aplicada | — | art. 166, caput; art. 166, parágrafo único; art. 168, caput |
| 14133-F11-T05 | Pedir reconsideração da inidoneidade | faculdade | Sanção aplicada | 15 dias úteis após: Sanção aplicada | — | art. 167, caput; art. 168, caput |
| 14133-F11-T06 | Monitorar registro no CEIS/CNEP e prescrição | acompanhamento | Sanção aplicada | 15 dias úteis após: Sanção aplicada | — | art. 158, § 4º; art. 161, caput |
| 14133-F11-T07 | Pedir reabilitação | direito | Sanção aplicada | 1 ano(s) após: Sanção aplicada | — | art. 163, caput, I a V; art. 163, parágrafo único |

### F12 — Ata de registro de preços (3)

| Código | Tarefa | Natureza | Abre com | Prazo | Condição | Base legal |
| --- | --- | --- | --- | --- | --- | --- |
| 14133-F12-T01 | Cumprir compromisso de fornecimento da ata | obrigacao | Ata de registro de preços assinada | 1 ano(s) após: Ata de registro de preços assinada | srp=true | art. 83, caput; art. 84, caput |
| 14133-F12-T02 | Avaliar pedido de adesão à ata | faculdade | Pedido de adesão à ata | sem prazo legal | srp=true | art. 86, § 2º, III; art. 86, § 8º; art. 86, §§ 4º e 5º |
| 14133-F12-T03 | Prospectar órgãos para adesão | faculdade | Ata de registro de preços assinada | sem prazo legal | srp=true | art. 86, § 2º, I e II; art. 86, § 3º |
