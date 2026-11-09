-- Checagem da migration 20261109160000_fieb_servico_fora_do_escopo.
-- Toda linha reclassificada por ela fica fora do escopo de forma coerente (categoria nula, escopo_estado
-- 'OUT_OF_SCOPE', item como serviço) e guarda os valores anteriores para a volta. Num banco vazio não há linha
-- reclassificada e a checagem passa; em produção ela confere as 22 licitações e os 11 itens.

do $$
declare
  n int;
begin
  select count(*) into n
    from public.licitacoes_externas
   where raw ? 'reclassificacao_escopo'
     and (categoria_escopo is not null
          or escopo_estado is distinct from 'OUT_OF_SCOPE'
          or not (raw->'reclassificacao_escopo' ? 'anterior')
          or not (raw->'reclassificacao_escopo' ? 'estado_anterior'));
  if n > 0 then
    raise exception 'CHECK FALHOU: % licitação(ões) reclassificada(s) ainda no escopo ou sem o valor anterior', n;
  end if;

  select count(*) into n
    from public.licitacao_itens
   where raw ? 'reclassificacao_escopo'
     and (categoria_escopo is not null
          or escopo_estado is distinct from 'OUT_OF_SCOPE'
          or material_ou_servico is distinct from 'S'
          or not (raw->'reclassificacao_escopo' ? 'material_anterior'));
  if n > 0 then
    raise exception 'CHECK FALHOU: % item(ns) reclassificado(s) incoerente(s) ou sem o valor anterior', n;
  end if;

  raise notice 'SUCESSO: reclassificação de escopo da FIEB coerente';
end $$;
