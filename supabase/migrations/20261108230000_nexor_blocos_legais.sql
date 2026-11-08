-- Nexor, Fase 0 (PR 3b): blocos legais do edital (matriz bloco × procedimento da Lei 14.133).
--
-- Por quê: a planilha da spec (specs/nexor_spec.xlsx, aba Padrao_Lei) mapeia os 22 blocos que um edital da Lei 14.133
-- deve ter, por procedimento (pregão, concorrência, dispensa, inexigibilidade, credenciamento): se o bloco é obrigatório,
-- condicional ou não se aplica, o prazo legal (quantidade, unidade, antes/depois de qual evento) e a confiança da
-- pesquisa. norma_dispositivos guarda o texto do artigo; a matriz não existia (specs/nexor-fase0-mapa.md, legal_blocks).
--
-- O que muda:
--   public.blocos_legais  110 linhas (22 blocos × 5 procedimentos), regime lei_14133. Só o pregão tem o detalhe da
--                         seção 2 (condição, base legal, parte obrigada, temas para o RAG, variações por regime/UF); nos
--                         outros procedimentos esses campos ficam null (não pesquisado, não inventado).
--
-- Quem lê e escreve: escrita só por migration (bloco gerado por scripts/import-spec.ts --bloco=blocos). Leitura só
-- service_role (agentes, nas fases seguintes). Cliente não lê direto. Nada lê a tabela ainda.
--
-- Verificar: supabase/tests/nexor_blocos_legais_check.sql; tests/supabase/scripts/import_spec_test.ts confere que o
-- bloco gerado abaixo é igual ao que o script produz hoje.
-- Idempotente.

begin;

create table if not exists public.blocos_legais (
  regime_id        text not null references public.regimes (id) on delete restrict,
  procedimento     text not null
    check (procedimento in ('pregao', 'concorrencia', 'dispensa', 'inexigibilidade', 'credenciamento')),
  bloco            text not null check (bloco ~ '^[a-z0-9_]+$'),
  ordem            smallint not null check (ordem > 0),
  status           text not null check (status in ('obrigatorio', 'condicional', 'nao_aplica')),
  prazo_quantidade integer check (prazo_quantidade >= 0),
  prazo_unidade    text check (prazo_unidade in ('du', 'dc', 'h', 'min', 'meses', 'anos')),
  prazo_sentido    text check (prazo_sentido in ('antes', 'depois')),
  prazo_ancora     text check (prazo_ancora ~ '^[a-z0-9_]+$'),
  confianca        text not null check (confianca in ('alta', 'media', 'baixa')),
  condicao         text check (btrim(condicao) <> ''),
  base_legal       text check (btrim(base_legal) <> ''),
  parte_obrigada   text check (parte_obrigada in ('orgao', 'licitante')),
  temas_rag        text[],
  variacoes        text check (btrim(variacoes) <> ''),
  fonte            text not null default 'specs/nexor_spec.xlsx#Padrao_Lei',
  atualizado_em    timestamptz not null default now(),
  primary key (regime_id, procedimento, bloco),
  constraint blocos_legais_prazo_coerente check (
    (prazo_quantidade is null) = (prazo_unidade is null)
    and (prazo_sentido is null) = (prazo_ancora is null)
    and (prazo_quantidade is null or prazo_sentido is not null)
    and (status <> 'nao_aplica' or prazo_quantidade is null)
  )
);

comment on table public.blocos_legais is
  'Blocos do edital por regime e procedimento (Padrao_Lei, seções 1 e 2): status, prazo legal e confiança da pesquisa. '
  'Escrita só por migration gerada de specs/nexor_spec.xlsx.';
comment on column public.blocos_legais.prazo_quantidade is
  'Prazo legal do bloco; null = sem prazo numérico na pesquisa. Com prazo_sentido e prazo_ancora sem quantidade: '
  'prazo "até o evento" (ex.: proposta até a abertura da sessão).';
comment on column public.blocos_legais.prazo_unidade is
  'du = dias úteis, dc = dias corridos, h, min, meses, anos.';
comment on column public.blocos_legais.prazo_ancora is
  'Evento de referência do prazo, como escrito na planilha (ex.: abertura_sessao, declaracao_vencedor).';
comment on column public.blocos_legais.confianca is
  'Confiança da pesquisa da planilha (alta, media, baixa); não é confiança do modelo.';
comment on column public.blocos_legais.condicao is
  'Detalhe da seção 2 (só pregão). Alguns textos terminam em "…": vieram cortados na própria planilha.';

alter table public.blocos_legais enable row level security;

-- Escrita só por migration (dono da tabela). service_role só lê.
revoke all on table public.blocos_legais from anon, authenticated, service_role, public;
grant select on table public.blocos_legais to service_role;

-- >>> gerado por scripts/import-spec.ts --bloco=blocos: não editar à mão
insert into public.blocos_legais (regime_id, procedimento, bloco, ordem, status, prazo_quantidade, prazo_unidade,
  prazo_sentido, prazo_ancora, confianca, condicao, base_legal, parte_obrigada, temas_rag, variacoes) values
  ('lei_14133', 'pregao', 'preambulo_quadro_datas', 1, 'obrigatorio', 8, 'du', 'antes', 'abertura_sessao', 'alta', 'Prazo mínimo entre divulgação do edital e propostas: 8 du para bens e 10 du para serviços comuns e obras/serviços comuns de engenharia, menor preço ou maior desconto (art. 55). Data e hora da sessão em horário de Brasília (IN 73 …', 'Lei 14.133 art. 25 caput, art. 54 (PNCP; extrato no DOU/jornal, §1º), art. 55; IN SEGES 73/2022 arts. 14, 17, 48', 'orgao', array['quadro_de_datas', 'prazo_minimo_propostas', 'publicidade_pncp', 'horario_brasilia']::text[], 'Lei 14.981/2024 (calamidade, com ato autoriza; Lei 13.303/2016 (estatais); Sesc/Senac (Res. 1.593/2024 e 1.270/2024); Pernambuco (Decreto 54.142/2022)'),
  ('lei_14133', 'concorrencia', 'preambulo_quadro_datas', 1, 'obrigatorio', 8, 'du', 'antes', 'abertura_sessao', 'alta', null, null, null, null, null),
  ('lei_14133', 'dispensa', 'preambulo_quadro_datas', 1, 'condicional', 3, 'du', 'antes', 'abertura_propostas_lances', 'alta', null, null, null, null, null),
  ('lei_14133', 'inexigibilidade', 'preambulo_quadro_datas', 1, 'nao_aplica', null, null, null, null, 'media', null, null, null, null, null),
  ('lei_14133', 'credenciamento', 'preambulo_quadro_datas', 1, 'obrigatorio', null, null, null, null, 'media', null, null, null, null, null),
  ('lei_14133', 'pregao', 'objeto', 2, 'obrigatorio', null, null, null, null, 'alta', 'Pregão obrigatório quando o objeto tem padrões de desempenho e qualidade objetivamente definíveis por especificações usuais de mercado; não se aplica a serviços técnicos especializados predominantemente intelectuais e a obras e s…', 'Lei 14.133 art. 25 caput; art. 29 e art. 6º, XLI (pregão: bens e serviços comuns); art. 6º, XXI, a (serviços comuns de engenharia)', 'orgao', array['objeto', 'item_grupo_global', 'especificacao_usual_de_mercado']::text[], null),
  ('lei_14133', 'concorrencia', 'objeto', 2, 'obrigatorio', null, null, null, null, 'alta', null, null, null, null, null),
  ('lei_14133', 'dispensa', 'objeto', 2, 'obrigatorio', null, null, null, null, 'alta', null, null, null, null, null),
  ('lei_14133', 'inexigibilidade', 'objeto', 2, 'obrigatorio', null, null, null, null, 'alta', null, null, null, null, null),
  ('lei_14133', 'credenciamento', 'objeto', 2, 'obrigatorio', null, null, null, null, 'alta', null, null, null, null, null),
  ('lei_14133', 'pregao', 'valor_estimado_sigilo', 3, 'obrigatorio', 6, 'meses', 'antes', 'divulgacao_edital', 'alta', 'Estimativa compatível com o mercado; sigilo facultativo, justificado e sem prejuízo da divulgação dos quantitativos; sigilo não vale para órgãos de controle; no maior desconto o preço estimado ou máximo consta do edital (art. 24 …', 'Lei 14.133 arts. 23 e 24; IN SEGES 73/2022 art. 12', 'orgao', array['valor_estimado', 'orcamento_sigiloso', 'pesquisa_precos', 'maior_desconto_valor_no_edital']::text[], 'Ceará (Decreto 36.863/2025, alterando o 35.06; São Paulo (Decreto 67.888/2023, art. 6º); Lei 13.303/2016 (estatais), art. 34; Minas Gerais (Resolução Seplag 10…'),
  ('lei_14133', 'concorrencia', 'valor_estimado_sigilo', 3, 'obrigatorio', 6, 'meses', 'antes', 'divulgacao_edital', 'alta', null, null, null, null, null),
  ('lei_14133', 'dispensa', 'valor_estimado_sigilo', 3, 'obrigatorio', null, null, null, null, 'media', null, null, null, null, null),
  ('lei_14133', 'inexigibilidade', 'valor_estimado_sigilo', 3, 'obrigatorio', 1, 'anos', 'antes', 'contratacao', 'media', null, null, null, null, null),
  ('lei_14133', 'credenciamento', 'valor_estimado_sigilo', 3, 'condicional', null, null, null, null, 'media', null, null, null, null, null),
  ('lei_14133', 'pregao', 'participacao_impedimentos', 4, 'obrigatorio', 3, 'du', 'antes', 'recebimento_propostas', 'media', 'Impedimentos do art. 14 incluem condenação transitada em julgado nos 5 anos anteriores à divulgação do edital por trabalho infantil, escravo ou adolescentes em casos vedados. Credenciamento prévio no Sicaf (IN 73 art. 13).', 'Lei 14.133 art. 14 (inciso IV: proibição de vínculo deve constar do edital), art. 15 (consórcio); IN SEGES 73/2022 arts. 13 e 38', 'licitante', array['impedimentos_art_14', 'sicaf', 'consorcio', 'conflito_interesses']::text[], 'Pernambuco (Decreto 54.142/2022, art. 44, IV,'),
  ('lei_14133', 'concorrencia', 'participacao_impedimentos', 4, 'obrigatorio', 3, 'du', 'antes', 'recebimento_propostas', 'media', null, null, null, null, null),
  ('lei_14133', 'dispensa', 'participacao_impedimentos', 4, 'obrigatorio', null, null, null, null, 'media', null, null, null, null, null),
  ('lei_14133', 'inexigibilidade', 'participacao_impedimentos', 4, 'condicional', null, null, null, null, 'baixa', null, null, null, null, null),
  ('lei_14133', 'credenciamento', 'participacao_impedimentos', 4, 'obrigatorio', null, null, null, null, 'media', null, null, null, null, null),
  ('lei_14133', 'pregao', 'me_epp', 5, 'condicional', 5, 'du', 'depois', 'declaracao_vencedor', 'media', 'Aplica-se quando couber. Regularidade fiscal e trabalhista da ME/EPP só exigida para a assinatura do contrato (LC 123 art. 42). Empate ficto: até 10%, no pregão até 5% (art. 44). Itens até R$ 80.000,00 exclusivos (art. 48, I; tex…', 'Lei 14.133 art. 4º §§1º-3º e art. 60 §2º; LC 123/2006 arts. 42-49 (art. 43 §1º, art. 44, art. 45 §3º, art. 48)', 'licitante', array['me_epp_exclusividade', 'empate_ficto', 'regularizacao_fiscal_5_du', 'cota_25']::text[], 'Caruaru-PE e Macaé-RJ (editais reais 2025)'),
  ('lei_14133', 'concorrencia', 'me_epp', 5, 'condicional', 5, 'du', 'depois', 'declaracao_vencedor', 'media', null, null, null, null, null),
  ('lei_14133', 'dispensa', 'me_epp', 5, 'condicional', null, null, null, null, 'baixa', null, null, null, null, null),
  ('lei_14133', 'inexigibilidade', 'me_epp', 5, 'nao_aplica', null, null, null, null, 'baixa', null, null, null, null, null),
  ('lei_14133', 'credenciamento', 'me_epp', 5, 'condicional', null, null, null, null, 'media', null, null, null, null, null),
  ('lei_14133', 'pregao', 'impugnacao_esclarecimento', 6, 'obrigatorio', 3, 'du', 'antes', 'abertura_sessao', 'alta', 'Qualquer pessoa pode pedir. O órgão responde em até 3 du do recebimento, limitado ao último dia útil anterior à abertura (art. 164); resposta divulgada em sítio oficial. Se a impugnação for acolhida, nova data respeitando o art. …', 'Lei 14.133 art. 164; IN SEGES 73/2022 art. 16', 'licitante', array['prazo_impugnacao', 'prazo_resposta', 'efeito_suspensivo', 'esclarecimento']::text[], 'Pernambuco (Decreto 54.142/2022, art. 14); Lei 13.303/2016 art. 87 §1º e Petrobras RLCP ; Sesc/Senac (art. 25 §2º); Macaé-RJ (concorrência 003/2025)'),
  ('lei_14133', 'concorrencia', 'impugnacao_esclarecimento', 6, 'obrigatorio', 3, 'du', 'antes', 'abertura_sessao', 'alta', null, null, null, null, null),
  ('lei_14133', 'dispensa', 'impugnacao_esclarecimento', 6, 'condicional', null, null, null, null, 'baixa', null, null, null, null, null),
  ('lei_14133', 'inexigibilidade', 'impugnacao_esclarecimento', 6, 'nao_aplica', null, null, null, null, 'baixa', null, null, null, null, null),
  ('lei_14133', 'credenciamento', 'impugnacao_esclarecimento', 6, 'obrigatorio', 3, 'du', 'depois', 'recebimento_pedido', 'alta', null, null, null, null, null),
  ('lei_14133', 'pregao', 'proposta', 7, 'obrigatorio', null, null, 'antes', 'abertura_sessao', 'media', 'Proposta enviada pelo sistema até a data e hora de abertura; retirada ou substituição até a abertura. Garantia de proposta condicional: até 1% do valor estimado, exigida no momento da proposta, devolvida em 10 du (art. 58). Valid…', 'IN SEGES 73/2022 arts. 13, II e 18; Lei 14.133 art. 58 (garantia de proposta, condicional)', 'licitante', array['envio_proposta', 'validade_proposta_60_dias', 'garantia_proposta']::text[], 'Rio de Janeiro (Decreto 48.778/2023, art. 22); Macaé-RJ e Pernambuco; Goiás (Decreto 10.359/2023, art. 45)'),
  ('lei_14133', 'concorrencia', 'proposta', 7, 'obrigatorio', null, null, null, null, 'media', null, null, null, null, null),
  ('lei_14133', 'dispensa', 'proposta', 7, 'obrigatorio', null, null, null, null, 'media', null, null, null, null, null),
  ('lei_14133', 'inexigibilidade', 'proposta', 7, 'nao_aplica', null, null, null, null, 'media', null, null, null, null, null),
  ('lei_14133', 'credenciamento', 'proposta', 7, 'condicional', null, null, null, null, 'media', null, null, null, null, null),
  ('lei_14133', 'pregao', 'disputa_lances', 8, 'obrigatorio', 10, 'min', 'depois', 'abertura_sessao', 'alta', 'Modo aberto e fechado: 15 min, fechamento aleatório de até 10 min, lance sigiloso final de 5 min para até 10% da melhor oferta. Vedado modo fechado isolado em menor preço/maior desconto (art. 56). Reinício da disputa se a diferen…', 'Lei 14.133 arts. 56 e 57; IN SEGES 73/2022 arts. 20-25', 'licitante', array['modo_disputa', 'lance_aberto_10_2', 'lance_fechado', 'reinicio_disputa', 'intervalo_minimo']::text[], 'Caruaru-PE (pregão 90007/2025); Rio de Janeiro (Decreto 48.778/2023, art. 28)'),
  ('lei_14133', 'concorrencia', 'disputa_lances', 8, 'condicional', 10, 'min', 'depois', 'abertura_sessao', 'alta', null, null, null, null, null),
  ('lei_14133', 'dispensa', 'disputa_lances', 8, 'condicional', 6, 'h', 'depois', 'abertura_fase_lances', 'alta', null, null, null, null, null),
  ('lei_14133', 'inexigibilidade', 'disputa_lances', 8, 'nao_aplica', null, null, null, null, 'alta', null, null, null, null, null),
  ('lei_14133', 'credenciamento', 'disputa_lances', 8, 'nao_aplica', null, null, null, null, 'alta', null, null, null, null, null),
  ('lei_14133', 'pregao', 'criterio_julgamento', 9, 'obrigatorio', null, null, null, null, 'alta', 'Pregão: menor preço ou maior desconto; por item, grupo ou global. Desempate pelo art. 60 (programa de integridade no inciso IV, Decreto 12.304/2024); margem de preferência pelo art. 26.', 'Lei 14.133 art. 6º, XLI; art. 33; IN SEGES 73/2022 art. 4º', 'orgao', array['menor_preco', 'maior_desconto', 'desempate_art_60', 'margem_preferencia']::text[], null),
  ('lei_14133', 'concorrencia', 'criterio_julgamento', 9, 'obrigatorio', null, null, null, null, 'media', null, null, null, null, null),
  ('lei_14133', 'dispensa', 'criterio_julgamento', 9, 'obrigatorio', null, null, null, null, 'media', null, null, null, null, null),
  ('lei_14133', 'inexigibilidade', 'criterio_julgamento', 9, 'nao_aplica', null, null, null, null, 'alta', null, null, null, null, null),
  ('lei_14133', 'credenciamento', 'criterio_julgamento', 9, 'nao_aplica', null, null, null, null, 'alta', null, null, null, null, null),
  ('lei_14133', 'pregao', 'aceitacao', 10, 'obrigatorio', 2, 'h', 'depois', 'convocacao_proposta_ajustada', 'alta', 'Negociação (arts. 30-34); inexequibilidade em bens e serviços em geral: indício abaixo de 50% do orçado, com diligência (IN 73); obras e engenharia abaixo de 75%; saneamento por decisão fundamentada (art. 41); suspensão para dili…', 'Lei 14.133 arts. 59-61; IN SEGES 73/2022 arts. 29-34, 41 e 43', 'licitante', array['proposta_ajustada_2h', 'inexequibilidade_50', 'negociacao', 'saneamento', 'diligencia_24h']::text[], 'Rio de Janeiro, Goiás, Pernambuco, Ceará (dec; Lei 13.303/2016 art. 56 §3º'),
  ('lei_14133', 'concorrencia', 'aceitacao', 10, 'obrigatorio', 2, 'h', 'depois', 'convocacao_proposta_ajustada', 'alta', null, null, null, null, null),
  ('lei_14133', 'dispensa', 'aceitacao', 10, 'obrigatorio', null, null, null, null, 'media', null, null, null, null, null),
  ('lei_14133', 'inexigibilidade', 'aceitacao', 10, 'nao_aplica', null, null, null, null, 'media', null, null, null, null, null),
  ('lei_14133', 'credenciamento', 'aceitacao', 10, 'nao_aplica', null, null, null, null, 'media', null, null, null, null, null),
  ('lei_14133', 'pregao', 'habilitacao_juridica', 11, 'obrigatorio', 2, 'h', 'depois', 'convocacao_documentos', 'alta', 'Documentos só do vencedor, salvo inversão de fases (art. 63, II); vedada substituição ou juntada posterior, salvo diligência (art. 64). Sicaf substitui jurídica, fiscal/social/trabalhista e econômico-financeira. Inversão de fases…', 'Lei 14.133 arts. 62, 63 e 66; IN SEGES 73/2022 arts. 36-39', 'licitante', array['habilitacao_juridica', 'sicaf', 'inversao_fases', 'diligencia_documentos']::text[], 'Goiás (Decreto 10.359/2023, arts. 79-87); Lei 13.303/2016 art. 58; Sesc/Senac arts. 15-16 e SESI/SENAI art. 9º'),
  ('lei_14133', 'concorrencia', 'habilitacao_juridica', 11, 'obrigatorio', 2, 'h', 'depois', 'convocacao_documentos', 'alta', null, null, null, null, null),
  ('lei_14133', 'dispensa', 'habilitacao_juridica', 11, 'condicional', null, null, null, null, 'media', null, null, null, null, null),
  ('lei_14133', 'inexigibilidade', 'habilitacao_juridica', 11, 'condicional', null, null, null, null, 'media', null, null, null, null, null),
  ('lei_14133', 'credenciamento', 'habilitacao_juridica', 11, 'obrigatorio', null, null, null, null, 'media', null, null, null, null, null),
  ('lei_14133', 'pregao', 'habilitacao_fiscal_trabalhista', 12, 'obrigatorio', 5, 'du', 'depois', 'declaracao_vencedor', 'alta', 'Regularidade fiscal exigida apenas do melhor classificado e só após o julgamento (art. 63, III). Inclui CPF/CNPJ, cadastros, Fazenda, Seguridade/FGTS, Justiça do Trabalho e art. 7º, XXXIII da CF (art. 68). Declaração de reserva d…', 'Lei 14.133 arts. 62, 63, III e 68; LC 123 art. 42 e art. 43 §1º', 'licitante', array['regularidade_fiscal', 'cndt', 'fgts', 'reserva_cargos_pcd']::text[], 'Goiás (Decreto 10.359/2023)'),
  ('lei_14133', 'concorrencia', 'habilitacao_fiscal_trabalhista', 12, 'obrigatorio', 5, 'du', 'depois', 'declaracao_vencedor', 'alta', null, null, null, null, null),
  ('lei_14133', 'dispensa', 'habilitacao_fiscal_trabalhista', 12, 'obrigatorio', null, null, null, null, 'media', null, null, null, null, null),
  ('lei_14133', 'inexigibilidade', 'habilitacao_fiscal_trabalhista', 12, 'condicional', null, null, null, null, 'media', null, null, null, null, null),
  ('lei_14133', 'credenciamento', 'habilitacao_fiscal_trabalhista', 12, 'obrigatorio', null, null, null, null, 'media', null, null, null, null, null),
  ('lei_14133', 'pregao', 'habilitacao_economica', 13, 'condicional', null, null, null, null, 'media', 'Exigência conforme o edital/TR, nos limites do art. 69: balanço dos 2 últimos exercícios e certidão de falência. As notas não afirmam obrigatoriedade universal; o art. 70 permite dispensar documentação em hipóteses de entrega ime…', 'Lei 14.133 arts. 62 e 69 (§2º vedado faturamento mínimo; §4º capital ou patrimônio líquido mínimo de até 10% do valor estimado)', 'licitante', array['balanco_2_exercicios', 'capital_minimo_10', 'indices_contabeis']::text[], 'Bahia (IN SAEB 010/2024) e Rio Grande do Sul'),
  ('lei_14133', 'concorrencia', 'habilitacao_economica', 13, 'condicional', null, null, null, null, 'media', null, null, null, null, null),
  ('lei_14133', 'dispensa', 'habilitacao_economica', 13, 'condicional', null, null, null, null, 'media', null, null, null, null, null),
  ('lei_14133', 'inexigibilidade', 'habilitacao_economica', 13, 'condicional', null, null, null, null, 'media', null, null, null, null, null),
  ('lei_14133', 'credenciamento', 'habilitacao_economica', 13, 'condicional', null, null, null, null, 'media', null, null, null, null, null),
  ('lei_14133', 'pregao', 'habilitacao_tecnica', 14, 'condicional', null, null, null, null, 'media', 'Exigência conforme o objeto e o TR. Vistoria prévia só quando o TR a exigir, substituível por declaração do responsável técnico (art. 63 §§2º-4º). Serviços contínuos: experiência mínima de no máximo 3 anos (art. 67 §5º).', 'Lei 14.133 arts. 62, 63 §§2º-4º e 67 (§1º atestado restrito a parcelas de valor igual ou superior a 4% do valor estimado; §2º qua…', 'licitante', array['atestado_capacidade_tecnica', 'vistoria', 'responsavel_tecnico']::text[], null),
  ('lei_14133', 'concorrencia', 'habilitacao_tecnica', 14, 'condicional', null, null, null, null, 'media', null, null, null, null, null),
  ('lei_14133', 'dispensa', 'habilitacao_tecnica', 14, 'condicional', null, null, null, null, 'media', null, null, null, null, null),
  ('lei_14133', 'inexigibilidade', 'habilitacao_tecnica', 14, 'condicional', null, null, null, null, 'media', null, null, null, null, null),
  ('lei_14133', 'credenciamento', 'habilitacao_tecnica', 14, 'condicional', null, null, null, null, 'media', null, null, null, null, null),
  ('lei_14133', 'pregao', 'amostra', 15, 'condicional', null, null, null, null, 'media', 'Só se previsto no edital e justificada; na fase de julgamento restringe-se ao licitante provisoriamente vencedor. Prazo de entrega e avaliação: NÃO CONFIRMADO em norma.', 'Lei 14.133 art. 41 (II e p.ú.), art. 17 §3º, art. 42 §2º; IN SEGES 73/2022 art. 29 §1º', 'licitante', array['amostra', 'prova_de_conceito', 'exame_conformidade']::text[], 'Editais reais 2025 (ES, DNIT, DER-SP)'),
  ('lei_14133', 'concorrencia', 'amostra', 15, 'condicional', null, null, null, null, 'media', null, null, null, null, null),
  ('lei_14133', 'dispensa', 'amostra', 15, 'condicional', null, null, null, null, 'baixa', null, null, null, null, null),
  ('lei_14133', 'inexigibilidade', 'amostra', 15, 'condicional', null, null, null, null, 'baixa', null, null, null, null, null),
  ('lei_14133', 'credenciamento', 'amostra', 15, 'condicional', null, null, null, null, 'baixa', null, null, null, null, null),
  ('lei_14133', 'pregao', 'recurso', 16, 'obrigatorio', 3, 'du', 'depois', 'intimacao_ou_ata_julgamento_ou_habilitacao', 'alta', 'Intenção manifestada imediatamente, sob pena de preclusão, em campo próprio do sistema (mínimo de 10 min de sessão); razões em momento único em 3 du; contrarrazões em 3 du (mesmo prazo, a partir da divulgação do recurso, art. 165…', 'Lei 14.133 art. 165 (I, §1º, §2º, §4º); IN SEGES 73/2022 art. 40', 'licitante', array['intencao_recurso_10min', 'prazo_recurso_3du', 'contrarrazoes', 'decisao_autoridade_10du', 'preclusao']::text[], 'Caruaru-PE (pregão 90007/2025); Macaé-RJ (concorrência 003/2025); Lei 13.303/2016 art. 59 §1º; Sesc/Senac art. 30 e SESI/SENAI art. 15; Ceará (Decreto 36.863/2…'),
  ('lei_14133', 'concorrencia', 'recurso', 16, 'obrigatorio', 3, 'du', 'depois', 'intimacao_ou_ata_julgamento_ou_habilitacao', 'alta', null, null, null, null, null),
  ('lei_14133', 'dispensa', 'recurso', 16, 'condicional', null, null, null, null, 'baixa', null, null, null, null, null),
  ('lei_14133', 'inexigibilidade', 'recurso', 16, 'condicional', null, null, null, null, 'baixa', null, null, null, null, null),
  ('lei_14133', 'credenciamento', 'recurso', 16, 'obrigatorio', 3, 'du', 'depois', 'publicacao_decisao', 'alta', null, null, null, null, null),
  ('lei_14133', 'pregao', 'adjudicacao_homologacao', 17, 'obrigatorio', null, null, null, null, 'alta', 'Pela autoridade superior, depois de exauridos os recursos: saneamento, revogação, anulação ou adjudicação e homologação. A homologação não gera direito à contratação (modelo AGU, seção 16).', 'Lei 14.133 art. 71; IN SEGES 73/2022 art. 44', 'orgao', array['adjudicacao', 'homologacao', 'autoridade_superior']::text[], null),
  ('lei_14133', 'concorrencia', 'adjudicacao_homologacao', 17, 'obrigatorio', null, null, null, null, 'alta', null, null, null, null, null),
  ('lei_14133', 'dispensa', 'adjudicacao_homologacao', 17, 'condicional', null, null, null, null, 'media', null, null, null, null, null),
  ('lei_14133', 'inexigibilidade', 'adjudicacao_homologacao', 17, 'condicional', null, null, null, null, 'media', null, null, null, null, null),
  ('lei_14133', 'credenciamento', 'adjudicacao_homologacao', 17, 'nao_aplica', null, null, null, null, 'media', null, null, null, null, null),
  ('lei_14133', 'pregao', 'registro_precos_adesao', 18, 'condicional', 8, 'du', 'depois', 'divulgacao_intencao_registro_precos', 'media', 'Ata com vigência de 1 ano, prorrogável por igual período se vantajoso (art. 84). Adesão de não participante (art. 86 §2º): justificativa de vantagem, compatibilidade de preços, aceite do gerenciador e do fornecedor; §3º (Lei 14.7…', 'Lei 14.133 arts. 82-86; Decreto 11.462/2023 (arts. 9º, 22, 31 §2º, 32)', 'orgao', array['registro_precos', 'irp_8_du', 'carona_adesao', 'limite_50_dobro', 'cadastro_reserva', 'vigencia_ata_1_ano']::text[], 'Pernambuco (Decreto 54.700/2023, arts. 25, 41; Ceará (Decreto 36.863/2025, art. 15 do 35.323; Bahia (Lei 14.634/2023); Goiás; Sesc/Senac arts. 44-55 e SESI/SEN…'),
  ('lei_14133', 'concorrencia', 'registro_precos_adesao', 18, 'condicional', 8, 'du', 'depois', 'divulgacao_intencao_registro_precos', 'media', null, null, null, null, null),
  ('lei_14133', 'dispensa', 'registro_precos_adesao', 18, 'condicional', null, null, null, null, 'media', null, null, null, null, null),
  ('lei_14133', 'inexigibilidade', 'registro_precos_adesao', 18, 'condicional', null, null, null, null, 'media', null, null, null, null, null),
  ('lei_14133', 'credenciamento', 'registro_precos_adesao', 18, 'condicional', null, null, null, null, 'baixa', null, null, null, null, null),
  ('lei_14133', 'pregao', 'contrato_garantia', 19, 'obrigatorio', 1, 'meses', 'depois', 'homologacao', 'alta', 'Contrato obrigatório, substituível nos casos do art. 95. Convocação no prazo do edital, prorrogável uma vez por igual período mediante pedido justificado (art. 90); recusa injustificada leva à perda da garantia de proposta e a sa…', 'Lei 14.133 arts. 90, 95, 96, 98, 99; art. 58 (garantia de proposta); LC 123 art. 43 §1º', 'licitante', array['assinatura_contrato', 'garantia_contratual_5_10', 'seguro_garantia_1_mes', 'programa_integridade', 'instrumento_substitutivo']::text[], 'Anatel (pregão 90001/2025); Rio de Janeiro (Decreto 48.778/2023, art. 46); Lei 13.303/2016 art. 70; Sesc/Senac art. 34 e SESI/SENAI art. 35; Lei 14.981/2024 ar…'),
  ('lei_14133', 'concorrencia', 'contrato_garantia', 19, 'obrigatorio', 1, 'meses', 'depois', 'homologacao', 'alta', null, null, null, null, null),
  ('lei_14133', 'dispensa', 'contrato_garantia', 19, 'condicional', null, null, null, null, 'media', null, null, null, null, null),
  ('lei_14133', 'inexigibilidade', 'contrato_garantia', 19, 'obrigatorio', null, null, null, null, 'media', null, null, null, null, null),
  ('lei_14133', 'credenciamento', 'contrato_garantia', 19, 'obrigatorio', null, null, null, null, 'media', null, null, null, null, null),
  ('lei_14133', 'pregao', 'execucao_entrega_pagamento', 20, 'obrigatorio', null, null, null, null, 'media', 'Prazo geral de pagamento em dias: NÃO FIXADO na lei lida (o art. 141 trata de ordem cronológica por fonte de recursos). Só o credenciamento via Sicx tem limite de 30 dias (art. 79 §1º, VII, e).', 'Lei 14.133 art. 25 caput, art. 92, art. 140 (recebimento provisório e definitivo; §6º obra: 5 anos), art. 141 (ordem cronológica …', 'orgao', array['recebimento_provisorio_definitivo', 'ordem_cronologica_pagamento', 'fiscalizacao_gestao', 'reajuste_repactuacao']::text[], 'São Paulo (Decreto 67.608/2023, art. 2º, II); Caruaru-PE e Macaé-RJ'),
  ('lei_14133', 'concorrencia', 'execucao_entrega_pagamento', 20, 'obrigatorio', null, null, null, null, 'media', null, null, null, null, null),
  ('lei_14133', 'dispensa', 'execucao_entrega_pagamento', 20, 'obrigatorio', null, null, null, null, 'media', null, null, null, null, null),
  ('lei_14133', 'inexigibilidade', 'execucao_entrega_pagamento', 20, 'obrigatorio', null, null, null, null, 'media', null, null, null, null, null),
  ('lei_14133', 'credenciamento', 'execucao_entrega_pagamento', 20, 'obrigatorio', null, null, null, null, 'media', null, null, null, null, null),
  ('lei_14133', 'pregao', 'sancoes', 21, 'obrigatorio', 15, 'du', 'depois', 'intimacao', 'alta', 'Prescrição em 5 anos (art. 158 §4º). Inidoneidade impede licitar e contratar com todos os entes; impedimento vale no âmbito do ente que aplicou.', 'Lei 14.133 arts. 155-163 (art. 156 §3º multa 0,5% a 30%; §4º impedimento até 3 anos; §5º inidoneidade 3 a 6 anos), arts. 157-158,…', 'licitante', array['infracoes_art_155', 'multa_0_5_a_30', 'impedimento_3_anos', 'inidoneidade_3_a_6', 'defesa_15_du']::text[], 'Bahia (Lei 14.634/2023); Lei 13.303/2016 arts. 82-84; Sesc/Senac arts. 39-41 e SESI art. 33'),
  ('lei_14133', 'concorrencia', 'sancoes', 21, 'obrigatorio', 15, 'du', 'depois', 'intimacao', 'alta', null, null, null, null, null),
  ('lei_14133', 'dispensa', 'sancoes', 21, 'obrigatorio', 15, 'du', 'depois', 'intimacao', 'alta', null, null, null, null, null),
  ('lei_14133', 'inexigibilidade', 'sancoes', 21, 'obrigatorio', 15, 'du', 'depois', 'intimacao', 'alta', null, null, null, null, null),
  ('lei_14133', 'credenciamento', 'sancoes', 21, 'obrigatorio', 15, 'du', 'depois', 'intimacao', 'alta', null, null, null, null, null),
  ('lei_14133', 'pregao', 'anexos_obrigatorios', 22, 'obrigatorio', 0, 'dc', 'depois', 'divulgacao_edital', 'alta', 'Minuta de contrato, TR, projetos e demais anexos divulgados em sítio oficial na mesma data do edital, sem exigência de cadastro.', 'Lei 14.133 art. 25 §3º e art. 54; IN SEGES 81/2022 (TR) e 58/2022 (ETP): texto das INs NÃO LIDO', 'orgao', array['anexos', 'termo_referencia', 'minuta_contrato', 'etp', 'divulgacao_mesma_data']::text[], null),
  ('lei_14133', 'concorrencia', 'anexos_obrigatorios', 22, 'obrigatorio', 0, 'dc', 'depois', 'divulgacao_edital', 'alta', null, null, null, null, null),
  ('lei_14133', 'dispensa', 'anexos_obrigatorios', 22, 'condicional', null, null, null, null, 'media', null, null, null, null, null),
  ('lei_14133', 'inexigibilidade', 'anexos_obrigatorios', 22, 'nao_aplica', null, null, null, null, 'media', null, null, null, null, null),
  ('lei_14133', 'credenciamento', 'anexos_obrigatorios', 22, 'obrigatorio', null, null, null, null, 'media', null, null, null, null, null)
on conflict (regime_id, procedimento, bloco) do update set ordem = excluded.ordem, status = excluded.status,
  prazo_quantidade = excluded.prazo_quantidade, prazo_unidade = excluded.prazo_unidade,
  prazo_sentido = excluded.prazo_sentido, prazo_ancora = excluded.prazo_ancora, confianca = excluded.confianca,
  condicao = excluded.condicao, base_legal = excluded.base_legal, parte_obrigada = excluded.parte_obrigada,
  temas_rag = excluded.temas_rag, variacoes = excluded.variacoes, atualizado_em = now();
-- <<< fim do bloco gerado (blocos legais)

commit;
