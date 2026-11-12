-- portal_visitante: visitante por CPF guardado só como HMAC (12/11/2026).
--
-- Contexto: o cadastro de visitante nos portais Paradigma passa a aceitar CPF + nome de uma pessoa, além do CNPJ
-- da empresa (decisão do Marcelo, PR #533). O código do visitante no portal (n_cd_visitante) é guardado por fonte
-- para não criar um cadastro novo a cada execução. CPF é dado pessoal: em vez do documento, a linha guarda o
-- HMAC-SHA256 do CPF, cuja chave (VISITANTE_HASH_CHAVE) fica só no secret do coletor, nunca no banco.
--
-- O que muda (aditivo; a tabela estava vazia em produção em 12/11/2026):
--   * tipo_documento ('CNPJ' | 'CPF'), padrão 'CNPJ' (linhas antigas continuam válidas);
--   * documento_hash (64 hex) para CPF;
--   * cnpj deixa de ser obrigatório (CPF não tem cnpj); a regra de 14 dígitos continua valendo quando preenchido;
--   * constraint: linha CNPJ tem cnpj e não tem hash; linha CPF tem hash e não tem cnpj.
-- Quem lê/escreve: só o coletor (service_role), por documentos_paradigma.py. RLS ligada e sem policy, como antes.
-- Verificar: supabase/tests/portal_visitante_cpf_check.sql.
-- Volta: apagar as linhas CPF, recolocar not null em cnpj e remover as duas colunas e a constraint.
begin;

alter table public.portal_visitante add column if not exists tipo_documento text not null default 'CNPJ';
alter table public.portal_visitante add column if not exists documento_hash text;
alter table public.portal_visitante alter column cnpj drop not null;

do $$
begin
  if not exists (select 1 from pg_constraint
                  where conname = 'portal_visitante_documento_ck'
                    and conrelid = 'public.portal_visitante'::regclass) then
    alter table public.portal_visitante add constraint portal_visitante_documento_ck check (
      (tipo_documento = 'CNPJ' and cnpj is not null and documento_hash is null)
      or (tipo_documento = 'CPF' and cnpj is null and documento_hash ~ '^[0-9a-f]{64}$')
    );
  end if;
end $$;

comment on column public.portal_visitante.tipo_documento is
  'Documento do visitante no portal: CNPJ (empresa) ou CPF (pessoa).';
comment on column public.portal_visitante.documento_hash is
  'Só para CPF: HMAC-SHA256 do CPF com a chave VISITANTE_HASH_CHAVE do coletor. O CPF em claro nunca é gravado.';

alter table public.portal_visitante enable row level security;
revoke all on table public.portal_visitante from anon, authenticated, public;

commit;
