-- LicitaGym: tira do escopo 22 compras de serviço da FIEB gravadas antes do #509
--
-- Contexto:
-- O #509 (09/11/2026) fez o coletor Paradigma deixar de classificar como forte/fraco a compra só de serviço
-- (manutenção de equipamentos de musculação, ginástica laboral, reinstalação de esteira, estofamento, polimento).
-- O coletor só grava o que está no escopo e nunca rebaixa linha antiga, então as 22 compras da FIEB gravadas antes
-- da correção continuam com categoria_escopo forte (21) ou fraco (1) e escopo_estado 'CLASSIFICATION_CANDIDATE'.
-- Todas estão em prioridade 'historico' (nenhuma é lead), mas contam no histórico, no BI e em v_oportunidades_externas.
--
-- Evidência (09/11/2026, MCP somente leitura + código da main em c2a7ce7):
--   * as 22 são as linhas da FIEB que o run manual 42643619249 (dry_run=false, mesmo dia) não regravou: o run gravou
--     133 licitações; o banco tinha 155;
--   * reclassificadas offline com coletor.paradigma.avaliar_processo (objeto + itens do banco + catálogo da FIEB,
--     123 produtos), as 22 dão (None, False);
--   * nenhuma tem decisão manual de escopo (licitacao_escopo_decisao), card no pipeline nem decisão comercial;
--     nenhuma licitação ou item tem interesse_borracha.
--
-- O que muda (o mesmo par que o coletor grava: categoria nula <-> escopo_estado 'OUT_OF_SCOPE', paradigma.py):
--   * licitacoes_externas: nas 22 (lista fechada por fonte, id_externo e modulo), categoria_escopo -> null e
--     escopo_estado -> 'OUT_OF_SCOPE'. Os valores anteriores ficam em raw->'reclassificacao_escopo'.
--   * licitacao_itens dessas 22: os 11 itens 'M' que só nomeiam atividade de serviço (ginástica laboral,
--     reinstalação; mesma regra de ITEM_ATIVIDADE_SERVICO do #509) passam a material_ou_servico 'S',
--     categoria_escopo null e escopo_estado 'OUT_OF_SCOPE'. Os anteriores ficam em raw->'reclassificacao_escopo'.
--     Os outros 19 itens dessas compras já são 'S' / null / 'OUT_OF_SCOPE' e não mudam.
--
-- Não muda: linha com decisão manual de escopo (precedência da edição manual), linha já fora do escopo (idempotente),
-- resultados homologados (licitacao_resultados), fornecedores, documentos e licitacao_match (os triggers
-- licitacao_match_*_upd disparam por statement, mas só remarcam quando objeto/descricao/licitacao_id mudam).
--
-- Quem lê: Dashboard (Oportunidades, BI) via Edge Functions e v_oportunidades_externas.
-- Quem escreve: só esta migration (dado); o coletor não regrava essas compras (fora do escopo).
--
-- Como verificar (produção, depois do merge):
--   select count(*) from licitacoes_externas
--    where fonte = 'fieb' and raw ? 'reclassificacao_escopo'
--      and categoria_escopo is null and escopo_estado = 'OUT_OF_SCOPE';                       -- esperado: 22
--   select count(*) from licitacao_itens
--    where raw ? 'reclassificacao_escopo' and material_ou_servico = 'S'
--      and categoria_escopo is null and escopo_estado = 'OUT_OF_SCOPE';                       -- esperado: 11
--
-- Volta (por tabela):
--   update licitacoes_externas
--      set categoria_escopo = raw->'reclassificacao_escopo'->>'anterior',
--          escopo_estado = raw->'reclassificacao_escopo'->>'estado_anterior',
--          raw = raw - 'reclassificacao_escopo'
--    where fonte = 'fieb' and raw->'reclassificacao_escopo'->>'origem' = 'migration 20261109160000_fieb_servico_fora_do_escopo';
--   update licitacao_itens
--      set categoria_escopo = raw->'reclassificacao_escopo'->>'anterior',
--          escopo_estado = raw->'reclassificacao_escopo'->>'estado_anterior',
--          material_ou_servico = raw->'reclassificacao_escopo'->>'material_anterior',
--          raw = raw - 'reclassificacao_escopo'
--    where raw->'reclassificacao_escopo'->>'origem' = 'migration 20261109160000_fieb_servico_fora_do_escopo';
--
-- Idempotente: só toca licitação que ainda tem categoria e item que ainda é 'M'; a segunda execução não acha nada.
-- Checagem: supabase/tests/fieb_servico_fora_do_escopo_check.sql.

begin;

with alvo(id_externo, modulo) as (
  values (32, 59), (701, 18), (1287, 59), (1729, 18), (1730, 18), (1977, 19), (5391, 59), (6236, 19), (6801, 19),
         (8322, 19), (9527, 59), (11894, 19), (12976, 59), (13745, 19), (19072, 19), (19654, 19), (20061, 19),
         (27897, 19), (31454, 19), (38622, 19), (42146, 19), (42147, 19)
),
licitacoes as (
  select le.id
    from public.licitacoes_externas le
    join alvo a on a.id_externo = le.id_externo and a.modulo = le.modulo
   where le.fonte = 'fieb'
     and not exists (select 1 from public.licitacao_escopo_decisao d where d.licitacao_id = le.id)
),
itens as (
  -- update dentro de WITH roda mesmo sem ser referenciado pela consulta principal
  update public.licitacao_itens li
     set raw = coalesce(li.raw, '{}'::jsonb) || jsonb_build_object('reclassificacao_escopo', jsonb_build_object(
               'anterior', li.categoria_escopo,
               'estado_anterior', li.escopo_estado,
               'material_anterior', li.material_ou_servico,
               'motivo', 'item que só nomeia atividade de serviço (ginástica laboral, reinstalação): #509',
               'origem', 'migration 20261109160000_fieb_servico_fora_do_escopo',
               'em', '2026-11-09')),
         categoria_escopo = null,
         escopo_estado = 'OUT_OF_SCOPE',
         material_ou_servico = 'S'
   where li.licitacao_id in (select id from licitacoes)
     and li.material_ou_servico = 'M'
     and li.raw->>'sDsItem' ~* '^\W*(\d+\s*-\s*)?((atendimentos?|aulas?|sess[aãÃ]o|sess[oõÕ]es)\s+(de|em)\s+)?gin[aáÁ]stica\s+laboral|^\W*(\d+\s*-\s*)?reinstala[cçÇ]'
  returning li.id
)
update public.licitacoes_externas le
   set raw = coalesce(le.raw, '{}'::jsonb) || jsonb_build_object('reclassificacao_escopo', jsonb_build_object(
             'anterior', le.categoria_escopo,
             'estado_anterior', le.escopo_estado,
             'motivo', 'compra só de serviço não é oportunidade de material (regra de negócio; #509)',
             'origem', 'migration 20261109160000_fieb_servico_fora_do_escopo',
             'em', '2026-11-09')),
       categoria_escopo = null,
       escopo_estado = 'OUT_OF_SCOPE'
 where le.id in (select id from licitacoes)
   and le.categoria_escopo is not null;

commit;
