-- LicitaGym: consultas das rotas dos agentes (spec 0035, K-0, K-1, R-1 a R-3).
--
-- Por quê: a rota do agente (/agentes/editais, /agentes/juridico) busca as oportunidades do pipeline que estão numa
-- etapa com tarefa ativa daquele agente e lista os documentos oficiais da escolhida. As duas consultas juntam tabelas
-- com tenant_id e contam páginas indexadas; ficam no banco para casar a empresa dos dois lados (R-2) e não trazer os
-- chunks para a Edge Function só para contar.
--
-- O que cria:
--   public.agente_oportunidades_buscar(tenant, agente, busca, limite, deslocamento)
--     oportunidades do pipeline da empresa numa etapa com tarefa de agente ativa (modelo da mesma empresa), filtradas
--     pela busca (já saneada pela api-agentes), por prazo (data_fim) crescente e depois id; total na coluna `total`.
--   public.agente_documentos_listar(tenant, licitacao)
--     documentos da licitação com colunas fixas (nunca storage_uri, raw, extracao) e as páginas distintas indexadas
--     (null sem chunks). Licitação fora do pipeline da empresa: P0002 (404 na api-agentes).
-- Quem chama: só service_role (api-agentes). Só leitura, aditiva e idempotente. O merge na main aplica em produção.
-- Verificação: supabase/tests/agente_consultas_check.sql.

begin;

set local lock_timeout = '5s';

create or replace function public.agente_oportunidades_buscar(
  p_tenant       bigint,
  p_agente       text,
  p_busca        text,
  p_limite       integer,
  p_deslocamento integer
)
returns table (
  licitacao_id    bigint,
  numero_edital   text,
  numero_processo text,
  orgao_nome      text,
  municipio       text,
  uf              text,
  objeto          text,
  modalidade      text,
  data_fim        timestamptz,
  etapa_id        bigint,
  etapa_nome      text,
  total           bigint
)
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  with etapas as (
    select distinct m.etapa_id
      from public.pipeline_etapa_tarefas m
     where m.tenant_id = p_tenant and m.origem = 'agente' and m.ativo and m.responsavel_agente = p_agente
  ),
  achadas as (
    select le.id, le.numero_edital, le.numero_processo, le.orgao_nome, le.municipio, le.uf, le.objeto,
           le.modalidade, le.data_fim, e.id as etapa_id, e.nome as etapa_nome
      from public.pipeline_oportunidades po
      join etapas et on et.etapa_id = po.etapa_id
      join public.pipeline_etapas e on e.tenant_id = po.tenant_id and e.id = po.etapa_id
      join public.licitacoes_externas le on le.id = po.licitacao_id
     where po.tenant_id = p_tenant
       and (nullif(btrim(p_busca), '') is null
            or le.objeto ilike '%' || btrim(p_busca) || '%'
            or le.orgao_nome ilike '%' || btrim(p_busca) || '%'
            or le.municipio ilike '%' || btrim(p_busca) || '%'
            or le.numero_edital ilike '%' || btrim(p_busca) || '%'
            or le.numero_processo ilike '%' || btrim(p_busca) || '%'
            or le.id::text = btrim(p_busca))
  )
  select a.id, a.numero_edital, a.numero_processo, a.orgao_nome, a.municipio, a.uf, a.objeto, a.modalidade,
         a.data_fim, a.etapa_id, a.etapa_nome, count(*) over ()
    from achadas a
   order by a.data_fim asc nulls last, a.id
   limit least(greatest(coalesce(p_limite, 20), 1), 50)
  offset greatest(coalesce(p_deslocamento, 0), 0);
$$;
comment on function public.agente_oportunidades_buscar(bigint, text, text, integer, integer) is
  'Rota do agente (spec 0035, K-0/R-2): oportunidades do pipeline da empresa numa etapa com tarefa ativa do agente. '
  'A busca chega saneada (sanitizeSearchTerm). Limite 1 a 50. Só service_role.';

create or replace function public.agente_documentos_listar(
  p_tenant    bigint,
  p_licitacao bigint
)
returns table (
  id                   bigint,
  secao                text,
  nome                 text,
  data_documento       timestamptz,
  status_processamento text,
  paginas              integer,
  erro                 text
)
language plpgsql
stable
security invoker
set search_path = public, pg_temp
as $$
begin
  if not exists (select 1 from public.pipeline_oportunidades po
                  where po.tenant_id = p_tenant and po.licitacao_id = p_licitacao) then
    raise exception 'Licitação fora do pipeline da empresa.' using errcode = 'P0002';
  end if;
  return query
  select d.id, d.secao, coalesce(nullif(btrim(d.nome_original), ''), d.arquivo_origem), d.data_documento,
         d.status_processamento,
         (select nullif(count(distinct c.pagina), 0)::integer
            from public.licitacao_chunks c
           where c.documento_id = d.id and c.pagina is not null),
         d.erro
    from public.licitacao_documentos d
   where d.licitacao_id = p_licitacao
   order by d.secao, d.data_documento asc nulls last, d.id
   limit 500;
end;
$$;
comment on function public.agente_documentos_listar(bigint, bigint) is
  'Documentos oficiais da licitação para a rota do agente (spec 0035, K-1/R-3): colunas fixas e páginas indexadas. '
  'P0002 fora do pipeline da empresa. `erro` sai cru só para a api-agentes, que devolve a categoria. Só service_role.';

revoke all on function public.agente_oportunidades_buscar(bigint, text, text, integer, integer) from PUBLIC, anon, authenticated;
revoke all on function public.agente_documentos_listar(bigint, bigint) from PUBLIC, anon, authenticated;
grant execute on function public.agente_oportunidades_buscar(bigint, text, text, integer, integer) to service_role;
grant execute on function public.agente_documentos_listar(bigint, bigint) to service_role;

commit;
