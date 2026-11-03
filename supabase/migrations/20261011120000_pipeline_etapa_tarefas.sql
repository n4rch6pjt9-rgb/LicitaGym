-- LicitaGym: tarefas padrão por etapa do pipeline (spec 0018, PR 2 da ordem; decisões 1 a 11).
--
-- Por quê: ao entrar numa etapa, a equipe recebe as tarefas daquela etapa, do catálogo 14.133 ou escritas pela empresa.
-- tarefas_equipe (#252, 20261011110000) e o regulamento (spec 0020, 20261011110100) já estão em produção.
--
-- O que muda:
--   public.pipeline_etapa_tarefas           modelo de tarefas por etapa (configuração da empresa)
--   public.pipeline_semear_tarefas()        semente do modelo padrão (seções 2 e 2b); o gatilho de tenant a chama
--   public.pipeline_etapa_tarefas_criar()   cria as tarefas da etapa para uma licitação (idempotente)
--   public.pipeline_tarefas_reaplicar()     recria as tarefas da etapa atual e das visitadas (regulamento que chegou)
--   gatilho em pipeline_oportunidades       ao entrar numa etapa (pipeline_mover, pipeline_etapa_excluir, #308), cria
--   gatilho em licitacoes_externas          regulamento nulo -> preenchido: reaplica para quem tem no pipeline
--   tarefas_equipe                          colunas de origem por etapa, índice da tarefa da empresa, constraints
--                                           de origem e de prazo refeitas (drop/add; só ampliam)
-- A fila de Triagem (private.job_queue) NÃO entra aqui: vai no PR 4, com o consumidor (spec 0018, ordem dos PRs).
--
-- Regras (spec 0018):
--   * tarefa do catálogo vinda da etapa continua origem = 'catalogo' (mesmo alvo de conflito da #252: uma instância
--     só, com as duas origens); tarefa da empresa é única por (tenant, licitação, origem_modelo_chave);
--   * catálogo só com regulamento LEI_14133/LEI_14981; nulo -> só tarefas da empresa ("regulamento_nao_informado");
--     outro -> só da empresa ("regulamento_sem_catalogo"). Condição falsa não nasce; ausente nasce "não verificada";
--   * nasce na fila do admin (responsavel_papel = 'admin', sem pessoa); sair da etapa não fecha nem apaga;
--   * excluir etapa: modelo cai em cascata; a tarefa fica, com origem_etapa_id nulo e o retrato (origem_etapa_nome).
--
-- Quem lê/escreve: só service_role (api-pipeline, pipeline_mover, coletor). Verificar:
-- supabase/tests/pipeline_etapa_tarefas_check.sql. Idempotente.

begin;

set local lock_timeout = '5s';

-- 1) Modelo por etapa ----------------------------------------------------------------------------------------------
create table if not exists public.pipeline_etapa_tarefas (
  id            bigint generated always as identity primary key,
  tenant_id     bigint not null,
  etapa_id      bigint not null,
  origem        text   not null,
  tarefa_codigo text   references public.tarefas_catalogo (codigo),
  chave         text,
  titulo        text,
  descricao     text,
  prazo_horas   integer,
  ordem         integer not null default 0,
  ativo         boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  updated_by    uuid,
  constraint pipeline_etapa_tarefas_etapa_fkey foreign key (tenant_id, etapa_id)
    references public.pipeline_etapas (tenant_id, id) on delete cascade,
  constraint pipeline_etapa_tarefas_origem_chk check (
    (origem = 'catalogo' and tarefa_codigo is not null and chave is null and titulo is null and prazo_horas is null)
    or (origem = 'empresa' and tarefa_codigo is null and nullif(btrim(chave), '') is not null
        and nullif(btrim(titulo), '') is not null)
  ),
  constraint pipeline_etapa_tarefas_prazo_chk check (prazo_horas is null or prazo_horas > 0),
  constraint pipeline_etapa_tarefas_titulo_chk check (titulo is null or char_length(titulo) <= 200),
  constraint pipeline_etapa_tarefas_tenant_id_key unique (tenant_id, id)
);
comment on table public.pipeline_etapa_tarefas is
  'Modelo de tarefas por etapa do pipeline (spec 0018): do catálogo 14.133 (tarefa_codigo) ou da empresa (chave '
  'imutável, título). Desligar é ativo = false; a api-pipeline nunca apaga. Só service_role.';
comment on column public.pipeline_etapa_tarefas.chave is
  'Só origem = empresa: identificador imutável, único na empresa (semente: slug fixo; admin: emp- + 8 hex).';

create unique index if not exists pipeline_etapa_tarefas_catalogo_uq
  on public.pipeline_etapa_tarefas (etapa_id, tarefa_codigo) where origem = 'catalogo';
create unique index if not exists pipeline_etapa_tarefas_empresa_uq
  on public.pipeline_etapa_tarefas (tenant_id, chave) where origem = 'empresa';
create index if not exists pipeline_etapa_tarefas_etapa_idx on public.pipeline_etapa_tarefas (tenant_id, etapa_id);

-- Tarefa do catálogo no modelo precisa existir, estar ativa e ser do fornecedor (CA-13). Só ao inserir, trocar o
-- código ou ligar o modelo: desligar (ativo = false) sempre pode, mesmo com a tarefa já inativa no catálogo.
create or replace function public.pipeline_etapa_tarefas_validar()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  if new.origem = 'catalogo' and new.ativo
     and (tg_op = 'INSERT' or new.tarefa_codigo is distinct from old.tarefa_codigo or not old.ativo)
     and not exists (
       select 1 from public.tarefas_catalogo c
        where c.codigo = new.tarefa_codigo and c.ativo
          and c.ator in ('licitante', 'contratado', 'licitante_ou_contratado')) then
    raise exception 'Tarefa % não está ativa no catálogo ou não é do fornecedor.', new.tarefa_codigo
      using errcode = '23514';
  end if;
  return new;
end;
$$;
drop trigger if exists pipeline_etapa_tarefas_validar_trg on public.pipeline_etapa_tarefas;
create trigger pipeline_etapa_tarefas_validar_trg
  before insert or update on public.pipeline_etapa_tarefas
  for each row execute function public.pipeline_etapa_tarefas_validar();

alter table public.pipeline_etapa_tarefas enable row level security;
revoke all on table public.pipeline_etapa_tarefas from PUBLIC, anon, authenticated;
grant select, insert, update, delete on table public.pipeline_etapa_tarefas to service_role;

-- 2) tarefas_equipe: origem por etapa ---------------------------------------------------------------------------
alter table public.tarefas_equipe
  add column if not exists origem_etapa_id     bigint,
  add column if not exists origem_modelo_id    bigint,
  add column if not exists origem_etapa_nome   text,
  add column if not exists origem_modelo_chave text;
-- FKs com tenant_id: a tarefa da empresa A nunca aponta para etapa ou modelo da empresa B. Excluir a etapa (ou o
-- modelo) anula só a coluna de origem; tenant_id fica.
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'tarefas_equipe_origem_etapa_fkey') then
    alter table public.tarefas_equipe add constraint tarefas_equipe_origem_etapa_fkey
      foreign key (tenant_id, origem_etapa_id) references public.pipeline_etapas (tenant_id, id)
      on delete set null (origem_etapa_id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'tarefas_equipe_origem_modelo_fkey') then
    alter table public.tarefas_equipe add constraint tarefas_equipe_origem_modelo_fkey
      foreign key (tenant_id, origem_modelo_id) references public.pipeline_etapa_tarefas (tenant_id, id)
      on delete set null (origem_modelo_id);
  end if;
end $$;
comment on column public.tarefas_equipe.origem_etapa_nome is
  'Retrato do nome da etapa que criou a tarefa (fica quando a etapa é excluída e origem_etapa_id vira nulo).';
comment on column public.tarefas_equipe.origem_modelo_chave is
  'Chave imutável do modelo (origem = empresa): idempotência da tarefa da empresa por (tenant, licitação, chave).';

create unique index if not exists tarefas_equipe_empresa_uq
  on public.tarefas_equipe (tenant_id, licitacao_id, origem_modelo_chave) where origem = 'empresa';
create index if not exists tarefas_equipe_origem_etapa_idx on public.tarefas_equipe (origem_etapa_id);
create index if not exists tarefas_equipe_origem_modelo_idx on public.tarefas_equipe (origem_modelo_id);

-- Constraints refeitas só quando ainda não aceitam o novo (drop/add que só amplia; tabela com 0 linhas em 11/10).
do $$ begin
  if not exists (select 1 from pg_constraint
                  where conrelid = 'public.tarefas_equipe'::regclass and conname = 'tarefas_equipe_origem_chk'
                    and pg_get_constraintdef(oid) like '%origem_etapa_nome%') then
    alter table public.tarefas_equipe drop constraint if exists tarefas_equipe_origem_chk;
    alter table public.tarefas_equipe add constraint tarefas_equipe_origem_chk check (
      (origem = 'catalogo' and tarefa_codigo is not null
        and (liberada_por_fase is not null or liberada_por_evento is not null or origem_etapa_nome is not null))
      or (origem = 'empresa' and tarefa_codigo is null and nullif(btrim(titulo), '') is not null)
    );
  end if;
  if not exists (select 1 from pg_constraint
                  where conrelid = 'public.tarefas_equipe'::regclass and conname = 'tarefas_equipe_prazo_chk'
                    and pg_get_constraintdef(oid) like '%sem_prazo''%') then
    alter table public.tarefas_equipe drop constraint if exists tarefas_equipe_prazo_chk;
    alter table public.tarefas_equipe add constraint tarefas_equipe_prazo_chk check (
      prazo_situacao in ('nao_calculado', 'definido_no_edital', 'sem_prazo_legal', 'imediato', 'manual', 'calculado',
                         'sem_prazo')
      and ((prazo_situacao in ('manual', 'calculado')) = (prazo_em is not null))
      and (prazo_situacao <> 'manual' or (prazo_informado_por is not null and prazo_informado_em is not null))
    );
  end if;
end $$;
comment on column public.tarefas_equipe.prazo_situacao is
  'nao_calculado (dias úteis sem calendário, ou sem data do evento), definido_no_edital, sem_prazo_legal, imediato, '
  'manual (prazo_em informado pela equipe), calculado (prazo_horas da tarefa da empresa, contado da entrada na etapa), '
  'sem_prazo (tarefa da empresa sem prazo).';

-- 3) Semente do modelo padrão (seções 2 e 2b) -------------------------------------------------------------------
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
  )
  select ((select count(*) from ins_cat) + (select count(*) from ins_emp))::integer
$$;
comment on function public.pipeline_semear_tarefas(bigint) is
  'Semente do modelo padrão de tarefas nas 13 etapas padrão (spec 0018, seções 2 e 2b). on conflict do nothing: '
  'reaplicar não duplica nem desfaz edição do admin.';

-- O gatilho de tenant novo semeia etapas e, em seguida, o modelo de tarefas.
create or replace function public.pipeline_semear_etapas_trg()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  perform public.pipeline_semear_etapas(new.id);
  perform public.pipeline_semear_tarefas(new.id);
  return new;
end
$$;

select public.pipeline_semear_tarefas(t.id) from public.tenants t where t.ativo;

-- 4) Criar as tarefas de uma etapa para uma licitação ----------------------------------------------------------
create or replace function public.pipeline_etapa_tarefas_criar(
  p_tenant    bigint,
  p_licitacao bigint,
  p_etapa     bigint,
  p_user      uuid default null
)
returns table (criadas integer, existentes integer, bloqueio text)
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_etapa_nome  text;
  v_regulamento text;
  v_contexto    jsonb;
  v_bloqueio    text;
  v_total       integer := 0;
  v_cat         integer := 0;
  v_emp         integer := 0;
  v_entrada     timestamptz;
begin
  select e.nome into v_etapa_nome from public.pipeline_etapas e where e.id = p_etapa and e.tenant_id = p_tenant;
  if v_etapa_nome is null then
    return query select 0, 0, 'etapa_inexistente'::text;
    return;
  end if;

  select l.regulamento into v_regulamento from public.licitacoes_externas l where l.id = p_licitacao;
  if v_regulamento is null then
    v_bloqueio := 'regulamento_nao_informado';
  elsif v_regulamento not in ('LEI_14133', 'LEI_14981') then
    v_bloqueio := 'regulamento_sem_catalogo';
  end if;

  -- Tarefas do catálogo: as do modelo e as filhas delas (parent_codigo), com a condição avaliada no contexto oficial.
  if v_bloqueio is null then
    v_contexto := public.tarefas_contexto_certame(p_licitacao);
    with modelo as (
      select m.id as modelo_id, m.tarefa_codigo
        from public.pipeline_etapa_tarefas m
       where m.tenant_id = p_tenant and m.etapa_id = p_etapa and m.origem = 'catalogo' and m.ativo
    ),
    alvo as (
      select distinct on (c.codigo) c.codigo, c.prazo_unidade, c.condicao,
             coalesce(mo.modelo_id, mp.modelo_id) as modelo_id
        from public.tarefas_catalogo c
        left join modelo mo on mo.tarefa_codigo = c.codigo
        left join modelo mp on mp.tarefa_codigo = c.parent_codigo
       where c.ativo and (mo.tarefa_codigo is not null or mp.tarefa_codigo is not null)
       order by c.codigo
    ),
    avaliado as (
      select a.*, public.catalogo_condicao_avaliar(a.condicao, v_contexto) as aplicavel from alvo a
    ),
    gravadas as (
      insert into public.tarefas_equipe as te (
        tenant_id, licitacao_id, origem, tarefa_codigo, condicao_verificada, contexto, prazo_situacao,
        responsavel_papel, criada_por, atualizada_por, origem_etapa_id, origem_modelo_id, origem_etapa_nome
      )
      select p_tenant, p_licitacao, 'catalogo', v.codigo, v.aplicavel, v_contexto,
             public.tarefas_prazo_situacao(v.prazo_unidade), 'admin', p_user, p_user,
             p_etapa, v.modelo_id, v_etapa_nome
        from avaliado v
       where v.aplicavel is distinct from false
      on conflict (tenant_id, licitacao_id, tarefa_codigo) where origem = 'catalogo' do update
         set origem_etapa_id     = coalesce(te.origem_etapa_id, excluded.origem_etapa_id),
             origem_modelo_id    = coalesce(te.origem_modelo_id, excluded.origem_modelo_id),
             origem_etapa_nome   = coalesce(te.origem_etapa_nome, excluded.origem_etapa_nome),
             condicao_verificada = coalesce(te.condicao_verificada, excluded.condicao_verificada),
             contexto            = case when te.condicao_verificada is null and excluded.condicao_verificada
                                        then excluded.contexto else te.contexto end,
             atualizada_por      = coalesce(excluded.atualizada_por, te.atualizada_por),
             atualizada_em       = now()
       where te.origem_etapa_nome is null
          or (te.condicao_verificada is null and excluded.condicao_verificada)
      returning (xmax = 0) as nova
    )
    select count(*) filter (where nova) into v_cat from gravadas;
    select count(*) into v_total
      from public.tarefas_catalogo c
     where c.ativo
       and public.catalogo_condicao_avaliar(c.condicao, v_contexto) is distinct from false
       and exists (select 1 from public.pipeline_etapa_tarefas m
                    where m.tenant_id = p_tenant and m.etapa_id = p_etapa and m.origem = 'catalogo' and m.ativo
                      and m.tarefa_codigo in (c.codigo, c.parent_codigo));
  end if;

  -- Tarefas da empresa: sempre (qualquer regulamento), uma por chave. O prazo (prazo_horas) conta da entrada na
  -- etapa (última entrada registrada em pipeline_historico), não do momento em que a tarefa é criada (reaplicar).
  select max(h.em) into v_entrada
    from public.pipeline_historico h
   where h.tenant_id = p_tenant and h.licitacao_id = p_licitacao and h.etapa_para = p_etapa;
  with gravadas as (
    insert into public.tarefas_equipe (
      tenant_id, licitacao_id, origem, titulo, descricao, condicao_verificada, prazo_situacao, prazo_em,
      responsavel_papel, criada_por, atualizada_por, origem_etapa_id, origem_modelo_id, origem_etapa_nome,
      origem_modelo_chave
    )
    select p_tenant, p_licitacao, 'empresa', m.titulo, m.descricao, true,
           case when m.prazo_horas is null then 'sem_prazo' else 'calculado' end,
           case when m.prazo_horas is null then null
                else coalesce(v_entrada, now()) + make_interval(hours => m.prazo_horas) end,
           'admin', p_user, p_user, p_etapa, m.id, v_etapa_nome, m.chave
      from public.pipeline_etapa_tarefas m
     where m.tenant_id = p_tenant and m.etapa_id = p_etapa and m.origem = 'empresa' and m.ativo
    on conflict (tenant_id, licitacao_id, origem_modelo_chave) where origem = 'empresa' do nothing
    returning 1
  )
  select count(*) into v_emp from gravadas;
  v_total := v_total + (select count(*) from public.pipeline_etapa_tarefas m
                         where m.tenant_id = p_tenant and m.etapa_id = p_etapa and m.origem = 'empresa' and m.ativo);

  return query select v_cat + v_emp, v_total - (v_cat + v_emp), v_bloqueio;
end;
$$;
comment on function public.pipeline_etapa_tarefas_criar(bigint, bigint, bigint, uuid) is
  'Cria as tarefas do modelo da etapa para a licitação (spec 0018, seção 3). Idempotente. bloqueio: '
  'regulamento_nao_informado / regulamento_sem_catalogo (só as tarefas da empresa nascem), etapa_inexistente.';

-- 5) Reaplicar: etapa atual e as visitadas desde a última entrada no pipeline ------------------------------------
create or replace function public.pipeline_tarefas_reaplicar(
  p_tenant    bigint,
  p_licitacao bigint,
  p_user      uuid default null
)
returns table (criadas integer, existentes integer, bloqueio text)
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_entrada  timestamptz;
  v_criadas  integer := 0;
  v_exist    integer := 0;
  v_bloqueio text;
  r          record;
  x          record;
begin
  -- Só licitação que está no pipeline da empresa recebe tarefa (decisão 2 da spec 0019): fora dele, nada.
  if not exists (select 1 from public.pipeline_oportunidades po
                  where po.tenant_id = p_tenant and po.licitacao_id = p_licitacao) then
    return query select 0, 0, 'fora_do_pipeline'::text;
    return;
  end if;

  select max(h.em) into v_entrada
    from public.pipeline_historico h
   where h.tenant_id = p_tenant and h.licitacao_id = p_licitacao and h.etapa_de is null and h.etapa_para is not null;

  for r in
    select e.id
      from public.pipeline_etapas e
     where e.tenant_id = p_tenant
       and (e.id in (select po.etapa_id from public.pipeline_oportunidades po
                      where po.tenant_id = p_tenant and po.licitacao_id = p_licitacao)
            or e.id in (select h.etapa_para from public.pipeline_historico h
                         where h.tenant_id = p_tenant and h.licitacao_id = p_licitacao
                           and h.etapa_para is not null and h.em >= coalesce(v_entrada, '-infinity'::timestamptz)))
     order by e.ordem, e.id
  loop
    select * into x from public.pipeline_etapa_tarefas_criar(p_tenant, p_licitacao, r.id, p_user);
    v_criadas := v_criadas + x.criadas;
    v_exist := v_exist + x.existentes;
    v_bloqueio := coalesce(v_bloqueio, x.bloqueio);
  end loop;
  return query select v_criadas, v_exist, v_bloqueio;
end;
$$;
comment on function public.pipeline_tarefas_reaplicar(bigint, bigint, uuid) is
  'Cria (idempotente) as tarefas das etapas da licitação: a atual e as visitadas desde a última entrada no pipeline; '
  'etapa excluída é ignorada. Não relibera eventos do certame (#252). p_user nulo = sistema.';

-- 6) Gatilhos ---------------------------------------------------------------------------------------------------
-- Entrar numa etapa (insert, ou update que troca a etapa) cria as tarefas dela, na mesma transação.
create or replace function public.pipeline_oportunidades_tarefas()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'UPDATE' and new.etapa_id is not distinct from old.etapa_id then
    return null;
  end if;
  perform public.pipeline_etapa_tarefas_criar(new.tenant_id, new.licitacao_id, new.etapa_id, new.atualizada_por);
  return null;
end;
$$;
drop trigger if exists pipeline_oportunidades_tarefas_trg on public.pipeline_oportunidades;
create trigger pipeline_oportunidades_tarefas_trg
  after insert or update of etapa_id on public.pipeline_oportunidades
  for each row execute function public.pipeline_oportunidades_tarefas();

-- Regulamento que chega (coleta ou consulta sob demanda) libera as tarefas da lei que estavam pendentes. Sem
-- "update of regulamento": o regulamento é gravado pelo gatilho BEFORE de amparo_legal, fora da lista do SET.
create or replace function public.licitacoes_externas_regulamento_reaplicar()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  r record;
begin
  for r in select po.tenant_id
             from public.pipeline_oportunidades po
             join public.tenants t on t.id = po.tenant_id and t.ativo
            where po.licitacao_id = new.id loop
    -- A coleta da fonte oficial não pode falhar por causa da configuração de tarefas de uma empresa: o erro vira
    -- WARNING (log do Postgres) e as tarefas da lei ficam pendentes; a fila de Triagem (PR 4) e a ação manual
    -- tarefas_reaplicar da api-pipeline (PR 3) refazem, de forma idempotente.
    begin
      perform public.pipeline_tarefas_reaplicar(r.tenant_id, new.id, null);
    exception when others then
      raise warning 'pipeline_tarefas_reaplicar(tenant %, licitação %) falhou: % (%)', r.tenant_id, new.id, sqlerrm, sqlstate;
    end;
  end loop;
  return null;
end;
$$;
drop trigger if exists licext_regulamento_reaplicar_trg on public.licitacoes_externas;
create trigger licext_regulamento_reaplicar_trg
  after update on public.licitacoes_externas
  for each row when (old.regulamento is null and new.regulamento is not null)
  execute function public.licitacoes_externas_regulamento_reaplicar();

-- 7) ACL --------------------------------------------------------------------------------------------------------
revoke all on function public.pipeline_etapa_tarefas_validar() from PUBLIC, anon, authenticated;
revoke all on function public.pipeline_semear_tarefas(bigint) from PUBLIC, anon, authenticated;
revoke all on function public.pipeline_etapa_tarefas_criar(bigint, bigint, bigint, uuid) from PUBLIC, anon, authenticated;
revoke all on function public.pipeline_tarefas_reaplicar(bigint, bigint, uuid) from PUBLIC, anon, authenticated;
revoke all on function public.pipeline_oportunidades_tarefas() from PUBLIC, anon, authenticated;
revoke all on function public.licitacoes_externas_regulamento_reaplicar() from PUBLIC, anon, authenticated;
grant execute on function public.pipeline_semear_tarefas(bigint) to service_role;
grant execute on function public.pipeline_etapa_tarefas_criar(bigint, bigint, bigint, uuid) to service_role;
grant execute on function public.pipeline_tarefas_reaplicar(bigint, bigint, uuid) to service_role;

commit;
