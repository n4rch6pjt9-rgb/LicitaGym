-- Dados só para usuário logado: remove leitura anon das tabelas de referência
-- criadas em 20260920142857_compras_api_secao_legislacao.

DROP POLICY IF EXISTS compras_api_secoes_select ON public.compras_api_secoes;
CREATE POLICY compras_api_secoes_select ON public.compras_api_secoes
  FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS compras_api_secao_legislacao_select ON public.compras_api_secao_legislacao;
CREATE POLICY compras_api_secao_legislacao_select ON public.compras_api_secao_legislacao
  FOR SELECT TO authenticated USING (true);

REVOKE ALL ON public.compras_api_secoes FROM anon;
REVOKE ALL ON public.compras_api_secao_legislacao FROM anon;
