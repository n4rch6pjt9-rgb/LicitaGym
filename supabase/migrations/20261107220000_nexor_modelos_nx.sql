-- Nexor, Fase 0 (PR 2): etapas e modelos de tarefa NX no catálogo da plataforma, e apelidos LG-T/NX.
--
-- Por quê: o prompt Nexor v0.2 dá a cada modelo de tarefa um id fixo Origem.Regime.Etapa.Bloco.Seq-DV
-- (ex.: NX.GEN.A02.IMP.005-4) e guarda LG-Txx e 14133-Fxx-Tyy como apelidos. Decisões do Marcelo (07/11/2026) em
-- specs/nexor-fase0-mapa.md: estender processo_fases e tarefas_catalogo (norma = 'NX'), apelidos em tabela própria,
-- etapas Nexor só para tenant novo. De-para aprovado em specs/nexor-de-para-tarefas.md.
--
-- O que muda:
--   public.processo_fases            + 14 etapas NX (A01–R14), norma 'NX'. R12 é macro 'contrato'; as demais, 'certame'.
--   public.tarefas_catalogo          + colunas prazo_horas_apos_etapa (SLA interno da planilha, em horas) e
--                                    responsavel_padrao (texto da planilha, ex.: "agente:juridico"); check do formato do
--                                    código NX; + 23 modelos NX (18 novos + 5 parciais aprovados como modelo novo).
--   public.tarefas_catalogo_apelidos (nova) LG-Txx e NX → modelo. LG-T18 aponta para dois modelos. LG-T34 é reservado:
--                                    sem modelo nem apelido.
--
-- Efeito para a Konnen: nenhum. O seletor do catálogo (api-pipeline, listarCatalogo) filtra norma = 'LEI_14133_2021';
-- nenhuma etapa da Konnen aponta para modelo NX. Os 84 modelos da 14.133 não são alterados (on conflict só em NX).
-- Condição em texto da planilha vai como {"condicao_nx": "<texto>"}: catalogo_condicao_avaliar devolve null ("não
-- verificada"), nunca true; "sempre" vira {}.
--
-- Quem lê e escreve: processo_fases e tarefas_catalogo mantêm a ACL e as policies atuais. tarefas_catalogo_apelidos:
-- escrita só por migration, leitura só service_role.
--
-- Verificar: supabase/tests/nexor_modelos_nx_check.sql; tests/supabase/scripts/import_spec_test.ts confere que o bloco
-- gerado abaixo é igual ao que scripts/import-spec.ts --bloco=modelos produz da planilha.
-- Aditiva e idempotente. O merge na main aplica em produção.

begin;

set local lock_timeout = '5s';

alter table public.tarefas_catalogo
  add column if not exists prazo_horas_apos_etapa integer,
  add column if not exists responsavel_padrao     text;

do $$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.tarefas_catalogo'::regclass
                    and conname = 'tarefas_catalogo_prazo_horas_apos_etapa_check') then
    alter table public.tarefas_catalogo add constraint tarefas_catalogo_prazo_horas_apos_etapa_check
      check (prazo_horas_apos_etapa is null or prazo_horas_apos_etapa > 0);
  end if;
  -- Modelo NX: código com DV no formato do Glossario. Não afeta a 14.133 (norma diferente).
  if not exists (select 1 from pg_constraint where conrelid = 'public.tarefas_catalogo'::regclass
                    and conname = 'tarefas_catalogo_codigo_nx_check') then
    alter table public.tarefas_catalogo add constraint tarefas_catalogo_codigo_nx_check
      check (norma <> 'NX' or codigo ~ '^NX\.[A-Z0-9]{3,5}\.[APSR][0-9]{2}\.[A-Z]{3}\.[0-9]{3}-[0-9]$');
  end if;
end $$;

comment on column public.tarefas_catalogo.prazo_horas_apos_etapa is
  'Prazo interno (SLA) em horas depois que a oportunidade entra na etapa. Só modelos NX; não é prazo legal.';
comment on column public.tarefas_catalogo.responsavel_padrao is
  'Texto da planilha Nexor: papel:admin | papel:operacao | agente:<nome>, combinável com " + ". O nome do agente é o '
  'da planilha (ex.: precos), não o código de agentes_catalogo (preco): mapear antes de despachar. Só sugestão; o '
  'tenant decide o responsável real.';
comment on table public.processo_fases is
  'Fases do processo: Lei 14.133 (norma LEI_14133_2021, F01–F12) e etapas Nexor (norma NX, A01–R14, geradas de '
  'specs/nexor_spec.xlsx por scripts/import-spec.ts).';
comment on table public.tarefas_catalogo is
  'Modelos de tarefa da plataforma: Lei 14.133 (norma LEI_14133_2021) e Nexor (norma NX, código '
  'Origem.Regime.Etapa.Bloco.Seq-DV, gerados de specs/nexor_spec.xlsx). Apelidos em tarefas_catalogo_apelidos.';

create table if not exists public.tarefas_catalogo_apelidos (
  sistema       text not null check (sistema in ('nx', 'lg_t')),
  apelido       text not null,
  tarefa_codigo text not null references public.tarefas_catalogo (codigo) on delete restrict,
  primary key (sistema, apelido, tarefa_codigo),
  constraint tarefas_catalogo_apelidos_formato_check check (
    (sistema = 'lg_t' and apelido ~ '^LG-T[0-9]{2}$')
    or (sistema = 'nx' and apelido ~ '^NX\.[A-Z0-9]{3,5}\.[APSR][0-9]{2}\.[A-Z]{3}\.[0-9]{3}-[0-9]$')
  )
);
create index if not exists tarefas_catalogo_apelidos_tarefa_idx on public.tarefas_catalogo_apelidos (tarefa_codigo);

comment on table public.tarefas_catalogo_apelidos is
  'Códigos alternativos de um modelo do catálogo: LG-Txx (planilha legada) e id NX dos modelos da 14.133. Fonte: '
  'specs/nexor-de-para-tarefas.md. Um apelido pode apontar para mais de um modelo (LG-T18).';

alter table public.tarefas_catalogo_apelidos enable row level security;
revoke all on table public.tarefas_catalogo_apelidos from anon, authenticated, service_role, public;
grant select on table public.tarefas_catalogo_apelidos to service_role;

-- >>> gerado por scripts/import-spec.ts (modelos NX): não editar à mão
insert into public.processo_fases (codigo, norma, ordem, nome, macro, descricao, artigos) values
  ('A01', 'NX', 1, 'Captada', 'certame', 'Grupo: Análise. Coluna atual no LicitaGym: Nova. Entrada automática: Ao importar o edital. Gatilho: Captura / upload.', '{}'::integer[]),
  ('A02', 'NX', 2, 'Triagem', 'certame', 'Grupo: Análise. Coluna atual no LicitaGym: Triagem. Entrada automática: Não. Guardrail: Alerta se o prazo de impugnação vencer em menos de 48h.', '{}'::integer[]),
  ('A03', 'NX', 3, 'Análise do edital', 'certame', 'Grupo: Análise. Coluna atual no LicitaGym: Em análise. Entrada automática: Não.', '{}'::integer[]),
  ('A04', 'NX', 4, 'Decisão de participar', 'certame', 'Grupo: Análise. Coluna atual no LicitaGym: Interessante. Entrada automática: Não. Guardrail: Alerta se não houver decisão até 72h antes do limite de propostas.', '{}'::integer[]),
  ('P05', 'NX', 5, 'Habilitação', 'certame', 'Grupo: Preparação. Coluna atual no LicitaGym: Qualificação. Entrada automática: Não. Guardrail: Alerta se houver certidão vencida na data da abertura.', '{}'::integer[]),
  ('P06', 'NX', 6, 'Proposta de preços', 'certame', 'Grupo: Preparação. Coluna atual no LicitaGym: Preparando proposta. Entrada automática: Não.', '{}'::integer[]),
  ('P07', 'NX', 7, 'Declarações e amostras', 'certame', 'Grupo: Preparação. Coluna atual no LicitaGym: Documentação. Entrada automática: Não. Guardrail: Alerta 48h e 24h antes do limite de propostas se o card ainda estiver em Análise ou Preparação.', '{}'::integer[]),
  ('S08', 'NX', 8, 'Proposta cadastrada', 'certame', 'Grupo: Sessão pública. Coluna atual no LicitaGym: Proposta enviada. Entrada automática: Quando a API confirmar a proposta registrada. Gatilho: API da plataforma. Guardrail: Se a API não confirmar até o limite de propostas: alerta crítico.', '{}'::integer[]),
  ('S09', 'NX', 9, 'Lances', 'certame', 'Grupo: Sessão pública. Coluna atual no LicitaGym: Disputa. Entrada automática: Sim: na data/hora de abertura. Gatilho: API (status da sessão) > preâmbulo (data de abertura). Guardrail: Move de qualquer coluna anterior; se vier de Análise ou Preparação, marca ''proposta não confirmada''. Nunca move Perdida ou Descartada.', '{}'::integer[]),
  ('S10', 'NX', 10, 'Aceitação e habilitação', 'certame', 'Grupo: Sessão pública. Coluna atual no LicitaGym: (nova). Entrada automática: Sim: quando o pregoeiro convocar. Gatilho: API (evento de convocação). Guardrail: Inicia o prazo do edital (ex.: 2h SESC, 1 dia útil Sorriso) e alerta na metade do prazo.', '{}'::integer[]),
  ('S11', 'NX', 11, 'Recurso e homologação', 'certame', 'Grupo: Sessão pública. Coluna atual no LicitaGym: Aguardando resultado. Entrada automática: Sim: quando abrir a fase de recurso ou sair o resultado. Gatilho: API (fase recursal / resultado). Guardrail: Inicia a contagem de 3 dias úteis para as razões.', '{}'::integer[]),
  ('R12', 'NX', 12, 'Ata e execução', 'contrato', 'Grupo: Resultado. Coluna atual no LicitaGym: Vencida. Entrada automática: Sim: homologação a favor da empresa. Gatilho: API (homologação). Guardrail: Inicia os 5 dias úteis para assinar a ata.', '{}'::integer[]),
  ('R13', 'NX', 13, 'Perdida', 'certame', 'Grupo: Resultado. Coluna atual no LicitaGym: Perdida. Entrada automática: Sim: homologação a favor de outra empresa. Gatilho: API (homologação).', '{}'::integer[]),
  ('R14', 'NX', 14, 'Descartada', 'certame', 'Grupo: Resultado. Coluna atual no LicitaGym: Descartada. Entrada automática: Não (só manual). Guardrail: Exige motivo.', '{}'::integer[])
on conflict (codigo) do update set ordem = excluded.ordem, nome = excluded.nome, macro = excluded.macro,
  descricao = excluded.descricao
  where public.processo_fases.norma = 'NX';

insert into public.tarefas_catalogo (codigo, norma, fase_codigo, ordem, titulo, descricao, natureza, ator,
  prazo_unidade, prazo_horas_apos_etapa, prazo_observacao, condicao, saida_esperada, responsavel_padrao) values
  ('NX.GEN.A01.DAT.001-2', 'NX', 'A01', 1, 'Identificar regime jurídico e normas citadas', 'Regime definido (14.133 / Sistema S / outro) e lista de normas com página', 'preparacao'::public.tarefa_natureza, 'licitante', 'sem_prazo_legal'::public.prazo_unidade, 4, null, '{}'::jsonb, 'Regime definido (14.133 / Sistema S / outro) e lista de normas com página', 'agente:juridico'),
  ('NX.GEN.A01.DAT.003-8', 'NX', 'A01', 3, 'Extrair calendário do certame', 'Abertura, limite de propostas e de impugnação, com cláusula e página', 'acompanhamento'::public.tarefa_natureza, 'licitante', 'sem_prazo_legal'::public.prazo_unidade, 4, null, '{}'::jsonb, 'Abertura, limite de propostas e de impugnação, com cláusula e página', 'agente:edital'),
  ('NX.GEN.A02.PAR.004-2', 'NX', 'A02', 4, 'Conferir plataforma e credenciamento', 'Credenciamento ativo comprovado; taxas registradas', 'preparacao'::public.tarefa_natureza, 'licitante', 'sem_prazo_legal'::public.prazo_unidade, 24, null, '{}'::jsonb, 'Credenciamento ativo comprovado; taxas registradas', 'papel:operacao'),
  ('NX.GEN.A03.PAR.006-8', 'NX', 'A03', 6, 'Checar condições de participação e impedimentos', 'Checklist de cada impedimento com resultado', 'preparacao'::public.tarefa_natureza, 'licitante', 'sem_prazo_legal'::public.prazo_unidade, 24, null, '{}'::jsonb, 'Checklist de cada impedimento com resultado', 'agente:juridico'),
  ('NX.GEN.A03.OBJ.007-5', 'NX', 'A03', 7, 'Extrair itens, lotes e especificações do TR', 'Tabela de itens com página, marca/modelo e quantidade', 'preparacao'::public.tarefa_natureza, 'licitante', 'sem_prazo_legal'::public.prazo_unidade, 24, null, '{}'::jsonb, 'Tabela de itens com página, marca/modelo e quantidade', 'agente:edital'),
  ('NX.GEN.A03.PAR.008-4', 'NX', 'A03', 8, 'Consultar cadastros de sanções', 'Consulta datada por cadastro (TCU, CEIS, CNEP, estaduais)', 'preparacao'::public.tarefa_natureza, 'licitante', 'sem_prazo_legal'::public.prazo_unidade, 24, null, '{}'::jsonb, 'Consulta datada por cadastro (TCU, CEIS, CNEP, estaduais)', 'papel:operacao'),
  ('NX.GEN.P05.HJU.009-5', 'NX', 'P05', 9, 'Montar checklist de habilitação com validade', 'Cada documento exigido (jurídica, fiscal, trabalhista, econômica, técnica) com número, emissor, validade e situação; alerta se vencer antes do pagamento previsto', 'preparacao'::public.tarefa_natureza, 'licitante', 'sem_prazo_legal'::public.prazo_unidade, 48, null, '{}'::jsonb, 'Cada documento exigido (jurídica, fiscal, trabalhista, econômica, técnica) com número, emissor, validade e situação; alerta se vencer antes do pagamento previsto', 'papel:operacao'),
  ('NX.GEN.A04.GER.010-1', 'NX', 'A04', 10, 'Decidir participação (go/no-go)', 'Decisão com motivo registrada', 'preparacao'::public.tarefa_natureza, 'licitante', 'sem_prazo_legal'::public.prazo_unidade, 24, null, '{}'::jsonb, 'Decisão com motivo registrada', 'papel:admin'),
  ('NX.GEN.P06.JUL.011-9', 'NX', 'P06', 11, 'Formar preço por item ou lote', 'Planilha por item com custo, margem e referência', 'preparacao'::public.tarefa_natureza, 'licitante', 'sem_prazo_legal'::public.prazo_unidade, 48, null, '{}'::jsonb, 'Planilha por item com custo, margem e referência', 'agente:precos'),
  ('NX.GEN.P06.EXE.012-8', 'NX', 'P06', 12, 'Levantar custos de execução', 'Frete, entrega, instalação, garantia, assistência e prazo de pagamento custeados', 'preparacao'::public.tarefa_natureza, 'licitante', 'sem_prazo_legal'::public.prazo_unidade, 48, null, '{}'::jsonb, 'Frete, entrega, instalação, garantia, assistência e prazo de pagamento custeados', 'papel:operacao'),
  ('NX.GEN.P07.AMO.015-1', 'NX', 'P07', 15, 'Preparar amostras e catálogos', 'Material pronto antes da sessão', 'preparacao'::public.tarefa_natureza, 'licitante', 'definido_no_edital'::public.prazo_unidade, null, 'conforme convocação', '{"condicao_nx":"se o edital prever amostra"}'::jsonb, 'Material pronto antes da sessão', 'papel:operacao'),
  ('NX.GEN.R12.CTR.020-0', 'NX', 'R12', 20, 'Assinar Ata de Registro de Preços', 'ARP assinada e devolvida', 'obrigacao'::public.tarefa_natureza, 'contratado', 'definido_no_edital'::public.prazo_unidade, null, '5 dias úteis após convocação', '{}'::jsonb, 'ARP assinada e devolvida', 'papel:admin'),
  ('NX.GEN.R12.SAN.021-7', 'NX', 'R12', 21, 'Montar matriz de sanções e multas', 'Hipóteses, percentuais e prazos tabelados', 'preparacao'::public.tarefa_natureza, 'licitante_ou_contratado', 'sem_prazo_legal'::public.prazo_unidade, 48, null, '{}'::jsonb, 'Hipóteses, percentuais e prazos tabelados', 'agente:juridico'),
  ('NX.GEN.R12.EXE.023-8', 'NX', 'R12', 23, 'Monitorar habilitação durante a ARP', 'Certidões vigentes sem lacuna', 'obrigacao'::public.tarefa_natureza, 'contratado', 'definido_no_edital'::public.prazo_unidade, null, 'recorrente até fim da ARP', '{}'::jsonb, 'Certidões vigentes sem lacuna', 'papel:operacao'),
  ('NX.GEN.R12.GER.025-3', 'NX', 'R12', 25, 'Conferir obrigações de LGPD', 'Responsabilidades de dados mapeadas', 'obrigacao'::public.tarefa_natureza, 'contratado', 'sem_prazo_legal'::public.prazo_unidade, 72, null, '{}'::jsonb, 'Responsabilidades de dados mapeadas', 'agente:juridico'),
  ('NX.GEN.R14.GER.026-1', 'NX', 'R14', 26, 'Registrar motivo do descarte', 'Motivo preenchido', 'acompanhamento'::public.tarefa_natureza, 'licitante', 'sem_prazo_legal'::public.prazo_unidade, 24, null, '{}'::jsonb, 'Motivo preenchido', 'papel:admin'),
  ('NX.GEN.A01.DAT.027-4', 'NX', 'A01', 27, 'Mapear contatos e canais oficiais', 'Registros de Pessoa criados (papel, órgão, canais institucionais, restrição de uso) com chunk_id e página de cada um; status citado_no_edital', 'preparacao'::public.tarefa_natureza, 'licitante', 'sem_prazo_legal'::public.prazo_unidade, 4, null, '{}'::jsonb, 'Registros de Pessoa criados (papel, órgão, canais institucionais, restrição de uso) com chunk_id e página de cada um; status citado_no_edital', 'agente:edital'),
  ('NX.GEN.R12.EXE.028-8', 'NX', 'R12', 28, 'Identificar fiscal/gestor da ata', 'Pessoa com papel fiscal ou gestor registrada, com fonte (portaria ou ARP) e canal institucional', 'acompanhamento'::public.tarefa_natureza, 'contratado', 'definido_no_edital'::public.prazo_unidade, null, '5 dias úteis após a homologação', '{"condicao_nx":"se o edital prevê nomeação posterior de fiscal/gestor"}'::jsonb, 'Pessoa com papel fiscal ou gestor registrada, com fonte (portaria ou ARP) e canal institucional', 'papel:operacao'),
  ('NX.GEN.A03.VAL.029-4', 'NX', 'A03', 29, 'Conferir enquadramento CATMAT × TR × valor estimado', 'Para cada item: código CATMAT, atributos do TR e valor estimado comparados com a faixa histórica de itens equivalentes; status OK ou divergente com trecho do TR; divergência gera pedido de esclarecimento ou ajuste de preço', 'preparacao'::public.tarefa_natureza, 'licitante', 'definido_no_edital'::public.prazo_unidade, null, 'antes do limite de impugnação (3 dias úteis antes da abertura)', '{}'::jsonb, 'Para cada item: código CATMAT, atributos do TR e valor estimado comparados com a faixa histórica de itens equivalentes; status OK ou divergente com trecho do TR; divergência gera pedido de esclarecimento ou ajuste de preço', 'agente:edital + agente:precos'),
  ('NX.GEN.A04.EXE.030-6', 'NX', 'A04', 30, 'Conferir viabilidade do prazo de entrega e instalação', 'Prazo de entrega, remessa, local, instalação e prazo de substituição registrados e comparados com lead time de fábrica + frete; parecer Go/No-go logístico', 'preparacao'::public.tarefa_natureza, 'licitante', 'sem_prazo_legal'::public.prazo_unidade, 24, null, '{}'::jsonb, 'Prazo de entrega, remessa, local, instalação e prazo de substituição registrados e comparados com lead time de fábrica + frete; parecer Go/No-go logístico', 'papel:operacao'),
  ('NX.GEN.A04.EXE.031-4', 'NX', 'A04', 31, 'Verificar garantia e assistência técnica exigidas', 'Prazo de garantia (CDC ou contratual) e exigência de assistência técnica regional identificados com cláusula; se exigir AT comprovada e a empresa não tiver: No-go ou parceria registrada', 'preparacao'::public.tarefa_natureza, 'licitante', 'sem_prazo_legal'::public.prazo_unidade, 24, null, '{}'::jsonb, 'Prazo de garantia (CDC ou contratual) e exigência de assistência técnica regional identificados com cláusula; se exigir AT comprovada e a empresa não tiver: No-go ou parceria registrada', 'agente:juridico'),
  ('NX.GEN.P06.EXE.032-2', 'NX', 'P06', 32, 'Projetar fluxo de recebimento e pagamento', 'Prazos de recebimento provisório e definitivo, liquidação e pagamento em dias úteis; reajuste, retenções e índice de atraso; custo financeiro incluído no preço', 'preparacao'::public.tarefa_natureza, 'licitante', 'sem_prazo_legal'::public.prazo_unidade, 24, null, '{}'::jsonb, 'Prazos de recebimento provisório e definitivo, liquidação e pagamento em dias úteis; reajuste, retenções e índice de atraso; custo financeiro incluído no preço', 'agente:precos'),
  ('NX.GEN.R12.CTR.033-1', 'NX', 'R12', 33, 'Preparar minuta de contrato/ARP', 'Minuta (Word) preenchida com a proposta aceita: itens, marca, modelo, quantidades, preços, prazos, gestão e fiscalização; revisada pelo jurídico', 'preparacao'::public.tarefa_natureza, 'licitante', 'definido_no_edital'::public.prazo_unidade, null, '5 dias úteis após a convocação para assinatura', '{"condicao_nx":"se vencedor"}'::jsonb, 'Minuta (Word) preenchida com a proposta aceita: itens, marca, modelo, quantidades, preços, prazos, gestão e fiscalização; revisada pelo jurídico', 'agente:juridico + agente:edital')
on conflict (codigo) do update set fase_codigo = excluded.fase_codigo, ordem = excluded.ordem,
  titulo = excluded.titulo, descricao = excluded.descricao, natureza = excluded.natureza, ator = excluded.ator,
  prazo_unidade = excluded.prazo_unidade, prazo_horas_apos_etapa = excluded.prazo_horas_apos_etapa,
  prazo_observacao = excluded.prazo_observacao, condicao = excluded.condicao,
  saida_esperada = excluded.saida_esperada, responsavel_padrao = excluded.responsavel_padrao, atualizado_em = now()
  where public.tarefas_catalogo.norma = 'NX';

insert into public.tarefas_catalogo_apelidos (sistema, apelido, tarefa_codigo) values
  ('lg_t', 'LG-T01', 'NX.GEN.A01.DAT.001-2'),
  ('lg_t', 'LG-T02', '14133-F01-T01'),
  ('nx', 'NX.GEN.A01.ANX.002-9', '14133-F01-T01'),
  ('lg_t', 'LG-T03', 'NX.GEN.A01.DAT.003-8'),
  ('lg_t', 'LG-T04', 'NX.GEN.A02.PAR.004-2'),
  ('lg_t', 'LG-T05', '14133-F01-T04'),
  ('nx', 'NX.GEN.A02.IMP.005-4', '14133-F01-T04'),
  ('lg_t', 'LG-T06', 'NX.GEN.A03.PAR.006-8'),
  ('lg_t', 'LG-T07', 'NX.GEN.A03.OBJ.007-5'),
  ('lg_t', 'LG-T08', 'NX.GEN.A03.PAR.008-4'),
  ('lg_t', 'LG-T09', 'NX.GEN.P05.HJU.009-5'),
  ('lg_t', 'LG-T10', 'NX.GEN.A04.GER.010-1'),
  ('lg_t', 'LG-T11', 'NX.GEN.P06.JUL.011-9'),
  ('lg_t', 'LG-T12', 'NX.GEN.P06.EXE.012-8'),
  ('lg_t', 'LG-T13', '14133-F01-T10'),
  ('nx', 'NX.GEN.P06.PRO.013-0', '14133-F01-T10'),
  ('lg_t', 'LG-T14', '14133-F01-T09'),
  ('nx', 'NX.GEN.P07.HFT.014-6', '14133-F01-T09'),
  ('lg_t', 'LG-T15', 'NX.GEN.P07.AMO.015-1'),
  ('lg_t', 'LG-T16', '14133-F04-T01'),
  ('nx', 'NX.GEN.S10.ACE.016-2', '14133-F04-T01'),
  ('lg_t', 'LG-T17', '14133-F02-T04'),
  ('nx', 'NX.GEN.S09.MEP.017-5', '14133-F02-T04'),
  ('lg_t', 'LG-T18', '14133-F05-T01'),
  ('nx', 'NX.GEN.S11.REC.018-0', '14133-F05-T01'),
  ('lg_t', 'LG-T18', '14133-F05-T02'),
  ('nx', 'NX.GEN.S11.REC.018-0', '14133-F05-T02'),
  ('lg_t', 'LG-T19', '14133-F06-T04'),
  ('nx', 'NX.GEN.R13.HOM.019-0', '14133-F06-T04'),
  ('lg_t', 'LG-T20', 'NX.GEN.R12.CTR.020-0'),
  ('lg_t', 'LG-T21', 'NX.GEN.R12.SAN.021-7'),
  ('lg_t', 'LG-T22', '14133-F08-T01'),
  ('nx', 'NX.GEN.R12.EXE.022-0', '14133-F08-T01'),
  ('lg_t', 'LG-T23', 'NX.GEN.R12.EXE.023-8'),
  ('lg_t', 'LG-T24', '14133-F12-T02'),
  ('nx', 'NX.GEN.R12.SRP.024-0', '14133-F12-T02'),
  ('lg_t', 'LG-T25', 'NX.GEN.R12.GER.025-3'),
  ('lg_t', 'LG-T26', 'NX.GEN.R14.GER.026-1'),
  ('lg_t', 'LG-T27', 'NX.GEN.A01.DAT.027-4'),
  ('lg_t', 'LG-T28', 'NX.GEN.R12.EXE.028-8'),
  ('lg_t', 'LG-T29', 'NX.GEN.A03.VAL.029-4'),
  ('lg_t', 'LG-T30', 'NX.GEN.A04.EXE.030-6'),
  ('lg_t', 'LG-T31', 'NX.GEN.A04.EXE.031-4'),
  ('lg_t', 'LG-T32', 'NX.GEN.P06.EXE.032-2'),
  ('lg_t', 'LG-T33', 'NX.GEN.R12.CTR.033-1')
on conflict (sistema, apelido, tarefa_codigo) do nothing;
-- <<< fim do bloco gerado (modelos NX)

commit;
