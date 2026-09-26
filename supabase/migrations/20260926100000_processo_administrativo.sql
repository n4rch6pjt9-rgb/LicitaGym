-- LicitaGym: identificação por PROCESSO ADMINISTRATIVO (não pelo número do edital)
-- "Pregão Eletrônico nº 001/2026" se repete entre órgãos: é só rótulo.
-- Hierarquia: órgão (CNPJ) -> processo administrativo (1..N compras) -> compra/edital -> itens.
--   PNCP: identidade da compra = numero_controle_pncp (codigo_externo).
--   Fora do PNCP (Sistema S etc.): (fonte, órgão/unidade, processo administrativo).
-- Busca por processo: compara só os dígitos (00007.20260204/0002-28 == 00007202602040002 28).

alter table public.licitacoes_externas
  add column if not exists processo_norm text
  generated always as (nullif(regexp_replace(coalesce(numero_processo, ''), '\D', '', 'g'), '')) stored;
create index if not exists idx_licext_processo on public.licitacoes_externas (processo_norm, orgao_cnpj);

alter table public.contratacoes_editais
  add column if not exists processo_norm text
  generated always as (nullif(regexp_replace(coalesce(numero_processo, ''), '\D', '', 'g'), '')) stored;
create index if not exists idx_contredit_processo on public.contratacoes_editais (processo_norm, orgao_cnpj);

-- Até a v12 o coletor PNCP gravava o código PNCP em numero_processo. Limpa para não confundir;
-- depois rode: python3 -m coletor.pncp --corrigir-processos
update public.licitacoes_externas set numero_processo = null
 where fonte = 'pncp' and numero_processo = codigo_externo;
