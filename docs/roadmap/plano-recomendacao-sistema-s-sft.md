# Plano em 4 passos: recomendação, Sistema S, SFT e editais

Revisado em 01/10/2026 contra o código. Substitui o rascunho `README.md.txt` (worker de recomendação).

## Regras transversais

- **Rótulo sem revisão humana não vai para o banco.** O pré-rótulo do Gemini fica só no CSV de revisão. Em
  `licitacao_itens.categoria_escopo` entram apenas: regras (estado atual), rótulo revisado, ou predição do modelo SFT
  já aceito (`escopo_metodo = 'llm_sft'` + `escopo_confianca`).
- Rótulos de escopo (fonte da verdade: `training/comum.py` no repo `P-s-Treinamento-LLM`): `forte`, `fraco`, `piso`,
  `borracha`, `obra_piso`, `manutencao`, `fora`.
- `licitacao_itens` e `licitacao_resultados` só são legíveis por `service_role`. Nada de leitura direta do navegador.

## Estado dos dados (30/09/2026)

- 1.976 itens em 44 licitações; 305 resultados de 69 fornecedores.
- `vencedor = false` em todos os resultados: hoje só dá para treinar com **participação**, não com vitória.
- `categoria_escopo` nulo em ~84% dos itens (322 com categoria, todas vindas das regras).
- Nenhuma licitação com `data_fim` futura: `apenasAbertas: true` retorna vazio.
- `catalogo_empresa_catmat` vazio (futuro insumo do cold start).

## Passo 1: worker de recomendação (TF.js)

Recomenda licitações para fornecedores. Adaptação do `modelTrainingWorker.js` do curso:

| E-commerce (curso) | LicitaGym |
|---|---|
| usuário | fornecedor (CNPJ) |
| produto | item de licitação (`licitacao_itens`) |
| compra | participação no item (`licitacao_resultados`) |

- **Features do item:** `categoria_escopo` (one-hot), `uf`, modalidade agrupada, valor unitário (log, normalizado) e
  descrição (bag-of-words com hashing, 64 dimensões), com um peso por bloco.
- **Vetor do fornecedor:** média dos itens em que participou. Sem histórico (cold start), sai de
  `perfil: { categorias, ufs, palavras }`.
- **Treino:** pares `[fornecedor | item]`, label 1 = participou, 0 = amostra de itens em que não participou
  (3 negativos por positivo). Rede densa 128 → 64 → sigmoide.
- **Recomendação:** nota por item aberto, agrupada por licitação (nota = melhor item); devolve o top N com os 3 itens
  mais aderentes de cada licitação.

Contrato de mensagens:

```js
const worker = new Worker(new URL('./workers/modelTrainingWorker.js', import.meta.url), { type: 'module' });
worker.postMessage({
  action: workerEvents.trainModel,
  itens,          // [{ licitacao_id, numero_item, descricao, categoria_escopo, valor_unitario_estimado, uf, modalidade, data_fim }]
  participacoes,  // [{ fornecedor_cnpj, licitacao_id, numero_item }]
});
worker.postMessage({
  action: workerEvents.recommend,
  fornecedor: { cnpj: '00000000000100', perfil: { categorias: ['borracha', 'piso'], ufs: ['SC', 'PR'], palavras: ['piso', 'borracha'] } },
  topN: 10,
  apenasAbertas: true,   // data_fim >= agora
});
// eventos: progressUpdate, trainingLog, trainingComplete, recommend, trainingError, recommendError
```

Pendências:

- Edge Function que entrega `itens` e `participacoes` ao navegador **exigindo login** (a tabela de resultados tem
  CNPJs de terceiros) e devolvendo só as colunas acima.
- Testar com dados reais usando `apenasAbertas: false` enquanto não houver licitação aberta.
- Depende do Passo 2 para treinar com vitórias reais em vez de só participação.

## Passo 2: coleta do Sistema S (prioridade)

- **Fonte principal: APIs de dados abertos (TCU).** Sesc `/api/213` e `/216`, CNI `/publico/licitacoes`, Senac
  `/licitacoes/regional/{uf}`, SEST SENAT `/api-tcu`. Cobrem inclusive portais Paradigma que proíbem robôs.
- Exige ampliar o check de `fontes_externas.plataforma` (ex.: `api_dados_abertos`).
- **Ganho:** Sesc (licitantes com valores + vencedor) e CNI (`itensLotes.participantes`) trazem propostas e vencedores
  reais, que viram rótulos de vitória para o Passo 1.
- Portais só para os DRs de SESI/SENAI sem dados na API da CNI. Autorizações obrigatórias: Sistema FIEP (PR) e FIEA
  (AL). Decisão de 05/10/2026: `robots.txt` que bloqueia o portal não impede a coleta. WAF e desafio
  Cloudflare (403) continuam fora.
- O conector é Python (`services/coletor-externo/coletor/paradigma.py`); não há Edge Function de coleta do Sistema S.
  As Edge Functions só usam a lista de hosts Paradigma para validar links de edital (`_shared/edital-url.ts`).
- **Regulamento próprio:** o Sistema S não segue a Lei 14.133, então `tarefas_catalogo`/`processo_fases` precisam de
  uma variante por regulamento. Preencher `entidade` e `regulamento`, hoje nulos.
- Fontes em paradigmabs.com.br com `robots.txt` recusando o coletor entram pela coleta do webservice do mural.
  O modo `aviso_fornecedor` deixa de ser a trava dessas fontes.

## Passo 3: classificador de escopo via SFT (Tunix)

Pipeline na `main` do repo `P-s-Treinamento-LLM` (`training/`).

1. **Coletar** (`export_dataset.py coletar`): itens do LicitaGym + objetos do Sesc (API 213). Não precisa esperar o
   Passo 2.
2. **Pré-rotular** (`rotular_gemini.py`, Vertex com `GOOGLE_GENAI_USE_VERTEXAI=true`) → `rotulos_sugeridos.csv`.
   **Não grava no banco.**
3. **Revisão humana** de 1.500 a 2.000 linhas → `rotulos.csv` (gargalo).
4. **Montar** (`export_dataset.py montar`): só linhas revisadas; split 70/15/15 por licitação.
5. **Treinar** (`sft_tunix.ipynb`: Gemma 3 1B-it + LoRA, Colab TPU v5e-1 ou T4).
6. **Avaliar** (`avaliar.py`) contra o baseline `escopo.classificar_texto_item` do coletor. **O aceite usa o macro-F1
   dos itens do LicitaGym** (`id` com prefixo `lg-`): o Sesc entra com o objeto da licitação, não com o item, então é
   útil no treino mas não representa a produção. `avaliar.py` mostra as métricas por origem.
7. **Integrar:** inferência em lote → `categoria_escopo` com `escopo_metodo = 'llm_sft'` e `escopo_confianca`.

Fase 2 (futuro): prever o nó da taxonomia ou o PDM do CATMAT. Com `categoria_escopo` preenchido na maioria dos itens,
o worker do Passo 1 deixa de depender quase só da descrição.

## Passo 4: extração de editais (depois)

SFT ou Gemini estruturado sobre `licitacao_chunks` para extrair prazos, exigências de habilitação e especificações em
JSON, respeitando o isolamento por `nivel_confianca` (ver `docs/seguranca/`).
