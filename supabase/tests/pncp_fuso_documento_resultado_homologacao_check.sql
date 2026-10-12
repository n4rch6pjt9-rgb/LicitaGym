-- Regressão da #339: +3 h uma vez, e a segunda chamada não soma de novo.
-- Dados fictícios. begin/rollback. Aborta se licitacoes_externas tiver mais de 100 linhas.
-- Antes: 2026-10-08 10:00+00 (Brasília rotulado como UTC). Depois: o mesmo instante + 3 h.

begin;

do $$
declare
  v_qtd int;
  v_lic bigint;
  v_doc bigint;
  v_res bigint;
  v_antes timestamptz := timestamptz '2026-10-08 10:00+00';
  v_depois timestamptz := timestamptz '2026-10-08 10:00+00' + interval '3 hours';
  v_n bigint;
  v_doc_em timestamptz;
  v_res_em timestamptz;
  v_hom_em timestamptz;
begin
  select count(*) into v_qtd from public.licitacoes_externas;
  if v_qtd > 100 then
    raise exception 'TRAVA DE SEGURANCA: licitacoes_externas contem % linhas (> 100). Abortando para proteger producao.', v_qtd;
  end if;

  insert into public.fontes_externas (slug, entidade, plataforma, base_url, modo_coleta)
  values ('pncp', 'PNCP', 'pncp', 'https://pncp.gov.br', 'automatico')
  on conflict (slug) do nothing;

  insert into public.licitacoes_externas (fonte, modulo, id_externo, codigo_externo, data_homologacao)
  values ('pncp', 1, 900339, '00000000000339-1-000339/2026', v_antes)
  returning id into v_lic;

  insert into public.licitacao_documentos (licitacao_id, secao, arquivo_origem, data_documento)
  values (v_lic, 'processo', 'pncp-339', v_antes)
  returning id into v_doc;

  insert into public.licitacao_resultados (licitacao_id, numero_item, sequencial_resultado, data_resultado)
  values (v_lic, 1, 1, v_antes)
  returning id into v_res;

  select coalesce(sum(c.corrigidas), 0) into v_n
    from private.corrigir_fuso_pncp_339() c
   where c.relacao in ('licitacao_documentos', 'licitacao_resultados', 'licitacoes_externas');

  select d.data_documento into v_doc_em from public.licitacao_documentos d where d.id = v_doc;
  select r.data_resultado into v_res_em from public.licitacao_resultados r where r.id = v_res;
  select l.data_homologacao into v_hom_em from public.licitacoes_externas l where l.id = v_lic;

  if v_doc_em is distinct from v_depois or v_res_em is distinct from v_depois or v_hom_em is distinct from v_depois then
    raise exception 'pncp_fuso_339: esperado %, documento % resultado % homologacao %', v_depois, v_doc_em, v_res_em, v_hom_em;
  end if;
  if v_n < 3 then
    raise exception 'pncp_fuso_339: a primeira chamada corrigiu % linhas das tres de teste (esperado ao menos 3)', v_n;
  end if;

  select coalesce(sum(c.corrigidas), 0) into v_n from private.corrigir_fuso_pncp_339() c;
  select d.data_documento into v_doc_em from public.licitacao_documentos d where d.id = v_doc;
  if v_n <> 0 or v_doc_em is distinct from v_depois then
    raise exception 'pncp_fuso_339: a segunda chamada corrigiu % e o documento ficou %', v_n, v_doc_em;
  end if;

  raise notice 'SUCESSO: pncp_fuso_documento_resultado_homologacao_check antes % depois %', v_antes, v_depois;
end $$;

rollback;
