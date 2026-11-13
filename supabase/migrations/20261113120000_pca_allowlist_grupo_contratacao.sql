-- Corrige a lista de campos permitidos de private.pca_persistir_unidade_atomica para pca_itens (incidente de 12/11/2026).
--
-- Contexto (medido em produção em 13/11/2026, MCP somente leitura):
--   A spec 0056 (commit ce35ea9, migration 20261111200000_pca_impressao_eventos.sql) criou em public.pca_itens as
--   colunas grupo_contratacao_codigo, grupo_contratacao_nome e data_atualizacao_origem, e passou a mandá-las em
--   normalizePcaItem. A lista de campos permitidos da RPC (20261027231110_pca_persistencia_atomica.sql) não foi
--   atualizada: todo lote de itens falha com 22023 "Campo PCA fora da lista permitida".
--   Efeito: nenhum item de PCA gravado desde 12/11 06:40 UTC (último last_synced_at em pca_itens: 06/11);
--   195 planos em private.pca_plano_fila com status 'erro' (tentativas esgotadas) e 3 'pendente' com esse erro.
--
-- O que muda:
--   1. create or replace da função, idêntica à de 20261027231110 exceto pelos 3 campos acrescentados à lista de
--      pca_itens. Campos protegidos (id, created_at, ativo, descoberta_ausente, reprocessar) continuam barrados, e a
--      checagem de coluna existente em pg_attribute continua valendo. Mesma assinatura, SECURITY INVOKER,
--      search_path vazio, execução só por service_role (revoke/grant reaplicados).
--   2. Reabre na fila os planos que falharam por esse erro, no padrão de 20261111220000_pca_fila_reabrir_esgotados_0056:
--      status 'pendente', tentativas 0, disponivel_em e reserva_token nulos, erro com o rastro
--      "reaberto allowlist; antes: <erro anterior>" e chain_id fixo 00560000-0000-4000-8000-000000000057.
--      Só linhas cujo erro é desta causa e atualizadas desde 12/11 (início do incidente). Teto de 3000 linhas: em
--      13/11 eram 198, mas a continuação da carga (06–08 UTC) segue processando os 2.611 planos pendentes da
--      impressão até o merge, e cada um que falhar entra no corte; acima do teto a migration falha em vez de reabrir em
--      massa (a fila inteira tem cerca de 3.650 linhas). Rodar de novo não toca linha nenhuma: as reabertas já estão
--      em 'pendente' com tentativas 0.
--
-- Efeito esperado depois do merge: os itens dos planos passam a gravar com hash novo (os 3 campos entram no hash),
-- então os itens já existentes voltam como 'alterado'; o trigger de eventos da 0056 já ignora esses 3 campos na
-- classificação de mudança de negócio (não sai evento falso), mas public.pca_alteracoes ganha uma linha com o snapshot
-- completo por item reprocessado, uma única vez (6.330 itens em pca_itens em 13/11, mais os novos).
-- Corpo da função conferido em 13/11: md5(prosrc) em produção = corpo de 20261027231110 (d1e45c99ad0bb95e7133f961dc5bbcf3);
-- esta cópia não desfaz alteração feita fora do repositório.
--
-- Quem lê/escreve: só service_role (sync-pncp-pca via pca_persistir_lote_atomico).
-- Verificar: supabase/tests/pca_allowlist_grupo_contratacao_check.sql e, em produção,
--   select status, count(*) from private.pca_plano_fila
--    where chain_id = '00560000-0000-4000-8000-000000000057' group by 1;
begin;

set local lock_timeout = '10s';

CREATE OR REPLACE FUNCTION private.pca_persistir_unidade_atomica(
  p_tabela text,
  p_chave jsonb,
  p_linha jsonb,
  p_sync_run_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $function$
DECLARE
  v_tabela text;
  v_chave text;
  v_id uuid;
  v_atual jsonb;
  v_novo jsonb;
  v_payload jsonb;
  v_hash text;
  v_resultado text;
  v_reativacao boolean := false;
  v_colunas text;
  v_colunas_select text;
  v_colunas_update text;
  v_colunas_update_select text;
  v_filtro text;
  v_valor1 text;
  v_valor2 text;
  v_headers jsonb;
  v_run_header text;
BEGIN
  IF p_tabela NOT IN ('pca_planos', 'pca_itens')
     OR p_tabela IS NULL THEN
    RAISE EXCEPTION 'Tabela PCA não permitida'
      USING ERRCODE = '22023';
  END IF;

  IF p_chave IS NULL
     OR jsonb_typeof(p_chave) <> 'object'
     OR p_linha IS NULL
     OR jsonb_typeof(p_linha) <> 'object'
     OR p_sync_run_id IS NULL THEN
    RAISE EXCEPTION 'Argumentos PCA inválidos'
      USING ERRCODE = '22023';
  END IF;

  v_headers := COALESCE(
    NULLIF(current_setting('request.headers', true), '')::jsonb,
    '{}'::jsonb
  );

  v_run_header := v_headers ->> 'x-pca-run-id';

  IF v_run_header IS DISTINCT FROM p_sync_run_id::text THEN
    RAISE EXCEPTION 'Execução PCA não corresponde ao header'
      USING ERRCODE = '40001';
  END IF;

  PERFORM 1
  FROM private.pncp_sync_run
  WHERE id = p_sync_run_id
    AND resource_type = 'pca'
    AND status = 'executando'
  FOR SHARE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Execução PCA não está ativa'
      USING ERRCODE = '40001';
  END IF;

  IF p_tabela = 'pca_planos' THEN
    IF (SELECT count(*) FROM jsonb_object_keys(p_chave)) <> 1
       OR NOT (p_chave ? 'id_pca_pncp') THEN
      RAISE EXCEPTION 'Chave natural inválida para plano'
        USING ERRCODE = '22023';
    END IF;

    v_valor1 := p_chave ->> 'id_pca_pncp';

    IF NULLIF(v_valor1, '') IS NULL
       OR p_linha ->> 'id_pca_pncp' IS DISTINCT FROM v_valor1 THEN
      RAISE EXCEPTION 'Identificador do plano inconsistente'
        USING ERRCODE = '22023';
    END IF;

    v_filtro := 'id_pca_pncp = $1';
    v_chave := v_valor1;
  ELSE
    IF (SELECT count(*) FROM jsonb_object_keys(p_chave)) <> 2
       OR NOT (p_chave ? 'pca_plano_id')
       OR NOT (p_chave ? 'numero_item') THEN
      RAISE EXCEPTION 'Chave natural inválida para item'
        USING ERRCODE = '22023';
    END IF;

    v_valor1 := (p_chave ->> 'pca_plano_id')::uuid::text;
    v_valor2 := (p_chave ->> 'numero_item')::integer::text;

    IF p_linha ->> 'pca_plano_id' IS DISTINCT FROM v_valor1
       OR (p_linha ->> 'numero_item')::integer::text
          IS DISTINCT FROM v_valor2 THEN
      RAISE EXCEPTION 'Identificador do item inconsistente'
        USING ERRCODE = '22023';
    END IF;

    v_filtro := 'pca_plano_id = $1::uuid AND numero_item = $2::integer';
    v_chave := v_valor1 || ':' || v_valor2;
  END IF;

  v_hash := NULLIF(p_linha ->> 'payload_hash', '');

  IF v_hash IS NULL THEN
    RAISE EXCEPTION 'payload_hash obrigatório'
      USING ERRCODE = '22023';
  END IF;

  -- Bloqueio serializa escritores cooperativos da mesma chave.
  PERFORM pg_advisory_xact_lock(
    hashtextextended('pca:' || p_tabela || ':' || v_chave, 0)
  );

  -- Identidade e estado operacional não são controlados pelo payload.
  -- Campos de sincronização recebidos do TS serão sobrescritos abaixo.
  IF p_linha ?| ARRAY[
    'id', 'created_at', 'ativo',
    'descoberta_ausente', 'reprocessar'
  ] THEN
    RAISE EXCEPTION 'Campo PCA protegido no payload'
      USING ERRCODE = '22023';
  END IF;

  -- Somente campos explicitamente permitidos podem ser persistidos.
  -- A lista é separada por tabela para impedir escrita em colunas
  -- operacionais adicionadas futuramente.
  IF EXISTS (
    SELECT 1
    FROM jsonb_object_keys(p_linha) AS k(nome)
    WHERE NOT (
      CASE p_tabela
        WHEN 'pca_planos' THEN
          k.nome = ANY (ARRAY[
            'id_pca_pncp', 'ano_exercicio', 'orgao_cnpj',
            'unidade_codigo', 'numero_plano', 'titulo',
            'descricao', 'status', 'data_aprovacao',
            'data_publicacao', 'data_atualizacao_origem',
            'url_origem', 'payload_hash',
            'updated_at', 'last_synced_at', 'last_seen_sync_id'
          ])
        WHEN 'pca_itens' THEN
          k.nome = ANY (ARRAY[
            'pca_plano_id', 'numero_item', 'descricao',
            'categoria', 'classe_material_servico',
            'codigo_classe_catmat', 'classificacao_catalogo_id',
            'pdm_codigo_origem', 'codigo_item_origem',
            'quantidade', 'unidade_medida',
            'valor_unitario_estimado', 'valor_total_estimado',
            'data_prevista_contratacao', 'prioridade',
            'status', 'payload_hash',
            'updated_at', 'last_synced_at', 'last_seen_sync_id',
            -- Spec 0056 (20261111200000_pca_impressao_eventos.sql): literal do DTO e data da fonte.
            'grupo_contratacao_codigo', 'grupo_contratacao_nome',
            'data_atualizacao_origem'
          ])
        ELSE false
      END
    )
  ) THEN
    RAISE EXCEPTION 'Campo PCA fora da lista permitida'
      USING ERRCODE = '22023';
  END IF;

  -- Evita colunas desconhecidas ou pertencentes a outra tabela.
  IF EXISTS (
    SELECT 1
    FROM jsonb_object_keys(p_linha) AS k(nome)
    WHERE NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_attribute a
      WHERE a.attrelid = format('public.%I', p_tabela)::regclass
        AND a.attname = k.nome
        AND a.attnum > 0
        AND NOT a.attisdropped
    )
  ) THEN
    RAISE EXCEPTION 'Payload contém coluna PCA desconhecida'
      USING ERRCODE = '22023';
  END IF;

  v_tabela := format('public.%I', p_tabela);

  -- Metadados controlados pelo servidor.
  v_payload := p_linha || jsonb_build_object(
    'last_synced_at', now(),
    'last_seen_sync_id', p_sync_run_id,
    'updated_at', now()
  );

  IF p_tabela = 'pca_planos' THEN
    EXECUTE format(
      'SELECT to_jsonb(t) FROM %s t WHERE %s FOR UPDATE',
      v_tabela, v_filtro
    )
    INTO v_atual
    USING v_valor1;
  ELSE
    EXECUTE format(
      'SELECT to_jsonb(t) FROM %s t WHERE %s FOR UPDATE',
      v_tabela, v_filtro
    )
    INTO v_atual
    USING v_valor1, v_valor2;
  END IF;

  SELECT
    string_agg(format('%I', k.nome), ', ' ORDER BY k.nome),
    string_agg(format('%I', k.nome), ', ' ORDER BY k.nome)
  INTO v_colunas, v_colunas_select
  FROM jsonb_object_keys(v_payload) AS k(nome);

  IF v_atual IS NULL THEN
    EXECUTE format(
      'INSERT INTO %s (%s)
       SELECT %s
       FROM jsonb_populate_record(NULL::%s, $1)
       RETURNING id',
      v_tabela, v_colunas, v_colunas_select, v_tabela
    )
    INTO v_id
    USING v_payload;

    v_resultado := 'novo';
  ELSE
    v_id := (v_atual ->> 'id')::uuid;

    v_reativacao := COALESCE((v_atual ->> 'ativo')::boolean, false) = false;

    IF v_atual ->> 'payload_hash' = v_hash THEN
      EXECUTE format(
        'UPDATE %s
         SET last_synced_at = now(),
             last_seen_sync_id = $1,
             ativo = true
         WHERE id = $2',
        v_tabela
      )
      USING p_sync_run_id, v_id;

      IF NOT v_reativacao THEN
        RETURN jsonb_build_object(
          'id', v_id,
          'resultado', 'inalterado'
        );
      END IF;

      v_resultado := 'alterado';
    ELSE
    SELECT
      string_agg(format('%I', k.nome), ', ' ORDER BY k.nome),
      string_agg(format('%I', k.nome), ', ' ORDER BY k.nome)
    INTO v_colunas_update, v_colunas_update_select
    FROM jsonb_object_keys(v_payload) AS k(nome)
    WHERE k.nome NOT IN (
      'id_pca_pncp', 'pca_plano_id', 'numero_item'
    );

    EXECUTE format(
      'UPDATE %s
       SET (%s) = (
         SELECT %s
         FROM jsonb_populate_record(NULL::%s, $1)
       ),
       ativo = true
       WHERE id = $2',
      v_tabela,
      v_colunas_update,
      v_colunas_update_select,
      v_tabela
    )
    USING v_payload, v_id;

    v_resultado := 'alterado';
    END IF;
  END IF;

  -- Snapshot completo do estado efetivamente persistido.
  EXECUTE format(
    'SELECT to_jsonb(t) FROM %s t WHERE id = $1',
    v_tabela
  )
  INTO v_novo
  USING v_id;

  IF v_novo IS NULL THEN
    RAISE EXCEPTION 'Estado PCA não encontrado após persistência'
      USING ERRCODE = 'P0002';
  END IF;

  -- O erro desta inserção aborta também a alteração principal.
  IF p_tabela = 'pca_planos' THEN
    INSERT INTO public.pca_alteracoes (
      pca_plano_id,
      tipo_operacao,
      dados_anteriores,
      dados_novos,
      payload_hash_anterior,
      payload_hash_novo,
      sync_run_id
    )
    VALUES (
      v_id,
      CASE
        WHEN v_resultado = 'novo' THEN 'insert'
        WHEN v_reativacao THEN 'reativacao'
        ELSE 'update'
      END,
      v_atual,
      v_novo,
      v_atual ->> 'payload_hash',
      v_hash,
      p_sync_run_id
    );
  ELSE
    INSERT INTO public.pca_alteracoes (
      pca_plano_id,
      pca_item_id,
      tipo_operacao,
      dados_anteriores,
      dados_novos,
      payload_hash_anterior,
      payload_hash_novo,
      sync_run_id
    )
    VALUES (
      v_valor1::uuid,
      v_id,
      CASE
        WHEN v_resultado = 'novo' THEN 'insert'
        WHEN v_reativacao THEN 'reativacao'
        ELSE 'update'
      END,
      v_atual,
      v_novo,
      v_atual ->> 'payload_hash',
      v_hash,
      p_sync_run_id
    );
  END IF;

  RETURN jsonb_build_object(
    'id', v_id,
    'resultado', v_resultado
  );
END;
$function$;

REVOKE ALL ON FUNCTION private.pca_persistir_unidade_atomica(
  text, jsonb, jsonb, uuid
) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION private.pca_persistir_unidade_atomica(
  text, jsonb, jsonb, uuid
) TO service_role;


-- Reabertura dos planos que falharam pela lista de campos (ver cabeçalho).
do $reabrir$
declare
  v_n integer;
begin
  update private.pca_plano_fila
     set status = 'pendente',
         tentativas = 0,
         erro = left('reaberto allowlist; antes: ' || coalesce(erro, ''), 500),
         disponivel_em = null,
         reserva_token = null,
         chain_id = '00560000-0000-4000-8000-000000000057'::uuid,
         atualizado_em = now()
   where status in ('erro', 'pendente')
     and erro like '%Campo PCA fora da lista permitida%'
     and atualizado_em >= timestamptz '2026-11-12 00:00:00+00'
     and erro not like 'reaberto allowlist; antes: %';
  get diagnostics v_n = row_count;
  if v_n > 3000 then
    raise exception 'reabertura allowlist: % linhas, acima do teto de 3000; nada foi reaberto', v_n;
  end if;
  raise notice 'reabertura allowlist: % linha(s) reaberta(s)', v_n;
end;
$reabrir$;

commit;
