# Trilhas e informe: a descoberta de oportunidades como auditoria contínua

<!-- Documento interno de arquitetura de produto. Nome interno: LicitaGym. Nome externo (tela, e-mail, informe,
material para cliente): Nexor Licitações. Mudança de escopo derivada daqui passa pelo ESCOPO.md e pelo ok do Marcelo. -->

- **Dono:** Marcelo Rosas
- **Status:** proposta (11/11/2026)
- **Módulo do `ESCOPO.md`:** 1 (Radar de oportunidades), com a trilha de escopo alimentando o módulo 3 (spec 0032,
  fase 3)
- **Nome:** documentação interna continua como LicitaGym. Todo texto que o cliente vê (informe, e-mail, rótulo de
  alerta) usa **Nexor Licitações**.

## Por que este documento

A descoberta hoje é uma busca de texto com filtro de escopo. Ela traz falso positivo (ex.: licitação 2021, "academias
para praças públicas", gravada como `forte`) e chega tarde (o edital aparece quando já está publicado). O plano do
cruzamento de camadas (PCA → órgão → edital → TR → homologação) resolve isso, mas faltava uma moldura que dissesse
**para onde** cada fase leva.

A moldura vem da Alice, ferramenta de auditoria contínua da CGU (Manual prático, CGU/SFC, versão 1.0, dez/2025).
A Alice não é uma fonte que podemos consumir: o acesso direto é restrito às unidades de auditoria e controle interno
(nota 1, p. 4), e as rotas `/alice/*` da API do Compras.gov.br exigem login de usuário criado por administrador
(OpenAPI conferido em 10/11/2026). O que aproveitamos é o **desenho**, com o ponto de vista invertido:

| | Alice (CGU) | LicitaGym / Nexor Licitações |
|---|---|---|
| Quem usa | auditor | fornecedor (tenant) |
| Pergunta | "esta compra tem risco?" | "esta compra é para mim, e o que faço com ela?" |
| Alerta vira | auditoria | lead, impugnação, recurso ou descarte com motivo |

## O ciclo em quatro etapas

```
Coleta diária ──> Cruzamento ──> Trilhas ──> Informe diário
 (fontes abertas)   (órgão, PCA,     (regras        (por órgão acompanhado,
                     histórico)       determinísticas) com cifrões)
                                                        │
                                                        └──> Uso: o humano decide
                                                             (Enviar para pipeline, descartar com motivo)
```

### 1. Coleta (diária)

| Fonte | Para quê | Situação em 10/11/2026 | Spec |
|---|---|---|---|
| PCA (PNCP) | saber da compra antes do edital | **travada**: o sync não lê plano desde 07/11 (página 1 da classe 7830 falha com 503 e pausa de cota) | a criar: PCA em camadas |
| Edital por CNPJ (`/v1/contratacoes/publicacao?cnpj=`) | achar o edital pelo órgão, não pela palavra | código pronto em `sync-pncp-contratacoes-editais`, sem cron (última execução 20/09) | a criar ou reativar |
| Busca por texto (`/api/search/`) | rede larga para órgão fora da lista | em produção (`coletor/pncp.py`) | existente |
| Compras.gov.br (homologados) | preço, marca, vencedor | em produção | 0009, 0014 |
| Portal de Compras Públicas, Sistema S | portais fora do PNCP | em produção | existentes |
| DOU, Licitações-e (BB), Licitações CAIXA | fontes que a Alice cobre e nós não | não usadas; viabilidade não medida | — |

### 2. Cruzamento

O que a Alice faz com "mais de 40 bases" (p. 5), nós fazemos com o que é aberto e já está no banco:

- **Órgão acompanhado:** ranking por tenant (faixas A, B, C) a partir de compras homologadas, editais em escopo, leads
  ativos e PCA. Levantado à mão em 10/11/2026 para a Konnen: A 128, B 733, C 885. Os órgãos A e B formam a lista de
  acompanhamento, o equivalente às "UASGs ou CNPJs que o usuário escolheu monitorar" do informe da Alice (p. 10).
- **Plano → edital:** chave `grupoContratacaoCodigo` (`UASG-N/ANO`). Provada na USP: 113 grupos ligados, mediana de 63
  dias entre a publicação do edital e a data desejada do plano. `pca_itens` ainda não guarda o campo.
- **Histórico do órgão:** valor homologado por órgão, base dos cifrões (abaixo).
- **Catálogo do tenant:** PDMs e itens CATMAT, com o sinal "CATMAT de risco" medido pelo uso real (spec 0055, K-1).
- Bases de sanção e situação cadastral (CEIS, CNEP, CNPJ): fonte aberta e forma de acesso **não levantadas**.

### 3. Trilhas

Uma trilha é uma regra determinística, versionada e testável, que lê dado da coleta ou do cruzamento e gera um alerta
com fonte, trecho e página (quando vem de documento). Nenhuma trilha exclui oportunidade sozinha. A IA não escolhe
trilha nem decide escopo (`AGENTS.md`). Onde a Alice usa classificador de IA para rotear trilhas (p. 5), nós usamos o
catálogo CATMAT do tenant.

Mesma classificação da Alice (p. 8), com sentido de fornecedor:

| Fase da compra | Trilha | Sentido para o fornecedor | Dado | Situação |
|---|---|---|---|---|
| Planejamento | **Ar livre no TR** (`escopo.ar_livre_tr`) | descartar com motivo | trechos do TR | spec 0055 (rascunho) |
| Planejamento | **CATMAT divergente** (`catmat.divergente`) | lead real com código errado; não descartar | TR + K-1 | spec 0055 (rascunho) |
| Planejamento | **Ar livre no objeto** (camada 1) | não deixar entrar | objeto e itens | regra existe; falha "para praças" sem correção |
| Planejamento | **PCA com data próxima** | preparar antes do edital | PCA + lag do órgão | depende da coleta do PCA |
| Planejamento | **Cláusula restritiva** (ex.: certidão de quitação, citada pelo manual como não prevista na Lei 14.133) | ponto de impugnação | edital/TR | a especificar; liga ao agente jurídico |
| Seleção | **Concorrente frágil** (CNPJ inativo, capital social incompatível) | argumento de recurso | ata + base cadastral | a especificar; fonte não levantada |
| Gestão | **Ata com saldo** | carona (adesão) | ARP | a especificar |

Cada trilha nova é uma spec própria que diz a fase da spec-mãe que alimenta. Pela regra de foco do `ESCOPO.md`, só a
trilha de escopo (0055) alimenta a 0032 hoje; as outras ficam `parada` até a fase 3 da 0032 terminar ou o Marcelo
mudar o foco.

### 4. Informe diário

O informe é a entrega que hoje não existe: um resumo por tenant, uma linha por compra nova ou alterada dos órgãos
acompanhados. Campos, no molde do informe da Alice (p. 10):

| Campo | Conteúdo | Regra |
|---|---|---|
| Órgão | nome, CNPJ, UASG e UF | UASG embaixo do nome, CNPJ do órgão um nível acima (mesma hierarquia pedida para a tela do PCA) |
| Edital | número e link para o **portal oficial da disputa** | PNCP só quando o portal não pode ser lido |
| Valor | valor estimado e **cifrões** | ver abaixo |
| Evento | suspensão, reabertura, cancelamento, impugnação respondida | só com fonte |
| Alertas | trilhas disparadas, com rótulo legível | em branco = "nenhum alerta nas trilhas ativas" |
| Prazo | data da sessão no horário de Brasília | — |

**Alerta em branco é intencional** (p. 11): a linha avisa que a compra existe. A ausência de alerta não quer dizer
"está tudo certo": vale a regra do projeto de dado "não verificado".

**Cifrões (1 a 6).** Na Alice, indicam o peso da compra **comparado ao histórico do próprio órgão**, não um valor
absoluto (p. 10). Para nós, cálculo determinístico: posição do valor estimado na distribuição dos valores homologados
do órgão (mesma escala de PDMs do tenant). Sem histórico suficiente → "sem histórico", nunca um cifrão inventado. Os
cortes de cada faixa e o mínimo de compras para haver histórico são decisão em aberto (P-2).

**Canal (decisão de 11/11/2026, P-1): a Sala de agentes.** O informe não é um e-mail à parte: é a **atividade** da
tela "Sala de agentes Nexor" (design de 08/11/2026, duas versões, 2D e 3D, com dados fictícios). Cada linha da
atividade já tem o formato que a trilha produz: hora, quem agiu (agente ou equipe Nexor), etiqueta de resultado
(neutro, positivo, atenção, bloqueio), licitação, o que aconteceu, **motivo** e **link de prova**. O próprio rodapé do
design diz que, na versão real, cada linha vem do registro de execuções.

| Sala do design | Agente do design | Etapa / trilha deste documento | Fonte real hoje |
|---|---|---|---|
| 1. Garimpo | Garimpeiro | Coleta + lista de órgãos acompanhados ("12 editais novos para o perfil") | coletores; ranking ainda manual |
| 2. Triagem | Triador, Verificador | Trilhas de escopo (ar livre, CATMAT divergente) e de preço ("custo mais margem passa do estimado") | camada 1; spec 0055; cálculo de margem não existe |
| 3. Leitura do edital | Leitor de edital | Agente de edital: exigências, escopo por item, com trecho e página | `agenteEdital` (0032) |
| 4. Habilitação | Conferente de certidões | Validade de certidões (regra de 90 dias em `regras-negocio.md`) | a especificar |
| 5. Disputa | Robô de lances, Monitor de chat | Módulos 5, 6 e 10 do `ESCOPO.md` | 0039 (`parada`) |
| 6. Recursos e contratos | Gestor de contratos | Trilhas de seleção e gestão (concorrente frágil, ata com saldo) | a especificar |

O que isso pede de dado: uma tabela de **eventos** por tenant (quem, o quê, motivo, link de prova, licitação, data e
hora), alimentada pelas execuções de coleta, trilhas e agentes. `agente_execucoes` cobre só a parte dos agentes; a
fonte única dos eventos é decisão de spec. Os indicadores do topo (em acompanhamento, em disputa, precisam de decisão,
barradas no mês) saem da mesma tabela, nunca de número fixo.

Pendências que o próprio design levantou e que este documento herda:

- O evento só tem hora; os prazos dos painéis têm data. O cliente precisa ver o dia de cada evento.
- "Precisa de você: aprovar o preço mínimo" e, na mesma tela, o robô lançando "dentro do piso autorizado": a ordem
  (piso aprovado antes de qualquer lance) precisa ficar explícita.
- Cifrões entram na coluna de valor das linhas de Garimpo e Triagem.

Sem resumo por e-mail: o informe fica só na tela (P-1b, 11/11/2026).

### 5. Uso

Na Alice, o alerta crítico pode virar tarefa automática no e-CGU (p. 7). Aqui a oportunidade só entra no pipeline pelo
botão "Enviar para pipeline" (`regras-negocio.md`). O equivalente permitido é **sugerir**: destacar no informe a linha
com valor alto (5 ou 6 cifrões) e trilha de oportunidade, sem mover nada sozinho.

## Referência de mercado (Licinexus, páginas públicas lidas em 11/11/2026)

O concorrente publica três "IAs" que caem em etapas deste documento. Só o texto de marketing foi lido; nada sobre
como funcionam por dentro.

| Produto deles | O que a página promete | Onde cai aqui | Diferença de abordagem |
|---|---|---|---|
| Auditor | Cláusula restritiva, sinal de direcionamento, alerta com dispositivo da Lei 14.133 e acórdão do TCU, score alto/médio/baixo | Trilha "cláusula restritiva" (planejamento) e trilhas de seleção | Nossa trilha é regra determinística; dispositivo e acórdão só quando vêm de fonte citável, nunca gerados |
| Previsor | Faixa de preço esperada por item, probabilidade de vencer, confiança pelo número de casos parecidos | Agente de preço (homologado em 12 a 24 meses) e cifrões | Faixa por percentil do homologado com o número de casos; "probabilidade de vencer" não entra sem regra testável |
| Catálogo | Descrição livre do item vira CATMAT/CATSER/NCM, com match semântico | Catálogo do tenant e de-para de itens sem CATMAT | Aqui o TR manda e o CATMAT é apoio; classificação de escopo não fica a cargo de modelo |

A página inicial deles é um "escritório num dia real de trabalho", em que cada pessoa no prédio é um agente: é a
referência visual da Sala de agentes (conferência técnica no documento do design, de 08/11/2026).

## Limites (adaptados do manual, p. 12 e 13)

- A trilha aponta sinal, não prova. Quem decide é o humano.
- Ausência de alerta não é garantia: o informe diz "nenhum alerta nas trilhas ativas", nunca "sem risco".
- Depende da qualidade das fontes. Atraso do PNCP em relação ao portal é conhecido; o portal oficial prevalece.
- As trilhas não cobrem tudo, e a leitura de texto falha com anexo escaneado e documento fora de padrão.
- Não cobre 100% das compras: só as fontes da etapa 1.

## Ordem de construção

1. **Coleta do PCA em camadas** (fase 1 do plano; destrava cruzamento e a trilha "PCA com data próxima").
2. **Lista de órgãos acompanhados** a partir do ranking, e **edital por CNPJ** com cron para essa lista.
3. **Chave plano → edital** (`grupoContratacaoCodigo`) e lag por órgão.
4. **Trilhas de escopo:** correção da camada 1 ("para praças", com contagem antes/depois) e spec 0055.
5. **Tabela de eventos e atividade da Sala de agentes**, com cifrões (marca Nexor Licitações). A 2D primeiro: a 3D
   não tem os indicadores nem o estado das salas em texto.
6. Trilhas de impugnação, concorrente e ata, uma spec por trilha.

## Perguntas em aberto

- **P-1.** ~~Canal do informe~~ Decidido em 11/11/2026: a atividade da Sala de agentes.
- **P-1b.** ~~Resumo por e-mail~~ Decidido em 11/11/2026: só na tela.
- **P-2.** Cifrões: cortes por sextis do histórico do órgão (cada cifrão = 1/6) ou outra regra? Mínimo de compras
  homologadas para haver histórico?
- **P-3.** A lista de acompanhamento é só a faixa A, A e B, ou o tenant escolhe (com o ranking como sugestão)?
- **P-4.** Este documento entra no `ESCOPO.md` como módulo novo ("Trilhas e informe") ou como parte do módulo 1?
- **P-5.** Vale levantar DOU, Licitações-e e Licitações CAIXA como fontes, ou ficam fora por enquanto?
