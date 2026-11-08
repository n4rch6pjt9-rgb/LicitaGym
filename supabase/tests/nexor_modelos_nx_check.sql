-- Checagem da migration 20261107220000_nexor_modelos_nx (Nexor Fase 0, PR 2).
--   14 etapas NX; 23 modelos NX com DV correto (recalculado aqui em SQL, independente do script); 84 modelos da
--   14.133 intactos; apelidos (33 NX-T ativos, NX-T18 com dois modelos, NX-T34 ausente); condição em texto = "não
--   verificada"; ACL de tarefas_catalogo_apelidos (RLS, sem policy, só service_role lê).

do $$
declare
  r  text;
  n  integer;
  c  record;
  s  text;
  dv integer;
begin
  select count(*) into n from public.processo_fases where norma = 'NX';
  if n <> 14 then raise exception 'CHECK FALHOU: esperadas 14 etapas NX, achei %', n; end if;
  if exists (select 1 from public.processo_fases where norma = 'NX' and codigo !~ '^[APSR][0-9]{2}$') then
    raise exception 'CHECK FALHOU: etapa NX com código fora de A01–R14';
  end if;
  if (select macro from public.processo_fases where codigo = 'R12' and norma = 'NX') is distinct from 'contrato'
     or exists (select 1 from public.processo_fases where norma = 'NX' and codigo <> 'R12' and macro <> 'certame') then
    raise exception 'CHECK FALHOU: macro das etapas NX (R12 = contrato, demais = certame)';
  end if;

  select count(*) into n from public.tarefas_catalogo where norma = 'NX';
  if n <> 23 then raise exception 'CHECK FALHOU: esperados 23 modelos NX, achei %', n; end if;
  select count(*) into n from public.tarefas_catalogo where norma = 'LEI_14133_2021';
  if n <> 84 then raise exception 'CHECK FALHOU: modelos da 14.133 mudaram (esperados 84, achei %)', n; end if;
  if exists (select 1 from public.tarefas_catalogo where norma = 'LEI_14133_2021'
              and (prazo_horas_apos_etapa is not null or responsavel_padrao is not null)) then
    raise exception 'CHECK FALHOU: colunas NX preenchidas em modelo da 14.133';
  end if;

  -- Constraints novas existem e recusam código NX fora do formato (subtransação: nada fica gravado).
  if (select count(*) from pg_constraint where conrelid = 'public.tarefas_catalogo'::regclass
        and conname in ('tarefas_catalogo_codigo_nx_check', 'tarefas_catalogo_prazo_horas_apos_etapa_check')) <> 2 then
    raise exception 'CHECK FALHOU: constraints novas de tarefas_catalogo ausentes';
  end if;
  begin
    insert into public.tarefas_catalogo (codigo, norma, fase_codigo, ordem, titulo, descricao, natureza, ator, prazo_unidade)
    values ('NX.GEN.A01.DAT.001', 'NX', 'A01', 999, 'x', 'x', 'preparacao', 'licitante', 'sem_prazo_legal');
    raise exception 'CHECK FALHOU: código NX sem DV foi aceito';
  exception when check_violation then null;
  end;
  if exists (select 1 from public.tarefas_catalogo t
              where t.norma = 'NX'
                and not exists (select 1 from public.processo_fases f where f.codigo = t.fase_codigo and f.norma = 'NX')) then
    raise exception 'CHECK FALHOU: modelo NX fora de etapa NX';
  end if;

  -- DV = MOD(Σ código do caractere × posição; 10), sobre o id sem o "-DV".
  for c in select codigo from public.tarefas_catalogo where norma = 'NX'
           union select apelido from public.tarefas_catalogo_apelidos where sistema = 'nx' loop
    s := split_part(c.codigo, '-', 1);
    select sum(ascii(substr(s, i, 1)) * i) % 10 into dv from generate_series(1, length(s)) i;
    if dv::text <> split_part(c.codigo, '-', 2) then
      raise exception 'CHECK FALHOU: DV errado em % (esperado %)', c.codigo, dv;
    end if;
  end loop;
  if not exists (select 1 from public.tarefas_catalogo_apelidos
                  where sistema = 'nx' and apelido = 'NX.GEN.A02.IMP.005-4' and tarefa_codigo = '14133-F01-T04') then
    raise exception 'CHECK FALHOU: NX.GEN.A02.IMP.005-4 (NX-T05) não aponta para 14133-F01-T04';
  end if;

  if exists (select 1 from public.tarefas_catalogo where norma = 'NX'
              and (prazo_unidade = 'sem_prazo_legal') <> (prazo_horas_apos_etapa is not null)) then
    raise exception 'CHECK FALHOU: modelo NX com SLA em horas e prazo do edital ao mesmo tempo (ou nenhum)';
  end if;
  if exists (select 1 from public.tarefas_catalogo where norma = 'NX' and condicao ? 'condicao_nx'
              and public.catalogo_condicao_avaliar(condicao, '{}'::jsonb) is not null) then
    raise exception 'CHECK FALHOU: condição em texto deveria ficar "não verificada" (null)';
  end if;

  select count(*) into n from public.tarefas_catalogo_apelidos;
  if n <> 45 then raise exception 'CHECK FALHOU: esperados 45 apelidos, achei %', n; end if;
  select count(distinct apelido) into n from public.tarefas_catalogo_apelidos where sistema = 'nx_t';
  if n <> 33 then raise exception 'CHECK FALHOU: esperados 33 NX-T com apelido, achei %', n; end if;
  if exists (select 1 from public.tarefas_catalogo_apelidos where apelido = 'NX-T34') then
    raise exception 'CHECK FALHOU: NX-T34 é reservado e não pode ter apelido';
  end if;
  select count(*) into n from public.tarefas_catalogo_apelidos where sistema = 'nx_t' and apelido = 'NX-T18';
  if n <> 2 then raise exception 'CHECK FALHOU: NX-T18 deveria apontar para 2 modelos, achei %', n; end if;

  if not (select relrowsecurity from pg_class where oid = 'public.tarefas_catalogo_apelidos'::regclass) then
    raise exception 'CHECK FALHOU: RLS desligada em tarefas_catalogo_apelidos';
  end if;
  if exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'tarefas_catalogo_apelidos') then
    raise exception 'CHECK FALHOU: tarefas_catalogo_apelidos não deve ter policy';
  end if;
  foreach r in array array['anon', 'authenticated', 'public'] loop
    if has_table_privilege(r, 'public.tarefas_catalogo_apelidos', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN') then
      raise exception 'CHECK FALHOU: % tem privilégio em tarefas_catalogo_apelidos', r;
    end if;
  end loop;
  if not has_table_privilege('service_role', 'public.tarefas_catalogo_apelidos', 'SELECT')
     or has_table_privilege('service_role', 'public.tarefas_catalogo_apelidos', 'INSERT,UPDATE,DELETE,TRUNCATE') then
    raise exception 'CHECK FALHOU: service_role deve só ler tarefas_catalogo_apelidos';
  end if;

  raise notice 'SUCESSO: nexor modelos NX (14 etapas, 23 modelos, DV, apelidos, ACL)';
end $$;
