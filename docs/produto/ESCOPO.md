# Escopo do LicitaGym

<!-- Documento guarda-chuva. Toda spec nova aponta para uma fase daqui. Mudança neste arquivo exige ok do Marcelo. -->

- **Dono:** Marcelo Rosas
- **Spec-mãe em execução:** `specs/0032-agentes-dentro-da-tarefa.md`
- **Revisão:** a cada spec fechada (skill `ciclo-janelas`)

## Objetivo final
Para cada oportunidade no pipeline, os agentes de **edital**, **preço** e **jurídico** trabalham dentro das tarefas da
oportunidade: o usuário clica "Analisar", recebe achados com fonte, trecho e página, e aprova ou rejeita.
A equipe decide entrar no certame com base no preço mínimo dos seus produtos e chega à disputa sem perder sessão.

## Para quem
Fornecedor de equipamentos de musculação que disputa licitações públicas. Cliente atual: Konnen
(KONNEN EQUIPAMENTOS FITNESS, marcas Konnen/Impulse). Papéis no tenant: `admin` e `operacao`.

## Módulos e fases

| # | Módulo | O que entrega | Specs | Situação |
|---|---|---|---|---|
| 1 | Radar de oportunidades | licitações abertas aderentes ao catálogo de produtos do tenant, julgadas pelo texto do TR (CATMAT como apoio), com prioridade | 0006, 0023–0030 | no ar, em ajuste |
| 2 | Pipeline e tarefas | etapas por tenant, tarefas padrão por etapa e por certame | 0017–0019 | no ar |
| 3 | **Agentes na tarefa** | edital (com aderência), preço, jurídico dentro do cartão da tarefa | **0032** (fases 1–4) | **agora** |
| 4 | Proposta | marca, modelo e preço por item, guardados na etapa Proposta | (spec a criar) | próximo |
| 5 | Alerta de disputa | aviso da convocação para lance fechado: push no celular, e-mail, navegador; extensão no operador | 0039 (`parada`) | próximo |
| 6 | Sessão do certame | chat da sessão do Compras.gov como aba do certame (fonte: Integra Compras, Serpro) | 0039 (`parada`) | próximo |
| 7 | Inteligência de sessão | motivos recorrentes de desclassificação; chamadas de negociação; reavaliações; desconto médio estimado → homologado por item | 0039 (`parada`, fonte); análise a especificar | depois |
| 8 | Base de treino dos agentes | licitações homologadas com Edital/TR/ETP + chat da sessão do portal oficial | (spec a criar) | depois |
| 9 | Preços e BI | preço, marca e fornecedor de compra homologada | 0009, 0014, 0031 (citada na 0032; o arquivo ainda não está na `main`) | no ar; a 0031 alimenta a fase 3 da 0032 |
| 10 | Robô de lances | extensão no navegador do operador logado; lance por regra determinística dentro do piso, com o valor final mínimo nativo como rede de segurança | 0039 (`parada`) | depois da fase 3 da 0032 |

**Regra de foco:** enquanto a 0032 não terminar a fase 3, spec nova só entra se alimentar uma fase da 0032.
As outras ficam com status `parada` e uma linha nesta tabela.

## Evidência da decisão "TR primeiro" (20/10)
Dispensa 311/2026 da BAvT (#2691). O TR pede leg press horizontal, cadeira flexora e piso emborrachado de 15 mm, mas o
órgão cadastrou os CATMAT 623742 (multi estação ao ar livre), 628720 (banco regulável) e 620884 (piso de 3 mm), e o
próprio TR cita o 641560, que no CATMAT é barra olímpica. O TR diz que prevalece sobre o CATMAT. Pelo catálogo CATMAT
da empresa, o item 1 ficaria fora e ainda cairia na regra de "ar livre", embora seja um leg press.

## Fora de escopo
- Academia ao ar livre (multi estação "ar livre", academia de praça).
- Contrato de serviço: credenciamento, locação, manutenção, obra, oficineiros.
- Login em portal de compras; coleta que exige captcha.
- Modelo de IA decidindo sozinho: agentes rodam por regra (`metodo = regra`) e humano aprova.
- AWS (Cognito, RDS, S3) e Asaas.

## Fontes de dados
Portal oficial da disputa (indicado no edital) é a fonte primária; PNCP é alternativa quando o portal não pode ser lido.
Detalhe em `AGENTS.md`.

## Decisões registradas
| Data | Decisão |
|---|---|
| 09/10 | Preço, marca e fornecedor só de compra homologada, com fonte e data (spec 0009) |
| 11/10 | Regras de operação R1–R4 (revisores, fechamento de spec, ciclo de janelas) |
| 19/10 | Agentes só no botão "Analisar"; admin e operação aprovam; caso de aceite #3558 (controle #3641) |
| 20/10 | Academia ao ar livre fora de escopo (confirmado); "ar livre" desqualifica o item pelo texto do TR/edital |
| até 20/10 | Portal oficial é a fonte primária; PNCP é alternativa |
| 20/10 | Produto multi-tenant, configurado por metadados na interface, não por código |
| 20/10 | Catálogo do tenant por CSV de layout único (colunas aprovadas, atributos como `atr:<nome>`), em `/configuracoes/catalogo` |
| 20/10 | Catálogo, escopo CATMAT e ficha de produto ficam em `/configuracoes` |
| 20/10 | Visões salvas de filtro são da equipe do tenant |
| até 20/10 | Homologadas com documentos e chat da sessão são o núcleo do treino dos agentes |
| 20/10 | **TR primeiro, CATMAT como suporte.** O catálogo CATMAT deixa de ser a fonte da verdade do escopo: os órgãos erram o enquadramento com frequência (evidência: Dispensa 311/2026 da BAvT, #2691). Divergência TR × CATMAT vira achado |

## Decisões pendentes
<!-- Itens que estavam como CONFIRMAR no CLAUDE.md antigo. Resolvido → vai para "Decisões registradas" e para
     .claude/rules/regras-negocio.md. -->
- **Mesma compra publicada duas vezes no PNCP:** tratar como uma só pela chave `(orgao_cnpj, processo_norm,
  numero_edital)` na view `licitacoes_pncp_canonica`?
- **Sistema S:** precisa de fase, prazo ou tarefa própria (RLC/RCA), ou segue a 14.133?
- **Taxonomia:** os JSON `taxonomia-pisos-v0.2.json` e `dicionario-aparelhos-v0.3.json` continuam fonte da verdade ou
  passam a derivar do catálogo de produtos do tenant (issue #272)?
- **Piso de borracha:** continua no escopo de oportunidade da Konnen ou vira escopo de outro tenant?
