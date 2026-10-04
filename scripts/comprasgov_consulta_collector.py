#!/usr/bin/env python3
"""
Compras.gov.br Consulta Collector
Extrai dados via 77 endpoints com segurança, rastreabilidade e retry.

Padrão:
- Máx 3 requisições paralelas
- 500ms delay entre lotes
- Retry exponencial (3x) com backoff
- Timeout 30s por requisição
- Logging detalhado

Uso:
    python3 scripts/comprasgov_consulta_collector.py --modulo 01-PCA
    python3 scripts/comprasgov_consulta_collector.py --data-inicio 2026-09-01 --data-fim 2026-09-30
"""

import json
import sys
import time
import asyncio
import logging
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any, Optional, Dict, List
from urllib.parse import urlencode
from dataclasses import dataclass, asdict

from scripts.lib.http_client import (
    HttpClient,
    HttpFetchError,
    clamp_compras_gov_page_size,
    is_legacy_empty_on_error_enabled,
)
from scripts.lib.paginacao import acao_pagina
from scripts.lib.sync_state import SyncStateManager, is_sync_resume_enabled

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s"
)
logger = logging.getLogger(__name__)

BASE_URL = "https://dadosabertos.compras.gov.br"
MAX_PARALELO = 3
DELAY_ENTRE_LOTES_MS = 500
TIMEOUT_REQUISICAO = 30
MAX_RETRIES = 3

@dataclass
class EndpointConsulta:
    """Definição de um endpoint de consulta"""
    modulo: str
    nome: str
    metodo: str
    path: str
    parametros: Dict[str, Dict[str, Any]]
    temPaginacao: bool
    temVarianteCsv: bool
    descricao: Optional[str] = None

@dataclass
class ConsultaResultado:
    """Resultado de uma consulta"""
    endpoint: str
    modulo: str
    sucesso: bool
    registrosTotais: int
    registrosProcessados: int
    erros: List[str]
    tempoMs: int
    dataExecucao: str
    tentativas: int

class ConsultaComprasGovCollector:
    """Collector seguro para 77 endpoints do Compras.gov.br"""

    def __init__(self, schema_path: Optional[str] = None):
        self.catalogo: Dict[str, EndpointConsulta] = {}
        self.resultados: List[ConsultaResultado] = []
        self.session: Optional[Any] = None
        self.client = HttpClient(
            timeout=TIMEOUT_REQUISICAO,
            max_retries=MAX_RETRIES,
            user_agent="LicitaGym/1.0 (+https://licitagym.com)",
        )

        if schema_path:
            self.carrega_schema(schema_path)
        else:
            self.inicializa_catlogo_placeholder()

    def inicializa_catlogo_placeholder(self):
        """Placeholder enquanto schema JSON não chegar"""
        logger.warning("Schema JSON não fornecido. Usando placeholder vazio.")

    def carrega_schema(self, caminho: str):
        """Carrega endpoints do schema JSON (suporta formato 'endpoints' e formato 'modulos')"""
        try:
            with open(caminho, 'r', encoding='utf-8') as f:
                schema = json.load(f)

            if 'endpoints' in schema:
                for ep_dict in schema['endpoints']:
                    ep = EndpointConsulta(**ep_dict)
                    self.catalogo[ep.nome] = ep
            elif 'modulos' in schema:
                for mod in schema['modulos']:
                    mod_nome = mod.get('modulo', 'desconhecido')
                    for ep_dict in mod.get('endpoints', []):
                        nome = ep_dict.get('operationId') or ep_dict.get('nome') or ep_dict.get('path')
                        ep = EndpointConsulta(
                            modulo=mod_nome,
                            nome=nome,
                            metodo=ep_dict.get('metodo', 'GET'),
                            path=ep_dict.get('path', ''),
                            parametros=ep_dict.get('parametros', {}),
                            temPaginacao=ep_dict.get('temPaginacao', True),
                            temVarianteCsv=ep_dict.get('variante_csv', False),
                            descricao=ep_dict.get('summary') or ep_dict.get('descricao'),
                        )
                        self.catalogo[ep.nome] = ep
            else:
                logger.error("Schema JSON inválido: falta 'endpoints' ou 'modulos'")
                return

            logger.info(f"Schema carregado: {len(self.catalogo)} endpoints")
        except Exception as e:
            logger.error(f"Erro ao carregar schema: {e}")

    async def consultar_endpoint(
        self,
        nome_endpoint: str,
        opcoes: Optional[Dict[str, Any]] = None,
    ) -> ConsultaResultado:
        """Consulta um endpoint com retry automático via HttpClient"""

        inicio = time.time()

        endpoint = self.catalogo.get(nome_endpoint)
        if not endpoint:
            return ConsultaResultado(
                endpoint=nome_endpoint,
                modulo="desconhecido",
                sucesso=False,
                registrosTotais=0,
                registrosProcessados=0,
                erros=[f"Endpoint não encontrado: {nome_endpoint}"],
                tempoMs=int((time.time() - inicio) * 1000),
                dataExecucao=datetime.now().isoformat(),
                tentativas=0,
            )

        try:
            resultado = await self._faz_requisicao(endpoint, opcoes or {})
            resultado.tempoMs = int((time.time() - inicio) * 1000)
            resultado.dataExecucao = datetime.now().isoformat()
            return resultado
        except HttpFetchError as e:
            if e.status_code == 404:
                logger.warning(f"HTTP 404 na consulta {nome_endpoint}; não é fim de coleta: {e}")
            else:
                logger.warning(f"Falha na consulta {nome_endpoint}: {e}")
            return ConsultaResultado(
                endpoint=nome_endpoint,
                modulo=endpoint.modulo,
                sucesso=False,
                registrosTotais=0,
                registrosProcessados=0,
                erros=[f"Falha após {e.attempts} tentativa(s): {e}"],
                tempoMs=int((time.time() - inicio) * 1000),
                dataExecucao=datetime.now().isoformat(),
                tentativas=e.attempts,
            )
        except Exception as e:
            logger.error(f"Erro inesperado na consulta {nome_endpoint}: {e}")
            return ConsultaResultado(
                endpoint=nome_endpoint,
                modulo=endpoint.modulo,
                sucesso=False,
                registrosTotais=0,
                registrosProcessados=0,
                erros=[f"Erro inesperado: {e}"],
                tempoMs=int((time.time() - inicio) * 1000),
                dataExecucao=datetime.now().isoformat(),
                tentativas=1,
            )

    async def _faz_requisicao(
        self,
        endpoint: EndpointConsulta,
        opcoes: Dict[str, Any],
    ) -> ConsultaResultado:
        """Faz requisição HTTP para um endpoint usando o HttpClient compartilhado"""

        opcoes = self._com_tamanho_pagina(endpoint, opcoes)
        tamanho = opcoes.get("pageSize") or opcoes.get("tamanhoPagina") or clamp_compras_gov_page_size(None)
        pagina = int(opcoes.get("pagina") or 1)
        acumulado: List[Any] = []
        vistos: set[str] = set()
        lidos = 0
        loop = asyncio.get_running_loop()

        while True:
            op = dict(opcoes)
            op["pagina"] = pagina
            url = self._monta_url(endpoint, op)
            dados = await loop.run_in_executor(
                None,
                lambda url=url: self.client.fetch_json(
                    url=url,
                    timeout=TIMEOUT_REQUISICAO,
                    max_retries=MAX_RETRIES,
                    raise_for_status=True,
                    legacy_empty_envelope_key="resultado",
                ),
            )
            registros, corpo = self._registros_e_corpo(dados)
            if registros is None:
                logger.warning(
                    "consulta %s página %s: resposta inesperada; não é fim de coleta",
                    endpoint.nome, pagina,
                )
                return ConsultaResultado(
                    endpoint=endpoint.nome,
                    modulo=endpoint.modulo,
                    sucesso=False,
                    registrosTotais=len(acumulado),
                    registrosProcessados=len(acumulado),
                    erros=["resposta inesperada; não é fim de coleta"],
                    tempoMs=0,
                    dataExecucao=datetime.now().isoformat(),
                    tentativas=1,
                )
            parar, incluir = acao_pagina(
                registros, corpo, tamanho=int(tamanho), pagina=pagina, vistos=vistos, logger=logger,
                ja_lidos=lidos,
            )
            if incluir:
                lidos += len(registros)
                acumulado.extend(registros)
            if not incluir:
                return ConsultaResultado(
                    endpoint=endpoint.nome,
                    modulo=endpoint.modulo,
                    sucesso=False,
                    registrosTotais=len(acumulado),
                    registrosProcessados=len(acumulado),
                    erros=["página repetida ou resposta inesperada; não é fim de coleta"],
                    tempoMs=0,
                    dataExecucao=datetime.now().isoformat(),
                    tentativas=1,
                )
            if parar or not endpoint.temPaginacao:
                if not endpoint.temPaginacao and not parar:
                    logger.warning(
                        "consulta %s: schema sem paginação e o total não confirma o fim da página %s",
                        endpoint.nome, pagina,
                    )
                break
            pagina += 1

        return ConsultaResultado(
            endpoint=endpoint.nome,
            modulo=endpoint.modulo,
            sucesso=True,
            registrosTotais=len(acumulado),
            registrosProcessados=len(acumulado),
            erros=[],
            tempoMs=0,
            dataExecucao=datetime.now().isoformat(),
            tentativas=1,
        )

    def _com_tamanho_pagina(self, endpoint: EndpointConsulta, opcoes: Dict[str, Any]) -> Dict[str, Any]:
        op = dict(opcoes)
        pedido = op.get("pageSize", op.get("tamanhoPagina"))
        tamanho = clamp_compras_gov_page_size(pedido)
        chaves = set(endpoint.parametros or {})
        if "pageSize" in chaves or "pageSize" in op:
            op["pageSize"] = tamanho
        if "tamanhoPagina" in chaves or "tamanhoPagina" in op:
            op["tamanhoPagina"] = tamanho
        if "pageSize" not in op and "tamanhoPagina" not in op:
            op["tamanhoPagina"] = tamanho
        return op

    def _registros_e_corpo(self, dados: Any) -> tuple[Optional[List[Any]], Dict[str, Any]]:
        if isinstance(dados, list):
            return dados, {}
        if isinstance(dados, dict):
            if isinstance(dados.get("resultado"), list):
                return dados["resultado"], dados
            if isinstance(dados.get("data"), list):
                return dados["data"], dados
        return None, {}

    def _monta_url(self, endpoint: EndpointConsulta, opcoes: Dict[str, Any]) -> str:
        """Monta URL com parâmetros e clamp de page-size"""
        base = BASE_URL.rstrip('/')
        path = endpoint.path if endpoint.path.startswith('/') else f"/{endpoint.path}"
        url = f"{base}{path}"

        params = {}
        if 'data_inicio' in opcoes:
            params['dataInicio'] = opcoes['data_inicio']
        if 'data_fim' in opcoes:
            params['dataFim'] = opcoes['data_fim']
        if 'pagina' in opcoes:
            params['pagina'] = opcoes['pagina']
        if 'pageSize' in opcoes:
            params['pageSize'] = clamp_compras_gov_page_size(opcoes['pageSize'])
        elif 'tamanhoPagina' in opcoes:
            params['tamanhoPagina'] = clamp_compras_gov_page_size(opcoes['tamanhoPagina'])

        if opcoes.get('filtros'):
            params.update(opcoes['filtros'])

        if params:
            url += f"?{urlencode(params)}"

        return url

    def _extrai_registros(self, dados: Any) -> List[Any]:
        """Extrai registros do response (com ou sem paginação)"""
        if isinstance(dados, list):
            return dados
        if isinstance(dados, dict):
            if 'resultado' in dados and isinstance(dados['resultado'], list):
                return dados['resultado']
            if 'data' in dados and isinstance(dados['data'], list):
                return dados['data']
        return []

    async def consultar_multiplos(
        self,
        nomes_endpoints: List[str],
        opcoes: Optional[Dict[str, Any]] = None,
        resume: Optional[bool] = None,
        sync_manager: Optional[SyncStateManager] = None,
    ) -> List[ConsultaResultado]:
        """Consulta múltiplos endpoints com paralelismo limitado e suporte a checkpoint"""
        should_resume = is_sync_resume_enabled() if resume is None else resume
        if sync_manager is None and should_resume:
            sync_manager = SyncStateManager("comprasgov_consultar_multiplos")

        completed_endpoints: List[str] = []
        reconstituted_resultados: List[ConsultaResultado] = []
        if sync_manager is not None:
            state = sync_manager.start_run(resume=should_resume)
            if should_resume:
                prev_data = None
                if isinstance(state.cursor, dict) and "resultados" in state.cursor:
                    prev_data = state.cursor["resultados"]
                else:
                    prev_data = sync_manager.load_accumulated_data()

                if isinstance(prev_data, list):
                    for item in prev_data:
                        if isinstance(item, dict):
                            try:
                                reconstituted_resultados.append(ConsultaResultado(**item))
                            except Exception as e:
                                logger.warning(f"Erro ao reconstituir ConsultaResultado: {e}")

                if isinstance(state.cursor, dict) and "completed_endpoints" in state.cursor:
                    completed_endpoints = list(state.cursor["completed_endpoints"])
                else:
                    completed_endpoints = [r.endpoint for r in reconstituted_resultados if r.sucesso]

        resultados = list(reconstituted_resultados)
        endpoints_para_executar = [
            ep for ep in nomes_endpoints if ep not in completed_endpoints
        ]

        if len(endpoints_para_executar) < len(nomes_endpoints):
            pulados = len(nomes_endpoints) - len(endpoints_para_executar)
            logger.info(f"{pulados} endpoint(s) já concluídos no checkpoint anterior, pulando.")

        has_failure = False
        primeiro_erro = None

        for i in range(0, len(endpoints_para_executar), MAX_PARALELO):
            lote = endpoints_para_executar[i:i + MAX_PARALELO]
            logger.info(f"Processando lote {i//MAX_PARALELO + 1}: {len(lote)} endpoints")

            tarefas = [
                self.consultar_endpoint(nome, opcoes)
                for nome in lote
            ]

            resultados_lote = await asyncio.gather(*tarefas)
            resultados.extend(resultados_lote)

            for r in resultados_lote:
                if r.sucesso:
                    completed_endpoints.append(r.endpoint)
                else:
                    has_failure = True
                    if primeiro_erro is None:
                        primeiro_erro = r.erros[0] if r.erros else f"Falha em {r.endpoint}"

            if sync_manager is not None:
                registros_lote = sum(r.registrosTotais for r in resultados_lote if r.sucesso)
                cursor_payload = {
                    "completed_endpoints": completed_endpoints,
                    "resultados": [asdict(r) for r in resultados if r.sucesso],
                }
                if has_failure:
                    sync_manager.record_partial_failure(
                        primeiro_erro or "Falha em lote de endpoints",
                        page=i // MAX_PARALELO + 1,
                        error_details={"failed_endpoints": [r.endpoint for r in resultados_lote if not r.sucesso]},
                        cursor=cursor_payload,
                    )
                else:
                    sync_manager.record_page_success(
                        page=i // MAX_PARALELO + 1,
                        records_in_page=registros_lote,
                        cursor=cursor_payload,
                    )
                sync_manager.save_accumulated_data([asdict(r) for r in resultados if r.sucesso])

            if i + MAX_PARALELO < len(endpoints_para_executar):
                await asyncio.sleep(DELAY_ENTRE_LOTES_MS / 1000)

        for r in resultados:
            if not any(existing.endpoint == r.endpoint and existing.dataExecucao == r.dataExecucao for existing in self.resultados):
                self.resultados.append(r)

        if sync_manager is not None and not has_failure:
            total_records = sum(r.registrosTotais for r in resultados if r.sucesso)
            sync_manager.record_completed(total_records=total_records, metadata_update={"total_records": total_records})

        return resultados

    async def consultar_por_modulo(
        self,
        modulo: str,
        opcoes: Optional[Dict[str, Any]] = None,
        resume: Optional[bool] = None,
        sync_manager: Optional[SyncStateManager] = None,
    ) -> List[ConsultaResultado]:
        """Consulta todos os endpoints de um módulo"""

        endpoints_modulo = [
            nome for nome, ep in self.catalogo.items()
            if ep.modulo == modulo
        ]

        if not endpoints_modulo:
            logger.warning(f"Nenhum endpoint encontrado para módulo: {modulo}")
            return []

        logger.info(f"Consultando módulo {modulo}: {len(endpoints_modulo)} endpoints")
        return await self.consultar_multiplos(endpoints_modulo, opcoes, resume=resume, sync_manager=sync_manager)

    async def consultar_periodo(
        self,
        data_inicio: str,  # "2026-09-01"
        data_fim: str,      # "2026-09-30"
        resume: Optional[bool] = None,
        sync_manager: Optional[SyncStateManager] = None,
    ) -> List[ConsultaResultado]:
        """Consulta endpoints que suportam filtro por data"""

        endpoints_com_data = [
            nome for nome, ep in self.catalogo.items()
            if any(p.get('tipo') == 'date' for p in ep.parametros.values())
        ]

        opcoes = {
            'data_inicio': data_inicio,
            'data_fim': data_fim,
        }

        logger.info(f"Consultando período {data_inicio} a {data_fim}: {len(endpoints_com_data)} endpoints")
        return await self.consultar_multiplos(endpoints_com_data, opcoes, resume=resume, sync_manager=sync_manager)

    async def fechar(self):
        """Fecha sessão HTTP (no-op para compatibilidade)"""
        pass

    def relatorio(self) -> Dict[str, Any]:
        """Gera relatório de execução"""
        sucesso = sum(1 for r in self.resultados if r.sucesso)
        falha = sum(1 for r in self.resultados if not r.sucesso)
        registros_total = sum(r.registrosTotais for r in self.resultados)
        tempo_total = sum(r.tempoMs for r in self.resultados)

        return {
            'total_consultadas': len(self.resultados),
            'sucesso': sucesso,
            'falha': falha,
            'taxa_sucesso_pct': (sucesso / len(self.resultados) * 100) if self.resultados else 0,
            'registros_total': registros_total,
            'tempo_total_ms': tempo_total,
            'tempo_medio_ms': tempo_total // len(self.resultados) if self.resultados else 0,
            'resultados': [asdict(r) for r in self.resultados],
        }

async def main():
    import argparse

    parser = argparse.ArgumentParser(description="Compras.gov.br Consulta Collector")
    parser.add_argument("--schema", help="Caminho para schema JSON")
    parser.add_argument("--modulo", help="Módulo específico (ex: 01-PCA)")
    parser.add_argument("--data-inicio", help="Data início (YYYY-MM-DD)")
    parser.add_argument("--data-fim", help="Data fim (YYYY-MM-DD)")
    parser.add_argument("--resume", action="store_true", help="Retoma do último checkpoint salvo")
    parser.add_argument("--output", help="Arquivo de saída JSON", default="comprasgov_resultado.json")

    args = parser.parse_args()

    collector = ConsultaComprasGovCollector(args.schema)

    try:
        if args.modulo:
            resultados = await collector.consultar_por_modulo(args.modulo, resume=args.resume)
        elif args.data_inicio and args.data_fim:
            resultados = await collector.consultar_periodo(args.data_inicio, args.data_fim, resume=args.resume)
        else:
            logger.error("Especifique --modulo ou --data-inicio e --data-fim")
            return 1

        relatorio = collector.relatorio()
        logger.info(f"Execução concluída: {relatorio['sucesso']}/{relatorio['total_consultadas']} sucesso")

        with open(args.output, 'w', encoding='utf-8') as f:
            json.dump(relatorio, f, indent=2, ensure_ascii=False)

        logger.info(f"Relatório salvo em {args.output}")

        return 0 if relatorio['falha'] == 0 else 1

    finally:
        await collector.fechar()

if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
