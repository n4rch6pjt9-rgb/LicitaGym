"""Documentos (anexos) dos processos Paradigma, guardados dentro do LicitaGym.

Fluxo, igual ao do mural do portal (HAR SFIEC PE000652022, 26/09/2026):
  1. PesquisarAnexos (sNmLocalAnexo=EditalAnexos) -> lista do processo: edital, erratas, avisos, relatório final...
  2. ValidarSalvarVisitante -> 1 quando o portal exige identificação do visitante para baixar
  3. SalvarVisitante -> cadastro do visitante. O LicitaGym se identifica com o CNPJ da empresa
     (VISITANTE_* no ambiente). Nunca com CPF de pessoa. Sem cadastro configurado, o documento fica
     registrado como pendente e NÃO é baixado (o coletor não contorna a exigência do portal).
  4. AnexoExiste -> Download.aspx?q=<sDsParametroCriptografado>
  5. O arquivo vai para o Supabase Storage (bucket privado) e a linha de licitacao_documentos guarda
     storage_uri, sha256, tamanho e tipo.

Histórico: nada é apagado. Documento novo no portal ganha first_seen_at; documento que some do portal
ganha removido_do_portal_em (o arquivo já baixado continua no LicitaGym). Assim o processo aberto
acumula tudo o que foi anexado e o fechado fica com o dossiê completo para análise.
"""
from __future__ import annotations

import json
import logging
import re
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

import requests

from .destino import Armazenamento, env, parece_html, sha256
from .fornecedores import cnpj_valido
from .portal import parse_data

log = logging.getLogger("coletor.documentos")

SECAO_PROCESSO = "processo"
LOCAL_ANEXOS = "EditalAnexos"


class ArquivoGrande(Exception):
    pass


@dataclass(frozen=True)
class VisitanteInstitucional:
    """Identificação do LicitaGym nos portais (pessoa jurídica). Lida do ambiente/segredo do coletor."""
    cnpj: str
    razao_social: str
    email: str
    telefone: str
    uf: str
    contato: str = ""

    @classmethod
    def do_ambiente(cls) -> "VisitanteInstitucional | None":
        """None quando não configurado. Exige VISITANTE_CONSENTIMENTO_LGPD=1 (decisão explícita da empresa)."""
        cnpj = env("VISITANTE_CNPJ")
        if not cnpj:
            return None
        d = cnpj_valido(cnpj)
        if not d:
            raise SystemExit("VISITANTE_CNPJ inválido (dígito verificador).")
        if (env("VISITANTE_CONSENTIMENTO_LGPD") or "") != "1":
            raise SystemExit("Defina VISITANTE_CONSENTIMENTO_LGPD=1: o cadastro de visitante no portal exige o aceite.")
        faltam = [k for k in ("VISITANTE_RAZAO_SOCIAL", "VISITANTE_EMAIL", "VISITANTE_TELEFONE", "VISITANTE_UF") if not env(k)]
        if faltam:
            raise SystemExit(f"Cadastro institucional incompleto: {', '.join(faltam)}")
        return cls(d, env("VISITANTE_RAZAO_SOCIAL"), env("VISITANTE_EMAIL"), re.sub(r"\D", "", env("VISITANTE_TELEFONE")),
                   env("VISITANTE_UF").upper()[:2], env("VISITANTE_CONTATO") or "")

    def dto(self, n_cd_visitante: int, anexo: dict, d: dict) -> dict:
        """dtoVisitante no formato do formulário do portal, com documento do tipo CNPJ."""
        return {
            "nCdVisitante": n_cd_visitante or 0, "nCdEndereco": 0, "nCdEmpresa": 0,
            "sDsCpf": "", "sDsCnpj": self.cnpj, "sDsRg": "", "sNmVisitante": self.razao_social,
            "sDsEmail": self.email, "sDsTelefone": self.telefone, "sDsEndereco": "", "sNrEndereco": "",
            "sDsComplemento": "", "sNmBairro": "", "sCdCep": "", "sCdPais": "BR", "sCdEstado": self.uf,
            "nCdCidade": "0", "sDsTipoDocumento": "CNPJ", "bFlInteresseCertame": "1", "sNmContato": self.contato,
            "bFlConsentimentoLGPD": 1,
            "dtoAnexo": {"nCdAnexo": anexo["nCdAnexo"], "nSqAnexo": anexo["nSqAnexo"]},
            "dtoEdital": {"nCdEdital": d["nCdProcesso"], "nCdOrigem": d.get("nCdOrigem") or d["nCdProcesso"]},
            "dtoProcesso": {"nCdProcesso": d["nCdProcesso"], "nCdModulo": d.get("nCdModulo") or 59,
                            "dtoIdioma": {"nCdIdioma": 1}},
        }


class DocumentosParadigma:
    def __init__(self, portal, sb, arm: Armazenamento | None, visitante: VisitanteInstitucional | None,
                 max_bytes: int = 50 * 1024 * 1024, dry_run: bool = False):
        self.portal = portal
        self.sb = sb
        self.arm = arm
        self.visitante = visitante
        self.max_bytes = max_bytes
        self.dry_run = dry_run
        self.n_cd_visitante: int | None = None  # código do visitante no portal (reaproveitado entre execuções)
        if sb is not None and visitante is not None and not dry_run:
            try:
                rows = sb.selecionar("portal_visitante", select="n_cd_visitante",
                                     fonte=f"eq.{portal.fonte.slug}", cnpj=f"eq.{visitante.cnpj}")
                self.n_cd_visitante = rows[0]["n_cd_visitante"] if rows else None
            except Exception as e:
                log.info("portal_visitante indisponível (%s): cadastra de novo nesta execução", e)

    # ---------------- portal ----------------
    def listar(self, d: dict) -> list[dict]:
        if not d.get("nCdAnexo"):
            return []
        r = self.portal._ws("PesquisarAnexos", {"dtoAnexo": {
            "nCdAnexo": d["nCdAnexo"], "sNmLocalAnexo": LOCAL_ANEXOS, "nCdModulo": d.get("nCdModulo") or 59,
            "nCdOrigem": d.get("nCdOrigem") or d["nCdProcesso"], "bFlPublico": 1}}) or []
        return [a for a in r if a.get("sNmArquivo") and a.get("sDsParametroCriptografado")]

    def _identificar(self, anexo: dict, d: dict) -> bool:
        """True quando o portal libera o download (sem exigência, ou visitante institucional cadastrado)."""
        exige = self.portal._ws("ValidarSalvarVisitante", {"cwAnexoVisitante": {
            "nCdAnexo": anexo["nCdAnexo"], "nSqAnexo": anexo["nSqAnexo"],
            "nIdTipoOrigem": d.get("nCdModulo") or 59, "nCdOrigem": d.get("nCdOrigem") or d["nCdProcesso"]}})
        if exige != 1:
            return True
        if self.visitante is None:
            return False
        r = self.portal._ws("SalvarVisitante", {"dtoVisitante": self.visitante.dto(self.n_cd_visitante or 0, anexo, d)})
        cod = (r or {}).get("nCdCodigo") if isinstance(r, dict) else None
        if not isinstance(cod, int) or cod <= 0:
            raise RuntimeError(f"SalvarVisitante não devolveu código ({str(r)[:120]})")
        if cod != self.n_cd_visitante and self.sb is not None and not self.dry_run:
            self.sb.upsert("portal_visitante", {"fonte": self.portal.fonte.slug, "n_cd_visitante": cod,
                                                "cnpj": self.visitante.cnpj}, "fonte")
        novo = cod != self.n_cd_visitante or not getattr(self, "_cookie_ok", False)
        self.n_cd_visitante = cod
        if not novo:
            return True
        # O mural guarda o visitante no cookie CK_VISITANTE_TEMP antes do download; o coletor faz o mesmo (1x por execução).
        self._cookie_ok = True
        try:
            dto = {k: v for k, v in self.visitante.dto(cod, anexo, d).items() if not k.startswith("dto")}
            self.portal.s.post(f"{self.portal.fonte.base}/WebService/Servicos.asmx/SetCookie",
                               data=json.dumps({"name": "CK_VISITANTE_TEMP", "value": json.dumps(dto)}).encode(),
                               headers={"Content-Type": "application/json; charset=utf-8"}, timeout=30)
        except requests.RequestException as e:
            log.info("SetCookie CK_VISITANTE_TEMP falhou (%s); seguindo", e)
        return True

    def _baixar(self, anexo: dict) -> tuple[bytes, str | None]:
        self.portal._ws("AnexoExiste", {"dtoAnexo": {"sNmLocalAnexo": LOCAL_ANEXOS, "sNmArquivo": anexo["sNmArquivo"]}})
        url = f"{self.portal.fonte.base}/Download.aspx{anexo['sDsParametroCriptografado']}"
        with self.portal.s.get(url, stream=True, timeout=(30, 300)) as r:
            r.raise_for_status()
            ctype = (r.headers.get("content-type") or "").split(";")[0].strip() or None
            partes, total = [], 0
            for bloco in r.iter_content(256 * 1024):
                partes.append(bloco)
                total += len(bloco)
                if total > self.max_bytes:
                    raise ArquivoGrande(f"arquivo maior que {self.max_bytes // 1048576} MB")
        time.sleep(self.portal.delay)
        conteudo = b"".join(partes)
        if parece_html(conteudo, ctype):
            raise RuntimeError("portal devolveu HTML em vez do arquivo")
        return conteudo, ctype

    # ---------------- banco ----------------
    @staticmethod
    def linha(lic_id: int | None, anexo: dict, agora: str) -> dict:
        return {
            "licitacao_id": lic_id,
            "secao": SECAO_PROCESSO,
            "nome_original": (anexo.get("sDsAnexo") or anexo["sNmArquivo"]).strip(),
            "arquivo_origem": anexo["sNmArquivo"],
            "data_documento": parse_data(anexo.get("tDtAnexo")),
            "origem_portal": anexo.get("sDsOrigem"),
            "last_seen_at": agora,
            "removido_do_portal_em": None,
            "raw": {k: v for k, v in anexo.items() if k != "sDsParametroCriptografado"},
        }

    def sincronizar(self, lic_id: int | None, d: dict, caminho_base: str) -> dict:
        """Registra todos os anexos do processo e baixa os que ainda não estão no LicitaGym."""
        resumo = {"documentos": 0, "novos": 0, "baixados": 0, "aguardando_cadastro": 0, "erros": 0, "ignorados": 0,
                  "removidos_do_portal": 0}
        anexos = self.listar(d)
        resumo["documentos"] = len(anexos)
        if self.dry_run:
            for a in anexos:
                print(f"      doc | {parse_data(a.get('tDtAnexo')) or '':25.25} | {a.get('sDsAnexo')}")
            return resumo
        agora = datetime.now(timezone.utc).isoformat()
        existentes = {r["arquivo_origem"]: r for r in self.sb.selecionar(
            "licitacao_documentos", select="id,arquivo_origem,status_processamento,sha256,removido_do_portal_em",
            licitacao_id=f"eq.{lic_id}", secao=f"eq.{SECAO_PROCESSO}")}
        linhas = [self.linha(lic_id, a, agora) for a in anexos]
        resumo["novos"] = sum(1 for l in linhas if l["arquivo_origem"] not in existentes)
        salvos = {s["arquivo_origem"]: s for s in (self.sb.upsert("licitacao_documentos", linhas,
                                                                 "licitacao_id,secao,arquivo_origem") if linhas else [])}
        # Some do portal: marca, não apaga (o arquivo baixado continua no LicitaGym)
        for arq, r in existentes.items():
            if arq not in salvos and not r.get("removido_do_portal_em"):
                self.sb.atualizar("licitacao_documentos", r["id"], {"removido_do_portal_em": agora})
                resumo["removidos_do_portal"] += 1

        ja: dict[str, str] = {}
        for a in anexos:
            doc = salvos[a["sNmArquivo"]]
            if doc.get("status_processamento") not in ("pendente", "erro") and doc.get("sha256"):
                continue
            try:
                if not self._identificar(a, d):
                    resumo["aguardando_cadastro"] += 1
                    self.sb.atualizar("licitacao_documentos", doc["id"], {
                        "status_processamento": "pendente",
                        "erro": "portal exige cadastro de visitante: configure VISITANTE_* (CNPJ da empresa)"})
                    continue
                conteudo, ctype = self._baixar(a)
                h = sha256(conteudo)
                uri = ja.get(h)
                if not uri:
                    nome = re.sub(r"[^A-Za-z0-9._-]", "_", a["sNmArquivo"])
                    uri = self.arm.salvar(f"{caminho_base}/{SECAO_PROCESSO}/{nome}", conteudo, ctype)
                    ja[h] = uri
                self.sb.atualizar("licitacao_documentos", doc["id"], {
                    "storage_uri": uri, "mime_type": ctype, "tamanho_bytes": len(conteudo), "sha256": h,
                    "baixado_em": datetime.now(timezone.utc).isoformat(),
                    "status_processamento": "baixado", "erro": None})
                resumo["baixados"] += 1
            except ArquivoGrande as e:
                resumo["ignorados"] += 1
                self.sb.atualizar("licitacao_documentos", doc["id"], {"status_processamento": "ignorado", "erro": str(e)})
            except Exception as e:  # um arquivo com erro não derruba o processo
                resumo["erros"] += 1
                log.warning("documento %s: %s", a.get("sDsAnexo"), e)
                self.sb.atualizar("licitacao_documentos", doc["id"], {"status_processamento": "erro", "erro": str(e)[:500]})
        return resumo
