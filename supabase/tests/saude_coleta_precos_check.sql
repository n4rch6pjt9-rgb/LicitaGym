-- =============================================================================
-- Checagem da migration 20261009161000_saude_coleta_precos (spec 0009, CA-6).
--
-- A verificação precos_dias_sem_coleta de private.saude_operacional_resumo():
--   1. tem limiar em private.saude_limiares (crítico a partir de 8 dias; sem dado = crítico);
--   2. sem nenhum preço gravado: crítico (sem dado);
--   3. última coleta (max(last_synced_at) de precos_praticados_itens) há 9 dias: crítico;
--   4. última coleta há 1 dia: ok;
--   5. não entra na verificação do Sistema S (coleta_externa_dias_sem_sucesso continua igual).
-- Banco LOCAL de teste; tudo dentro de begin; ... rollback;. Trava: aborta com mais de 100 preços (produção).
-- Saída esperada: "SUCESSO: saude_coleta_precos_check".
-- =============================================================================

begin;

do $$
declare
  v_qtd bigint;
  r record;
begin
  if not exists (select 1 from private.saude_limiares where verificacao = 'precos_dias_sem_coleta') then
    raise exception 'CHECK FALHOU: private.saude_limiares sem a verificação precos_dias_sem_coleta';
  end if;
  select * into r from private.saude_limiares where verificacao = 'precos_dias_sem_coleta';
  if r.critico is distinct from 8 or r.sem_dado is distinct from 'critico' or not r.ativo then
    raise exception 'CHECK FALHOU: limiar de precos_dias_sem_coleta: critico=% sem_dado=% ativo=%',
      r.critico, r.sem_dado, r.ativo;
  end if;

  select count(*) into v_qtd from public.precos_praticados_itens;
  if v_qtd > 100 then
    raise exception 'TRAVA DE SEGURANCA: precos_praticados_itens contem % linhas (> 100). Abortando.', v_qtd;
  end if;
  delete from public.precos_praticados_itens;  -- só no banco de teste (trava acima); desfeito pelo rollback

  select * into r from private.saude_operacional_resumo() s where s.verificacao = 'precos_dias_sem_coleta';
  if not found then
    raise exception 'CHECK FALHOU: precos_dias_sem_coleta ausente do resumo';
  end if;
  if r.status <> 'critico' or r.valor is not null then
    raise exception 'CHECK FALHOU: sem preço gravado deveria ser crítico sem valor (status=% valor=%)', r.status, r.valor;
  end if;

  insert into public.precos_praticados_itens (id_compra, id_item_compra, codigo_pdm, last_synced_at)
  values ('00000000000000009', 1, '999001', now() - interval '9 days'),
         ('00000000000000009', 2, '999001', now() - interval '20 days');
  select * into r from private.saude_operacional_resumo() s where s.verificacao = 'precos_dias_sem_coleta';
  if r.status <> 'critico' or r.valor <> 9.0 then
    raise exception 'CHECK FALHOU: coleta há 9 dias deveria ser crítica com valor 9.0 (status=% valor=%)', r.status, r.valor;
  end if;
  if r.detalhe ->> 'ultima_coleta' is null then
    raise exception 'CHECK FALHOU: detalhe sem ultima_coleta (%)', r.detalhe;
  end if;

  update public.precos_praticados_itens set last_synced_at = now() - interval '1 day' where id_item_compra = 1;
  select * into r from private.saude_operacional_resumo() s where s.verificacao = 'precos_dias_sem_coleta';
  if r.status <> 'ok' or r.valor <> 1.0 then
    raise exception 'CHECK FALHOU: coleta há 1 dia deveria ser ok (status=% valor=%)', r.status, r.valor;
  end if;

  -- O invólucro public (usado pela api-saude) também traz a verificação.
  if not exists (select 1 from public.saude_operacional_resumo() s where s.verificacao = 'precos_dias_sem_coleta') then
    raise exception 'CHECK FALHOU: public.saude_operacional_resumo() sem precos_dias_sem_coleta';
  end if;

  raise notice 'SUCESSO: saude_coleta_precos_check';
end $$;

rollback;
