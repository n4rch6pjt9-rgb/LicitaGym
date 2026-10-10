# Índice para os agentes de edital, preço e jurídico

Contexto de processo. Não é linha de treino e não entra no banco. Campo que o documento real não tiver fica ausente.

## Ordem em que o órgão monta a compra

1. **DFD**, formalização da demanda. Quantidade, local de entrega, data prevista.
2. **ETP**, estudo técnico preliminar. Por que compra e qual a solução.
3. **Pesquisa de preço.** O que conta como referência: contrato homologado, cotação, média. A faixa numérica só existe depois, no valor unitário gravado.
4. **Termo de referência.** Lugar da especificação: motor, velocidade, peso, garantia, amostra, visita.
5. **Minuta de edital e de contrato.**

O jurídico lê as listas da AGU e as cláusulas da PGE (amostra, garantia, visita, qualificação, consórcio) quando o edital existe. Não entra no score do plano.

## Bem permanente, equipamento de academia

O exemplo das cadeiras (material permanente) vira, para esteira, bicicleta, musculação e piso:

- Quantos aparelhos dessa família o órgão já tem, pelo histórico homologado do mesmo CNPJ e do mesmo PDM.
- A última compra é recente ou o parque é velho, pelo ano da homologação.
- A quantidade no plano repõe ou aumenta, comparada com a quantidade já comprada.
- O valor do item é grande ou pequeno perto da linha de equipamento permanente. O orçamento total do órgão não é o denominador.
- Peça de manutenção não entra na fila de reposição do bem permanente.

## Plano e verba

Ausência de PCA ou de PAAC é `not_observed`, não zero. No Sistema S o PCA da Lei 14.133 não é a regra. O sinal pré-edital localizado é o PAAC do SEST/SENAT. A série de orçamento contra despesa liquidada do SESC só entra quando o conector guardar URL, hash e data de publicação. Até lá a nota de materialidade fica `not_observed`.

Data interna só entra se o documento a trouxer. Data desconhecida não vira 31/12 do ano anterior.

## Onde está o código

| Arquivo | Responsabilidade |
|---|---|
| `supabase/migrations/20261010100100_agente_execucoes.sql` | Tabela `public.agente_execucoes` |
| `supabase/tests/agente_execucoes_check.sql` | Checagem de RLS e ACL |
| `supabase/functions/_shared/agentes/tipos.ts` | Tipos e `REGRA_VERSAO` |
| `supabase/functions/_shared/agentes/achados.ts` | `validarAchado`, `hashContexto`, `normalizarTexto` |
| `supabase/functions/_shared/agentes/edital.ts` | Detecção de exigências e prazo |
| `supabase/functions/_shared/agentes/preco.ts` | Faixa, referência praticada, piso |
| `supabase/functions/_shared/agentes/juridico.ts` | Mapa sinal → dispositivo |
| `supabase/functions/api-agentes/` | API (`index.ts`, `repo.ts`, `validation.ts`) |
| `docs/agentes/politica-uso-ia.md` | Política de uso |
| `tests/supabase/functions/agentes_*_test.ts`, `api_agentes_test.ts` | Testes |
