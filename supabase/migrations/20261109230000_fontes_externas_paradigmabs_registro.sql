-- LicitaGym: alinha o cadastro de fontes_externas dos portais paradigmabs ao que o coletor faz
--
-- Contexto:
-- O cadastro (20260925120000 e 20260929140000) registra sescsp, sesc_senac_rs, sescdn, sescrj e sescba como
-- modo_coleta 'aviso_fornecedor', robots_permite false. Desde a decisão de 05/10/2026 (confirmada pelo Marcelo em
-- 09/11/2026) as cinco são coletadas todo dia pelo webservice público do mural (coletor-sistema-s.yml).
-- Conferido em 09/11/2026:
--   * egov.paradigmabs.com.br (sesc_senac_rs, sescrj, sescba) e scr360.paradigmabs.com.br (sescsp): robots.txt
--     com `Disallow: /`; coletam pelo override FONTES_MURAL_AUTORIZADO (coletor/paradigma.py);
--   * egov-br.paradigmabs.com.br (sescdn): sem robots.txt (404), sem X-Robots-Tag; coleta sem override.
--
-- O que muda: só dado de cadastro em public.fontes_externas (5 linhas): modo_coleta 'automatico',
-- robots_permite (false nas quatro com Disallow; null no sescdn, como nos self-hosted sem robots.txt) e observação.
-- Não muda: schema, ACL, RLS, coleta, licitações. Nenhuma função ou Edge Function lê modo_coleta/robots_permite hoje.
--
-- Quem lê: catálogo de fontes (documentação/BI). Quem escreve: migrations.
--
-- Como verificar (produção, depois do merge):
--   select slug, modo_coleta, robots_permite from public.fontes_externas
--    where slug in ('sescsp','sesc_senac_rs','sescdn','sescrj','sescba');   -- esperado: 5 'automatico'
--
-- Volta: update ... set modo_coleta = 'aviso_fornecedor', robots_permite = false,
--        observacao = 'robots.txt do host proíbe coleta automatizada' where slug in (...).
-- Idempotente: update por slug com valores fixos.
-- Checagem: supabase/tests/fontes_externas_paradigmabs_check.sql.

begin;

update public.fontes_externas
   set modo_coleta = 'automatico',
       robots_permite = false,
       observacao = 'robots.txt com Disallow: /; coletado pelo webservice público do mural (decisão de 05/10/2026, '
                    'confirmada em 09/11/2026; FONTES_MURAL_AUTORIZADO)',
       updated_at = now()
 where slug in ('sescsp', 'sesc_senac_rs', 'sescrj', 'sescba')
   and (modo_coleta, robots_permite, observacao) is distinct from
       ('automatico', false, 'robots.txt com Disallow: /; coletado pelo webservice público do mural (decisão de '
                             '05/10/2026, confirmada em 09/11/2026; FONTES_MURAL_AUTORIZADO)');

update public.fontes_externas
   set modo_coleta = 'automatico',
       robots_permite = null,
       observacao = 'Webservice público; robots.txt ausente (404, conferido em 09/11/2026)',
       updated_at = now()
 where slug = 'sescdn'
   and (modo_coleta, robots_permite, observacao) is distinct from
       ('automatico', null::boolean, 'Webservice público; robots.txt ausente (404, conferido em 09/11/2026)');

commit;
