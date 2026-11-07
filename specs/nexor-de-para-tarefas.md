# De-para LG-T (planilha `specs/nexor_spec.xlsx`, aba Tarefas_Default) × `tarefas_catalogo` (84 modelos)

**Aprovado pelo Marcelo em 07/11/2026** (7 iguais, 8 parciais, 18 novos; LG-T34 fundida na LG-T09 e reservada).
Montado comparando os títulos e os critérios de conclusão; os modelos do banco foram lidos por consulta somente
leitura.

Legenda: **igual** = mesma tarefa; **parcial** = o modelo do banco cobre parte (o LG-T é mais amplo ou mais estreito);
**novo** = nenhum modelo cobre, vira modelo NX novo.

| LG-T | Título na planilha | Modelo do banco | Casamento |
|---|---|---|---|
| T01 | Identificar regime jurídico e normas citadas | — | novo |
| T02 | Registrar edital, anexos e versão | 14133-F01-T01 Registrar edital e anexos | igual |
| T03 | Extrair calendário do certame | — (F01-T02 só confere o prazo mínimo) | novo |
| T04 | Conferir plataforma e credenciamento | — | novo |
| T05 | Calcular prazo de impugnação e decidir se impugna | 14133-F01-T04 Impugnar o edital | **igual (confirmado)** |
| T06 | Checar condições de participação e impedimentos | — | novo |
| T07 | Extrair itens, lotes e especificações do TR | — | novo |
| T08 | Consultar cadastros de sanções | — (F11-T06 monitora o registro da própria empresa) | novo |
| T09 | Montar checklist de habilitação com validade | F04-T01 a F04-T04 | parcial |
| T10 | Decidir participação (go/no-go) | — | novo |
| T11 | Formar preço por item ou lote | F01-T10 Montar e cadastrar a proposta | parcial |
| T12 | Levantar custos de execução | — | novo |
| T13 | Preencher proposta no modelo do edital | F01-T10 Montar e cadastrar a proposta | igual |
| T14 | Emitir declarações exigidas | F01-T09 Preparar declarações obrigatórias | igual |
| T15 | Preparar amostras e catálogos | — | novo |
| T16 | Enviar proposta readequada e habilitação | F04-T01 Enviar documentos de habilitação | parcial |
| T17 | Exercer desempate ME/EPP | F02-T04 Exercer preferência de ME/EPP | igual |
| T18 | Avaliar intenção de recurso e razões | F05-T01 + F05-T02 | igual (dois modelos) |
| T19 | Registrar preços vencedores e motivo da perda | F06-T04 Registrar resultado homologado | parcial (motivo da perda é novo) |
| T20 | Assinar Ata de Registro de Preços | F07-T01 Assinar o contrato | parcial (ARP × contrato) |
| T21 | Montar matriz de sanções e multas | F11-T01 Prevenir infrações (checklist) | parcial |
| T22 | Planejar execução (OF, entrega, NF) | F08-T01 Executar conforme contrato | parcial |
| T23 | Monitorar habilitação durante a ARP | — | novo |
| T24 | Avaliar adesão (carona) | F12-T02 Avaliar pedido de adesão à ata | igual |
| T25 | Conferir obrigações de LGPD | — | novo |
| T26 | Registrar motivo do descarte | — (hoje é regra do pipeline, não tarefa) | novo |
| T27 | Mapear contatos e canais oficiais | — | novo |
| T28 | Identificar fiscal/gestor da ata | — | novo |
| T29 | Conferir enquadramento CATMAT × TR × valor estimado | — | novo |
| T30 | Conferir viabilidade do prazo de entrega e instalação | — | novo |
| T31 | Verificar garantia e assistência técnica exigidas | — | novo |
| T32 | Projetar fluxo de recebimento e pagamento | F08-T08 + F08-T09 | parcial |
| T33 | Preparar minuta de contrato/ARP | — | novo |
| T34 | Checklist de habilitação com validades | F04-T02 Regularidade fiscal (e sobrepõe o LG-T09) | parcial |

**Resumo:** 7 iguais (T02, T05, T13, T14, T17, T18, T24), 9 parciais (8 depois da fusão da T34 na T09) e 18 novos. Os LG-T usam 18 dos 84
modelos; ficam 66 sem LG-T, a maioria das fases F08 a F11 (execução, alteração, extinção, sanções).

## Parciais lado a lado (proposta aprovada em 07/11/2026)

Com a LG-T34 fundida na LG-T09 (decisão de 07/11), sobram **8 parciais**. A LG-T34 fica reservada, sem modelo NX.
"Planilha" vem da aba Tarefas_Default; "Banco" vem de `tarefas_catalogo` (consulta de 07/11).

| LG-T | Planilha (etapa · responsável · prazo · critério) | Banco (modelo · prazo · condição · saída) | Diferença | Proposta |
|---|---|---|---|---|
| T09 (+T34) | Habilitação · operação · 48 h · "Todos os documentos válidos na data da abertura" | F04-T01 Enviar habilitação (vencedor) · F04-T02 Regularidade fiscal · F04-T03 Atestados · F04-T04 Econômico-financeira; todos `definido_no_edital`, condição `posicao = vencedor` | Planilha prepara e confere validade **antes** da sessão para todos; banco é o **envio** depois do julgamento, só pelo vencedor | NX nova para o checklist; F04-T01 a T04 ficam como estão (sem apelido) |
| T11 | Proposta de preços · agente:precos · 48 h · planilha por item com custo, margem e referência | F01-T10 Montar e cadastrar a proposta · `definido_no_edital` · "Proposta cadastrada" | Banco junta preço e cadastro na plataforma; planilha separa preço (T11) do preenchimento (T13) | NX nova para T11; F01-T10 fica apelido só da T13 |
| T16 | Aceitação e habilitação · operação · após convocação · envio no prazo | F04-T01 Enviar documentos de habilitação (vencedor) | Planilha inclui a proposta readequada; banco só a habilitação | apelido F04-T01, com a readequação como item a mais do critério |
| T19 | Perdida · agente:precos · 48 h · preço vencedor **e motivo da perda** | F06-T04 Registrar resultado homologado · sem prazo legal | Banco não tem motivo da perda nem gatilho "Perdida" | apelido F06-T04 + campo "motivo da perda" |
| T20 | Ata e execução · admin · 5 du após convocação · ARP assinada | F07-T01 Assinar o contrato · vencedor | ARP (art. 90) × contrato (art. 89); prazo e instrumento diferentes | NX nova para ARP; F07-T01 fica para contrato |
| T21 | Ata e execução · agente:juridico · 48 h · hipóteses, percentuais e prazos tabelados | F11-T01 Prevenir infrações (checklist) · sem prazo legal | Banco é checklist genérico de infrações; planilha extrai multas e percentuais do edital | NX nova (extração); F11-T01 continua |
| T22 | Ata e execução · operação · 48 h · cronograma por OF com entrega e faturamento | F08-T01 Executar conforme contrato · "Entregas no cronograma" | Banco é a execução em si; planilha é o planejamento antes da primeira OF | apelido F08-T01 |
| T32 | Proposta de preços · agente:precos · 24 h · prazos de recebimento, liquidação e pagamento | F08-T08 Recebimento + F08-T09 Faturar e acompanhar pagamento (execução) | Planilha **projeta** antes da proposta (caixa); banco **acompanha** na execução | NX nova (projeção); F08-T08/T09 ficam |

**Resultado aprovado:** 3 apelidos (T16, T19, T22) e 5 NX novas (T09, T11, T20, T21, T32). Total NX novas: 18 + 5 = 23.
Os apelidos vão para `tarefas_catalogo_apelidos` (decisão 2 de `specs/nexor-fase0-mapa.md`).

## Achados na planilha (resolvidos em 07/11/2026)
- **LG-T09 × LG-T34:** os dois eram checklist de habilitação com validade. LG-T34 descontinuada e fundida na LG-T09;
  as referências em Documentacao_Edital (I24:I27) e Proposta_Nexor (M75) apontam para LG-T09.
- **LG-T21 e LG-T25:** a coluna `ref_SESC_126135` tinha virado data por conversão do Excel. Corrigidas para
  "29 (sanções)" e "32 (LGPD)".
