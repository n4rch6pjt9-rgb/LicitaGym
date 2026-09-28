-- Recuperado de supabase_migrations.schema_migrations em 2026-09-28 (aplicado no remoto sem arquivo no repo).
-- Nao reaplicar: versao ja registrada como aplicada.

INSERT INTO public.legislacao_fontes (nome, url, tipo_fonte)
VALUES
  (
    'Legislação Compras.gov.br',
    'https://www.gov.br/compras/pt-br/acesso-a-informacao/legislacao',
    'pagina_indice'
  ),
  (
    'Planalto — legislação federal',
    'https://www.planalto.gov.br/ccivil_03/',
    'pagina_indice'
  )
ON CONFLICT (url) DO NOTHING;

INSERT INTO public.legislacao_documentos (
  tipo_norma, numero, ano, titulo, orgao_emissor,
  status, url_oficial, url_canonica, fonte_id
)
SELECT v.tipo_norma, v.numero, v.ano, v.titulo, v.orgao_emissor,
       v.status, v.url_oficial, v.url_canonica, f.id
FROM (
  VALUES
    (
      'lei'::text, '14133'::text, 2021,
      'Lei nº 14.133/2021 - Licitações e Contratos Administrativos'::text,
      'Presidência da República'::text, 'vigente'::text,
      'https://www.planalto.gov.br/ccivil_03/_ato2019-2022/2021/lei/l14133.htm'::text,
      'https://www.planalto.gov.br/ccivil_03/_ato2019-2022/2021/lei/l14133.htm'::text
    ),
    (
      'lei', '8666', 1993,
      'Lei nº 8.666/1993 - Licitações e Contratos (legado)',
      'Presidência da República', 'vigente',
      'https://www.planalto.gov.br/ccivil_03/leis/l8666cons.htm',
      'https://www.planalto.gov.br/ccivil_03/leis/l8666cons.htm'
    ),
    (
      'lei_complementar', '123', 2006,
      'Lei Complementar nº 123/2006 - Microempresas e EPP',
      'Presidência da República', 'vigente',
      'https://www.planalto.gov.br/ccivil_03/leis/lcp/lcp123.htm',
      'https://www.planalto.gov.br/ccivil_03/leis/lcp/lcp123.htm'
    ),
    (
      'lei', '12527', 2011,
      'Lei nº 12.527/2011 - Lei de Acesso à Informação',
      'Presidência da República', 'vigente',
      'https://www.planalto.gov.br/ccivil_03/_ato2011-2014/2011/lei/l12527.htm',
      'https://www.planalto.gov.br/ccivil_03/_ato2011-2014/2011/lei/l12527.htm'
    ),
    (
      'lei', '13709', 2018,
      'Lei nº 13.709/2018 - LGPD',
      'Presidência da República', 'vigente',
      'https://www.planalto.gov.br/ccivil_03/_ato2015-2018/2018/lei/l13709.htm',
      'https://www.planalto.gov.br/ccivil_03/_ato2015-2018/2018/lei/l13709.htm'
    ),
    (
      'decreto', '10947', 2022,
      'Decreto nº 10.947/2022 - Plano de Contratações Anual',
      'Presidência da República', 'vigente',
      'https://www.planalto.gov.br/ccivil_03/_ato2019-2022/2022/decreto/d10947.htm',
      'https://www.planalto.gov.br/ccivil_03/_ato2019-2022/2022/decreto/d10947.htm'
    ),
    (
      'decreto', '11462', 2023,
      'Decreto nº 11.462/2023 - Sistema de Registro de Preços',
      'Presidência da República', 'vigente',
      'https://www.planalto.gov.br/ccivil_03/_ato2023-2026/2023/decreto/d11462.htm',
      'https://www.planalto.gov.br/ccivil_03/_ato2023-2026/2023/decreto/d11462.htm'
    ),
    (
      'decreto', '12807', 2025,
      'Decreto nº 12.807/2025 - Valores vigentes Lei 14.133',
      'Presidência da República', 'vigente',
      'https://www.planalto.gov.br/ccivil_03/_ato2023-2026/2025/decreto/d12807.htm',
      'https://www.planalto.gov.br/ccivil_03/_ato2023-2026/2025/decreto/d12807.htm'
    ),
    (
      'instrucao_normativa', '65', 2021,
      'IN SEGES/ME nº 65/2021 - Pesquisa de preços',
      'SEGES/ME', 'vigente',
      'https://www.gov.br/compras/pt-br/acesso-a-informacao/legislacao/instrucoes-normativas/instrucao-normativa-seges-me-no-65-de-7-de-julho-de-2021',
      'https://www.gov.br/compras/pt-br/acesso-a-informacao/legislacao/instrucoes-normativas/instrucao-normativa-seges-me-no-65-de-7-de-julho-de-2021'
    ),
    (
      'instrucao_normativa', '81', 2022,
      'IN SEGES/ME nº 81/2022 - Termo de Referência',
      'SEGES/ME', 'vigente',
      'https://www.gov.br/compras/pt-br/acesso-a-informacao/legislacao/instrucoes-normativas/instrucao-normativa-seges-me-no-81-de-25-de-novembro-de-2022',
      'https://www.gov.br/compras/pt-br/acesso-a-informacao/legislacao/instrucoes-normativas/instrucao-normativa-seges-me-no-81-de-25-de-novembro-de-2022'
    ),
    (
      'instrucao_normativa', '73', 2022,
      'IN SEGES/ME nº 73/2022 - Menor preço ou maior desconto',
      'SEGES/ME', 'vigente',
      'https://www.gov.br/compras/pt-br/acesso-a-informacao/legislacao/instrucoes-normativas/instrucao-normativa-seges-me-no-73-de-30-de-setembro-de-2022',
      'https://www.gov.br/compras/pt-br/acesso-a-informacao/legislacao/instrucoes-normativas/instrucao-normativa-seges-me-no-73-de-30-de-setembro-de-2022'
    )
) AS v(tipo_norma, numero, ano, titulo, orgao_emissor, status, url_oficial, url_canonica)
LEFT JOIN public.legislacao_fontes f
  ON f.url = CASE
    WHEN v.url_canonica LIKE 'https://www.planalto.gov.br%'
      THEN 'https://www.planalto.gov.br/ccivil_03/'
    ELSE 'https://www.gov.br/compras/pt-br/acesso-a-informacao/legislacao'
  END
ON CONFLICT (url_canonica) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.compras_api_secoes (
  codigo text PRIMARY KEY,
  nome text NOT NULL,
  descricao text,
  path_prefix text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.compras_api_secao_legislacao (
  secao_codigo text NOT NULL REFERENCES public.compras_api_secoes(codigo) ON DELETE CASCADE,
  documento_id uuid NOT NULL REFERENCES public.legislacao_documentos(id) ON DELETE CASCADE,
  papel text NOT NULL CHECK (papel IN ('rege', 'referencia', 'historico')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (secao_codigo, documento_id)
);

CREATE INDEX IF NOT EXISTS compras_api_secao_legislacao_doc_idx
  ON public.compras_api_secao_legislacao (documento_id);

ALTER TABLE public.compras_api_secoes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.compras_api_secao_legislacao ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS compras_api_secoes_select ON public.compras_api_secoes;
CREATE POLICY compras_api_secoes_select ON public.compras_api_secoes
  FOR SELECT TO authenticated, anon USING (true);

DROP POLICY IF EXISTS compras_api_secao_legislacao_select ON public.compras_api_secao_legislacao;
CREATE POLICY compras_api_secao_legislacao_select ON public.compras_api_secao_legislacao
  FOR SELECT TO authenticated, anon USING (true);

INSERT INTO public.compras_api_secoes (codigo, nome, descricao, path_prefix) VALUES
  ('01', 'CATÁLOGO — MATERIAL', 'Catálogo de Materiais (CATMAT)', '/modulo-material/'),
  ('03', 'PESQUISA DE PREÇO', 'Preços praticados nas compras públicas', '/modulo-pesquisa-preco/'),
  ('04', 'PGC', 'Planejamento e Gerenciamento de Contratações', '/modulo-pgc/'),
  ('05', 'UASG', 'Unidades Administrativas de Serviços Gerais', '/modulo-uasg/'),
  ('06', 'LEGADO', 'Licitações sob a Lei nº 8.666/1993 e anteriores à 14.133/2021', '/modulo-legado/'),
  ('07', 'CONTRATAÇÕES', 'Contratações sob a Lei nº 14.133/2021', '/modulo-contratacoes/'),
  ('08', 'ARP', 'Atas de Registro de Preços', '/modulo-arp/'),
  ('09', 'CONTRATOS', 'Contratos e itens', '/modulo-contratos/'),
  ('10', 'FORNECEDOR', 'Fornecedores registrados', '/modulo-fornecedor/'),
  ('11', 'OCDS', 'Contratações no formato OCDS', '/modulo-ocds/'),
  ('97', 'INDICADORES', 'Indicadores de uso e desempenho da API Compras V2', NULL),
  ('98', 'ALICE', 'Integração Analisador de Licitações (Alice)', NULL),
  ('99', 'USUARIOS', 'Gestão de usuários — fora do escopo de ingestão', NULL),
  ('AUTENTICACAO', 'AUTENTICACAO', 'Serviço de autenticação de usuários', NULL)
ON CONFLICT (codigo) DO UPDATE SET
  nome = EXCLUDED.nome,
  descricao = EXCLUDED.descricao,
  path_prefix = EXCLUDED.path_prefix;

INSERT INTO public.compras_api_secao_legislacao (secao_codigo, documento_id, papel)
SELECT s.secao_codigo, d.id, s.papel
FROM (
  VALUES
    ('03'::text, 'https://www.gov.br/compras/pt-br/acesso-a-informacao/legislacao/instrucoes-normativas/instrucao-normativa-seges-me-no-65-de-7-de-julho-de-2021'::text, 'referencia'::text),
    ('04', 'https://www.planalto.gov.br/ccivil_03/_ato2019-2022/2022/decreto/d10947.htm', 'referencia'),
    ('06', 'https://www.planalto.gov.br/ccivil_03/leis/l8666cons.htm', 'rege'),
    ('07', 'https://www.planalto.gov.br/ccivil_03/_ato2019-2022/2021/lei/l14133.htm', 'rege'),
    ('08', 'https://www.planalto.gov.br/ccivil_03/_ato2023-2026/2023/decreto/d11462.htm', 'rege'),
    ('09', 'https://www.planalto.gov.br/ccivil_03/_ato2019-2022/2021/lei/l14133.htm', 'rege')
) AS s(secao_codigo, url_canonica, papel)
JOIN public.legislacao_documentos d ON d.url_canonica = s.url_canonica
ON CONFLICT (secao_codigo, documento_id) DO UPDATE SET papel = EXCLUDED.papel;

COMMENT ON TABLE public.compras_api_secoes IS
  'Seções/módulos da API Dados Abertos Compras.gov.br (smoke + documentação).';
COMMENT ON TABLE public.compras_api_secao_legislacao IS
  'Cruzamento seção API ↔ legislacao_documentos (papel: rege|referencia|historico).';
