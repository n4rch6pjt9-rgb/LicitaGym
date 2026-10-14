-- Regressão da #339.
-- PNCP (fonte pncp): +3 h uma vez. A marca é por fonte: uma marca fonte=pncp no mesmo id não impede o SEST.
-- SEST (fonte sestsenat) e outro Paradigma (fonte fiesc): parse_data já gravou UTC; a data não muda;
--   a marca fica na fonte da linha, com regra manter_utc.
-- portal_rlc_rca (sesi_pe): não é o bug do PNCP e o coletor não grava /Date(ms)/; a data não muda e não ganha marca.
-- Segunda chamada corrige 0. Dados fictícios. begin/rollback. Aborta se licitacoes_externas tiver mais de 100 linhas.

-- Caminho de compatibilidade (13/10/2026): recria o formato da primeira versão (tabela sem fonte/regra, pk (relacao,id),
-- 3 h somadas em toda linha marcada) com dados fictícios, chama private.pncp_fuso_339_compatibilidade() e confere:
-- pncp intacto, sestsenat devolvido 3 h, marcas com fonte/regra, órfã como 'desconhecida', chave nova. begin/rollback.
begin;

do $$
declare
  v_qtd int;
  v_lic_pncp bigint;
  v_doc_pncp bigint;
  v_lic_sest bigint;
  v_doc_sest bigint;
  v_antes timestamptz := timestamptz '2026-10-08 10:00+00';
  v_mais3 timestamptz := timestamptz '2026-10-08 10:00+00' + interval '3 hours';
  v_r record;
  v_doc timestamptz;
  v_hom timestamptz;
  v_pk text;
begin
  select count(*) into v_qtd from public.licitacoes_externas;
  if v_qtd > 100 then
    raise exception 'TRAVA DE SEGURANCA: licitacoes_externas contem % linhas (> 100). Abortando para proteger producao.', v_qtd;
  end if;

  insert into public.fontes_externas (slug, entidade, plataforma, base_url, modo_coleta)
  values ('pncp', 'PNCP', 'pncp', 'https://pncp.gov.br', 'automatico'),
         ('sestsenat', 'SEST SENAT', 'paradigma', 'https://compras.sestsenat.org.br/portal', 'automatico')
  on conflict (slug) do nothing;

  -- estado que a v1 deixou: as datas já estão 3 h adiantadas nos dois, e a marca não tem fonte
  insert into public.licitacoes_externas (fonte, modulo, id_externo, codigo_externo, data_homologacao)
  values ('pncp', 1, 910339, 'compat-pncp', v_mais3) returning id into v_lic_pncp;
  insert into public.licitacao_documentos (licitacao_id, secao, arquivo_origem, data_documento)
  values (v_lic_pncp, 'processo', 'compat-pncp', v_mais3) returning id into v_doc_pncp;
  insert into public.licitacoes_externas (fonte, modulo, id_externo, codigo_externo, data_homologacao)
  values ('sestsenat', 1, 910340, 'compat-sest', v_mais3) returning id into v_lic_sest;
  insert into public.licitacao_documentos (licitacao_id, secao, arquivo_origem, data_documento)
  values (v_lic_sest, 'processo', 'compat-sest', v_mais3) returning id into v_doc_sest;

  drop table private.pncp_fuso_linha_339;
  create table private.pncp_fuso_linha_339 (
    relacao text not null check (relacao in ('licitacao_documentos', 'licitacao_resultados', 'licitacoes_externas')),
    id bigint not null,
    corrigida_em timestamptz not null default now(),
    primary key (relacao, id)
  );
  insert into private.pncp_fuso_linha_339 (relacao, id) values
    ('licitacao_documentos', v_doc_pncp), ('licitacoes_externas', v_lic_pncp),
    ('licitacao_documentos', v_doc_sest), ('licitacoes_externas', v_lic_sest),
    ('licitacao_resultados', 999999339);  -- órfã: resultado que não existe mais

  select * into v_r from private.pncp_fuso_339_compatibilidade();
  if v_r.documentos <> 1 or v_r.resultados <> 0 or v_r.homologacoes <> 1 then
    raise exception 'compat 339: devolvidas % documentos, % resultados, % homologacoes (esperado 1, 0, 1)',
      v_r.documentos, v_r.resultados, v_r.homologacoes;
  end if;

  select d.data_documento into v_doc from public.licitacao_documentos d where d.id = v_doc_pncp;
  select l.data_homologacao into v_hom from public.licitacoes_externas l where l.id = v_lic_pncp;
  if v_doc is distinct from v_mais3 or v_hom is distinct from v_mais3 then
    raise exception 'compat 339: pncp mudou, documento % homologacao % (esperado %)', v_doc, v_hom, v_mais3;
  end if;
  select d.data_documento into v_doc from public.licitacao_documentos d where d.id = v_doc_sest;
  select l.data_homologacao into v_hom from public.licitacoes_externas l where l.id = v_lic_sest;
  if v_doc is distinct from v_antes or v_hom is distinct from v_antes then
    raise exception 'compat 339: sestsenat nao voltou, documento % homologacao % (esperado %)', v_doc, v_hom, v_antes;
  end if;

  if not exists (select 1 from private.pncp_fuso_linha_339 where relacao = 'licitacao_documentos' and id = v_doc_pncp and fonte = 'pncp' and regra = 'pncp_mais_3h')
     or not exists (select 1 from private.pncp_fuso_linha_339 where relacao = 'licitacao_documentos' and id = v_doc_sest and fonte = 'sestsenat' and regra = 'manter_utc')
     or not exists (select 1 from private.pncp_fuso_linha_339 where relacao = 'licitacao_resultados' and id = 999999339 and fonte = 'desconhecida' and regra = 'pncp_mais_3h') then
    raise exception 'compat 339: marcas sem fonte/regra esperadas';
  end if;
  select string_agg(a.attname, ',' order by k.ord) into v_pk
    from pg_constraint c
    join lateral unnest(c.conkey) with ordinality as k(attnum, ord) on true
    join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.attnum
   where c.conrelid = 'private.pncp_fuso_linha_339'::regclass and c.contype = 'p';
  if v_pk is distinct from 'relacao,id,fonte' then
    raise exception 'compat 339: chave primaria % (esperado relacao,id,fonte)', v_pk;
  end if;

  -- segunda chamada: tabela já no formato novo, nada a fazer
  select * into v_r from private.pncp_fuso_339_compatibilidade();
  if v_r.documentos <> 0 or v_r.homologacoes <> 0 then
    raise exception 'compat 339: segunda chamada devolveu % documentos e % homologacoes', v_r.documentos, v_r.homologacoes;
  end if;

  raise notice 'SUCESSO: compatibilidade da #339 devolve 3 h so fora do PNCP, marca fonte/regra e refaz a chave.';
end $$;

rollback;

-- Invariantes da compatibilidade com a primeira versão (13/10/2026): toda marca tem fonte e regra coerentes.
do $$
declare
  v_sem_fonte bigint;
  v_errada bigint;
  v_retorno text;
begin
  select count(*) into v_sem_fonte from private.pncp_fuso_linha_339 where fonte is null or regra is null;
  select count(*) into v_errada from private.pncp_fuso_linha_339
   where (fonte = 'pncp' and regra <> 'pncp_mais_3h')
      or (fonte not in ('pncp', 'desconhecida') and regra <> 'manter_utc');
  select pg_get_function_result(p.oid) into v_retorno
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'private' and p.proname = 'corrigir_fuso_pncp_339';
  if v_sem_fonte > 0 or v_errada > 0 then
    raise exception 'ACL CHECK FALHOU: pncp_fuso_linha_339 com % marcas sem fonte/regra e % com regra incoerente', v_sem_fonte, v_errada;
  end if;
  if v_retorno is distinct from 'TABLE(fonte text, relacao text, corrigidas bigint)' then
    raise exception 'ACL CHECK FALHOU: corrigir_fuso_pncp_339 com retorno %, esperado TABLE(fonte, relacao, corrigidas)', v_retorno;
  end if;
  raise notice 'SUCESSO: marcas da #339 com fonte e regra coerentes; função no retorno novo.';
end $$;

begin;

do $$
declare
  v_qtd int;
  v_lic_pncp bigint;
  v_doc_pncp bigint;
  v_res_pncp bigint;
  v_lic_sest bigint;
  v_doc_sest bigint;
  v_res_sest bigint;
  v_lic_fiesc bigint;
  v_doc_fiesc bigint;
  v_res_fiesc bigint;
  v_lic_sesi bigint;
  v_doc_sesi bigint;
  v_antes timestamptz := timestamptz '2026-10-08 10:00+00';
  v_depois timestamptz := timestamptz '2026-10-08 10:00+00' + interval '3 hours';
  v_n bigint;
  v_marcas bigint;
  v_marcas_depois bigint;
  v_doc_em timestamptz;
  v_res_em timestamptz;
  v_hom_em timestamptz;
begin
  select count(*) into v_qtd from public.licitacoes_externas;
  if v_qtd > 100 then
    raise exception 'TRAVA DE SEGURANCA: licitacoes_externas contem % linhas (> 100). Abortando para proteger producao.', v_qtd;
  end if;

  insert into public.fontes_externas (slug, entidade, plataforma, base_url, modo_coleta)
  values
    ('pncp', 'PNCP', 'pncp', 'https://pncp.gov.br', 'automatico'),
    ('sestsenat', 'SEST SENAT', 'paradigma', 'https://compras.sestsenat.org.br/portal', 'automatico'),
    ('fiesc', 'FIESC', 'paradigma', 'https://portaldecompras.fiesc.com.br/portal', 'automatico'),
    ('sesi_pe', 'SESI PE', 'portal_rlc_rca', 'https://licitacoes.pe.sesi.org.br:8081', 'manual')
  on conflict (slug) do nothing;

  insert into public.licitacoes_externas (fonte, modulo, id_externo, codigo_externo, data_homologacao)
  values ('pncp', 1, 900339, '00000000000339-1-000339/2026', v_antes)
  returning id into v_lic_pncp;
  insert into public.licitacao_documentos (licitacao_id, secao, arquivo_origem, data_documento)
  values (v_lic_pncp, 'processo', 'pncp-339', v_antes)
  returning id into v_doc_pncp;
  insert into public.licitacao_resultados (licitacao_id, numero_item, sequencial_resultado, data_resultado)
  values (v_lic_pncp, 1, 1, v_antes)
  returning id into v_res_pncp;

  insert into public.licitacoes_externas (fonte, modulo, id_externo, codigo_externo, data_homologacao)
  values ('sestsenat', 1, 900340, 'sest-339', v_antes)
  returning id into v_lic_sest;
  insert into public.licitacao_documentos (licitacao_id, secao, arquivo_origem, data_documento)
  values (v_lic_sest, 'processo', 'sest-339', v_antes)
  returning id into v_doc_sest;
  insert into public.licitacao_resultados (licitacao_id, numero_item, sequencial_resultado, data_resultado)
  values (v_lic_sest, 1, 1, v_antes)
  returning id into v_res_sest;

  insert into public.licitacoes_externas (fonte, modulo, id_externo, codigo_externo, data_homologacao)
  values ('fiesc', 1, 900341, 'fiesc-339', v_antes)
  returning id into v_lic_fiesc;
  insert into public.licitacao_documentos (licitacao_id, secao, arquivo_origem, data_documento)
  values (v_lic_fiesc, 'processo', 'fiesc-339', v_antes)
  returning id into v_doc_fiesc;
  insert into public.licitacao_resultados (licitacao_id, numero_item, sequencial_resultado, data_resultado)
  values (v_lic_fiesc, 1, 1, v_antes)
  returning id into v_res_fiesc;

  insert into public.licitacoes_externas (fonte, modulo, id_externo, codigo_externo, data_homologacao)
  values ('sesi_pe', 1, 900342, 'sesi-pe-339', v_antes)
  returning id into v_lic_sesi;
  insert into public.licitacao_documentos (licitacao_id, secao, arquivo_origem, data_documento)
  values (v_lic_sesi, 'processo', 'sesi-pe-339', v_antes)
  returning id into v_doc_sesi;

  -- Marca do PNCP no mesmo id do documento SEST: a passagem do SEST ainda tem de rodar.
  insert into private.pncp_fuso_linha_339 (relacao, id, fonte, regra)
  values ('licitacao_documentos', v_doc_sest, 'pncp', 'pncp_mais_3h');

  select coalesce(sum(c.corrigidas), 0) into v_n
    from private.corrigir_fuso_pncp_339() c
   where c.fonte = 'pncp';

  select d.data_documento into v_doc_em from public.licitacao_documentos d where d.id = v_doc_pncp;
  select r.data_resultado into v_res_em from public.licitacao_resultados r where r.id = v_res_pncp;
  select l.data_homologacao into v_hom_em from public.licitacoes_externas l where l.id = v_lic_pncp;
  if v_doc_em is distinct from v_depois or v_res_em is distinct from v_depois or v_hom_em is distinct from v_depois then
    raise exception 'pncp_fuso_339: PNCP esperado %, documento % resultado % homologacao %', v_depois, v_doc_em, v_res_em, v_hom_em;
  end if;
  if v_n < 3 then
    raise exception 'pncp_fuso_339: a primeira chamada corrigiu % linhas pncp (esperado ao menos 3)', v_n;
  end if;
  if not exists (
    select 1 from private.pncp_fuso_linha_339 m
     where m.relacao = 'licitacao_documentos' and m.id = v_doc_pncp
       and m.fonte = 'pncp' and m.regra = 'pncp_mais_3h'
  ) then
    raise exception 'pncp_fuso_339: documento PNCP sem marca pncp_mais_3h';
  end if;

  select d.data_documento into v_doc_em from public.licitacao_documentos d where d.id = v_doc_sest;
  select r.data_resultado into v_res_em from public.licitacao_resultados r where r.id = v_res_sest;
  select l.data_homologacao into v_hom_em from public.licitacoes_externas l where l.id = v_lic_sest;
  if v_doc_em is distinct from v_antes or v_res_em is distinct from v_antes or v_hom_em is distinct from v_antes then
    raise exception 'pncp_fuso_339: SEST sestsenat mudou, documento % resultado % homologacao %', v_doc_em, v_res_em, v_hom_em;
  end if;
  if not exists (
    select 1 from private.pncp_fuso_linha_339 m
     where m.relacao = 'licitacao_documentos' and m.id = v_doc_sest
       and m.fonte = 'sestsenat' and m.regra = 'manter_utc'
  ) then
    raise exception 'pncp_fuso_339: marca pncp no documento SEST impediu a marca sestsenat';
  end if;

  select d.data_documento into v_doc_em from public.licitacao_documentos d where d.id = v_doc_fiesc;
  select r.data_resultado into v_res_em from public.licitacao_resultados r where r.id = v_res_fiesc;
  select l.data_homologacao into v_hom_em from public.licitacoes_externas l where l.id = v_lic_fiesc;
  if v_doc_em is distinct from v_antes or v_res_em is distinct from v_antes or v_hom_em is distinct from v_antes then
    raise exception 'pncp_fuso_339: Paradigma fiesc mudou, documento % resultado % homologacao %', v_doc_em, v_res_em, v_hom_em;
  end if;
  if not exists (
    select 1 from private.pncp_fuso_linha_339 m
     where m.relacao = 'licitacoes_externas' and m.id = v_lic_fiesc
       and m.fonte = 'fiesc' and m.regra = 'manter_utc'
  ) or exists (
    select 1 from private.pncp_fuso_linha_339 m
     where m.id in (v_doc_fiesc, v_res_fiesc, v_lic_fiesc) and m.fonte = 'pncp'
  ) then
    raise exception 'pncp_fuso_339: fiesc sem marca manter_utc da propria fonte, ou marcado como pncp';
  end if;

  select d.data_documento into v_doc_em from public.licitacao_documentos d where d.id = v_doc_sesi;
  select l.data_homologacao into v_hom_em from public.licitacoes_externas l where l.id = v_lic_sesi;
  if v_doc_em is distinct from v_antes or v_hom_em is distinct from v_antes then
    raise exception 'pncp_fuso_339: sesi_pe mudou, documento % homologacao %', v_doc_em, v_hom_em;
  end if;
  if exists (
    select 1 from private.pncp_fuso_linha_339 m
     where m.id in (v_doc_sesi, v_lic_sesi) and m.fonte = 'sesi_pe'
  ) then
    raise exception 'pncp_fuso_339: sesi_pe ganhou marca sem regra lida no coletor';
  end if;

  select count(*) into v_marcas from private.pncp_fuso_linha_339;
  select coalesce(sum(c.corrigidas), 0) into v_n from private.corrigir_fuso_pncp_339() c;
  select count(*) into v_marcas_depois from private.pncp_fuso_linha_339;
  select d.data_documento into v_doc_em from public.licitacao_documentos d where d.id = v_doc_pncp;
  select l.data_homologacao into v_hom_em from public.licitacoes_externas l where l.id = v_lic_sest;
  if v_n <> 0 or v_marcas_depois <> v_marcas or v_doc_em is distinct from v_depois or v_hom_em is distinct from v_antes then
    raise exception 'pncp_fuso_339: a segunda chamada corrigiu %, marcas % -> %, pncp % sest %',
      v_n, v_marcas, v_marcas_depois, v_doc_em, v_hom_em;
  end if;

  raise notice 'SUCESSO: pncp_fuso_documento_resultado_homologacao_check pncp % sest/fiesc/sesi_pe intactos %', v_depois, v_antes;
end $$;

rollback;
