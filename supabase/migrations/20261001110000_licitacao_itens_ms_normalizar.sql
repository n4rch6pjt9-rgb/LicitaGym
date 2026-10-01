-- Normaliza licitacao_itens.material_ou_servico para o domínio da CHECK licitem_ms_chk ('M'/'S'/NULL) e valida a
-- constraint, criada NOT VALID em 20260925120000_sistema_s_coleta_externa.
--
-- Por quê: até o PR #112 o coletor PNCP gravava materialOuServicoNome ("Material"/"Serviço") em vez do código
-- materialOuServico ("M"/"S"). Linhas antigas ficaram com o nome; como a CHECK é NOT VALID, elas continuam na
-- tabela, mas qualquer UPDATE nelas falha com 23514 (ex.: reclassificar_escopo_pncp --apply ao regravar a
-- categoria de um item).
--
-- Regra (sem diferenciar maiúsculas nem acento, espaços nas pontas ignorados):
--   m / material / materiais        -> 'M'
--   s / servico / servicos / serviço -> 'S'
--   qualquer outro valor não nulo    -> NULL (desconhecido; a CHECK aceita NULL)
--
-- Idempotente: o UPDATE só toca linhas fora de ('M','S'); o VALIDATE só roda se a constraint ainda não estiver
-- validada; se a constraint não existir, é criada já validada. Rodar de novo não muda nada.
--
-- Custo/lock: o UPDATE pega ROW EXCLUSIVE (não bloqueia leitura) e trava só as linhas alteradas.
-- VALIDATE CONSTRAINT pega SHARE UPDATE EXCLUSIVE (não bloqueia SELECT/INSERT/UPDATE/DELETE) e faz uma
-- varredura da tabela. Em 01/10/2026 eram 1976 linhas (~3,7 MB). lock_timeout evita ficar na fila atrás de
-- um lock longo.

begin;

set local lock_timeout = '10s';

update public.licitacao_itens
   set material_ou_servico = case
         when lower(translate(btrim(material_ou_servico), 'áàâãéêíóôõúüçÁÀÂÃÉÊÍÓÔÕÚÜÇ', 'aaaaeeiooouucAAAAEEIOOOUUC')) in ('m', 'material', 'materiais') then 'M'
         when lower(translate(btrim(material_ou_servico), 'áàâãéêíóôõúüçÁÀÂÃÉÊÍÓÔÕÚÜÇ', 'aaaaeeiooouucAAAAEEIOOOUUC')) in ('s', 'servico', 'servicos') then 'S'
         else null
       end
 where material_ou_servico is not null
   and material_ou_servico not in ('M', 'S');

do $$
begin
  if not exists (select 1 from pg_constraint
                  where conname = 'licitem_ms_chk' and conrelid = 'public.licitacao_itens'::regclass) then
    alter table public.licitacao_itens add constraint licitem_ms_chk
      check (material_ou_servico is null or material_ou_servico in ('M', 'S'));
  elsif exists (select 1 from pg_constraint
                 where conname = 'licitem_ms_chk' and conrelid = 'public.licitacao_itens'::regclass
                   and not convalidated) then
    alter table public.licitacao_itens validate constraint licitem_ms_chk;
  end if;
end $$;

commit;
