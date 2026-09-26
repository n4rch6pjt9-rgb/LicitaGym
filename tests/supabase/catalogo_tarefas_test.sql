-- Testes do catálogo de tarefas (Lei 14.133). Rodar depois das migrations:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f tests/supabase/catalogo_tarefas_test.sql
-- Cada bloco falha com exceção se a regra quebrar.

do $$
declare n int;
begin
  -- 1. toda tarefa ativa tem base legal
  select count(*) into n from public.tarefas_catalogo t
   where t.ativo and not exists (select 1 from public.tarefas_catalogo_base_legal b where b.tarefa_codigo = t.codigo);
  if n > 0 then raise exception 'tarefas sem base legal: %', n; end if;

  -- 2. prazos em dias úteis citam evento de referência
  select count(*) into n from public.tarefas_catalogo
   where prazo_unidade in ('dias_uteis','dias_corridos','meses','anos') and prazo_evento is null;
  if n > 0 then raise exception 'prazo contável sem evento: %', n; end if;

  -- 3. filha nunca é mais permissiva que a mãe (condição da mãe contida na da filha)
  select count(*) into n from public.tarefas_catalogo f join public.tarefas_catalogo m on m.codigo = f.parent_codigo
   where not (f.condicao @> m.condicao);
  if n > 0 then raise exception 'filhas sem a condição da mãe: %', n; end if;

  -- 4. condição: false diverge, null falta dado, true bate
  if public.catalogo_condicao_avaliar('{"objeto":["obra_engenharia"]}', '{"objeto":"bens"}') is not false then
    raise exception 'condição divergente deveria ser false'; end if;
  if public.catalogo_condicao_avaliar('{"srp":true}', '{}') is not null then
    raise exception 'condição sem dado deveria ser null (não verificada)'; end if;
  if public.catalogo_condicao_avaliar('{"srp":true}', '{"srp":true}') is not true then
    raise exception 'condição igual deveria ser true'; end if;

  -- 5. sem inversão: ata de habilitação libera intenção de recurso (imediata) e vista
  select count(*) into n from public.catalogo_tarefas_do_evento('ATA_HABILITACAO', '{"inversao_fases":false}')
   where codigo in ('14133-F05-T01','14133-F05-T03') and aplicavel;
  if n <> 2 then raise exception 'ATA_HABILITACAO deveria liberar F05-T01 e F05-T03, liberou %', n; end if;

  -- 6. com inversão: intenção abre no resultado do julgamento, não na ata de habilitação
  select count(*) into n from public.catalogo_tarefas_do_evento('ATA_HABILITACAO', '{"inversao_fases":true}')
   where codigo = '14133-F05-T01';
  if n <> 0 then raise exception 'com inversão, F05-T01 não deveria abrir na ata de habilitação'; end if;
  select count(*) into n from public.catalogo_tarefas_do_evento('RESULTADO_JULGAMENTO', '{"inversao_fases":true}')
   where codigo = '14133-F05-T06' and aplicavel;
  if n <> 1 then raise exception 'com inversão, F05-T06 deveria abrir no resultado do julgamento'; end if;

  -- 7. prazos legais-chave (regressão)
  perform 1 from public.tarefas_catalogo where codigo = '14133-F01-T04'
     and prazo_quantidade = 3 and prazo_unidade = 'dias_uteis' and prazo_sentido = 'antes_de' and prazo_evento = 'DATA_ABERTURA';
  if not found then raise exception 'impugnação: 3 dias úteis antes da abertura (art. 164)'; end if;
  perform 1 from public.tarefas_catalogo where codigo = '14133-F05-T04' and prazo_quantidade = 3;
  if not found then raise exception 'contrarrazões: 3 dias úteis (art. 165 § 4º)'; end if;
  perform 1 from public.tarefas_catalogo where codigo = '14133-F11-T04' and prazo_quantidade = 15;
  if not found then raise exception 'recurso de sanção: 15 dias úteis (art. 166)'; end if;

  -- 8. remanescente não recebe tarefas exclusivas do vencedor
  select count(*) into n from public.catalogo_tarefas_da_fase('F07', '{"posicao":"remanescente"}')
   where codigo in ('14133-F07-T01','14133-F07-T02');
  if n <> 0 then raise exception 'remanescente recebeu tarefa do vencedor'; end if;

  -- 9. transições com inversão levam F01 -> F04
  perform 1 from public.processo_fase_transicoes
   where fase_origem = 'F01' and fase_destino = 'F04'
     and public.catalogo_condicao_avaliar(condicao, '{"inversao_fases":true}');
  if not found then raise exception 'transição F01->F04 com inversão ausente'; end if;

  raise notice 'catalogo_tarefas_test: OK';
end $$;
