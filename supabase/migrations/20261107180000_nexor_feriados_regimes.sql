-- Nexor, Fase 0 (PR 1): calendário de feriados nacionais e regimes jurídicos.
--
-- Por quê: prazo em dias úteis hoje pula só sábado e domingo (spec 0041, K-1). O limite de impugnação de uma abertura
-- em 15/10/2026 cai em 12/10/2026, feriado nacional. Regimes vêm da planilha da spec (Padrao_Lei, seção 3) e serão a
-- chave do regime do certame nas fases seguintes.
--
-- O que muda:
--   public.feriados_nacionais  datas de lei federal (data, nome, fundamento). Só nacionais; estadual e municipal fora.
--   public.regimes             regimes jurídicos citados pela planilha (id, norma, situação da pesquisa).
--
-- Quem lê e escreve: escrita só por migration (bloco gerado por scripts/import-spec.ts a partir de
-- specs/nexor_spec.xlsx). Leitura só service_role (Edge Functions). Cliente não lê direto.
--
-- Verificar: supabase/tests/nexor_feriados_regimes_check.sql; tests/supabase/scripts/import_spec_test.ts confere que o
-- bloco gerado abaixo é igual ao que o script produz hoje.
-- Idempotente.

begin;

create table if not exists public.feriados_nacionais (
  data        date primary key,
  nome        text not null check (btrim(nome) <> ''),
  fundamento  text not null check (btrim(fundamento) <> ''),
  abrangencia text not null default 'nacional' check (abrangencia = 'nacional'),
  fonte       text not null default 'specs/nexor_spec.xlsx#Documentacao_Edital!M34:O52'
);
comment on table public.feriados_nacionais is
  'Feriados nacionais de lei federal (fundamento = lei). Base da contagem de dias úteis; ano ausente = erro, nunca contagem sem feriado.';

create table if not exists public.regimes (
  id                text primary key check (id ~ '^[a-z0-9_]+$'),
  norma             text not null check (btrim(norma) <> ''),
  situacao_pesquisa text not null
);
comment on table public.regimes is
  'Regimes jurídicos do certame (Padrao_Lei, seção 3). situacao_pesquisa registra o que não foi confirmado na fonte.';

alter table public.feriados_nacionais enable row level security;
alter table public.regimes            enable row level security;

revoke all on table public.feriados_nacionais from anon, authenticated, public;
revoke all on table public.regimes            from anon, authenticated, public;
grant select, insert, update, delete on table public.feriados_nacionais to service_role;
grant select, insert, update, delete on table public.regimes            to service_role;

-- >>> gerado por scripts/import-spec.ts: não editar à mão
insert into public.feriados_nacionais (data, nome, fundamento) values
  (date '2026-01-01', 'Confraternização Universal', 'Lei 662/1949'),
  (date '2026-04-21', 'Tiradentes', 'Lei 662/1949'),
  (date '2026-05-01', 'Dia do Trabalho', 'Lei 662/1949'),
  (date '2026-09-07', 'Independência', 'Lei 662/1949'),
  (date '2026-10-12', 'Nossa Senhora Aparecida', 'Lei 6.802/1980'),
  (date '2026-11-02', 'Finados', 'Lei 662/1949'),
  (date '2026-11-15', 'Proclamação da República', 'Lei 662/1949'),
  (date '2026-11-20', 'Consciência Negra', 'Lei 14.759/2023'),
  (date '2026-12-25', 'Natal', 'Lei 662/1949'),
  (date '2027-01-01', 'Confraternização Universal', 'Lei 662/1949'),
  (date '2027-04-21', 'Tiradentes', 'Lei 662/1949'),
  (date '2027-05-01', 'Dia do Trabalho', 'Lei 662/1949'),
  (date '2027-09-07', 'Independência', 'Lei 662/1949'),
  (date '2027-10-12', 'Nossa Senhora Aparecida', 'Lei 6.802/1980'),
  (date '2027-11-02', 'Finados', 'Lei 662/1949'),
  (date '2027-11-15', 'Proclamação da República', 'Lei 662/1949'),
  (date '2027-11-20', 'Consciência Negra', 'Lei 14.759/2023'),
  (date '2027-12-25', 'Natal', 'Lei 662/1949')
on conflict (data) do update set nome = excluded.nome, fundamento = excluded.fundamento;

insert into public.regimes (id, norma, situacao_pesquisa) values
  ('lei_14133', 'Lei 14.133/2021 – administração direta, autárquica e fundacional', 'texto lido em Câmara/Senado (Planalto bloqueado); confiança média na consolidação'),
  ('lei_13303', 'Lei 13.303/2016 – empresas públicas e sociedades de economia mista', 'regulamentos de estatais além da Petrobras não lidos'),
  ('sistema_s_sesc_senac', 'Res. Sesc 1.593/2024 e Res. Senac 1.270/2024 (vigência desde 02/05/2024)', 'vigência em nov/2026 NÃO CONFIRMADA (portais nacionais 403)'),
  ('sistema_s_sesi_senai', 'SESI: RCA – Res. CN-SESI 0053/2023; SENAI: RCA de mesmo conteúdo', 'resolução do CN-SENAI não localizada; alterações 2024–2026 não confirmadas'),
  ('lei_14981', 'Lei 14.981/2024 – contratações em calamidade pública', 'exige ato que autorize o regime')
on conflict (id) do update set norma = excluded.norma, situacao_pesquisa = excluded.situacao_pesquisa;
-- <<< fim do bloco gerado

commit;
