-- LicitaGym: regulamento das compras PNCP a partir do amparo legal oficial (spec 0020).
--
-- Por quê: licitacoes_externas.regulamento está nulo em todas as linhas (11/10/2026), e a #252 (tarefas do catálogo,
-- spec 0019) só libera tarefa com regulamento LEI_14133/LEI_14981. O PNCP informa a lei no detalhe da compra
-- (amparoLegal: codigo, nome, descricao; ex.: "Lei 14.133/2021, Art. 28, I"), que o coletor não guardava.
--
-- O que muda:
--   licitacoes_externas.amparo_legal   jsonb nova: o amparoLegal original do PNCP (valor ao lado do normalizado)
--   public.regulamento_do_amparo(text) regra única: número da lei no nome oficial -> regulamento
--   licext_regulamento_amparo_trg      grava regulamento quando amparo_legal chega; sem amparo_legal, não mexe
--   licext_regulamento_chk             passa a aceitar LEI_14981 e LEI_13303 (drop/add que só amplia a lista)
--
-- Quem escreve amparo_legal: o coletor PNCP (identificacao_do_detalhe) e coletor/backfill_regulamento_pncp.py.
-- Verificar: supabase/tests/regulamento_amparo_check.sql. Idempotente.

begin;

alter table public.licitacoes_externas add column if not exists amparo_legal jsonb;
comment on column public.licitacoes_externas.amparo_legal is
  'amparoLegal do detalhe da compra no PNCP, objeto inteiro como veio (sem aparar). regulamento é derivado dele '
  '(regulamento_do_amparo). Nulo = não consultado ou o PNCP não informou.';

-- Constraint ampliada: refeita só quando ainda não aceita os valores novos.
do $$ begin
  if not exists (select 1 from pg_constraint
                  where conname = 'licext_regulamento_chk'
                    and pg_get_constraintdef(oid) like '%LEI_14981%'
                    and pg_get_constraintdef(oid) like '%LEI_13303%') then
    alter table public.licitacoes_externas drop constraint if exists licext_regulamento_chk;
    alter table public.licitacoes_externas add constraint licext_regulamento_chk
      check (regulamento is null
             or regulamento in ('RLC', 'RCA', 'LEI_14133', 'LEI_14981', 'LEI_13303', 'OUTRO'));
  end if;
end $$;

-- Número da lei no nome oficial do amparo. 14.981 e 13.303 antes de 14.133: o nome pode citar mais de uma lei.
create or replace function public.regulamento_do_amparo(p_nome text)
returns text
language sql
immutable
security invoker
set search_path = public, pg_temp
as $$
  select case
           when nullif(btrim(p_nome, E' \t\r\n'), '') is null then null
           when p_nome ~* '(^|[^0-9])14\.?981([^0-9]|$)'           then 'LEI_14981'
           when p_nome ~* '(^|[^0-9])13\.?303([^0-9]|$)'           then 'LEI_13303'
           when p_nome ~* '(^|[^0-9])14\.?133([^0-9]|$)'           then 'LEI_14133'
           else 'OUTRO'
         end;
$$;
comment on function public.regulamento_do_amparo(text) is
  'Regulamento a partir do nome oficial do amparo legal do PNCP: 14.981 -> LEI_14981, 13.303 -> LEI_13303, '
  '14.133 -> LEI_14133, outro -> OUTRO, vazio -> null. Espelho Python só para o resumo do dry-run (coletor/pncp.py).';

create or replace function public.licext_regulamento_do_amparo()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  if new.amparo_legal is not null and nullif(btrim(new.amparo_legal ->> 'nome', E' \t\r\n'), '') is not null then
    new.regulamento := public.regulamento_do_amparo(new.amparo_legal ->> 'nome');
  end if;
  return new;
end;
$$;

drop trigger if exists licext_regulamento_amparo_trg on public.licitacoes_externas;
create trigger licext_regulamento_amparo_trg
  before insert or update of amparo_legal on public.licitacoes_externas
  for each row execute function public.licext_regulamento_do_amparo();

revoke all on function public.regulamento_do_amparo(text) from PUBLIC, anon, authenticated;
revoke all on function public.licext_regulamento_do_amparo() from PUBLIC, anon, authenticated;
grant execute on function public.regulamento_do_amparo(text) to service_role;

commit;
