-- Checagem de 20261011210000_cron_pca_fila_ligar.sql (spec 0012, #289): o fluxo do PCA por fila fica ligado e o
-- antigo desligado. Sem pg_cron, avisa e passa.
begin;

do $chk$
declare
  v_falhas text[] := '{}';
  j record;
  v_esperado boolean;
begin
  if to_regclass('cron.job') is null then
    raise notice 'cron_pca_fila_ligar_check: sem pg_cron, checagem pulada';
    raise notice 'SUCESSO: cron_pca_fila_ligar_check';
    return;
  end if;

  for j in
    select t.nome, c.active
      from (values ('licitagym-sync-pncp-pca-fila'), ('licitagym-sync-pncp-pca-fila-continuacao'),
                   ('licitagym-sync-pncp-pca-reconciliacao'),
                   ('licitagym-sync-pncp-pca'), ('licitagym-sync-pncp-pca-continuacao')) as t(nome)
      left join cron.job c on c.jobname = t.nome
  loop
    v_esperado := j.nome like 'licitagym-sync-pncp-pca-fila%' or j.nome = 'licitagym-sync-pncp-pca-reconciliacao';
    if j.active is null then
      v_falhas := v_falhas || format('job %s ausente', j.nome);
    elsif j.active is distinct from v_esperado then
      v_falhas := v_falhas || format('job %s com active=%s (esperado %s)', j.nome, j.active, v_esperado);
    end if;
  end loop;

  if array_length(v_falhas, 1) > 0 then
    raise exception 'ACL CHECK FALHOU (cron_pca_fila_ligar): %', array_to_string(v_falhas, '; ');
  end if;
  raise notice 'SUCESSO: cron_pca_fila_ligar_check';
end
$chk$;

rollback;
