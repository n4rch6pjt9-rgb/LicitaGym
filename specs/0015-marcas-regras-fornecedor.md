# 0015: Resolver a marca dos preços praticados pelas regras do certame (própria, origem, grupo e marca composta)

- **Status:** rascunho (regras de negócio confirmadas pelo Marcelo em 09/10/2026)
- **Issue:** nenhuma; continua o resolvedor de marcas (#148, #228, #262) e a fila de pendentes (#180)
- **Área:** migrations (`private.marca_resolver`, views de marca), coletor (enriquecimento de fornecedor), dashboard-contrato
- **Depende do ok do Marcelo:** sim. Muda o resultado do ranking de marcas e cria tabelas de curadoria.

## Problema

A marca de cada item vencido vem do campo `marca` da Pesquisa de Preço do Compras.gov (`precos_praticados_itens`). O
JSON da API só traz `marca`, `niFornecedor` e `nomeFornecedor`: as colunas `fabricante` e `modelo` da tabela estão
vazias nas 25.465 linhas. O fornecedor (vencedor homologado) está certo. O problema é o que o licitante escreve no
campo marca, que mistura várias coisas.

Medido em 09/10/2026, só leitura (25.465 linhas, 9.505 pares marca × fornecedor, 2.711 fornecedores):

- **"PRÓPRIA" virou "não é marca".** Quando o fornecedor é o fabricante, ele declara a categoria "PRÓPRIA" em vez do
  nome.
  - São 1.174 linhas (4,6%), 118 fornecedores e R$ 137,5 milhões (22% do valor).
  - Grafias: `PROPRIA` 793, `PROPRIO` 214, `MARCA PROPRIA` 66, `PROPRIA IMPORT` 21, `PROPRIA PROPRIA` 15,
    `ACADEMIA PROPRIO` 12, `FABRICACAO PROPRIA` 10 e `FABRICANTE PROPRIO` 8.
  - Só 3 fornecedores têm alias restrito ao CNPJ (SIGMETAL; DELVA→VAXX; e o fornecedor da FLEX EQUIPMENT), com 531
    linhas.
  - Para os outros **116 fornecedores** vale o alias global de regex `^(MARCA |ACADEMIA )?P ?ROPR?I[AO0]( |$)`, do tipo
    `nao_marca`, e eles **somem do ranking**.
- **Origem declarada no lugar da marca.** A revenda informa se comprou a mercadoria no mercado nacional ou se é
  importada, sozinho ou junto da marca. Contando por trecho do campo, separado por `/`, ` - `, `,` ou `|`:

  | Origem | Linhas | Fornecedores | Exemplos |
  |---|---|---|---|
  | importado | 135 | 17 | `IMPORT`, `SS ESPORTES/IMPORT`, `PRÓPRIA/IMPORT` |
  | nacional ou importado | 94 | 2 | `Nac/Imp. - Conforme`, `Nac./Importado - Con` (MUEL, NEW FITNESS) |
  | nacional | 40 | 21 | `NACIONAL`, `EXERCIT ESPORTES/NAC` |

  Uma palavra de origem dentro de um nome não é origem: `BRASIL FIT`, `Zuí Brasil`, `Fundidos Brasil` e
  `AAZ IMPORTAÇÃO` são nomes de empresa.
- **Nome de empresa no campo marca.**
  - Às vezes é o nome do próprio vendedor: `Fundidos Brasil` (FUNDIDOS BRASIL COMERCIO E DISTRIBUICOES),
    `METALCO DO BRASIL` e `NEW FITNESS`.
  - Às vezes é de outra empresa, cujos produtos são revendidos: `Zuí Brasil` por 5 revendas, `BRASIL FIT` por 3 e
    `EVA BRASIL` por 2.
  - Às vezes é de outra empresa **do mesmo grupo**: FOR FITNESS declarou `Konnen Fitness`, e FOR FITNESS e KONNEN são
    o mesmo grupo.
- **Marca composta com barra.** São 1.204 linhas (4,7%), e a posição da marca não é fixa:
  - `KONNEN/IMPULSE` é fornecedor/marca: a marca é IMPULSE;
  - `VAXX/DELVA` é marca/fabricante: a marca é VAXX;
  - `SIGMETAL / AR LIVRE` é marca/linha: a marca é SIGMETAL.

  A regra "o lado que é empresa não é marca" falha no caso SIGMETAL.
- **Marca e modelo juntos na revenda** (por exemplo `MOVEMENT EDGE`: Movement é a marca, Edge é o modelo). Das 9.278
  linhas com mais de uma palavra:
  - 3.214 já casam com alias de marca de prefixo;
  - 2.424 são "não é marca" (medida, descrição);
  - **3.640 não têm alias** e entram no ranking com o texto inteiro.
- **Descrição do produto no campo marca** (`caneleira/1kg`, `DUMBELL MONTADO C/ A`, `ANILHAS P/ ACADEMIA`,
  `Aparelho / Equipamen`, `N/A`, `S/M`): não é marca nem fornecedor.
- **Código de modelo passa como marca** quando começa com 5 letras: `ESQUI01` e `MULTI01`. A regra de código da função
  só pega até 4 letras seguidas de dígito (`FTM1`, `ESC01`, `SCM01`).
- **Campo cortado em 20 caracteres na fonte:** `Propria do Fabricant`, `Nac/Imp. Conforme Ed` e `HALTER BOLA EMBORRAC`.
- **Nenhum dos 167 aliases foi revisado à mão:** todos são semente.
- **Cadastro do fornecedor incompleto:** dos 2.711 vencedores nos preços, só 435 estão em `public.fornecedores`, e 292
  deles com nome fantasia. Faltam 2.271 CNPJs de 14 dígitos. Dos 5 CNPJs de FOR FITNESS, KONNEN e SIGMETAL, só 1 está
  cadastrado, e ainda sem sócios.
- **Tela de pendentes lenta:** `v_marca_aliases_pendentes` lê `v_marca_ocorrencias` linha a linha, com 25.465
  chamadas de `private.marca_resolver` (cerca de 6 s), quando bastariam 9.505, uma por par.
  - **Restrição:** `v_marca_ocorrencias` fica **sem** `MATERIALIZED` de propósito (comentário na migration
    `20261005160000`). Com 100 mil vendas sintéticas, `v_fornecedor_marcas` de 1 CNPJ leva 0,27 s sem `MATERIALIZED` e
    6,3 s com.

## Regras confirmadas (Marcelo, 09/10/2026)

1. **Fornecedor:** o vencedor homologado do certame está certo. Não é revisado.
2. **"PRÓPRIA" (qualquer grafia, inclusive `FABRICANTE/PROPRIO` e `academia/ proprio`):** o fornecedor é o fabricante, e
   a marca é a do próprio fornecedor ou do grupo dele.
   - Sem alias com o nome da marca, aparece como **"Marca própria"**, com o fornecedor ao lado (opção a).
   - Um fornecedor pode fabricar e importar, como a NEW FITNESS, e ter itens nas duas versões.
3. **Revenda:** o campo mistura marca e modelo. A marca vem por alias de prefixo, e o modelo não é extraído.
4. **NACIONAL/IMPORTADO não são marca:** são a **origem declarada** da mercadoria. As grafias variam, e o padrão é por
   trecho inteiro.
5. **Marca composta com barra:** o lado que é o próprio fornecedor (ou o grupo dele) não é a marca, como em
   `KONNEN/IMPULSE` → IMPULSE. Confrontar com razão social e nome fantasia do vencedor.
6. **Nome de empresa no campo marca:**
   - do próprio vendedor ou do grupo dele: marca própria;
   - de outra empresa: a empresa de origem do que foi entregue, que funciona como marca.
7. **Descrição do produto no campo marca:** nem marca nem fornecedor ("sem marca declarada").
8. **Grupo de empresas:** razões sociais diferentes podem ser o mesmo grupo. Confirmados:
   - FOR FITNESS (`15563385000172`) + KONNEN EQUIPAMENTOS FITNESS (`09447411000102`);
   - SIGMETAL `50937669000182`, `26576226000129` e `36275431000108`.

## Abordagem proposta

1. **Duas dimensões por linha:** a saída do resolvedor ganha `origem_declarada` (`nacional` | `importado` |
   `nacional_ou_importado` | `nao_informada`) e `tipo_marca`:

   | `tipo_marca` | Quando |
   |---|---|
   | `marca` | Marca resolvida por alias de marca, ou nome de outra empresa |
   | `propria` | "PRÓPRIA" em qualquer grafia, ou nome do próprio vendedor ou do grupo |
   | `sem_marca_declarada` | Só origem, descrição do produto, `N/A`, `S/M` |
   | `codigo_ou_medida` | Código de modelo ou medida (regra atual, ampliada no item 6) |
   | `composta_pendente` | Barra sem lado reconhecido (passo 4.6) |
   | `bruta` | Sem alias (fila de curadoria atual) |

2. **Tabela de grupo:** `public.fornecedor_grupos` (grupo, CNPJ, nome da marca do grupo, `origem` = `manual` |
   `sugestao_confirmada`, `confirmado_por`, `confirmado_em`). É curadoria. A carga inicial são os 2 grupos confirmados.
3. **Origem por trecho:** separar o campo por `/`, ` - `, `,` e `|`.
   - Um trecho que, inteiro, é variante de `NAC`, `NACIONAL`, `IMP`, `IMPORT` ou `IMPORTADO/A`, com o complemento
     opcional "conforme edital/TR", vira origem. O complemento é aceito mesmo cortado: `CON`, `CONF…`, `ED…`.
   - Os outros trechos seguem para a marca.
   - Palavra de origem dentro de um trecho com outras palavras não é origem.
4. **Marca, em ordem:**
   1. **"PRÓPRIA"** em qualquer trecho → `propria`. O nome vem do alias restrito ao CNPJ ou ao grupo; sem alias,
      "Marca própria".
   2. **`X/X`** (trechos iguais depois de normalizados) → um trecho só.
   3. **Trecho que casa com alias de marca** (exato, prefixo ou regex) → `marca` com esse nome. Resolve `VAXX/DELVA` e
      `SIGMETAL / AR LIVRE`.
   4. **Trecho igual à razão social ou ao nome fantasia do vencedor ou de outra empresa do grupo**, comparando sem
      espaço, acento e pontuação (`SS ESPORTES` = `S S ESPORTES`):
      - se há outro trecho que não é origem nem descrição, a marca é o outro trecho (`KONNEN/IMPULSE` → IMPULSE);
      - se não há, `propria` com o nome desse trecho (`Fundidos Brasil`, `NEW FITNESS`, `Konnen Fitness` pela FOR
        FITNESS).
   5. **Trecho "não é marca"** (descrição do produto, `N/A`, `S/M`, medida): descartado. Se não sobra nada,
      `sem_marca_declarada`.
   6. **Sobram 2 ou mais trechos sem decisão** → `composta_pendente`, que vai para a fila "marca composta" com os
      trechos visíveis. Até a curadoria, não entra no ranking como marca.
   7. **Sobra 1 trecho sem alias** → `bruta`, como hoje.
5. **"PRÓPRIA" deixa de ser "não é marca":** o alias global de regex `nao_marca` de "PRÓPRIA" é desativado
   (`ativo = false`, não apagado); a regra 4.1 assume o caso. Os 3 aliases restritos ao CNPJ continuam. Os 2 grupos
   ganham um alias de grupo:
   - FOR FITNESS + KONNEN → KONNEN;
   - SIGMETAL × 3 → SIGMETAL.
6. **Código de modelo:** a regra de código passa a pegar até **8** letras seguidas de dígito, sem espaço (`ESQUI01`,
   `MULTI01`). Isso só depois de conferir, no Postgres descartável, que nenhuma marca real com alias cai na regra.
7. **Fornecedor como fabricante no BI:** quem declara `propria` em algum item recebe a evidência "declarou marca
   própria no certame" em `v_bi_fornecedor_historico` (regra 3 de `docs/bi-cruzamento-apis.md`), com confiança
   `alta_declarado`.
8. **Filas de curadoria (views de leitura, `service_role`):**
   - `v_marca_aliases_pendentes` (bruta) **reescrita a partir dos pares**: conta as linhas por par (marca, CNPJ) na
     tabela de preços, resolve cada par uma vez e agrega. `v_marca_ocorrencias` não muda nem ganha `MATERIALIZED`;
   - `v_marca_propria_sem_nome`: fabricantes com `propria` e sem alias de nome, ordenados por linhas e valor (hoje 116);
   - `v_marca_composta_pendente`: trechos de `composta_pendente` por fornecedor.
9. **Enriquecimento:** o enriquecimento por CNPJ (BrasilAPI, `coletor/fornecedores.py`) passa a cobrir todos os
   vencedores de `precos_praticados_itens`. Hoje cobre 435 de 2.711 (292 com nome fantasia). O nome fantasia é
   necessário para a regra 4.4.
   Sugestão de grupo (mesmo sócio, telefone ou endereço) fica fora: ver "Fora de escopo".

## Critérios de aceite

| ID | Dado / Quando / Então | Teste que prova |
|---|---|---|
| CA-1 | **Dado** `PROPRIA`, `Própria/Própria`, `MARCA PRÓPRIA`, `FABRICANTE/PROPRIO`, `academia/ proprio` e `P´RÓPRIA/IMPORT` de um CNPJ sem alias, **então** `tipo_marca = propria`, a marca é "Marca própria" e entra no ranking. Para o CNPJ da SIGMETAL, a marca é SIGMETAL. | SQL `supabase/tests/marca_regras_check.sql` |
| CA-2 | **Dado** `SS ESPORTES/IMPORT`, **então** a marca é SS ESPORTES e a origem é `importado`. **Dado** `Nac/Imp. - Conforme`, **então** `sem_marca_declarada` e `nacional_ou_importado`. **Dado** `NACIONAL`, **então** `sem_marca_declarada` e `nacional`. | idem |
| CA-3 | **Dado** `BRASIL FIT`, `Zuí Brasil` ou `AAZ IMPORTAÇÃO`, **então** a origem é `nao_informada` e o texto segue para a marca. | idem |
| CA-4 | **Dado** `KONNEN/IMPULSE` vendido pelo CNPJ `09447411000102`, **então** a marca é IMPULSE. **Dado** `Konnen Fitness` vendido pelo `15563385000172` (mesmo grupo), **então** `propria` com marca KONNEN. | idem |
| CA-5 | **Dado** `VAXX/DELVA` e `SIGMETAL / AR LIVRE` vendidos por terceiros, **então** as marcas são VAXX e SIGMETAL (alias). **Dado** `FUNDIBAN/FUNDIBAN`, **então** FUNDIBAN. | idem |
| CA-6 | **Dado** `Fundidos Brasil` vendido por FUNDIDOS BRASIL COMERCIO E DISTRIBUICOES (nome fantasia "FUNDIDOS BRASIL"), **então** `propria`. **Dado** `Zuí Brasil` vendido por PROFIT ENTERPRISE, **então** `marca` (empresa de origem). | idem |
| CA-7 | **Dado** `caneleira/1kg`, `DUMBELL MONTADO C/ A`, `N/A` ou `S/M`, **então** `sem_marca_declarada` e fora do ranking. | idem |
| CA-8 | **Dado** `ESQUI01` e `MULTI01`, **então** `codigo_ou_medida`. Nenhuma marca com alias ativo muda de `tipo_marca` pela regra nova (conferido com os 167 aliases). | idem |
| CA-9 | **Dado** dois trechos sem alias, sem nome do vendedor e que não são origem nem descrição (por exemplo `PENALTY/CAMBUCI` sem alias), **então** `composta_pendente`, fora do ranking e na `v_marca_composta_pendente`. | idem |
| CA-10 | `v_marca_aliases_pendentes` reescrita devolve as mesmas linhas da versão atual (mesmas colunas e valores) num banco de teste, e chama `marca_resolver` uma vez por par, não por linha. | idem + medição antes/depois no PR |
| CA-11 | `v_fornecedor_marcas` de 1 CNPJ continua sem resolver os outros pares (tempo da mesma ordem do atual no teste com 100 mil vendas sintéticas). | medição no PR |
| CA-12 | `fornecedor_grupos` e as views novas: sem grant para `anon`/`authenticated`; escrita só `service_role`; RLS ligada. | SQL `supabase/tests/marca_regras_check.sql` |
| CA-13 | Contagem antes/depois em produção (dry-run por consulta, sem gravar): linhas por `tipo_marca` e `origem_declarada`, fornecedores no ranking, e os 116 fabricantes que voltam ao ranking como "Marca própria". | verificação no PR |

## Fora de escopo

- **Sugestão automática de grupo** (mesmo sócio, telefone, e-mail ou endereço): só depois do enriquecimento cobrir
  todos os vencedores. O e-mail da SIGMETAL, por exemplo, é de escritório de contabilidade, então esse sinal sozinho
  gera vínculo falso. Vira spec própria.
- **Extrair o modelo** do texto da revenda: a fonte não tem campo de modelo e não há dicionário. Só a marca, por alias.
- **Preços fora de escala** que inflam `valor_total`: 79 linhas com preço unitário ≥ R$ 100 mil ou linha ≥ R$ 3 milhões,
  que somam R$ 219,7 milhões de R$ 629,4 milhões. Exemplo: bola de vôlei a R$ 7.900.000. É erro da fonte e vai para uma
  issue própria (sinalização, não correção).
- **Paradigma/SFIEC** como segunda fonte de marca (ponto de extensão da `v_marca_ocorrencias`).
- **Front** da curadoria.

## Impacto em dados

- **Migrations:** aditivas e idempotentes.
  - `<ts>_marca_regras.sql`: `fornecedor_grupos` com os 2 grupos confirmados, nova versão de `private.marca_resolver`
    (mesma assinatura e colunas atuais, mais `tipo_marca` e `origem_declarada`), recriação das views mantendo as colunas
    atuais e acrescentando as novas no fim, `v_marca_propria_sem_nome`, `v_marca_composta_pendente` e
    `v_marca_aliases_pendentes` a partir dos pares.
  - `<ts>_marca_aliases_propria.sql`: desativa (não apaga) o alias global `nao_marca` de "PRÓPRIA" e cria os aliases de
    grupo KONNEN e SIGMETAL.
  - Validadas com a skill `validar-migrations`.
- **Tabelas:**
  - escritas: `fornecedor_grupos` (nova) e `marca_aliases` (1 desativação e 2 inclusões);
  - lidas: `precos_praticados_itens`, `fornecedores` e `marca_aliases`.
- **ACL/RLS:** tabela e views novas só para `service_role`, como as atuais.
- **Contrato com o Dashboard:**
  - `v_fornecedor_marcas` e `v_fornecedor_marcas_ranking` mudam de **valor**: entram os 116 fabricantes como "Marca
    própria", e saem itens que eram texto de origem ou descrição;
  - colunas novas no fim, nenhuma removida;
  - `api-fornecedores-homologados` (marca_1..3) mostra a diferença.
- **Coletor:** enriquecimento dos 2.271 CNPJs que faltam, a 1 req/s na BrasilAPI (cerca de 38 min), em lotes.
- **Dado oficial x derivado:**
  - **oficial:** o texto `marca`, o fornecedor e o nome fantasia da Receita;
  - **derivado:** `tipo_marca`, `origem_declarada` e a marca resolvida, com o método visível;
  - **curadoria:** grupos e aliases;
  - nada é inventado. Sem alias, aparece "Marca própria" ou o texto da fonte, nunca um nome suposto.

## Perguntas em aberto

1. **Enriquecimento:** rodar o enriquecimento dos 2.271 CNPJs que faltam junto desta spec (a regra 4.4 depende do nome
   fantasia) ou antes, como passo separado?
2. **Regra de código de 8 letras (item 6):** liberar já, ou só depois de você ver a lista de valores que mudariam de
   "marca" para "código"?
