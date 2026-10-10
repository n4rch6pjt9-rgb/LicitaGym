# Coletores LicitaGym (PNCP + SEST SENAT) → Supabase + RAG

## Gate de marca e referências do edital (v16.3)
- Colunas na ordem fornecedor → marca → modelo, e o gate do fornecedor calculado sobre **todas** as propostas dele:
  `perfil_comercial` = fabricante — marca própria | fabricante + revenda | revenda monomarca | revenda multimarca;
  `marca_propria` (+ método: nome na razão social ou mais frequente), `qtd_marcas_fornecedor`, `marcas_ofertadas_fornecedor`;
  por linha, `relacao_marca` = marca própria | revenda.
- Referências do edital estruturadas (`coletor/data/referencias_edital/*.json`): `ref_marca_1..3`, `ref_modelo_1..3`,
  `qtd_marcas_referencia`, `marca_ofertada_na_referencia` (SIM/NÃO/SEM REFERÊNCIA, por marca normalizada) e `posicao_na_referencia`.
- Preço × referência sem sinal, em %: `desconto_vs_ref_pct` (abaixo da referência, ex. 54,93%) e `acrescimo_vs_ref_pct` (acima, ex. 8,44%).
- `python -m coletor.relatorio_ano --consolidar a.csv b.csv ... --saida todos.csv` junta anos e recalcula o gate.

## Relatório anual para o BI (v16.2)
`python -m coletor.relatorio_ano --fonte sfiec --ano 2023 --saida bi-sfiec-2023.csv --cache cache_relatorio`
- Junta o Mural estatístico do ano com o mural comum (o estatístico não traz tudo: ex. PD000802025 e os cancelados).
- Itens no escopo → lances, vencedor, marca/modelo, valor unitário e total; participantes de todos os itens → CNPJ (fabricante × revenda).
- CSV em padrão brasileiro (vírgula decimal, sem ponto de milhar). Cache por processo para retomar.
- Vencedor na "Contratação ou aquisição (disputa aberta)" (regulamento novo, 2025+): sem troféu, vale a 1ª posição Classificada.

## BI: perfil do equipamento, marca e fabricante × revenda (v16.1)
- `licitacao_itens`: `catalogo_codigo_item` (código do produto no portal, ex.: AI0300075), `familia_equipamento`, `no_taxonomia` (dicionário de aparelhos v0.3), `fonte_carga`, `perfil_metodo`/`perfil_confianca`.
- `licitacao_resultados.marca_normalizada` (MOVIMENT/MOVEMNT/… → MOVEMENT).
- `fornecedores.fabricante` (CNAE principal nas divisões 10–33).
- View `v_bi_resultados_itens`: uma linha por proposta ranqueada com código, descrição, família, empresa, fabricante/revenda, marca, modelo, valor, referência e desconto.
- O log do dry-run mostra código, descrição, família, vencedor, marca e desconto sobre a referência.
- Migração: `supabase/migrations/20260929140100_bi_perfil_equipamento.sql` (aplicada pela integração Supabase no merge).

## Documentos das licitações dentro do LicitaGym (v16, 26/09/2026)

Todo processo Paradigma no escopo, aberto ou fechado, tem os anexos (edital, erratas, avisos, adiamentos, relatório final…) **registrados em `licitacao_documentos` e guardados no Supabase Storage** (bucket privado `licitacao-documentos`). Nada é apagado:
- documento novo no portal → `first_seen_at` (o Dashboard mostra "novo" por 7 dias);
- documento que some do portal → `removido_do_portal_em` (o arquivo continua no LicitaGym);
- a view `v_licitacao_documentos` dá, por licitação, contagens e a lista completa (`documentos` jsonb com `bucket` e `caminho`).

**Cadastro de visitante:** o portal exige identificação para baixar. O coletor se identifica com o **CNPJ da empresa** (nunca CPF). Sem estas variáveis, os documentos ficam `pendente` e nada é baixado:

```
SUPABASE_STORAGE_BUCKET=licitacao-documentos
VISITANTE_CNPJ=00.000.000/0000-00
VISITANTE_RAZAO_SOCIAL=...
VISITANTE_EMAIL=...            # e-mail institucional
VISITANTE_TELEFONE=...
VISITANTE_UF=CE
VISITANTE_CONTATO=...          # opcional (nome do contato comercial)
VISITANTE_CONSENTIMENTO_LGPD=1 # aceite exigido pelo formulário do portal
MAX_MB=50                      # acima disso o documento fica "ignorado"
```
Guardar como segredo (Secret Manager / variáveis do job), não no repositório.

**Dashboard (abrir o arquivo):** usuário logado gera link assinado com o `bucket`/`caminho` da view:
```ts
const { data } = await supabase.storage.from(doc.bucket).createSignedUrl(doc.caminho, 3600)
```

**Arquivos antigos fora do SaaS:** os PDFs do SEST SENAT que estão no disco da VM sobem com `python -m coletor.migrar_storage` (rodar na VM; confere sha256; não apaga o original). O coletor SEST SENAT e o PNCP passam a gravar no Storage quando `SUPABASE_STORAGE_BUCKET` está definido.

Migração: `supabase/migrations/20260929140000_documentos_no_licitagym.sql` (aplicada pela integração Supabase no merge) (bucket + policy de leitura para `authenticated`, colunas de histórico, `portal_visitante`, view e o cadastro das fontes Paradigma que faltavam em `fontes_externas`).

## Coletor Sistema S — adaptador Paradigma (v15, 26/09/2026)

Novidades sobre a v14 (validado ao vivo na SFIEC, PE000652022):
- **Resultado pela grade de lances** (`PesquisarProcessoDetalheItemProdutoLance`): ranking, empresa + **CNPJ**, **marca, modelo**, valor e troféu. A aba Classificação (usada até a v14) devolve HTTP 500 em pregão e fica só como fallback.
- **Situação:** `vencedor` (troféu) ou `perdida` quando o portal deixa vazio. Cada item encerrado precisa ter **exatamente 1 vencedor**; senão levanta `ResultadoInvalido`, não grava e conta em `alertas`. Itens revogados/fracassados/desertos podem ter 0.
- Lances sem posição (histórico, incluindo âncoras de R$ 100 mil/500 mil) e linhas repetidas não entram em `licitacao_resultados`.
- **Filtro do catálogo** (tela Catálogo: Categoria + Tipo): `--categorias "EQUIPAMENTOS ESPORTIVOS;ESPORTIVO" --tipo produto` (padrão). Os itens cujo `nCdProduto` está nessas categorias entram com `escopo_metodo='catalogo'`, exceto ITEM_FORA (balanças etc.). `--sem-catalogo` desliga.
- **Encerrados por ano** (Mural estatístico): `--anos 2022,2023`. Traz os valores estimado, negociado e economia do certame (`raw.mural_estatistico`).
- **Cadastro de fornecedores** (`coletor/fornecedores.py`): todo CNPJ de participante é consultado (BrasilAPI → Minha Receita) e gravado em `public.fornecedores`. Cache de 30 dias. Não grava QSA; em MEI/empresário individual mascara o CPF e não guarda contato/endereço. Backfill: `python -m coletor.fornecedores --de-resultados`.
- **Peças de manutenção (v15.1):** cabo de aço, courvin/corino, polia, rolamento, correia/lona de esteira, estofamento, mola, pino seletor, manopla, lubrificante/desengripante… entram com `categoria_escopo='manutencao'` (preço de peça não se mistura com equipamento). Só com contexto de academia no item ou no objeto; peça citada antes do aparelho ("CABO DE AÇO PARA LEG PRESS") é manutenção, aparelho com peça ("LEG PRESS COM CABOS DE AÇO") continua `forte`. Compra só de peças vira `manutencao` no processo.
- **v15.2:** valor do lance é unitário; o vencedor grava `quantidade_homologada` e `valor_total_homologado` (conferido com o Relatório Final do PE000652022: 9 vencedores e R$ 377.233,50 no centavo). O cadastro de fornecedores recebe **todos os participantes do certame** (inclusive de itens fora do escopo e sem posição): 12 de 12 no PE000652022.
- Teste de um processo: `python -m coletor.paradigma --fonte sfiec --processo 32/18 --dry-run`

Pré-requisito: `supabase/migrations/20260925120000_sistema_s_coleta_externa.sql` e `20260926120000_fornecedores_e_lances.sql` (já aplicadas em produção).

## Coletor Sistema S — adaptador Paradigma (v12)

Um adaptador para todos os portais Paradigma (SEST SENAT, FIESC/SESI-SENAI SC). Validado em 24/09/2026.
Lê os **itens** de cada processo (as cotações têm objeto genérico) e o ranking/vencedor por item.
Precisa da migration `20260925120000_sistema_s_coleta_externa.sql` (PRD_SISTEMA_S_COLETA_EXTERNA_v1).

```bash
python3 -m coletor.paradigma --fonte fiesc --dry-run --paginas 1        # só lista (★ = interesse borracha)
python3 -m coletor.paradigma --fonte fiesc                                # grava licitação + itens + ranking
python3 -m coletor.paradigma --fonte sestsenat --termos "academia;esporte e lazer"
```
Decisão de 05/10/2026: quando o `robots.txt` bloqueia o portal, a coleta segue. Sesc SP (`sescsp`), Sesc/Senac RS (`sesc_senac_rs`), Sesc DN (`sescdn`), Sesc RJ (`sescrj`) e Sesc BA (`sescba`), em paradigmabs.com.br, entram pelo webservice público do mural, com o mesmo intervalo do adaptador. A decisão antiga (recusar e esperar aviso de fornecedor) não vale mais para esses hosts. Bloqueio de WAF continua fora: FIEMG responde 403 de desafio Cloudflare e não entra por esse caminho. O CLI passa `autorizado=True` só nessas cinco. `fiemg` continua em `PermissionError`.

---

## Coletor PNCP (trilho secundário)

Busca nacional no PNCP por frase exata (por padrão os 160 termos de `TERMOS_ESCOPO_COMPLETO` em `coletor/escopo.py`,
que cobrem os 58 PDMs do escopo — decisão do owner em 30/09/2026; `--termos-padrao` volta aos 12 termos resumidos de
`TERMOS_PADRAO` em `coletor/pncp.py`), classifica cada compra
pelo objeto **e pelos itens** (`coletor/escopo.py`) e grava compra, itens, **vencedores** e arquivos.

Três modos. O modo só escolhe o filtro `status` da busca no PNCP; não define sozinho a prioridade gravada.

| Modo | Filtro PNCP | Prioridade |
|---|---|---|
| `leads` (padrão) | `recebendo_proposta` | recebendo proposta |
| `monitorar` | `em_julgamento` | em julgamento, suspensa, adjudicação ou recurso |
| `historico` | `encerradas` | encerrada ou homologada |

**Prioridade** (owner, 02/10/2026): `leads` = recebendo proposta; `monitorar` = em julgamento, suspensa, adjudicação ou recurso; `historico` = encerrada ou homologada. Status desconhecido nunca vira lead. Falha de API ou documento ausente não pode gravar `encerradas`/`historico` nem promover a `leads`. Compra homologada não é lead.

Preço por item CATMAT, marca e mapa de fornecedor (revenda ou fabricante) saem só de certames homologados, ficam só no BI e são rastreáveis pelo certame. Revogada, anulada, deserta ou fracassada não alimentam esse mapa.

O detalhe da compra (`/api/consulta/v1/.../compras/{ano}/{seq}`), quando a chamada sucede, é a fonte do estado (`existeResultado`, `valorTotalHomologado`, `situacaoCompraNome`, `dataEncerramentoProposta`). Se o detalhe falha, não gravar prioridade por fallback da busca.

```bash
# pré-requisito: supabase/migrations/20260924100000_pncp_itens_resultados.sql (já aplicada)
python3 -m coletor.pncp --dry-run --termos "borracha granulada" --tam 20   # teste rápido
python3 -m coletor.pncp                                   # leads: recebendo proposta
python3 -m coletor.pncp --modo monitorar                  # em julgamento
python3 -m coletor.pncp --modo historico --paginas 10 --baixar-arquivos   # encerradas
python3 -m coletor.indexador                              # arquivos baixados -> RAG
```

Escopo completo (160 termos, o padrão; ~13x as chamadas dos 12 termos): pode rodar inteiro ou em 4 lotes, um por
execução (`--lote K/N`). Com lista maior que a de 12 termos o coletor usa 1 worker e 1 s entre chamadas (~1 req/s, o ritmo de `private.http_host_lease` para
`pncp.gov.br`), salvo `PNCP_WORKERS`/`DELAY_SEGUNDOS`. Busca que esgota as tentativas não derruba os outros termos:
entra em `falha_busca`/`termos_com_falha` no resumo e o processo sai com código 1; repetir o mesmo lote retoma.

```bash
python3 -m coletor.pncp --lote 1/4 --dry-run --paginas 1   # confere a fatia
python3 -m coletor.pncp --lote 1/4                         # depois 2/4, 3/4, 4/4
python3 -m coletor.pncp --termos-padrao                    # execução rápida só com os 12 termos
```

Documentos PNCP pendentes (`licitacao_documentos.status_processamento = 'pendente'`): `--baixar-pendentes` baixa pela
URL guardada, só das licitações nas categorias do escopo (padrão atual do CLI: `catmat,forte,borracha,piso,obra_piso`; `fraco` fica
fora) e opcionalmente filtrando por prioridade efetiva (`--prioridades leads,monitorar`, valores aceitos: `leads`, `monitorar`,
`historico`, lendo a view `licitacoes_externas_prioridade_efetiva`), grava pelo mesmo destino do coletor
(`Armazenamento.do_ambiente()`: Supabase Storage com `SUPABASE_STORAGE_BUCKET`, senão GCS, senão local), respeita `MAX_MB`
e `Retry-After`, e não baixa de novo o que já tem `sha256`. Em 30/09/2026 eram 141 pendentes do PNCP (108 borracha, 22 piso, 2 forte, 9 fraco).
Obra não vira lead: a categoria `obra_piso` nesse filtro de download não promove contrato de obra a `leads`.

```bash
python3 -m coletor.pncp --baixar-pendentes --dry-run                         # lista os elegíveis e detalha por prioridade
python3 -m coletor.pncp --baixar-pendentes --prioridades leads,monitorar     # baixa apenas leads e monitorar
python3 -m coletor.pncp --baixar-pendentes --prioridades leads --limite-download 20  # lote pequeno de leads
python3 -m coletor.pncp --baixar-pendentes --categorias catmat,forte,borracha,piso,obra_piso
python3 scripts/gerar_relatorio_termos.py                                    # docs/coletor-pncp-termos.md (PDM x termo)
```

Anexo com `statusAtivo=false` no `/arquivos` do PNCP (substituído/retirado pelo órgão) não é gravado de novo.
O que já existia recebe `removido_do_portal_em` (mesmo critério do #134). `--baixar-pendentes` só lê pendentes com
`removido_do_portal_em is null`, para não baixar um anexo inativado depois de gravado. O RAG deve filtrar
`removido_do_portal_em is null`.
`licitacoes_externas.link_sistema_origem` guarda o `linkSistemaOrigem` do detalhe (portal da disputa).

Recoleta por versão (migration `20261002230000_pncp_link_origem_atualizacao_anexos`): cada coleta completa grava
`dataAtualizacao`/`dataAtualizacaoGlobal` do detalhe em `pncp_data_atualizacao[_global]`; `--recoletar-atualizadas`
consulta o detalhe das compras gravadas (prioridade efetiva `leads,monitorar` por padrão) e recoleta metadados, itens,
resultados e lista de arquivos só das que mudaram (ou ainda sem valor guardado). Nunca baixa arquivo.

```bash
python3 -m coletor.pncp --recoletar-atualizadas --dry-run                  # só conta (1 GET de detalhe por compra)
python3 -m coletor.pncp --recoletar-atualizadas --limite-recoleta 50       # recoleta até 50 compras que mudaram
python3 -m coletor.pncp --recoletar-atualizadas --prioridades leads
```

Reclassificar as linhas PNCP já gravadas (as antigas `leads` homologadas viram `historico`) — dry-run por padrão:

```bash
export SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=...                       # do ambiente, nunca no código
python3 -m coletor.backfill_prioridade_pncp                                 # DRY-RUN: contagem por transição + amostra
python3 -m coletor.backfill_prioridade_pncp --consultar-pncp --limit 50     # DRY-RUN relendo o detalhe no PNCP (GET)
python3 -m coletor.reclassificar_escopo_pncp                               # DRY-RUN (prioridade + fase)
python3 -m coletor.reclassificar_escopo_pncp --apply                       # grava prioridade, fase e escopo
```

`backfill_prioridade_pncp --apply` está desativado (sai com código 2): ele decide só a prioridade, sem documentos
nem fase, e sobrescreveria fases documentais como "Suspensa (documento)". O dry-run dele fica como diagnóstico legado.

`oportunidades_borracha` lista primeiro os `leads` (certames abertos, ainda sem vencedor) e depois o resto, do
homologado mais recente para o mais antigo, com `dias_desde_homologacao`. Para oferecer raspa ao vencedor,
use as linhas `historico` com homologação recente (`dias_desde_homologacao`), não `prioridade = 'leads'`.

**`valor_total` da compra:** vem do detalhe (`valorTotalEstimado` de `/api/consulta/v1/orgaos/{cnpj}/compras/{ano}/{seq}`);
`valor_global` da busca (vazio em editais) é só fallback. Sem valor (ou 0, orçamento sigiloso) a coluna não vai
no upsert, então nunca apaga um valor já gravado. `valorTotalHomologado` não é usado (é o valor adjudicado, outra grandeza).
Backfill das linhas PNCP gravadas antes da correção (`valor_total IS NULL`) — dry-run por padrão:

```bash
export SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=...        # do ambiente, nunca no código
python3 -m coletor.backfill_valor_total_pncp --limit 20       # DRY-RUN: consulta o PNCP, mostra contagem/amostra, não grava
python3 -m coletor.backfill_valor_total_pncp --apply          # grava só valor_total, só onde o detalhe traz valor
```
Usa o cliente PNCP do coletor (`DELAY_SEGUNDOS`, backoff em 429/5xx). Falha de consulta não grava; rodar de novo retoma.

Volume observado (24/09/2026, frase exata): grama sintética 3.263 (85 abertas), academia ao ar livre 1.563,
equipamentos de academia 1.023, piso emborrachado 986, campo society 794, borracha granulada 122.
A busca do PNCP também acha termos dentro dos itens — decoração natalina, arbitragem e grama natural são
descartadas pelo classificador.

**Raspa de borracha para o vencedor:** a view `oportunidades_borracha` junta compra, item e vencedor
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
- Academia ao ar livre só conta junto com piso (o produto). Obra, credenciamento, locação, manutenção
  (inclusive com fornecimento de peças) e oficineiros nunca viram lead.
- Recreação infantil (parque infantil, playground).

`interesse_borracha(objeto)` marca as licitações onde o vencedor vai precisar de raspa/granulado.
Serviço de evento, uniforme e troféu ficam fora. Um termo de busca sozinho não torna a linha `forte`.
Polia e espaldar são `forte`. Pilates, "aparelho para condicionamento físico" genérico e colchonete são `fraco`.
`Puxador` é positivo só na categoria acessórios.
O coletor usa `--escopo fitness` por padrão (`--escopo tudo` desliga o filtro).

**Forte ancorado (03/10/2026, modo núcleo).** Com o banco configurado, `forte` só vem de item que casa uma âncora
do catálogo CATMAT da empresa (`coletor/catmat_ancoras.py`: nome/TIPO/NOME dos itens dos PDMs efetivos e dos itens
incluídos, segundo `catmat_itens_mapa()`, com o texto de `catmat_itens`/`catalogo_itens`; 100 linhas por página). As listas fixas acima só rebaixam: sem âncora o
`forte` delas vira `fraco`, e item ancorado que cai em `ITEM_FORA`, academia ao ar livre ou brinquedo infantil fica
`fraco`. O objeto da compra não tem âncora (`forte` do objeto vira `fraco`). Piso, borracha, obra_piso e o código
CATMAT (`catmat`) não mudam; as travas (serviço, obra, ATI, passagem sem core, predial) continuam. PDM efetivo sem
itens com descrição aborta a coleta antes de gravar. `FORTE_ANCORADO` = `nucleo` (padrão), `estrito`
(âncora inteira) ou `desligado` (regra antiga, só emergência).

## 1. Criar as tabelas (uma vez)

As tabelas vêm de `supabase/migrations/20260923100000_licitacoes_externas.sql` (já aplicada; migrations novas entram por PR e a integração Supabase aplica no merge)
Ela cria:

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
(inclui processos em andamento), `--dry-run`, `--coleta`.

**Pesquisa de Preço no mesmo Job (spec 0009).** `--coleta` escolhe o que roda: `sestsenat`, `precos` ou `todas`
(padrão). Com `precos`, o Job roda `coletor.compras_precos` em modo catálogo (PDMs de
`catalogo_catmat_pdms_efetivos()`; se a RPC falhar, a coleta falha, sem lista fixa) e depois o
`2_consultarMaterialDetalhe` só para as linhas sem descrição detalhada, gravando `detalhe_sincronizado_em`. Falha de
qualquer parte (inclusive de uma linha do detalhe) faz o Job sair com código 1. Para um agendamento só de preços:
`--args="--coleta,precos"`. A saúde operacional (`precos_dias_sem_coleta`) fica crítica com 8 dias sem gravar preço.

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
- **LGPD:** nos cadastros estruturados só CNPJ é gravado. No RAG, CPF e CNPJ
  que aparecem nos editais são dados públicos e são indexados sem máscara
  (decisão de 01/10/2026).
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
- O tipo do arquivo vem dos **bytes**, não da extensão (o PNCP entrega `.bin`/sem extensão):
  `%PDF-` → PDF; `PK` → ZIP, ou DOCX se tiver `word/document.xml`, ou XLSX se tiver `xl/`.
- PDF com texto → `pypdf`; PDF escaneado → OCR pelo Gemini; ZIP é aberto (até 2 níveis, nomes
  internos em cp850/UTF-8 sem flag corrigidos); DOCX lido direto; XLSX vira texto simples
  (uma linha por linha da planilha, células com " | ", sem datas formatadas, até 200 mil caracteres);
  `.rar`, `.7z`, `.pptx`, `.doc`/`.xls` antigos e imagens ficam em `extracao.arquivos_ignorados`.
  Arquivo com nome `.pdf` que não é PDF (ex.: página HTML de erro) é ignorado, não vai para o OCR.
- Gemini gera um JSON por documento em `licitacao_documentos.extracao` (tipo, resumo,
  fornecedores, decisão, motivos, fundamentos legais, valores, pontos-chave) e um trecho-resumo.
- Embeddings: `text-multilingual-embedding-002` (lotes de até 30 trechos, 1 chamada a cada 12,5 s), 768 dimensões, `RETRIEVAL_DOCUMENT` (consulta usa `RETRIEVAL_QUERY`).
  Cada chunk grava o modelo em `licitacao_chunks.embedding_model` (padrão da coluna: o mesmo modelo).
- `GEN_MODEL` (padrão `gemini-2.5-flash`) e `GOOGLE_CLOUD_LOCATION` (padrão `us-central1`) são configuráveis. O embedding do RAG permanece `text-multilingual-embedding-002` com 768 dimensões; trocar o modelo exige um plano de reindex aprovado. Não apontar `EMBED_MODEL` para outro modelo sem esse plano.

**Cota do Vertex (projeto novo):** o modelo de embeddings começa com **5 requisições/min**
por região. O indexador já respeita isso (`EMBED_INTERVALO=12.5`). Para acelerar, peça aumento em
IAM e administrador → Cotas → "online prediction requests per base model … textembedding-gecko"
(us-central1) e reduza `EMBED_INTERVALO`. PDFs escaneados passam por OCR em partes de
`OCR_PAGINAS=8` páginas.

**Importante para o app:** a pergunta do usuário precisa ser convertida em vetor com o
**mesmo modelo** (`text-multilingual-embedding-002`, 768d, `RETRIEVAL_QUERY`) antes de chamar
`match_licitacao_chunks`. Veja `coletor/buscar.py` como referência.
