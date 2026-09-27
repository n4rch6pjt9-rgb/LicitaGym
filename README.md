# Coletores LicitaGym (PNCP + SEST SENAT) → Supabase + RAG

**Versão no git: v15.** A partir desta versão o coletor **não é mais distribuído por ZIP**.
Código canônico: este repositório (`coletor/`, `tests/`, `supabase/migrations/`, `monitor.sh`).

## Cloud Shell / atualização (git pull)

```bash
# primeira vez (Cloud Shell ou máquina local)
git clone https://github.com/n4rch6pjt9-rgb/LicitaGym.git
cd LicitaGym
git checkout main          # após merge do PR v15; ou a branch feat/coletor-pncp-v15
pip install --user -r requirements.txt

# atualizar (substituí o unzip do zip)
cd ~/LicitaGym             # ou o path do clone
git fetch origin
git checkout main
git pull --ff-only origin main
pip install --user -r requirements.txt   # se requirements mudou
```

Monitor do job em andamento:

```bash
bash monitor.sh                  # padrão: processo_edital.log
bash monitor.sh pncp.log         # outro log
```

Testes offline:

```bash
pip install --user -r requirements.txt pytest
python -m pytest tests/test_pncp.py tests/test_processo_edital.py -q
```

### Endpoint de detalhe da compra (v15)

O detalhe da compra no PNCP passou para `/api/consulta/v1/...`. O caminho antigo
`/api/pncp/v1/.../compras/{ano}/{seq}` responde **301 em JSON** (sem Location útil).
Itens, resultados e arquivos **permanecem** em `/api/pncp/v1`.

Ver `PNCP.detalhe_compra` / `PNCP.compra` em `coletor/pncp.py`.

## Regra de identificação (IMPORTANTE)

O número do edital ("Pregão Eletrônico nº 001/2026") **se repete entre órgãos** e não identifica nada.
- Compra no PNCP → `codigo_externo` = número de controle PNCP (`CNPJ-1-sequencial/ano`).
- Certame fora do PNCP → **CNPJ do órgão + número do PROCESSO ADMINISTRATIVO**.
- Um processo administrativo pode ter **várias** compras (ex.: 131 compras num mesmo processo do Exército).

```bash
python3 -m coletor.buscar_processo "00007.20260204/0002-28" --cnpj 07.540.925/0001-74
python3 -m coletor.pncp --corrigir-processos   # corrige compras gravadas até a v12
python3 -m coletor.processo_edital --dry-run    # completa processos curtos ("4") lendo o edital
```

## Coletor PNCP (fonte principal)

Busca nacional no PNCP por frase exata (`TERMOS_PADRAO` em `coletor/pncp.py`), classifica cada compra
pelo objeto **e pelos itens** (`coletor/escopo.py`) e grava compra, itens, **vencedores** e arquivos.

Três modos, em ordem de prioridade comercial:

| Modo | O que pega | Uso |
|---|---|---|
| `leads` (padrão) | homologados nos últimos `--dias` (120), vencedor conhecido | oferecer raspa ao vencedor que ainda vai comprar |
| `monitorar` | recebendo proposta + em julgamento | acompanhar até sair o vencedor |
| `historico` | encerrados antigos | histórico de preço e RAG |

O filtro de `leads` usa a **data de resultado de cada item** (`dataResultado` do PNCP). A paginação
para quando os editais foram publicados há mais de `dias + margem_publicacao` (240) dias.

```bash
# schema: supabase/migrations/20260924100000_pncp_itens_resultados.sql (via supabase db push)
python3 -m coletor.pncp --dry-run --termos "borracha granulada" --tam 20   # teste rápido
python3 -m coletor.pncp                                   # leads: homologados nos últimos 120 dias
python3 -m coletor.pncp --dias 60                         # só os últimos 60 dias
python3 -m coletor.pncp --modo monitorar                  # abertos / em julgamento
python3 -m coletor.pncp --modo historico --paginas 10 --baixar-arquivos
python3 -m coletor.indexador                              # arquivos baixados -> RAG
```

`oportunidades_borracha` lista primeiro os leads, do homologado mais recente para o mais antigo,
com `dias_desde_homologacao`.

Volume observado (24/09/2026, frase exata): grama sintética 3.263 (85 abertas), academia ao ar livre 1.563,
equipamentos de academia 1.023, piso emborrachado 986, campo society 794, borracha granulada 122.
A busca do PNCP também acha termos dentro dos itens — decoração natalina, arbitragem e grama natural são
descartadas pelo classificador.

**Leads de raspa de borracha:** a view `oportunidades_borracha` junta compra, item e vencedor
(ex.: Carapicuíba/SP, 50 t de borracha granulada G3 homologadas a R$ 2.779,46/t para HG Comércio).

---

# Coletor SEST SENAT

Coleta licitações encerradas do portal de compras do SEST SENAT
(`compras.sestsenat.org.br`, plataforma Paradigma) e registra no Supabase:
dados do processo, esclarecimentos/impugnações do fórum, notas da comissão e
**todos os anexos** (edital, propostas, lances, negociação, habilitação,
recursos, contrarrazões e pareceres). Os arquivos vão para o Cloud Storage.

O portal não tem API pública, mas a própria página usa um webservice JSON
interno (`/portal/WebService/Servicos.asmx`). O coletor chama esses mesmos
endpoints — não precisa de navegador headless.

## Escopo (LicitaGym = CATMAT 7830)

Definido a partir da tabela `pca_itens`: 3.331 itens de PCA de 491 planos, ~R$ 146 mi,
**100% na classe CATMAT 7830 — Equipamento para Ginástica e Recreação**. PDMs mais planejados:
condicionamento físico (276), rede esporte (241), haltere (206), tatame (100), apito (71),
aparelho de ginástica (62), brinquedo inflável (53), bicicleta ergométrica (50), mesa de tênis de mesa (40).

`coletor/escopo.py` concentra: classes CATMAT, PDMs prioritários, termos de busca e o
classificador `classificar(objeto, classes_catmat)` → `catmat | forte | fraco | None`.
Também entram:
- **Grama sintética** (classe 7220, PDM 18481) e **piso sintético esportivo** (PDM 10779, só com texto
  esportivo/borracha — o PDM é majoritariamente piso vinílico comum);
- **Borracha granulada** (classe 9320, PDM 9461, item CATMAT 150846) — raspa, granulado, SBR, EPDM;
- **Obras de quadra/campo society/academia ao ar livre com grama sintética ou piso emborrachado**
  (categoria `obra_piso`). A borracha do infill costuma vir na especificação técnica da obra.
- Recreação infantil (parque infantil, playground).

`interesse_borracha(objeto)` marca as licitações onde o vencedor vai precisar de raspa/granulado.
Obras sem grama/piso (ex.: cobertura de quadra), serviços de evento, uniformes e troféus ficam fora.
O coletor usa `--escopo fitness` por padrão (`--escopo tudo` desliga o filtro).

## 1. Criar as tabelas (uma vez)

O schema vem de `supabase/migrations/20260923100000_licitacoes_externas.sql` (aplicado por `supabase db push`;
em produção já existe e está registrado via `supabase migration repair`). Cria:

| Tabela | Conteúdo |
|---|---|
| `licitacoes_externas` | 1 linha por processo (+ `esclarecimentos` e `notas` em JSON) |
| `licitacao_documentos` | 1 linha por arquivo, com seção, fornecedor, lotes e status |
| `licitacao_chunks` | trechos + embedding 768d (preenchida na próxima etapa) |
| `match_licitacao_chunks()` | busca semântica com filtro por seção/fonte |

## 2. Testar localmente

```bash
pip install -r requirements.txt
python -m coletor.main --ids 1,10,30,41 --dry-run     # só lista, não grava
export SUPABASE_URL=https://<projeto>.supabase.co
export SUPABASE_SERVICE_ROLE_KEY=...                  # nunca no frontend
python -m coletor.main --ids 1,10                     # grava; arquivos em ./dados
```

## 3. Rodar no Cloud Run (usa os créditos do GCP)

```bash
PROJECT=<seu-projeto-gcp>; REGION=southamerica-east1; BUCKET=licitagym-docs
gcloud config set project $PROJECT
gcloud services enable run.googleapis.com artifactregistry.googleapis.com \
  cloudbuild.googleapis.com secretmanager.googleapis.com storage.googleapis.com
gcloud storage buckets create gs://$BUCKET --location=$REGION
printf '%s' "$SUPABASE_SERVICE_ROLE_KEY" | gcloud secrets create supabase-service-key --data-file=-

gcloud run jobs deploy coletor-sestsenat --source . --region $REGION \
  --set-env-vars SUPABASE_URL=$SUPABASE_URL,GCS_BUCKET=$BUCKET,DELAY_SEGUNDOS=1.5 \
  --set-secrets SUPABASE_SERVICE_ROLE_KEY=supabase-service-key:latest \
  --args="--de,1,--ate,120" --task-timeout=6h --max-retries=1

gcloud run jobs execute coletor-sestsenat --region $REGION
```

A conta de serviço padrão do Cloud Run precisa de `roles/storage.objectAdmin`
no bucket e `roles/secretmanager.secretAccessor` no secret.

Para rodar toda semana: Cloud Scheduler → `gcloud run jobs execute`.
A coleta é idempotente (upsert + só baixa o que está `pendente`/`erro`).

## Configuração

| Variável | Padrão | Uso |
|---|---|---|
| `SECOES_DOWNLOAD` | `processo,recurso,contrarrazoes,parecer` | Seções cujos arquivos são baixados. Metadados de **todas** as seções são sempre gravados. |
| `DELAY_SEGUNDOS` | `1.5` | Pausa entre requisições (seja gentil com o portal). |
| `MAX_MB` | `80` | Arquivos maiores ficam como `ignorado`. |
| `GCS_BUCKET` | — | Sem ela, salva em `./dados`. |

Flags: `--ids`, `--de/--ate`, `--modulo` (59 = pregão eletrônico), `--todos`
(inclui processos em andamento), `--dry-run`.

## Volume observado (piloto)

Um pregão de registro de preços grande (8453-4/2025) tem 32 arquivos no processo
mas ~1.000 arquivos únicos de fornecedores (proposta 32, lance 265, negociação 415,
habilitação 264), muitos em `.zip`/`.rar`. Por isso o padrão baixa só as seções
de maior valor para o RAG. Ligue `proposta`/`negociacao` quando quiser preços.

## Cuidados

- **Cadastro de visitante:** a interface do portal pede um cadastro rápido de
  visitante antes de baixar anexos. O endpoint de download responde sem ele,
  mas o recomendado é fazer o cadastro com os dados da empresa responsável
  pelo LicitaGym para ficar em conformidade com o portal.
- **LGPD:** só CNPJ é gravado; identificadores de pessoa física (CPF) são
  descartados. Documentos de habilitação podem conter dados de sócios —
  mascarar antes de indexar no RAG.
- **Limites de taxa:** mantenha `DELAY_SEGUNDOS` ≥ 1 e rode fora do horário comercial.

## 4. Indexar no RAG (texto → Gemini → embeddings)

```bash
gcloud services enable aiplatform.googleapis.com
pip install --user -r requirements.txt
python3 -m coletor.indexador --limite 3     # teste com 3 arquivos
python3 -m coletor.indexador                # todo o resto
python3 -m coletor.buscar "Por que a Freedom Motors recorreu e qual foi a decisão?"
```

- Cada arquivo físico (sha256) é processado **uma vez**; cópias recebem o mesmo resultado.
- PDF com texto → `pypdf`; PDF escaneado → OCR pelo Gemini; `.zip` é aberto (até 2 níveis);
  `.docx` lido direto; `.rar` e imagens ficam listados em `extracao.arquivos_ignorados`.
- Gemini gera um JSON por documento em `licitacao_documentos.extracao` (tipo, resumo,
  fornecedores, decisão, motivos, fundamentos legais, valores, pontos-chave) e um trecho-resumo.
- Embeddings: `text-multilingual-embedding-002` (lotes de até 30 trechos, 1 chamada a cada 12,5 s), 768 dimensões, `RETRIEVAL_DOCUMENT` (consulta usa `RETRIEVAL_QUERY`).
- Modelos configuráveis: `EMBED_MODEL`, `GEN_MODEL` (padrão `gemini-2.5-flash`), `GOOGLE_CLOUD_LOCATION` (padrão `us-central1`).

**Cota do Vertex (projeto novo):** o modelo de embeddings começa com **5 requisições/min**
por região. O indexador já respeita isso (`EMBED_INTERVALO=12.5`). Para acelerar, peça aumento em
IAM e administrador → Cotas → "online prediction requests per base model … textembedding-gecko"
(us-central1) e reduza `EMBED_INTERVALO`. PDFs escaneados passam por OCR em partes de
`OCR_PAGINAS=8` páginas.

**Importante para o app:** a pergunta do usuário precisa ser convertida em vetor com o
**mesmo modelo** (`text-multilingual-embedding-002`, 768d, `RETRIEVAL_QUERY`) antes de chamar
`match_licitacao_chunks`. Veja `coletor/buscar.py` como referência.
