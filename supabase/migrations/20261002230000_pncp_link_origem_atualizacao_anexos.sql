-- PNCP: portal de origem da disputa, versão da compra (dataAtualizacao) e anexos inativos.
--
-- 1) licitacoes_externas.link_sistema_origem: linkSistemaOrigem do detalhe da compra no PNCP
--    (/api/consulta/v1/orgaos/{cnpj}/compras/{ano}/{seq}) = portal onde a disputa acontece (Comprasnet,
--    Portal de Compras Públicas, BLL...). Só http(s). Até aqui só existia em raw->>'link_sistema_origem'
--    (item da busca); o backfill abaixo copia de lá (mesmo valor, nenhum dado inventado).
-- 2) licitacoes_externas.pncp_data_atualizacao / pncp_data_atualizacao_global: dataAtualizacao e
--    dataAtualizacaoGlobal do detalhe na última coleta COMPLETA (metadados + itens + resultados + lista de
--    arquivos). O coletor (coletor/pncp.py, --recoletar-atualizadas) recoleta a compra quando o PNCP mostra
--    outro valor. NULL = nunca coletada com versão: a primeira rodada recoleta. Sem backfill de propósito
--    (raw->>'data_atualizacao_pncp' vem da busca e não garante que itens/arquivos foram gravados naquela versão).
-- 3) licitacao_documentos.ativo: statusAtivo do /arquivos do PNCP. false = anexo substituído/retirado pelo
--    órgão; fica só o metadado (título, data, url): o coletor não baixa e o RAG não deve indexar.
--    Default true: linhas existentes (Paradigma, PNCP antigo) continuam ativas.
--
-- Proposta (NÃO criada aqui): licitacao_documentos.versao_vigente boolean (NULL = não verificado), para o RAG
-- marcar pela /historico do PNCP qual versão de um documento retificado vale.
--
-- Idempotente (IF NOT EXISTS; o backfill só toca linhas com link NULL). Locks: ADD COLUMN sem default volátil é
-- só catálogo (ACCESS EXCLUSIVE breve); o UPDATE trava só as linhas pncp com link no raw (~1,1 mil em 02/10/2026).
-- O trigger licitacao_match_objetos_upd só marca pendência quando objeto muda: o backfill não gera pendência.
--
-- Rollback (perde os valores gravados nessas colunas; raw continua com o link):
--   begin;
--   alter table public.licitacao_documentos drop column if exists ativo;
--   alter table public.licitacoes_externas  drop column if exists pncp_data_atualizacao_global,
--                                          drop column if exists pncp_data_atualizacao,
--                                          drop column if exists link_sistema_origem;
--   commit;
--   (antes, voltar o coletor para a versão sem estas colunas: ele as envia no upsert e falharia com PGRST204)

begin;

set local lock_timeout = '10s';

alter table public.licitacoes_externas
  add column if not exists link_sistema_origem          text,
  add column if not exists pncp_data_atualizacao        timestamptz,
  add column if not exists pncp_data_atualizacao_global timestamptz;

comment on column public.licitacoes_externas.link_sistema_origem is
  'PNCP: linkSistemaOrigem do detalhe da compra (portal onde a disputa acontece). Só http(s). NULL = não informado.';
comment on column public.licitacoes_externas.pncp_data_atualizacao is
  'PNCP: dataAtualizacao do detalhe na última coleta completa (metadados+itens+arquivos). Mudou no PNCP -> recoleta. NULL = ainda não coletada com versão.';
comment on column public.licitacoes_externas.pncp_data_atualizacao_global is
  'PNCP: dataAtualizacaoGlobal do detalhe (compra, itens, resultados ou arquivos) na última coleta completa. Mudou no PNCP -> recoleta.';

alter table public.licitacao_documentos
  add column if not exists ativo boolean not null default true;

comment on column public.licitacao_documentos.ativo is
  'statusAtivo do anexo na fonte (PNCP /arquivos). false = substituído/retirado: só metadado, não baixar nem indexar no RAG.';

update public.licitacoes_externas
   set link_sistema_origem = btrim(raw->>'link_sistema_origem')
 where fonte = 'pncp'
   and link_sistema_origem is null
   and btrim(raw->>'link_sistema_origem') ~* '^https?://[^/\s]+';

commit;
