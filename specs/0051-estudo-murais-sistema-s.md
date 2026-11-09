# 0051: Estudar o que cada mural do Sistema S expõe, com o Chrome DevTools, antes da matriz de catálogos

- **Status:** rascunho
- **Alimenta:** spec 0053 (K-5, matriz de uso do catálogo por portal e unidade compradora), que alimenta a fase 3 da
  spec-mãe 0032. Sem esta, a matriz não sabe de onde tirar o catálogo de cada portal.
- **Repositório:** LicitaGym
- **Issue:** nenhuma
- **Área:** coletor (estudo) | docs
- **Depende do ok do Marcelo:** sim (decisão de produto sobre quais fontes estudar e acesso a portais com robots.txt
  restritivo)

## Leitura obrigatória antes de executar

| # | Arquivo | Por quê |
|---|---|---|
| 5 | `specs/0053-catalogo-sistema-s-de-para-catmat.md` | o que a matriz precisa (K-5) e as decisões de 08/11 |
| 6 | `specs/murais_sistema_s.xlsx` | inventário dos murais e colunas a preencher |
| 7 | `.claude/rules/coletor.md`, `.claude/rules/python-ingestion.md` | regras de coleta (intervalo, bloqueio, só dado público) |
| 8 | `services/coletor-externo/coletor/paradigma.py` (docstring: métodos do webservice, decisão de acesso de 05/10, `FONTES`, `FONTES_MURAL_AUTORIZADO`) | o que já se sabe dos portais Paradigma |
| 8 | `services/coletor-externo/coletor/catalogo_paradigma.py` | extrator do catálogo (PR #490) |
| 8 | `services/coletor-externo/README.md` (seções Paradigma e Catálogo) | validações anteriores por portal |
| 8 | `supabase/migrations/20260925120000_sistema_s_coleta_externa.sql` | cadastro `fontes_externas` |
| 10 | skill `chrome-devtools-mcp:chrome-devtools` | uso do MCP do DevTools |
| 10 | agentes `revisor-codigo`, `revisor-seguranca` | revisão do script de checagem da planilha |

## Problema (medido em 08/11/2026)

| Fato | Evidência |
|---|---|
| 19 fontes cadastradas; 15 na Paradigma, 2 em portal RLC/RCA, 1 WordPress, 1 manual | `fontes_externas` (MCP somente leitura) |
| Só 10 portais Paradigma têm licitação no banco | `licitacoes_externas`: fieb 155, sesc_senac_rs 126, firjan 83, sescba 55, fiesc 64, sescsp 22, fiergs 22, sestsenat 11, findes 5, sfiec 3, sescrj 3 |
| FIEMS, FIEMT e Sesc DN (Paradigma) estão cadastrados e sem nenhuma licitação no banco | mesma consulta |
| FIEMG fica de fora | `modo_coleta = bloqueado` (Cloudflare recusa cliente automatizado; não se contorna) |
| Pelo menos 10 Sesc regionais com página de licitação não estão no cadastro | domínios em resultados de busca de 08/11/2026 (CE, DF, PE, AL, TO, PI, SC, MT, SE, RN); plataforma não identificada |
| Catálogo lido em um portal só | Sesc DN, 08/11/2026: 131 produtos em PT030 e ES1205 |
| Quais telas e tabelas cada mural expõe (mural, mural estatístico, catálogo, detalhe, lances, anexos) | não medido, exceto SFIEC e FIESC (validados em 09/2026) e o catálogo do Sesc DN |

## Contrato

| ID | Contrato | Entrada | Saída | Erros | Quem |
|---|---|---|---|---|---|
| K-1 | Planilha `specs/murais_sistema_s.xlsx` | cadastro e contagens do banco | aba **Murais**: uma linha por portal (cadastro, URLs do mural e do catálogo, situação no banco e colunas do estudo); aba **Tabelas**: uma linha por chamada observada (tela, método, payload, campos, paginação, código interno); aba **Legenda** | — | gerada nesta spec; preenchida no estudo |
| K-2 | Roteiro do estudo com o MCP do Chrome DevTools, por mural | URL do mural e do catálogo | para cada tela pública (Mural, Mural estatístico, Catálogo, detalhe de um processo encerrado): requisições `Servicos.asmx` (ou equivalentes) com método, payload, campos da resposta e paginação; registro na aba Tabelas | portal que pede login ou recusa (401/403, WAF): `status_estudo = bloqueado`, sem tentar contornar | operador com o navegador (Marcelo ou sessão Claude com o MCP), uma página por vez |
| K-3 | Amostras | respostas observadas | arquivo por chamada **fora do repositório** (pasta local), com o caminho anotado na aba Tabelas | — | operador |
| K-4 | Checagem da planilha (`scripts/checar_murais.py`) | a planilha | erro se: slug Paradigma do cadastro sem linha; `url_base` diferente de `FONTES` em `paradigma.py`; mural com `status_estudo = concluído` sem nenhuma linha na aba Tabelas; FIEMG com status diferente de "não estudar (WAF)" | lista de divergências, saída diferente de zero | CI não; roda à mão antes de fechar o estudo |
| K-5 | Relatório do estudo (seção nova em `specs/0053-...md`) | planilha preenchida | por portal: tem catálogo público? código interno? formato? mesmo catálogo de outro portal (código e descrição)? ; recomendação de quais fontes entram na 0053 | — | autor do estudo; Marcelo decide |

## Critérios de aceite

| ID | Contrato | Dado / Quando / Então | Teste que prova |
|---|---|---|---|
| CA-1 | K-1 | **Dado** a planilha gerada, **então** tem uma linha para cada fonte do cadastro (19) e para cada portal não cadastrado (10), com `status_estudo` preenchido e FIEMG como "não estudar (WAF)" | pytest `tests/test_checar_murais.py` |
| CA-2 | K-4 | **Dado** uma `url_base` diferente da de `FONTES` em `paradigma.py`, **quando** a checagem roda, **então** aponta a divergência e sai com código diferente de zero | mesmo pytest |
| CA-3 | K-4 | **Dado** um mural `concluído` sem linha na aba Tabelas, **quando** a checagem roda, **então** aponta e falha | mesmo pytest |
| CA-4 | K-2 | **Dado** um portal que pede login ou responde 401/403, **então** fica `bloqueado` com o motivo, e nenhuma linha da aba Tabelas vem de área logada | revisão da planilha pelo `revisor-seguranca` antes do fechamento |

## Skills e agentes por contrato

| Contrato | Desenho e leitura | Execução | Teste | Revisão | Depois |
|---|---|---|---|---|---|
| K-1, K-4 | `/spec` | `/implement` (script e teste) | pytest | `revisor-codigo` | — |
| K-2, K-3 | `/spec` | skill `chrome-devtools-mcp:chrome-devtools` | CA-4 | `revisor-seguranca` (área pública, nenhum segredo nas amostras) | — |
| K-5 | `/spec` | autor do estudo | — | Marcelo | atualiza a 0053 |

## Regras do estudo

- Só páginas públicas. Sem login e sem o cadastro de visitante: o arquivo exige visitante em alguns portais (SFIEC), e
  o estudo para nesses casos.
- Bloqueio de WAF não se contorna (FIEMG). Portais do paradigmabs com robots.txt restritivo seguem a decisão de
  05/10/2026 (webservice público do mural, mesmo intervalo do adaptador); portal fora dessa lista com robots.txt
  restritivo fica `bloqueado` até decisão do Marcelo.
- Navegação humana, uma página por vez; nada de laço automático pelo DevTools. A coleta em volume continua sendo do
  coletor (`catalogo_paradigma.py`), com `DELAY_SEGUNDOS >= 1`.
- Amostras e respostas ficam fora do repositório. CPF ou nome de pessoa que aparecer numa resposta não vai para a
  planilha.

## Fora de escopo

- Coletar o catálogo completo de cada portal para o banco (é a 0053, K-1 e K-2).
- Escrever adaptador para portal fora da Paradigma (RLC/RCA, WordPress, Sesc regionais com sistema próprio).
- Cadastrar os portais novos em `fontes_externas` (migration própria, depois do estudo).

## Impacto em dados

- **Migration:** não.
- **Tabelas/views/funções tocadas:** nenhuma (leitura de `fontes_externas`, `licitacoes_externas` e `licitacao_itens`
  para a planilha).
- **ACL/RLS:** nenhum.
- **Backfill/reprocessamento:** não.
- **Edge Functions republicadas no merge:** todas (regra do repositório); nenhuma muda.
- **Contrato com o Dashboard:** inalterado.
- **Dado oficial × derivado:** a planilha registra o que cada portal expõe, com data; nenhum valor de licitação nem
  dado pessoal.

## Perguntas em aberto

1. **Ordem do estudo.** Começar pelos 3 portais Paradigma sem licitação no banco (FIEMS, FIEMT, Sesc DN) e pelos 10
   Sesc regionais não cadastrados, ou pelos 10 que já têm licitação (onde a matriz já tem os itens)?
2. **Quem executa.** O MCP do Chrome DevTools roda no seu navegador. Faço o estudo nesta sessão (você aprova cada
   portal), ou você executa seguindo o roteiro?
3. **Portais não Paradigma com robots.txt restritivo** (se aparecerem entre os Sesc regionais): mesma decisão de
   05/10 (webservice público autorizado) ou ficam `bloqueado`?
