-- LicitaGym: tarefa padrão por agente na etapa Nova (spec 0035, K-12 e R-15).
--
-- Por quê (Marcelo, 21/10): as Etapas e tarefas do pipeline já nascem com uma tarefa por agente. A semente fica em
-- pipeline_semear_tarefas, que o gatilho de empresa nova e o de empresa reativada já chamam (sem gatilho novo).
--
-- O que faz:
--   1) pipeline_semear_tarefas ganha 'Analisar o edital' (Agente de Edital) e 'Conferir a base legal' (Agente Jurídico)
--      na etapa padrão Nova (padrao and nome = 'Nova'; Nova renomeada ou excluída não recebe).
--   2) roda a semente para as empresas ativas (on conflict do nothing: não desfaz edição do admin).
--   3) cria a tarefa do agente nos cards que já estão numa etapa com tarefa de agente ativa (o gatilho só age na
--      entrada da etapa), por pipeline_tarefas_agente_backfill(). Só as tarefas de agente: diferente do
--      pipeline_tarefas_reaplicar citado na R-15, não cria as outras tarefas que faltem nesses cards (em produção, os 3
--      cards da Nova não têm as tarefas de catálogo da Nova, e criá-las agora seria mudança que ninguém pediu).
-- Contagem antes/depois (dry-run) no PR. Quem chama: só service_role. Idempotente. O merge na main aplica em produção.
-- Verificação: supabase/tests/tarefas_responsavel_agente_check.sql.

begin;

set local lock_timeout = '5s';

create or replace function public.pipeline_semear_tarefas(p_tenant bigint)
returns integer
language sql
security invoker
set search_path = public, pg_temp
as $$
  with catalogo (etapa, codigo, ordem) as (
    values
      ('Qualificação', '14133-F01-T01', 10), ('Qualificação', '14133-F01-T03', 20), ('Qualificação', '14133-F01-T04', 30),
      ('Qualificação', '14133-F01-T05', 40), ('Qualificação', '14133-F01-T06', 50),
      ('Preparando proposta', '14133-F01-T07', 10), ('Preparando proposta', '14133-F01-T08', 20),
      ('Preparando proposta', '14133-F01-T09', 30), ('Preparando proposta', '14133-F01-T10', 40),
      ('Documentação', '14133-F01-T11', 10), ('Documentação', '14133-F04-T01', 20), ('Documentação', '14133-F04-T02', 30),
      ('Documentação', '14133-F04-T03', 40), ('Documentação', '14133-F04-T04', 50), ('Documentação', '14133-F04-T05', 60),
      ('Proposta enviada', '14133-F02-T01', 10), ('Proposta enviada', '14133-F02-T02', 20),
      ('Proposta enviada', '14133-F02-T03', 30), ('Proposta enviada', '14133-F02-T04', 40),
      ('Proposta enviada', '14133-F02-T05', 50), ('Proposta enviada', '14133-F03-T01', 60),
      ('Proposta enviada', '14133-F03-T02', 70), ('Proposta enviada', '14133-F03-T03', 80),
      ('Proposta enviada', '14133-F03-T04', 90), ('Proposta enviada', '14133-F03-T05', 100),
      ('Disputa', '14133-F02-T01', 10), ('Disputa', '14133-F02-T02', 20), ('Disputa', '14133-F02-T03', 30),
      ('Disputa', '14133-F02-T04', 40), ('Disputa', '14133-F02-T05', 50), ('Disputa', '14133-F03-T01', 60),
      ('Disputa', '14133-F03-T02', 70), ('Disputa', '14133-F03-T03', 80), ('Disputa', '14133-F03-T04', 90),
      ('Disputa', '14133-F03-T05', 100),
      ('Aguardando resultado', '14133-F05-T01', 10), ('Aguardando resultado', '14133-F05-T02', 20),
      ('Aguardando resultado', '14133-F05-T03', 30), ('Aguardando resultado', '14133-F05-T04', 40),
      ('Aguardando resultado', '14133-F05-T05', 50), ('Aguardando resultado', '14133-F05-T06', 60),
      ('Aguardando resultado', '14133-F05-T07', 70),
      ('Vencida', '14133-F06-T01', 10), ('Vencida', '14133-F06-T04', 20), ('Vencida', '14133-F07-T01', 30),
      ('Vencida', '14133-F07-T02', 40), ('Vencida', '14133-F07-T03', 50), ('Vencida', '14133-F07-T04', 60),
      ('Vencida', '14133-F07-T05', 70), ('Vencida', '14133-F07-T06', 80), ('Vencida', '14133-F07-T07', 90),
      ('Perdida', '14133-F05-T01', 10), ('Perdida', '14133-F05-T02', 20), ('Perdida', '14133-F05-T03', 30),
      ('Perdida', '14133-F05-T04', 40), ('Perdida', '14133-F05-T05', 50), ('Perdida', '14133-F06-T03', 60)
  ),
  empresa (etapa, chave, titulo, descricao, ordem) as (
    values
      ('Triagem', 'triagem-aderencia', 'Confirmar a aderência item a item',
       'Descrição, especificação e quantidade de cada item contra o catálogo da empresa.', 10),
      ('Triagem', 'triagem-restricoes-lote', 'Conferir as restrições de participação por lote',
       'Lote exclusivo ME/EPP contra o porte da empresa; marca de referência; norma de certificação exigida; '
       'assistência técnica local.', 20),
      ('Em análise', 'analise-ler-edital', 'Ler o edital',
       'Exigências técnicas, amostra, atestados e prazo de entrega.', 10),
      ('Em análise', 'analise-preco-referencia', 'Conferir o preço de referência contra o piso da empresa',
       'Referência praticada do item contra o piso da empresa.', 20),
      ('Em análise', 'analise-dossie', 'Montar o dossiê por item antes da sessão',
       'Catálogo ou ficha, manual e certificado de conformidade do modelo, em português; declarações; atestado com '
       'nota fiscal; balanço.', 30),
      ('Em análise', 'analise-frete', 'Confirmar o frete até o local de entrega',
       'A distância calculada é só indicador aproximado (frete não verificado).', 40),
      ('Interessante', 'interessante-decidir', 'Decidir GO, GO condicionado ou NO-GO',
       'Decisão humana, com motivo; a recomendação dos agentes não tem pontuação.', 10)
  ),
  ins_cat as (
    insert into public.pipeline_etapa_tarefas (tenant_id, etapa_id, origem, tarefa_codigo, ordem)
    select p_tenant, e.id, 'catalogo', c.codigo, c.ordem
      from catalogo c
      join public.pipeline_etapas e on e.tenant_id = p_tenant and e.padrao and e.nome = c.etapa
      join public.tarefas_catalogo tc on tc.codigo = c.codigo and tc.ativo
    on conflict (etapa_id, tarefa_codigo) where origem = 'catalogo' do nothing
    returning 1
  ),
  ins_emp as (
    insert into public.pipeline_etapa_tarefas (tenant_id, etapa_id, origem, chave, titulo, descricao, ordem)
    select p_tenant, e.id, 'empresa', m.chave, m.titulo, m.descricao, m.ordem
      from empresa m
      join public.pipeline_etapas e on e.tenant_id = p_tenant and e.padrao and e.nome = m.etapa
    on conflict (tenant_id, chave) where origem = 'empresa' do nothing
    returning 1
  ),
  -- Spec 0035: uma tarefa de agente por agente ativo na etapa padrão Nova ("o nome é o contrato": Nova renomeada
  -- ou excluída não recebe). on conflict do nothing: não recria a que o admin desligou.
  agente (etapa, chave, titulo, descricao, agente, ordem) as (
    values
      ('Nova', 'agente-edital', 'Analisar o edital',
       'Rodar o Agente de Edital na rota do agente e enviar a análise para a oportunidade.', 'edital', 1010),
      ('Nova', 'agente-juridico', 'Conferir a base legal',
       'Rodar o Agente Jurídico na rota do agente e enviar a análise para a oportunidade.', 'juridico', 1020)
  ),
  ins_agt as (
    insert into public.pipeline_etapa_tarefas
           (tenant_id, etapa_id, origem, chave, titulo, descricao, ordem, responsavel_tipo, responsavel_agente)
    select p_tenant, e.id, 'agente', g.chave, g.titulo, g.descricao, g.ordem, 'agente', g.agente
      from agente g
      join public.pipeline_etapas e on e.tenant_id = p_tenant and e.padrao and e.nome = g.etapa
      join public.agentes_catalogo ac on ac.codigo = g.agente and ac.ativo
    on conflict (tenant_id, etapa_id, responsavel_agente) where origem = 'agente' do nothing
    returning 1
  )
  select ((select count(*) from ins_cat) + (select count(*) from ins_emp) + (select count(*) from ins_agt))::integer
$$;
comment on function public.pipeline_semear_tarefas(bigint) is
  'Semente do modelo padrão de tarefas nas 13 etapas padrão (spec 0018, seções 2 e 2b). on conflict do nothing: '
  'reaplicar não duplica nem desfaz edição do admin. Spec 0035: tarefas de agente (edital, jurídico) na etapa padrão Nova.';

select public.pipeline_semear_tarefas(t.id) from public.tenants t where t.ativo;

-- Cards já parados na etapa: mesma regra de pipeline_etapa_tarefas_criar para a parte de agente.
create or replace function public.pipeline_tarefas_agente_backfill()
returns integer
language sql
security invoker
set search_path = public, pg_temp
as $$
  with ins as (
    insert into public.tarefas_equipe (
      tenant_id, licitacao_id, origem, titulo, descricao, condicao_verificada, prazo_situacao, prazo_em,
      responsavel_papel, responsavel_tipo, responsavel_agente,
      origem_etapa_id, origem_modelo_id, origem_etapa_nome, origem_modelo_chave
    )
    select po.tenant_id, po.licitacao_id, 'empresa', m.titulo, m.descricao, true,
           case when m.prazo_horas is null then 'sem_prazo' else 'calculado' end,
           case when m.prazo_horas is null then null else now() + make_interval(hours => m.prazo_horas) end,
           'admin', 'agente', ag.codigo, e.id, m.id, e.nome, m.chave
      from public.pipeline_oportunidades po
      join public.tenants t on t.id = po.tenant_id and t.ativo
      join public.pipeline_etapas e on e.id = po.etapa_id and e.tenant_id = po.tenant_id
      join public.pipeline_etapa_tarefas m
        on m.tenant_id = po.tenant_id and m.etapa_id = po.etapa_id and m.origem = 'agente' and m.ativo
      join public.agentes_catalogo ag on ag.codigo = m.responsavel_agente and ag.ativo
    on conflict (tenant_id, licitacao_id, origem_modelo_chave) where origem = 'empresa' do nothing
    returning 1
  )
  select count(*)::integer from ins
$$;
comment on function public.pipeline_tarefas_agente_backfill() is
  'Spec 0035 (R-15): cria a tarefa de agente dos cards que já estão numa etapa com tarefa de agente ativa. '
  'on conflict do nothing: rodar de novo não duplica. Só a migration e os checks chamam (sem grant).';

select public.pipeline_tarefas_agente_backfill();

revoke all on function public.pipeline_tarefas_agente_backfill() from PUBLIC, anon, authenticated, service_role;
revoke all on function public.pipeline_semear_tarefas(bigint) from PUBLIC, anon, authenticated;
grant execute on function public.pipeline_semear_tarefas(bigint) to service_role;

commit;
