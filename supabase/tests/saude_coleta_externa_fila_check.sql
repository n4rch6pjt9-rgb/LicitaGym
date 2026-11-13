-- Spec 0064, CA-9 (K-9): coleta_externa_fila_pendente_horas = horas do 'pendente' mais antigo entre fontes ativas do
-- coletor Paradigma (0 com a fila vazia), limiares atenção 26 h e crítico 48 h, fonte no detalhe.
-- Fixtures revertidas ao final.
begin;

do $$
declare
  r record;
begin
  delete from private.coleta_externa_fila;
  update public.fontes_externas set ativo = false;
  update public.fontes_externas set ativo = true where slug = 'fiesc';

  -- 20261113200000 (decisão de 13/11/2026): limiar desligado até a fila escoar; desligada, a verificação não sai
  if (select l.ativo from private.saude_limiares l where l.verificacao = 'coleta_externa_fila_pendente_horas') then
    raise exception 'SAUDE FILA CHECK FALHOU: limiar coleta_externa_fila_pendente_horas devia estar desligado';
  end if;
  if exists (select 1 from private.saude_operacional_resumo() s where s.verificacao = 'coleta_externa_fila_pendente_horas') then
    raise exception 'SAUDE FILA CHECK FALHOU: verificação desligada saiu no resumo';
  end if;
  -- religada (como ficará depois do escoamento), mede pelos limiares
  update private.saude_limiares set ativo = true where verificacao = 'coleta_externa_fila_pendente_horas';

  -- fila vazia -> 0 e ok
  select * into r from private.saude_operacional_resumo() s where s.verificacao = 'coleta_externa_fila_pendente_horas';
  if r.verificacao is null then
    raise exception 'SAUDE FILA CHECK FALHOU: CA-9: verificação coleta_externa_fila_pendente_horas ausente';
  end if;
  if r.valor is distinct from 0 or r.status <> 'ok' then
    raise exception 'SAUDE FILA CHECK FALHOU: CA-9: fila vazia devia ser 0/ok, veio %/%', r.valor, r.status;
  end if;
  if r.atencao <> 26 or r.critico <> 48 then
    raise exception 'SAUDE FILA CHECK FALHOU: CA-9: limiares esperados 26/48, vieram %/%', r.atencao, r.critico;
  end if;

  -- pendente de fonte ativa com 30 h -> >= 30 e atenção, com a fonte no detalhe
  perform public.coleta_externa_fila_enfileirar('fiesc', '[{"nCdOrigem": 1, "modulo": 59, "listagem": {}}]'::jsonb);
  update private.coleta_externa_fila set pendente_desde = now() - interval '30 hours' where fonte = 'fiesc';
  select * into r from private.saude_operacional_resumo() s where s.verificacao = 'coleta_externa_fila_pendente_horas';
  if r.valor < 30 or r.status <> 'atencao' or r.detalhe::text not like '%fiesc%' then
    raise exception 'SAUDE FILA CHECK FALHOU: CA-9: 30 h devia ser atenção com fiesc: % % %', r.valor, r.status, r.detalhe;
  end if;

  -- 50 h -> crítico
  update private.coleta_externa_fila set pendente_desde = now() - interval '50 hours' where fonte = 'fiesc';
  select * into r from private.saude_operacional_resumo() s where s.verificacao = 'coleta_externa_fila_pendente_horas';
  if r.status <> 'critico' then
    raise exception 'SAUDE FILA CHECK FALHOU: CA-9: 50 h devia ser crítico, veio % (%)', r.status, r.valor;
  end if;

  -- fonte inativa não conta -> 0/ok; item 'feito' antigo também não
  update public.fontes_externas set ativo = false where slug = 'fiesc';
  select * into r from private.saude_operacional_resumo() s where s.verificacao = 'coleta_externa_fila_pendente_horas';
  if r.valor is distinct from 0 or r.status <> 'ok' then
    raise exception 'SAUDE FILA CHECK FALHOU: CA-9: fonte inativa devia ser 0/ok, veio %/%', r.valor, r.status;
  end if;
  update public.fontes_externas set ativo = true where slug = 'fiesc';
  update private.coleta_externa_fila set status = 'feito' where fonte = 'fiesc';
  select * into r from private.saude_operacional_resumo() s where s.verificacao = 'coleta_externa_fila_pendente_horas';
  if r.valor is distinct from 0 then
    raise exception 'SAUDE FILA CHECK FALHOU: CA-9: item feito contou como pendente (%)', r.valor;
  end if;

  raise notice 'SUCESSO: saude_coleta_externa_fila_check (CA-9)';
end $$;

rollback;
