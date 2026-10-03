-- Verificação (SOMENTE LEITURA) das migrations 20260929181500_views_valor_nulo_orgao_sem_cnpj e
-- 20261002205000_views_resultado_cancelado.
-- Só SELECT; não grava nada. O único estado tocado é um parâmetro de sessão (set_config 'views_check.*', some ao
-- fechar a conexão) que leva o resultado da consulta 1 até o bloco 2. Roda como postgres ou service_role (usa
-- public.norm_txt, cujo EXECUTE é só desses papéis desde a 20260929145232). Ex.:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/views_valor_nulo_orgao_sem_cnpj_check.sql
-- Também roda inteiro no SQL Editor do Supabase. A consulta 1 lista as 14 regras (falhas primeiro); o bloco 2
-- levanta EXCEPTION se alguma falhou (psql com ON_ERROR_STOP=1 sai com código != 0).
--
-- As regras são invariantes calculados a partir das tabelas, então valem para qualquer conteúdo (inclusive banco
-- vazio, onde só as regras de definição têm efeito). Nenhum dado real é citado aqui.
-- "Resultado válido" = linha de licitacao_resultados com vencedor distinto de false (true ou NULL) e situacao
-- distinta de 'Cancelado' (NULL conta); lance perdedor = vencedor = false (coletor Paradigma) e resultado PNCP
-- cancelado não podem contar em nenhuma das três views.
--   D1  orgaos_compradores, fornecedores_homologados e homologacoes_itens com security_invoker=true
--   D2  nem orgaos_compradores nem fornecedores_homologados têm "COALESCE(sum(" nem "COALESCE(res.valor_homologado"
--   D3  as três definições têm "vencedor IS DISTINCT FROM false" (o filtro não depende de haver dado de teste)
--   D4  as três definições excluem situacao 'Cancelado' tratando NULL ("COALESCE(r.situacao, ''::text) <> 'Cancelado'")
--   O1  cada grupo sem CNPJ esperado (fonte + nome normalizado, nome = orgao_nome ou unidade_compradora) aparece
--       em exatamente uma linha da view, com id 'sem-cnpj:<fonte>:<md5>' e qtd_licitacoes igual à contagem
--   O2  a view não tem linha sem CNPJ além das esperadas (grupos diferentes não colapsam num id só)
--   O3  nenhuma linha sem CNPJ mistura fontes (cardinality(fontes) = 1)
--   O4  nenhuma licitação com CNPJ, orgao_nome ou unidade_compradora fica fora da view (soma de qtd_licitacoes)
--   V1  orgaos_compradores.valor_estimado_total é NULL quando nenhuma licitação do grupo tem valor_total
--       (e nunca 0 nesse caso); igual à soma quando há valor
--   V2  orgaos_compradores.valor_homologado é NULL quando o grupo não tem resultado válido com valor; igual à
--       soma dos resultados válidos
--   V3  fornecedores_homologados.valor_total_homologado (e ticket_medio_edital) NULL quando nenhum resultado
--       válido do fornecedor tem valor; igual à soma dos resultados válidos
--   W1  fornecedores_homologados: exatamente os CNPJs com ao menos um resultado válido (fornecedor só com lances
--       perdedores não aparece), com qtd_itens e qtd_editais contados só sobre resultados válidos
--   W2  homologacoes_itens: nenhuma linha de resultado com vencedor = false ou cancelado; todo resultado válido aparece
--   W3  orgaos_compradores: qtd_homologadas e qtd_fornecedores_vencedores contados só sobre resultados válidos

-- 0) Zera o resultado de uma execução anterior na mesma sessão.
select set_config('views_check.regras', '', false) as reset_regras,
       set_config('views_check.falhas', '', false) as reset_falhas;

-- 1) Checagens --------------------------------------------------------------------------------------------
with
views3(o) as (values ('public.orgaos_compradores'), ('public.fornecedores_homologados'), ('public.homologacoes_itens')),
base as (
  select le.id, le.fonte,
         nullif(regexp_replace(coalesce(le.orgao_cnpj, ''), '\D', '', 'g'), '') as cnpj,
         coalesce(nullif(btrim(le.orgao_nome), ''), nullif(btrim(le.unidade_compradora), '')) as nome_org,
         le.valor_total
  from public.licitacoes_externas le
),
res_valido as (
  select r.* from public.licitacao_resultados r
   where r.vencedor is distinct from false and coalesce(r.situacao, '') <> 'Cancelado'
),
esperado_sem_cnpj as (
  select 'sem-cnpj:' || fonte || ':' || md5(btrim(regexp_replace(public.norm_txt(nome_org), '\s+', ' ', 'g'))) as id,
         count(*) as n
  from base
  where cnpj is null and nome_org is not null
  group by 1
),
grupo_lic as (
  select coalesce(cnpj, 'sem-cnpj:' || fonte || ':'
                  || md5(btrim(regexp_replace(public.norm_txt(nome_org), '\s+', ' ', 'g')))) as id,
         id as licitacao_id, valor_total
  from base
  where cnpj is not null or nome_org is not null
),
grupo_valor as (
  select id, count(valor_total) as n_valor, sum(valor_total) as soma from grupo_lic group by id
),
grupo_res as (
  select g.id, count(r.valor_total_homologado) as n_valor, sum(r.valor_total_homologado) as soma,
         count(distinct r.licitacao_id) as qtd_homologadas,
         count(distinct r.fornecedor_cnpj) as qtd_fornecedores
  from grupo_lic g join res_valido r on r.licitacao_id = g.licitacao_id
  group by g.id
),
forn_res as (
  select regexp_replace(r.fornecedor_cnpj, '\D', '', 'g') as cnpj,
         count(r.valor_total_homologado) as n_valor, sum(r.valor_total_homologado) as soma,
         count(*) as qtd_itens, count(distinct r.licitacao_id) as qtd_editais
  from res_valido r
  join public.licitacoes_externas l on l.id = r.licitacao_id
  where r.fornecedor_cnpj is not null
  group by 1
),
oc as (select * from public.orgaos_compradores),
checks(regra, descricao, falhas) as (
  select 'D1', 'security_invoker=true nas três views',
         (select count(*) from views3 v
           left join pg_class c on c.oid = to_regclass(v.o)
          where not coalesce('security_invoker=true' = any (c.reloptions), false))
  union all
  select 'D2', 'sem COALESCE(sum( / COALESCE(res.valor_homologado nas definições',
         (select count(*) from (values ('public.orgaos_compradores'), ('public.fornecedores_homologados')) v(o)
          where to_regclass(v.o) is null
             or pg_get_viewdef(to_regclass(v.o), true) ilike '%coalesce(sum(%'
             or pg_get_viewdef(to_regclass(v.o), true) ilike '%coalesce(res.valor_homologado%')
  union all
  select 'D3', 'definição sem o filtro "vencedor IS DISTINCT FROM false"',
         (select count(*) from views3 v
          where to_regclass(v.o) is null
             or pg_get_viewdef(to_regclass(v.o), true) not ilike '%vencedor is distinct from false%')
  union all
  select 'D4', 'definição sem o filtro de situacao Cancelado com NULL tratado',
         (select count(*) from views3 v
          where to_regclass(v.o) is null
             or pg_get_viewdef(to_regclass(v.o), true) not ilike '%coalesce(r.situacao, ''''::text) <> ''Cancelado''::text%')
  union all
  select 'O1', 'grupo sem CNPJ esperado ausente ou com qtd_licitacoes diferente',
         (select count(*) from esperado_sem_cnpj e
           where (select count(*) from oc where oc.id = e.id and oc.cnpj is null and oc.qtd_licitacoes = e.n) <> 1)
  union all
  select 'O2', 'linha sem CNPJ na view que não corresponde a um grupo esperado (colapso de órgãos)',
         (select count(*) from oc where oc.cnpj is null
             and not exists (select 1 from esperado_sem_cnpj e where e.id = oc.id))
  union all
  select 'O3', 'linha sem CNPJ com mais de uma fonte',
         (select count(*) from oc where oc.cnpj is null and cardinality(oc.fontes) <> 1)
  union all
  select 'O4', 'licitações com CNPJ/nome/unidade fora da view (diferença na soma de qtd_licitacoes)',
         (select abs((select count(*) from grupo_lic) - coalesce((select sum(qtd_licitacoes) from oc), 0)))
  union all
  select 'V1', 'valor_estimado_total: 0 em vez de NULL sem valor informado, ou diferente da soma',
         (select count(*) from oc join grupo_valor g on g.id = oc.id
           where (g.n_valor = 0 and oc.valor_estimado_total is not null)
              or (g.n_valor > 0 and oc.valor_estimado_total is distinct from g.soma))
  union all
  select 'V2', 'valor_homologado: 0 em vez de NULL sem resultado válido com valor, ou diferente da soma dos válidos',
         (select count(*) from oc left join grupo_res g on g.id = oc.id
           where (coalesce(g.n_valor, 0) = 0 and oc.valor_homologado is not null)
              or (g.n_valor > 0 and oc.valor_homologado is distinct from g.soma))
  union all
  select 'V3', 'fornecedores_homologados: valor_total_homologado/ticket 0 em vez de NULL, ou diferente da soma dos válidos',
         (select count(*) from public.fornecedores_homologados fh join forn_res f on f.cnpj = fh.cnpj
           where (f.n_valor = 0 and (fh.valor_total_homologado is not null or fh.ticket_medio_edital is not null))
              or (f.n_valor > 0 and fh.valor_total_homologado is distinct from f.soma))
  union all
  select 'W1', 'fornecedores_homologados: CNPJ só com lance perdedor na view, CNPJ válido ausente, ou qtd_itens/qtd_editais contando perdedor',
         (select count(*) from public.fornecedores_homologados fh full join forn_res f on f.cnpj = fh.cnpj
           where fh.cnpj is null or f.cnpj is null
              or fh.qtd_itens is distinct from f.qtd_itens or fh.qtd_editais is distinct from f.qtd_editais)
  union all
  select 'W2', 'homologacoes_itens: linha de lance perdedor (vencedor = false) ou cancelado, ou resultado válido ausente',
         (select count(*) from public.homologacoes_itens hi
            join public.licitacao_resultados r on r.id = hi.resultado_id
           where r.vencedor = false or coalesce(r.situacao, '') = 'Cancelado')
         + (select count(*) from res_valido r
             where not exists (select 1 from public.homologacoes_itens hi where hi.resultado_id = r.id))
  union all
  select 'W3', 'orgaos_compradores: qtd_homologadas/qtd_fornecedores_vencedores contando lance perdedor',
         (select count(*) from oc left join grupo_res g on g.id = oc.id
           where oc.qtd_homologadas is distinct from coalesce(g.qtd_homologadas, 0)
              or oc.qtd_fornecedores_vencedores is distinct from coalesce(g.qtd_fornecedores, 0))
)
select regra, descricao, falhas, (falhas = 0) as ok,
       count(*) filter (where falhas > 0) over () as regras_com_falha,
       set_config('views_check.regras', (count(*) over ())::text, false) is not null
         and set_config('views_check.falhas',
               coalesce(string_agg(regra, ',') filter (where falhas > 0) over (), ''), false) is not null
         as totais_registrados
  from checks
 order by (falhas = 0), regra;

-- 2) Resultado final: erro se alguma regra falhou ----------------------------------------------------------
do $$
declare
  v_regras int := nullif(current_setting('views_check.regras', true), '')::int;
  v_falhas text := current_setting('views_check.falhas', true);
begin
  if v_regras is null then
    raise exception 'VIEWS CHECK: consulta 1 não rodou nesta sessão';
  end if;
  if v_regras <> 14 then
    raise exception 'VIEWS CHECK FALHOU: % regras em vez de 14', v_regras;
  end if;
  if coalesce(v_falhas, '') <> '' then
    raise exception 'VIEWS CHECK FALHOU: regras violadas: % (ver consulta 1)', v_falhas;
  end if;
  raise notice 'VIEWS CHECK OK: 14/14 regras (lance perdedor e resultado cancelado não contam; órgão sem CNPJ separado por fonte/nome; valor ausente = NULL)';
end $$;
