-- Spec specs/0057-pgc-no-radar-pca.md, K-4 (CA-7): pgc_dias_sem_coleta em private.saude_operacional_resumo().
--   1. tem limiar em private.saude_limiares (atenção 1,5 dia; crítico 8 dias; sem dado = crítico);
--   2. sem nenhuma linha do PGC: crítico (sem dado);
--   3. última gravação (max(last_synced_at) de pca_pgc_itens) há 9 dias: crítico com valor 9.0;
--   4. última gravação há 1 dia: ok;
--   5. o invólucro public (api-saude) traz a verificação.
-- Banco LOCAL de teste; tudo dentro de begin; ... rollback;. Trava: aborta com mais de 100 linhas (produção).
-- Saída esperada: "SUCESSO: saude_pgc_check".

begin;

do $$
declare
  v_qtd bigint;
  r record;
begin
  select * into r from private.saude_limiares where verificacao = 'pgc_dias_sem_coleta';
  if not found then
    raise exception 'CHECK FALHOU: private.saude_limiares sem a verificação pgc_dias_sem_coleta';
  end if;
  if r.critico is distinct from 8 or r.sem_dado is distinct from 'critico' or not r.ativo then
    raise exception 'CHECK FALHOU: limiar de pgc_dias_sem_coleta: critico=% sem_dado=% ativo=%',
      r.critico, r.sem_dado, r.ativo;
  end if;

  select count(*) into v_qtd from public.pca_pgc_itens;
  if v_qtd > 100 then
    raise exception 'TRAVA DE SEGURANCA: pca_pgc_itens contem % linhas (> 100). Abortando.', v_qtd;
  end if;
  delete from public.pca_pgc_itens;  -- só no banco de teste (trava acima); desfeito pelo rollback

  select * into r from private.saude_operacional_resumo() s where s.verificacao = 'pgc_dias_sem_coleta';
  if not found then
    raise exception 'CHECK FALHOU: pgc_dias_sem_coleta ausente do resumo';
  end if;
  if r.status <> 'critico' or r.valor is not null then
    raise exception 'CHECK FALHOU: sem PGC gravado deveria ser crítico sem valor (status=% valor=%)', r.status, r.valor;
  end if;

  insert into public.pca_pgc_itens (codigo_uasg, orgao_cnpj, ano_pca_projeto_compra, numero_item_pncp,
                                    codigo_item_catalogo, payload_hash, last_synced_at)
  values ('999957', '99000057000100', 2099, 1, 999957001, 'chk', now() - interval '9 days'),
         ('999957', '99000057000100', 2099, 2, 999957002, 'chk', now() - interval '20 days');
  select * into r from private.saude_operacional_resumo() s where s.verificacao = 'pgc_dias_sem_coleta';
  if r.status <> 'critico' or r.valor <> 9.0 then
    raise exception 'CHECK FALHOU: PGC há 9 dias deveria ser crítico com valor 9.0 (status=% valor=%)', r.status, r.valor;
  end if;
  if r.detalhe ->> 'ultima_coleta' is null then
    raise exception 'CHECK FALHOU: detalhe sem ultima_coleta (%)', r.detalhe;
  end if;

  update public.pca_pgc_itens set last_synced_at = now() - interval '1 day' where numero_item_pncp = 1;
  select * into r from private.saude_operacional_resumo() s where s.verificacao = 'pgc_dias_sem_coleta';
  if r.status <> 'ok' or r.valor <> 1.0 then
    raise exception 'CHECK FALHOU: PGC há 1 dia deveria ser ok (status=% valor=%)', r.status, r.valor;
  end if;

  if not exists (select 1 from public.saude_operacional_resumo() s where s.verificacao = 'pgc_dias_sem_coleta') then
    raise exception 'CHECK FALHOU: public.saude_operacional_resumo() sem pgc_dias_sem_coleta';
  end if;

  raise notice 'SUCESSO: saude_pgc_check';
end $$;

rollback;
