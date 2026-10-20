# Regras de negócio do LicitaGym

<!-- Sem `paths:`: carrega em toda sessão. Só regra estável e decidida pelo Marcelo.
     Item ainda não decidido fica em docs/produto/ESCOPO.md > "Decisões pendentes", não aqui. -->

## Escopo do que é oportunidade
- **O código CATMAT do item não basta para decidir escopo.** O órgão pode cadastrar um CATMAT que não corresponde ao
  que o Termo de Referência descreve, e o TR prevalece quando diverge do CATMAT (cláusula comum nos TRs federais).
  Em caso de divergência, vale o texto do TR. O desenho do escopo por catálogo está em revisão
  (ver `docs/produto/ESCOPO.md` > Decisões pendentes).
- Demanda principal: objeto do tipo "AQUISIÇÃO DE EQUIPAMENTO DE MUSCULAÇÃO".
- CATMAT núcleo 78/7830, extensão curada 72/7220, sem misturar automaticamente.
- **Academia ao ar livre está fora de escopo** (multi estação "ar livre", academia de praça). Termos de "ar livre"
  desqualificam o item quando aparecem no texto do TR ou do edital, não só na descrição do código CATMAT.
- Contrato de serviço (credenciamento, locação, manutenção mesmo com peças, obra, oficineiros) nunca vira lead.
- Termo de busca sozinho não torna a linha `forte`.
- Classificação de equipamento: Musculação, Cárdio ou Acessórios; determinística, idempotente, editável à mão.
- Piso de borracha SBR/EPDM = prioridade alta; piso modular PP/TPE = sinal de concorrente.

## Prioridade da oportunidade
- `leads` (recebendo proposta), `monitorar` (em julgamento), `historico` (encerrada, homologada, cancelada).
- A view `licitacoes_externas_prioridade_efetiva` só rebaixa: sinal de encerramento → `historico`; prazo vencido
  (horário de Brasília) → `monitorar`. Status desconhecido nunca vira lead; falha de API nunca vira `historico`.

## Preço, marca e fornecedor
- Vêm só de compra homologada, sempre com fonte e data.
- Agente de preço: preço homologado histórico do item numa janela de 12 a 24 meses, conforme o último registro.

## Pipeline e agentes
- Oportunidade entra no pipeline só pela ação "Enviar para pipeline"; descartar exige motivo.
- Agentes (edital, preço, jurídico; aderência faz parte do edital) rodam **só no botão "Analisar"**, nunca ao entrar
  na etapa. Cada achado traz fonte, trecho e página.
- Admin e operação aprovam ou rejeitam achados; rejeitar exige nota.
- O agente de edital sempre informa o portal oficial da disputa.
- A proposta da empresa (marca, modelo e preço por item) é montada e guardada na etapa Proposta do pipeline.

## Tenant e papéis
- Admin da plataforma: `app_metadata.licitagym_role = 'admin'`. No tenant: `admin` ou `operacao`
  (`operacao` não vê dados bancários).
- Todo `service_role` que lê tabela com `tenant_id` filtra pela empresa de quem chama (`_shared/tenant.ts`).
  Vínculo inválido ou empresa desativada → 403, nunca cai em outra empresa.
- Tabela com RLS e sem policy é intencional: o cliente lê só via Edge Function.

## Habilitação
Documento sem validade informada vale emissão + 90 dias (marcado como calculado). Certidão de falência e balanço
não são sanáveis.
