-- LicitaGym: PGC no radar da rota PCA (spec 0057, K-2 e K-4)
--
-- Contexto (medido em 11/11/2026): public.pca_pgc_itens guarda todos os campos de retorno da API do PGC, mas
-- public.v_bi_pca_radar só expunha 18 colunas; título e descrição do projeto, objeto do DFD, janela do processo de
-- compra, unidade de fornecimento, nome do PDM e da classe, artefato e data de atualização ficavam fora. A view junta
-- public.orgaos por cnpj, que não tinha índice simples (seq scan de ~12.200 linhas por órgão; count(*) da view
-- estourava o tempo limite e a api-pncp-pca respondia em 3,3 s de média). O coletor do PGC nunca rodou e a saúde
-- operacional não acompanhava o PGC.
--
-- O que muda:
--   * índice btree (não único) orgaos_cnpj_btree_idx em public.orgaos (cnpj);
--   * public.v_bi_pca_radar: mesmas 18 colunas, mesma ordem e mesma regra (o PGC prevalece sobre o PNCP), e 14
--     colunas novas no fim: nome_pdm, nome_classe, unidade_fornecimento, titulo_projeto, descricao_projeto,
--     objeto_dfd, data_formalizacao_demanda, data_inicio_processo, data_fim_processo, duracao_processo_dias,
--     artefato, atualizado_na_fonte_em, status_execucao_codigo (código opaco, sem rótulo) e mes_inicio_processo.
--     Do lado PNCP, nome_pdm vem do catálogo oficial (catmat_pdms) e unidade_fornecimento de pca_itens.unidade_medida;
--     o resto fica nulo (nada derivado);
--   * private.saude_limiares ganha 'pgc_dias_sem_coleta' (atenção 1,5 dia; crítico 8 dias; sem dado = atenção: a tabela
--     está vazia até a primeira coleta, e só crítico abre a issue alerta-operacional) e
--     private.saude_operacional_resumo() mede max(last_synced_at) de pca_pgc_itens. O resto da função é cópia fiel
--     de 20261109020000.
-- Quem lê: api-pncp-pca (service_role) e api-saude (service_role). Quem escreve pca_pgc_itens: coletor compras_pgc.
-- ACL: inalterada (view só service_role; função security definer com EXECUTE só service_role), reaplicada abaixo.
-- Dados: nenhum apagado. Idempotente.
-- Verificação: supabase/tests/pca_radar_pgc_campos_check.sql, saude_pgc_check.sql, pca_radar_pdm_oficial_check.sql,
-- pca_radar_orgaos_duplicado_check.sql e saude_operacional_check.sql.

begin;

set local lock_timeout = '10s';

create or replace view public.v_bi_pca_radar
with (security_invoker = true) as
with pdms_escopo as (
  select codigo_pdm, codigo_classe
  from public.catalogo_catmat_pdms_efetivos()
),
pgc_normalizado as (
  select
    'pgc'::text as fonte,
    p.orgao_cnpj,
    p.codigo_uasg,
    coalesce(nullif(p.nome_uasg, ''), o.nome_orgao, o.razao_social, p.orgao_cnpj) as orgao_nome,
    p.ano_pca_projeto_compra as ano_pca,
    x.codigo_pdm,
    p.codigo_item_catalogo as codigo_item,
    p.descricao_item_catalogo as descricao_item,
    p.quantidade_item as quantidade,
    p.valor_unitario_item as valor_unitario,
    p.valor_total_item as valor_total,
    coalesce(p.data_prevista_formalizacao_demanda, p.data_inicio_processo_compra) as data_prevista,
    to_char(coalesce(p.data_prevista_formalizacao_demanda, p.data_inicio_processo_compra), 'YYYY-MM') as mes_previsto,
    p.nivel_prioridade_dfd as prioridade,
    p.status_contratacao_execucao as status,
    p.numero_item_pncp,
    true as casamento_confirmado,
    'pgc_catmat'::text as metodo_identificacao,
    -- spec 0057: campos de retorno do PGC, como vieram da fonte (nome do PDM cai no catálogo oficial se vier vazio)
    coalesce(nullif(p.nome_pdm_material, ''), cp.nome_pdm) as nome_pdm,
    nullif(p.nome_classe_material, '') as nome_classe,
    nullif(p.sigla_unidade_fornecimento, '') as unidade_fornecimento,
    nullif(p.titulo_projeto_compra, '') as titulo_projeto,
    nullif(p.descricao_projeto_compra, '') as descricao_projeto,
    nullif(p.descricao_objeto_dfd, '') as objeto_dfd,
    p.data_prevista_formalizacao_demanda as data_formalizacao_demanda,
    p.data_inicio_processo_compra as data_inicio_processo,
    p.data_fim_processo_compra as data_fim_processo,
    p.duracao_processo_compra as duracao_processo_dias,
    nullif(p.descricao_artefato, '') as artefato,
    p.data_hora_atualizacao_item as atualizado_na_fonte_em,
    -- mesmo dado de status, com nome explícito de código opaco (spec 0057, P-2)
    p.status_contratacao_execucao as status_execucao_codigo,
    to_char(p.data_inicio_processo_compra, 'YYYY-MM') as mes_inicio_processo
  from public.pca_pgc_itens p
  -- orgaos tem uma linha por unidade: pega UM nome por CNPJ (com nome primeiro, ativo primeiro, ordem estável)
  left join lateral (
    select oo.nome_orgao, oo.razao_social
      from public.orgaos oo
     where oo.cnpj = p.orgao_cnpj
     order by (nullif(btrim(oo.nome_orgao), '') is null), (nullif(btrim(oo.razao_social), '') is null), oo.ativo desc, oo.id
     limit 1
  ) o on true
  left join public.catmat_itens ci on ci.codigo_item = p.codigo_item_catalogo
  cross join lateral (
    select coalesce(
      case when p.codigo_pdm_material ~ '^\d+$' then p.codigo_pdm_material::integer end,
      case when ci.codigo_pdm ~ '^\d+$' then ci.codigo_pdm::integer end
    ) as codigo_pdm
  ) x
  left join public.catmat_pdms cp on cp.codigo_pdm = x.codigo_pdm
  where x.codigo_pdm in (select codigo_pdm from pdms_escopo)
),
pncp_itens_norm as (
  select
    'pncp'::text as fonte,
    pl.orgao_cnpj,
    pl.unidade_codigo as codigo_uasg,
    coalesce(pl.titulo, o.nome_orgao, o.razao_social, pl.orgao_cnpj) as orgao_nome,
    pl.ano_exercicio as ano_pca,
    x.codigo_pdm,
    case when i.codigo_item_origem ~ '^\d+$' then i.codigo_item_origem::bigint else null end as codigo_item,
    i.descricao as descricao_item,
    i.quantidade,
    i.valor_unitario_estimado as valor_unitario,
    i.valor_total_estimado as valor_total,
    i.data_prevista_contratacao as data_prevista,
    to_char(i.data_prevista_contratacao, 'YYYY-MM') as mes_previsto,
    i.prioridade,
    i.status,
    i.numero_item as numero_item_pncp,
    -- PDM vindo do campo oficial pdmCodigo do PNCP e existente no CATMAT é confirmado (decisão do Marcelo, 09/10),
    -- sem depender do vínculo pca_item_pdm gravado pelo sync.
    (
      coalesce(pip.confirmado, false)
      or exists (
        select 1 from public.catmat_pdms cpo
         where i.pdm_codigo_origem ~ '^\d+$'
           and cpo.codigo_pdm = case when i.pdm_codigo_origem ~ '^\d+$' then i.pdm_codigo_origem::integer end
      )
    ) as casamento_confirmado,
    case
      when pip.confirmado then 'pncp_pdm_confirmado'
      when i.pdm_codigo_origem is not null then 'pncp_pdm_origem'
      when ci.codigo_pdm is not null then 'pncp_catmat_item'
      else 'pncp_classe_apenas'
    end as metodo_identificacao,
    -- spec 0057: o PCA do PNCP não traz projeto, DFD nem janela do processo; ficam nulos (nada derivado).
    -- nome_pdm vem do catálogo oficial (catmat_pdms) pelo PDM do item.
    cp.nome_pdm,
    null::text as nome_classe,
    nullif(i.unidade_medida, '') as unidade_fornecimento,
    null::text as titulo_projeto,
    null::text as descricao_projeto,
    null::text as objeto_dfd,
    null::date as data_formalizacao_demanda,
    null::date as data_inicio_processo,
    null::date as data_fim_processo,
    null::integer as duracao_processo_dias,
    null::text as artefato,
    null::timestamptz as atualizado_na_fonte_em,
    null::text as status_execucao_codigo,
    null::text as mes_inicio_processo
  from public.pca_itens i
  join public.pca_planos pl on pl.id = i.pca_plano_id
  -- orgaos tem uma linha por unidade: pega UM nome por CNPJ (com nome primeiro, ativo primeiro, ordem estável)
  left join lateral (
    select oo.nome_orgao, oo.razao_social
      from public.orgaos oo
     where oo.cnpj = pl.orgao_cnpj
     order by (nullif(btrim(oo.nome_orgao), '') is null), (nullif(btrim(oo.razao_social), '') is null), oo.ativo desc, oo.id
     limit 1
  ) o on true
  left join public.pca_item_pdm pip on pip.pca_item_id = i.id and pip.confirmado = true
  left join public.catmat_itens ci on ci.codigo_item::text = i.codigo_item_origem
  cross join lateral (
    select coalesce(
      pip.codigo_pdm,
      case when i.pdm_codigo_origem ~ '^\d+$' then i.pdm_codigo_origem::integer end,
      case when ci.codigo_pdm ~ '^\d+$' then ci.codigo_pdm::integer end
    ) as codigo_pdm
  ) x
  left join public.catmat_pdms cp on cp.codigo_pdm = x.codigo_pdm
  where i.ativo = true and pl.ativo = true
    and x.codigo_pdm in (select codigo_pdm from pdms_escopo)
    -- Deduplicação: descarta item do PNCP que já consta no PGC para o mesmo orgao, uasg, ano e numero_item_pncp
    -- (regra atual: o PGC prevalece)
    and not exists (
      select 1 from public.pca_pgc_itens pgc
      where pgc.orgao_cnpj = pl.orgao_cnpj
        and pgc.codigo_uasg = pl.unidade_codigo
        and pgc.ano_pca_projeto_compra = pl.ano_exercicio
        and pgc.numero_item_pncp = i.numero_item
    )
)
select * from pgc_normalizado
union all
select * from pncp_itens_norm;

revoke all on public.v_bi_pca_radar from anon, authenticated, PUBLIC;
grant select on public.v_bi_pca_radar to service_role;

-- Índice depois da view: o create or replace view espera as leituras em curso; com o índice antes, o SHARE lock em
-- orgaos ficaria preso durante essa espera (bloqueando o sync de órgãos).
-- nome próprio: orgaos_cnpj_idx foi o índice ÚNICO antigo, removido em 20260930130000 (vários códigos de órgão
-- compartilham CNPJ); compras_orgaos_uasgs_check garante que esse nome não volte. Este é btree comum, não único.
create index if not exists orgaos_cnpj_btree_idx on public.orgaos using btree (cnpj);


insert into private.saude_limiares (verificacao, descricao, unidade, atencao, critico, sem_dado) values
  ('pgc_dias_sem_coleta', 'Dias desde a última coleta do PGC (PCA do Compras.gov)', 'dias', 1.5, 8, 'atencao')
on conflict (verificacao) do nothing;

create or replace function private.saude_operacional_resumo()
returns table (verificacao text, status text, valor numeric, unidade text, atencao numeric, critico numeric,
               mensagem text, detalhe jsonb)
language plpgsql
stable
security definer
set search_path = pg_catalog, pg_temp
as $fn$
#variable_conflict use_column
declare
  m jsonb := '[]'::jsonb;   -- [{verificacao, valor, detalhe}]
  v numeric;
  d jsonb;
  n_com bigint;
  n_total bigint;
  total_estimado boolean;
begin
  if to_regclass('cron.job_run_details') is not null then
    execute $q$
      select count(*), coalesce(jsonb_agg(jsonb_build_object('job', j.jobname, 'em', r.start_time,
                                          'erro', left(r.return_message, 200)) order by r.start_time desc), '[]'::jsonb)
        from cron.job_run_details r join cron.job j on j.jobid = r.jobid
       where j.jobname like 'licitagym-%' and r.status = 'failed' and r.start_time > now() - interval '24 hours'$q$
      into v, d;
    m := m || jsonb_build_array(jsonb_build_object('verificacao', 'cron_falhas_24h', 'valor', v, 'detalhe', d));
  end if;

  if to_regclass('private.cron_edge_chamadas') is not null then
    select count(*), coalesce(jsonb_agg(jsonb_build_object('job', c.job, 'funcao', c.funcao, 'http', c.status_code,
                                        'timeout', c.timed_out, 'erro', left(coalesce(c.erro, c.resposta), 200),
                                        'em', c.chamado_em) order by c.chamado_em desc), '[]'::jsonb)
      into v, d
      from private.cron_edge_chamadas c
     where c.chamado_em > now() - interval '24 hours'
       and (c.status_code >= 400 or c.timed_out or c.erro is not null);
    m := m || jsonb_build_array(jsonb_build_object('verificacao', 'cron_http_erros_24h', 'valor', v, 'detalhe', d));

    select count(*), coalesce(jsonb_agg(jsonb_build_object('job', c.job, 'funcao', c.funcao, 'em', c.chamado_em)), '[]'::jsonb)
      into v, d
      from private.cron_edge_chamadas c
     where c.respondido_em is null and c.chamado_em < now() - interval '30 minutes'
       and c.chamado_em > now() - interval '7 days';
    m := m || jsonb_build_array(jsonb_build_object('verificacao', 'cron_sem_resposta', 'valor', v, 'detalhe', d));
  end if;

  select round(max(extract(epoch from now() - coalesce(r.last_heartbeat_at, r.iniciada_em)) / 60)),
         coalesce(jsonb_agg(jsonb_build_object('id', r.id, 'resource', r.resource_type,
                            'heartbeat', coalesce(r.last_heartbeat_at, r.iniciada_em))), '[]'::jsonb)
    into v, d
    from private.pncp_sync_run r where r.status = 'executando';
  m := m || jsonb_build_array(jsonb_build_object('verificacao', 'pncp_sync_heartbeat_parado', 'valor', coalesce(v, 0), 'detalhe', d));

  select count(*), coalesce(jsonb_agg(jsonb_build_object('id', r.id, 'resource', r.resource_type,
                                      'erro', left(r.erro_principal, 200), 'em', r.iniciada_em)), '[]'::jsonb)
    into v, d
    from private.pncp_sync_run r where r.status = 'falhou' and r.iniciada_em > now() - interval '24 hours';
  m := m || jsonb_build_array(jsonb_build_object('verificacao', 'pncp_sync_falhas_24h', 'valor', v, 'detalhe', d));

  select max(t.dias), jsonb_object_agg(t.resource_type, t.dias)
    into v, d
    from (select x.resource_type,
                 round((extract(epoch from now() - max(r.finalizada_em)) / 86400)::numeric, 1) as dias
            from (values ('pca'), ('orgaos'), ('compras_catmat')) x(resource_type)
            left join private.pncp_sync_run r
              on r.resource_type = x.resource_type and r.status in ('concluida', 'concluida_com_erros')
           group by x.resource_type) t;
  m := m || jsonb_build_array(jsonb_build_object('verificacao', 'pncp_sync_dias_sem_sucesso', 'valor', v, 'detalhe', d));

  if to_regclass('private.coleta_externa_run') is not null then
    -- pior fonte entre as que já concluíram alguma vez; nenhuma conclusão = sem dado (crítico)
    select round((extract(epoch from now() - min(r.ultima)) / 86400)::numeric, 1),
           coalesce(jsonb_object_agg(r.fonte, r.ultima), '{}'::jsonb)
      into v, d
      from (select fonte, max(finished_at) as ultima
              from private.coleta_externa_run where status in ('concluida', 'concluida_com_erros')
             group by fonte) r;
    m := m || jsonb_build_array(jsonb_build_object('verificacao', 'coleta_externa_dias_sem_sucesso', 'valor', v, 'detalhe', d));
  end if;

  if to_regclass('public.precos_praticados_itens') is not null then
    -- Pesquisa de Preço (spec 0009): dias desde a última gravação de preço. last_synced_at só muda quando o upsert
    -- do coletor grava; uma coleta que falha inteira não move a data. Nenhum preço = sem dado (crítico).
    select round((extract(epoch from now() - max(p.last_synced_at)) / 86400)::numeric, 1),
           jsonb_build_object(
             'ultima_coleta', max(p.last_synced_at),
             'linhas', count(*),
             'sem_descricao_detalhada', count(*) filter (where nullif(btrim(p.descricao_detalhada_item), '') is null),
             'detalhe_sincronizado', count(*) filter (where p.detalhe_sincronizado_em is not null))
      into v, d
      from public.precos_praticados_itens p;
    m := m || jsonb_build_array(jsonb_build_object('verificacao', 'precos_dias_sem_coleta', 'valor', v, 'detalhe', d));
  end if;

  if to_regclass('public.pca_pgc_itens') is not null then
    -- PGC (spec 0057): dias desde a última gravação do coletor compras_pgc. O upsert regrava last_synced_at de toda
    -- linha lida; uma coleta que falha inteira não move a data. Nenhuma linha = sem dado (atenção, pelo limiar).
    select round((extract(epoch from now() - max(p.last_synced_at)) / 86400)::numeric, 1),
           jsonb_build_object('ultima_coleta', max(p.last_synced_at), 'linhas', count(*))
      into v, d
      from public.pca_pgc_itens p;
    m := m || jsonb_build_array(jsonb_build_object('verificacao', 'pgc_dias_sem_coleta', 'valor', v, 'detalhe', d));
  end if;

  select round((extract(epoch from now() - max(l.created_at)) / 3600)::numeric, 1),
         coalesce((select jsonb_object_agg(f.fonte, f.ultima)
                     from (select fonte, max(created_at) as ultima from public.licitacoes_externas group by fonte) f), '{}'::jsonb)
    into v, d
    from public.licitacoes_externas l;
  m := m || jsonb_build_array(jsonb_build_object('verificacao', 'licitacoes_horas_sem_novas', 'valor', v, 'detalhe', d));

  -- Itens sem taxonomia: conta exato só os itens COM taxonomia (poucos), pelo índice de expressão
  -- licitacao_itens_no_taxonomia_efetiva_idx (o predicado repete a expressão do índice). O total vem da estimativa
  -- do planner (pg_class.reltuples, mantida por autovacuum/analyze) e o detalhe diz isso em total_estimado.
  -- Tabela nunca analisada (reltuples < 0): conta exato, porque aí ela ainda é pequena.
  select count(*) into n_com
    from public.licitacao_itens i
   where coalesce(i.no_taxonomia, i.taxonomia ->> 'no_taxonomia') is not null;
  select c.reltuples::bigint into n_total from pg_class c where c.oid = 'public.licitacao_itens'::regclass;
  total_estimado := coalesce(n_total, -1) >= 0;
  if not total_estimado then
    select count(*) into n_total from public.licitacao_itens;
  end if;
  n_total := greatest(n_total, n_com);
  v := round(100.0 * (n_total - n_com) / nullif(n_total, 0), 1);
  d := jsonb_build_object('itens', n_total, 'sem_taxonomia', n_total - n_com, 'com_taxonomia', n_com,
                          'total_estimado', total_estimado);
  m := m || jsonb_build_array(jsonb_build_object('verificacao', 'itens_sem_taxonomia_pct', 'valor', v, 'detalhe', d));

  return query
    with medidas as (
      select e ->> 'verificacao' as verificacao, (e ->> 'valor')::numeric as valor, e -> 'detalhe' as detalhe
        from jsonb_array_elements(m) e
    ), avaliadas as (
      select x.verificacao,
             case when x.valor is null then l.sem_dado
                  when l.critico is not null and x.valor >= l.critico then 'critico'
                  when x.valor >= l.atencao then 'atencao'
                  else 'ok' end as status,
             x.valor, l.unidade, l.atencao, l.critico, l.descricao, x.detalhe
        from medidas x join private.saude_limiares l on l.verificacao = x.verificacao
       where l.ativo
    )
    select a.verificacao, a.status, a.valor, a.unidade, a.atencao, a.critico,
           a.descricao || ': ' || coalesce(a.valor::text || ' ' || a.unidade, 'sem dado') ||
             ' (atenção ≥ ' || a.atencao || coalesce(', crítico ≥ ' || a.critico, '') || ')',
           a.detalhe
      from avaliadas a
     order by case a.status when 'critico' then 0 when 'atencao' then 1 else 2 end, a.verificacao;
end
$fn$;

comment on function private.saude_operacional_resumo() is
  'Verificações de saúde da ingestão (cron, sync PNCP, coleta externa, coleta de preços, PGC, volume, taxonomia) com '
  'status por limiar de private.saude_limiares. Só leitura. EXECUTE só service_role (api-saude).';

revoke all on function private.saude_operacional_resumo() from public, anon, authenticated;
grant execute on function private.saude_operacional_resumo() to service_role;

commit;
