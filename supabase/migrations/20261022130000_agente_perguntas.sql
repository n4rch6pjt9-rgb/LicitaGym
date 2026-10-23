-- LicitaGym: pergunta livre ao agente com resposta rastreável (spec 0038, fase 2: K-1, K-5, K-11).
--
-- Por quê: a rota /agentes/editais passa a aceitar uma pergunta em texto livre sobre o edital. A resposta é escrita
-- pelo serviço agente-perguntas (Cloud Run) só com chunks da licitação e citações [n] conferidas pela api-agentes.
-- Cada pergunta fica no histórico da empresa (com modelo, versão do prompt e citações) e pode ir para a oportunidade
-- como nota (sem aprovar/rejeitar, sem virar achado).
--
-- O que cria:
--   public.agente_perguntas
--     uma linha por pergunta: empresa, agente (edital | juridico | preco), licitação (null no jurídico avulso), pergunta
--     (1 a 500 caracteres), resposta OU motivo_sem_resposta (sem_documentos | nao_encontrado; nunca os dois, nunca
--     nenhum), citações, modelo, versão do prompt, uso (tokens), quem perguntou, estrela e envio para a oportunidade.
--   public.agente_cota_dia + agente_cota_reservar / agente_cota_devolver
--     cota de 50 perguntas por empresa por dia (horário de Brasília; o dia vem da api-agentes). A vaga é reservada de
--     forma atômica ANTES de chamar o modelo (insert … on conflict do update … where usadas < limite): duas chamadas
--     simultâneas na 50ª não passam as duas. "sem_documentos" não reserva (não chama o modelo). A vaga só volta quando
--     o serviço nem foi chamado (não configurado); falha ou timeout do serviço não devolve (o modelo pode ter cobrado).
--   public.agente_chunks_licitacao(licitacao, embedding, k)
--     busca por similaridade (cosseno) só nos chunks da licitação, com página. Mesmas exclusões da
--     match_licitacao_chunks_v2 (suspeito, bloqueado, parte interessada), só a seção 'processo' (a mesma que a análise
--     por regra lê) e só vetor do modelo do indexador (text-multilingual-embedding-002, 768). k de 1 a 20 (padrão 8).
--     A match_licitacao_chunks_v2 não muda.
-- Quem lê e escreve: só service_role (api-agentes e o serviço agente-perguntas). Sem policy: com RLS ligada, anon e
-- authenticated não leem; o filtro por empresa é o da api-agentes (_shared/tenant.ts), como em agente_execucoes.
-- Aditiva e idempotente. O merge na main aplica em produção (integração Supabase).
-- Verificação: supabase/tests/agente_perguntas_check.sql.

begin;

set local lock_timeout = '10s';

create table if not exists public.agente_perguntas (
  id                  bigint generated always as identity primary key,
  tenant_id           bigint not null references public.tenants(id),
  agente              text not null,
  licitacao_id        bigint references public.licitacoes_externas(id) on delete cascade,
  pergunta            text not null,
  resposta            text,
  motivo_sem_resposta text,
  citacoes            jsonb not null default '[]'::jsonb,
  modelo              text,
  versao_prompt       text,
  uso                 jsonb,
  perguntado_por      uuid not null,
  created_at          timestamptz not null default now(),
  favorita            boolean not null default false,
  enviada_em          timestamptz,
  enviada_por         uuid,
  constraint agente_perguntas_agente_chk check (agente in ('edital', 'juridico', 'preco')),
  constraint agente_perguntas_pergunta_chk check (char_length(btrim(pergunta)) between 1 and 500),
  constraint agente_perguntas_motivo_chk check (motivo_sem_resposta in ('sem_documentos', 'nao_encontrado')),
  -- resposta e motivo se excluem: ou há resposta, ou há o motivo de não haver
  constraint agente_perguntas_resposta_xor_motivo_chk check ((resposta is not null) <> (motivo_sem_resposta is not null)),
  constraint agente_perguntas_citacoes_chk check (jsonb_typeof(citacoes) = 'array'),
  constraint agente_perguntas_uso_chk check (uso is null or jsonb_typeof(uso) = 'object'),
  -- K-11: envio para a oportunidade grava quem e quando juntos, e só pergunta ligada a uma licitação vai
  constraint agente_perguntas_envio_chk check ((enviada_em is null) = (enviada_por is null)),
  constraint agente_perguntas_envio_licitacao_chk check (enviada_em is null or licitacao_id is not null)
);

-- histórico da empresa (perguntas_listar), mais recentes primeiro
create index if not exists agente_perguntas_tenant_criada_idx
  on public.agente_perguntas (tenant_id, created_at desc);
-- histórico e notas de uma oportunidade (perguntas_listar com licitacao_id)
create index if not exists agente_perguntas_tenant_licitacao_idx
  on public.agente_perguntas (tenant_id, licitacao_id);

alter table public.agente_perguntas enable row level security;

revoke all on table public.agente_perguntas from public, anon, authenticated;
grant select, insert, update on table public.agente_perguntas to service_role;

comment on table public.agente_perguntas is
  'Perguntas livres aos agentes (spec 0038, K-5): pergunta, resposta ou motivo, citações conferidas, modelo e versão '
  'do prompt, estrela e envio como nota. Leitura e escrita só service_role (api-agentes).';

create or replace function public.agente_chunks_licitacao(
  p_licitacao_id bigint,
  p_embedding    vector(768),
  p_k            integer default 8
)
returns table (
  id           bigint,
  documento_id bigint,
  pagina       integer,
  secao        text,
  texto        text,
  similaridade double precision
)
language sql
stable
security invoker
set search_path = public, extensions, pg_temp
as $$
  select c.id, c.documento_id, c.pagina, c.secao, c.texto, 1 - (c.embedding <=> p_embedding)
    from public.licitacao_chunks c
   where c.licitacao_id = p_licitacao_id
     and c.secao = 'processo'
     and c.embedding is not null
     and coalesce(c.embedding_model, 'text-multilingual-embedding-002') = 'text-multilingual-embedding-002'
     and c.nivel_confianca not in ('suspeito', 'bloqueado', 'parte_interessada')
   order by c.embedding <=> p_embedding, c.id
   limit least(greatest(coalesce(p_k, 8), 1), 20);
$$;

comment on function public.agente_chunks_licitacao(bigint, vector, integer) is
  'Pergunta ao edital (spec 0038, K-1): chunks da licitação mais próximos do embedding (cosseno), com página. Só seção '
  'processo, sem suspeito/bloqueado/parte interessada, só text-multilingual-embedding-002. k de 1 a 20. Só service_role.';

revoke all on function public.agente_chunks_licitacao(bigint, vector, integer) from public, anon, authenticated;
grant execute on function public.agente_chunks_licitacao(bigint, vector, integer) to service_role;

create table if not exists public.agente_cota_dia (
  tenant_id bigint  not null references public.tenants(id),
  dia       date    not null,
  usadas    integer not null default 0,
  constraint agente_cota_dia_pk primary key (tenant_id, dia),
  constraint agente_cota_dia_usadas_chk check (usadas >= 0)
);

alter table public.agente_cota_dia enable row level security;

revoke all on table public.agente_cota_dia from public, anon, authenticated;
grant select, insert, update on table public.agente_cota_dia to service_role;

comment on table public.agente_cota_dia is
  'Cota diária de perguntas aos agentes por empresa (spec 0038, K-1/CA-12). Dia no horário de Brasília. Só service_role.';

-- Reserva uma vaga; devolve as usadas depois da reserva, ou null quando a cota do dia já estava cheia.
create or replace function public.agente_cota_reservar(p_tenant bigint, p_dia date, p_limite integer)
returns integer
language sql
volatile
security definer
set search_path = public, pg_temp
as $$
  insert into public.agente_cota_dia as c (tenant_id, dia, usadas)
  select p_tenant, p_dia, 1
   where coalesce(p_limite, 0) >= 1
  on conflict (tenant_id, dia) do update
    set usadas = c.usadas + 1
  where c.usadas < p_limite
  returning c.usadas;
$$;

-- Devolve uma vaga (sem passar de 0); devolve as usadas depois, ou null se não havia linha no dia.
create or replace function public.agente_cota_devolver(p_tenant bigint, p_dia date)
returns integer
language sql
volatile
security definer
set search_path = public, pg_temp
as $$
  update public.agente_cota_dia c
     set usadas = greatest(c.usadas - 1, 0)
   where c.tenant_id = p_tenant and c.dia = p_dia
  returning c.usadas;
$$;

comment on function public.agente_cota_reservar(bigint, date, integer) is
  'Spec 0038 (CA-12): reserva atômica de uma pergunta na cota do dia; null = cota cheia. Só service_role.';
comment on function public.agente_cota_devolver(bigint, date) is
  'Spec 0038: devolve a vaga quando o serviço nem foi chamado (não configurado). Nunca abaixo de 0. Só service_role.';

revoke all on function public.agente_cota_reservar(bigint, date, integer) from public, anon, authenticated;
revoke all on function public.agente_cota_devolver(bigint, date) from public, anon, authenticated;
grant execute on function public.agente_cota_reservar(bigint, date, integer) to service_role;
grant execute on function public.agente_cota_devolver(bigint, date) to service_role;

commit;
