-- Fix #228: idempotência de normalização + precedência manual em regex
-- Achado #1: colapso de frase repetida não é idempotente (FUNDIBAN FUNDIBAN FUNDIBAN não vira FUNDIBAN)
-- Achado #3: regex manual perde para regex semente mais longa (order by tamanho desc, manual desc errado)
-- Solução:
--   #1: loop em private.marca_normalizar até convergência (enquanto houver mudança, repete)
--   #3: mudar order para manual desc, tamanho desc (manual vence semente em empate)
-- Impacto: normalização mais correta + regex manual tem precedência real
-- Escrita: migration (sistema); Leitura: views (service_role)
-- Verificar: supabase/tests/marcas_resolvedor_views_check.sql cases R-S (idempotência, regex manual)

begin;

-- 1) Recriar private.marca_normalizar com loop para idempotência
-- O collapso de frases repetidas agora roda em loop até convergência (PL/pgSQL)
create or replace function private.marca_normalizar(entrada text)
returns text
language plpgsql
immutable
parallel safe
as $$
declare
  v_resultado text;
  v_anterior text;
  v_max_iter int := 20;  -- proteção contra loop infinito
begin
  -- Passo 1: maiúsculas, sem acentos
  v_resultado := upper(unaccent(coalesce(entrada, '')));

  -- Passo 2: normaliza espaços (múltiplos → simples)
  v_resultado := regexp_replace(v_resultado, '\s+', ' ', 'g');

  -- Passo 3: remove sufixos LTDA/ME/EPP/EIRELI/S.A./SA à direita
  v_resultado := trim(regexp_replace(v_resultado, '\s+(LTDA|ME|EPP|EIRELI|S\.A\.|SA|LTDA\.)?$', '', 'i'));

  -- Passo 4: collapso de frases repetidas EM LOOP até convergência (FIX #1)
  -- Exemplo: "FUNDIBAN FUNDIBAN FUNDIBAN" → "FUNDIBAN FUNDIBAN" (primeira iteração)
  --                                        → "FUNDIBAN" (segunda iteração)
  v_anterior := '';
  while v_resultado <> v_anterior and v_max_iter > 0 loop
    v_anterior := v_resultado;
    v_resultado := regexp_replace(v_resultado, '^(.+)\s+\1($|\s)', '\1 ', 'g');
    v_max_iter := v_max_iter - 1;
  end loop;

  -- Passo 5: trim final (remove espaço da última iteração se houver)
  v_resultado := trim(v_resultado);

  return v_resultado;
end $$;

comment on function private.marca_normalizar(text) is
  'Normaliza marca bruta: maiúsculas, sem acentos, remove sufixos LTDA/ME, espaços simples, collapso de frases repetidas EM LOOP até convergência (idempotente). Imutável, segura para índices.';

-- 2) Recriar private.marca_resolver com order by corrigido (manual desc, tamanho desc)
-- O único ponto que muda: order by em line 16 antes de LIMIT 1
create or replace function private.marca_resolver(marca_bruta text, ni text)
returns table (marca_norm text, marca text, metodo text, curada boolean, alias_id bigint)
language sql
stable
parallel safe
set search_path = public, pg_temp
as $$
with norm as (
  select private.marca_normalizar(marca_bruta) as marca_norm
),
-- Filtra aliases que casam (a ordem aqui importa)
casamentos as (
  select a.id, a.marca, a.tipo, a.tamanho, a.revisao_manual as manual, a.escopo_ni
    from public.marca_aliases a, norm n
   where a.tipo <> 'nao_marca'
     and (a.escopo_ni is null or a.escopo_ni = ni)
     and case when a.tipo = 'exato' then a.alias = n.marca_norm
              when a.tipo = 'prefixo' then n.marca_norm like a.alias || '%'
              when a.tipo = 'regex' then n.marca_norm ~ a.alias
              else false
         end
),
-- Ordena: escopo (CNPJ > global), tipo (exato > prefixo > regex), MANUAL FIRST (manual > semente), tamanho desc
rankeado as (
  select
    c.id, c.marca, c.tipo, c.manual,
    row_number() over (order by
      (c.escopo_ni is not null) desc,  -- CNPJ-específico vence global
      case c.tipo when 'exato' then 1 when 'prefixo' then 2 when 'regex' then 3 else 4 end,
      c.manual desc,  -- manual (true) vence semente (false) — FIX #3
      c.tamanho desc  -- mais longo vence (só em empate de manual)
    ) as pos
  from casamentos c
)
select
  n.marca_norm,
  coalesce(r.marca, '') as marca,  -- vazio se sem alias (marca bruta = nao_marca ou sem match)
  case when r.id is null then 'bruta' else 'alias_' || r.tipo end as metodo,
  (r.id is not null and r.tipo <> 'nao_marca') as curada,
  r.id as alias_id
from norm n
left join rankeado r on r.pos = 1;
$$;

comment on function private.marca_resolver(text, text) is
  'Resolve marca bruta + NI (CNPJ/CPF) para marca canônica. Escopo CNPJ > global, tipo exato > prefixo > regex, MANUAL > semente (FIX #3), tamanho desc. Sem alias: marca bruta (curada=false). STABLE, segura para views.';

-- 3) ACL: funções já têm security_invoker por padrão (nada novo para revogar/grant)
-- private.marca_normalizar e private.marca_resolver já têm grants feitos na migration 20261004002000

commit;
