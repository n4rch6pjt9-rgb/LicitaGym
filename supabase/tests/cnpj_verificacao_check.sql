-- Checagem da verificação local de CNPJ (spec specs/0008-verificacao-cnpj-brasilapi.md, entrega 1).
-- Falha com EXCEPTION se:
--   CA-1  private.cnpj_verificacao ou private.cnpj_verificacao_atualizar() ficarem acessíveis a anon/authenticated
--         (inclui PUBLIC), ou se service_role perder o acesso, ou se a RLS estiver desligada;
--   CA-2  CNPJ com DV inválido numa coluna de dado oficial não virar status 'dv_invalido';
--   CA-3  órgão do PCA sem nome (DV válido) não virar 'aguardando_consulta' com 'orgao_sem_nome';
--   CA-4  órgão do PGC sem plano no PNCP no mesmo ano não virar 'aguardando_consulta' com 'pgc_pncp_sem_par';
--   CA-5  CPF, CNPJ válido sem motivo ou repetição entrarem; ou a 2ª execução duplicar linha/motivo;
--   CA-6  a função alterar alguma tabela de dado oficial (hash antes = depois).
-- Fixtures com CNPJs fictícios (raiz 990000…) e ano 2099; tudo termina em rollback. Roda no banco descartável
-- (scripts/validar-migrations.sh) e pode rodar em produção pelo SQL Editor: não grava nada, exceto o avanço das
-- sequências/identity usadas pelos fixtures (nextval não volta no rollback). Em produção, não rodar no horário do cron
-- (segunda, 06:37 UTC): a função faz upsert dos alvos reais dentro da transação e travaria essas linhas.

begin;

do $chk$
declare
  v_falhas text[] := array[]::text[];
  v_antes text;
  v_depois text;
  v_r record;
  v_res jsonb;
  v_t1 timestamptz;
  v_t2 timestamptz;
  v_n int;
begin
  -- CA-1: objetos e ACL
  if to_regclass('private.cnpj_verificacao') is null then
    raise exception 'cnpj_verificacao_check: tabela private.cnpj_verificacao não existe';
  end if;
  if to_regprocedure('private.cnpj_verificacao_atualizar()') is null then
    raise exception 'cnpj_verificacao_check: função private.cnpj_verificacao_atualizar() não existe';
  end if;
  if not (select relrowsecurity from pg_class where oid = 'private.cnpj_verificacao'::regclass) then
    v_falhas := v_falhas || 'RLS desligada em private.cnpj_verificacao'::text;
  end if;
  for v_r in
    select papel, priv from unnest(array['anon', 'authenticated']) papel
     cross join unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) priv
     where has_table_privilege(papel, 'private.cnpj_verificacao', priv)
  loop
    v_falhas := v_falhas || format('%s tem %s em private.cnpj_verificacao', v_r.papel, v_r.priv);
  end loop;
  for v_r in select papel from unnest(array['anon', 'authenticated']) papel
              where has_function_privilege(papel, 'private.cnpj_verificacao_atualizar()', 'EXECUTE')
  loop
    v_falhas := v_falhas || format('%s executa private.cnpj_verificacao_atualizar()', v_r.papel);
  end loop;
  for v_r in select papel from unnest(array['anon', 'authenticated']) papel
              where has_schema_privilege(papel, 'private', 'USAGE')
  loop
    v_falhas := v_falhas || format('%s tem USAGE no schema private', v_r.papel);
  end loop;
  if not has_table_privilege('service_role', 'private.cnpj_verificacao', 'SELECT')
     or not has_table_privilege('service_role', 'private.cnpj_verificacao', 'INSERT')
     or not has_table_privilege('service_role', 'private.cnpj_verificacao', 'UPDATE')
     or not has_function_privilege('service_role', 'private.cnpj_verificacao_atualizar()', 'EXECUTE') then
    v_falhas := v_falhas || 'service_role sem SELECT na tabela ou sem EXECUTE na função'::text;
  end if;

  -- Fixtures (CNPJs fictícios; DV calculado: 99000001000101, 99000002000148, 99000003000192, 99000004000137)
  insert into public.orgaos (codigo_orgao, compras_raw, compras_payload_hash, cnpj, nome_orgao) values
    (999990001, '{}'::jsonb, 'chk', '99.000.001/0001-02', 'CHK DV INVALIDO'),  -- CA-2: DV inválido (certo: 01)
    (999990004, '{}'::jsonb, 'chk', '99000004000137', 'CHK VALIDO COM NOME'), -- CA-5: válido, sem motivo
    (999990005, '{}'::jsonb, 'chk', '12345678909', 'CHK CPF'),                -- CA-5: CPF fica de fora
    (999990007, '{}'::jsonb, 'chk', '', 'CHK VAZIO');                         -- CA-5: valor vazio fica de fora
  insert into public.pca_planos (id_pca_pncp, ano_exercicio, orgao_cnpj, titulo, payload_hash, ativo) values
    ('CHK-CNPJV-P2', 2099, '99000002000148', null, 'chk', true),                  -- CA-3: sem nome em lugar nenhum
    ('CHK-CNPJV-P5a', 2099, '99000005000181', null, 'chk', true),                 -- CA-3: um plano sem título...
    ('CHK-CNPJV-P5b', 2098, '99000005000181', 'CHK COM TITULO', 'chk', true),     -- ...e outro com: o órgão tem nome
    ('CHK-CNPJV-P6', 2099, '99000006000126', null, 'chk', true);                  -- CA-5: já consultado ('ok') mantém
  insert into private.cnpj_verificacao (cnpj, dv_valido, status, motivos, fonte, consultado_em)
    values ('99000006000126', true, 'ok', array['orgao_sem_nome'], 'brasilapi', now());
  insert into public.pca_pgc_itens (codigo_uasg, orgao_cnpj, ano_pca_projeto_compra) values
    ('999999', '99000003000192', 2099);                                            -- CA-4: sem plano PNCP em 2099

  -- CA-6: hash das tabelas de dado oficial antes
  select string_agg(h, ',' order by h) into v_antes from (
    select 'orgaos:' || md5(coalesce(string_agg(md5(t::text), '' order by md5(t::text)), '')) h from public.orgaos t
    union all select 'pca_planos:' || md5(coalesce(string_agg(md5(t::text), '' order by md5(t::text)), '')) from public.pca_planos t
    union all select 'pca_pgc_itens:' || md5(coalesce(string_agg(md5(t::text), '' order by md5(t::text)), '')) from public.pca_pgc_itens t
    union all select 'licitacoes_externas:' || md5(coalesce(string_agg(md5(t::text), '' order by md5(t::text)), '')) from public.licitacoes_externas t
    union all select 'contratacoes_editais:' || md5(coalesce(string_agg(md5(t::text), '' order by md5(t::text)), '')) from public.contratacoes_editais t
    union all select 'fornecedores:' || md5(coalesce(string_agg(md5(t::text), '' order by md5(t::text)), '')) from public.fornecedores t
    union all select 'licitacao_resultados:' || md5(coalesce(string_agg(md5(t::text), '' order by md5(t::text)), '')) from public.licitacao_resultados t
    union all select 'precos_praticados_itens:' || md5(coalesce(string_agg(md5(t::text), '' order by md5(t::text)), '')) from public.precos_praticados_itens t
    union all select 'atas_rp_itens:' || md5(coalesce(string_agg(md5(t::text), '' order by md5(t::text)), '')) from public.atas_rp_itens t
    union all select 'contratacoes_atas:' || md5(coalesce(string_agg(md5(t::text), '' order by md5(t::text)), '')) from public.contratacoes_atas t
    union all select 'resultados_itens_14133:' || md5(coalesce(string_agg(md5(t::text), '' order by md5(t::text)), '')) from public.resultados_itens_14133 t
  ) x;

  -- Execução como service_role (o papel que a Edge Function usa)
  execute 'set local role service_role';
  v_res := private.cnpj_verificacao_atualizar();
  v_t1 := (select ultima_vez_no_alvo from private.cnpj_verificacao where cnpj = '99000001000102');
  execute 'reset role';

  select string_agg(h, ',' order by h) into v_depois from (
    select 'orgaos:' || md5(coalesce(string_agg(md5(t::text), '' order by md5(t::text)), '')) h from public.orgaos t
    union all select 'pca_planos:' || md5(coalesce(string_agg(md5(t::text), '' order by md5(t::text)), '')) from public.pca_planos t
    union all select 'pca_pgc_itens:' || md5(coalesce(string_agg(md5(t::text), '' order by md5(t::text)), '')) from public.pca_pgc_itens t
    union all select 'licitacoes_externas:' || md5(coalesce(string_agg(md5(t::text), '' order by md5(t::text)), '')) from public.licitacoes_externas t
    union all select 'contratacoes_editais:' || md5(coalesce(string_agg(md5(t::text), '' order by md5(t::text)), '')) from public.contratacoes_editais t
    union all select 'fornecedores:' || md5(coalesce(string_agg(md5(t::text), '' order by md5(t::text)), '')) from public.fornecedores t
    union all select 'licitacao_resultados:' || md5(coalesce(string_agg(md5(t::text), '' order by md5(t::text)), '')) from public.licitacao_resultados t
    union all select 'precos_praticados_itens:' || md5(coalesce(string_agg(md5(t::text), '' order by md5(t::text)), '')) from public.precos_praticados_itens t
    union all select 'atas_rp_itens:' || md5(coalesce(string_agg(md5(t::text), '' order by md5(t::text)), '')) from public.atas_rp_itens t
    union all select 'contratacoes_atas:' || md5(coalesce(string_agg(md5(t::text), '' order by md5(t::text)), '')) from public.contratacoes_atas t
    union all select 'resultados_itens_14133:' || md5(coalesce(string_agg(md5(t::text), '' order by md5(t::text)), '')) from public.resultados_itens_14133 t
  ) x;
  if v_antes is distinct from v_depois then
    v_falhas := v_falhas || 'CA-6: a função alterou tabela de dado oficial'::text;
  end if;

  if v_res is null or jsonb_typeof(v_res) <> 'object' or not (v_res ? 'dv_invalido') or not (v_res ? 'aguardando_consulta') then
    v_falhas := v_falhas || format('retorno inesperado: %s', v_res);
  end if;

  -- CA-2
  if not exists (select 1 from private.cnpj_verificacao
                  where cnpj = '99000001000102' and status = 'dv_invalido' and dv_valido = false
                    and motivos @> array['dv_invalido'] and (ocorrencias ->> 'orgaos.cnpj')::int = 1) then
    v_falhas := v_falhas || 'CA-2: 99000001000102 não virou dv_invalido com ocorrencia em orgaos.cnpj'::text;
  end if;
  -- CA-3
  if not exists (select 1 from private.cnpj_verificacao
                  where cnpj = '99000002000148' and status = 'aguardando_consulta' and dv_valido
                    and motivos = array['orgao_sem_nome']) then
    v_falhas := v_falhas || 'CA-3: 99000002000148 não virou aguardando_consulta com orgao_sem_nome'::text;
  end if;
  -- CA-4
  if not exists (select 1 from private.cnpj_verificacao
                  where cnpj = '99000003000192' and status = 'aguardando_consulta' and dv_valido
                    and motivos @> array['pgc_pncp_sem_par']) then
    v_falhas := v_falhas || 'CA-4: 99000003000192 não virou aguardando_consulta com pgc_pncp_sem_par'::text;
  end if;
  -- CA-3: órgão com título em outro plano não é "sem nome"
  if exists (select 1 from private.cnpj_verificacao where cnpj = '99000005000181') then
    v_falhas := v_falhas || 'CA-3: 99000005000181 tem título noutro plano e entrou como orgao_sem_nome'::text;
  end if;
  -- CA-5: status já consultado não volta para aguardando
  if not exists (select 1 from private.cnpj_verificacao where cnpj = '99000006000126' and status = 'ok') then
    v_falhas := v_falhas || 'CA-5: 99000006000126 (ok) perdeu o status consultado'::text;
  end if;
  -- CA-5: fora do alvo
  if exists (select 1 from private.cnpj_verificacao where cnpj in ('99000004000137', '12345678909', '00012345678909')) then
    v_falhas := v_falhas || 'CA-5: CNPJ válido sem motivo ou CPF entrou na verificação'::text;
  end if;

  -- CA-5: 2ª execução não duplica e avança ultima_vez_no_alvo
  execute 'set local role service_role';
  perform private.cnpj_verificacao_atualizar();
  execute 'reset role';
  select count(*) into v_n from private.cnpj_verificacao where cnpj like '990000%';
  if v_n <> 4 then  -- 01 (dv), 02 (sem nome), 03 (pgc), 06 (pré-existente 'ok'); 05 tem nome em outro plano
    v_falhas := v_falhas || format('CA-5: esperadas 4 linhas de fixture após 2 execuções, achei %s', v_n);
  end if;
  if exists (select 1 from private.cnpj_verificacao
              where cnpj like '990000%' and cardinality(motivos) <> (select count(distinct m) from unnest(motivos) m)) then
    v_falhas := v_falhas || 'CA-5: motivo duplicado após a 2ª execução'::text;
  end if;
  v_t2 := (select ultima_vez_no_alvo from private.cnpj_verificacao where cnpj = '99000001000102');
  if not (v_t2 > v_t1) then
    v_falhas := v_falhas || format('CA-5: ultima_vez_no_alvo não avançou (%s → %s)', v_t1, v_t2);
  end if;

  if cardinality(v_falhas) > 0 then
    raise exception 'cnpj_verificacao_check: % falha(s): %', cardinality(v_falhas), array_to_string(v_falhas, '; ');
  end if;
  raise notice 'SUCESSO: cnpj_verificacao_check: ACL, alvos, idempotência e tabelas oficiais intactas';
end $chk$;

rollback;
