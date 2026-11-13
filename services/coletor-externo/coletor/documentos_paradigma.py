"""Documentos (anexos) dos processos Paradigma, guardados dentro do LicitaGym.

Fluxo, igual ao do mural do portal (HAR SFIEC PE000652022, 26/09/2026):
  1. PesquisarAnexos (sNmLocalAnexo=EditalAnexos) -> lista do processo: edital, erratas, avisos, relatório final...
  2. ValidarSalvarVisitante -> 1 quando o portal exige identificação do visitante para baixar
  3. SalvarVisitante -> cadastro do visitante, com o CNPJ da empresa (VISITANTE_CNPJ) ou, por decisão do dono em
     12/11/2026, com o CPF de uma pessoa (VISITANTE_CPF + VISITANTE_NOME), sempre com VISITANTE_CONSENTIMENTO_LGPD=1.
     O CPF é dado pessoal: portal_visitante guarda só o HMAC-SHA256 dele (chave em VISITANTE_HASH_CHAVE, que não
     fica no banco), e ele não vai para log nem para erro.
     Sem cadastro configurado, o documento fica registrado como pendente e NÃO é baixado (o coletor não
     contorna a exigência do portal).
     Com endereço configurado (spec 0061, K-13; HARs da Firjan de 12/11/2026), o cadastro vai completo: CEP com
     máscara, RG (só CPF) e nCdCidade achado pelo nome em PesquisarRegiao (tipo 1 confere a UF, tipo 2 lista as
     cidades); cidade fora da lista deixa o documento pendente com o motivo, sem SalvarVisitante.
  4. AnexoExiste -> Download.aspx?q=<sDsParametroCriptografado>
  5. O arquivo vai para o Supabase Storage (bucket privado) e a linha de licitacao_documentos guarda
     storage_uri, sha256, tamanho e tipo.
  6. Relatórios públicos do processo (spec 0061, K-14): PesquisarProcessoDetalheRelatorio + PDF de
     GetRelatorioAreaExterna (reportType=1), guardados como documento com arquivo estável relatorio_<nCdItem>.pdf.

Histórico: nada é apagado. Documento novo no portal ganha first_seen_at; documento que some do portal
não é marcado como removido automaticamente: ausência na coleta não comprova remoção do portal. O histórico permanece preservado até reconciliação autoritativa. Assim o processo aberto
acumula tudo o que foi anexado e o fechado fica com o dossiê completo para análise.
"""
from __future__ import annotations

import hashlib
import hmac
import json
import logging
import re
import time
import unicodedata
from dataclasses import dataclass, field
from datetime import datetime, timezone
from urllib.parse import urlsplit

import requests

from .destino import Armazenamento, env, parece_html, sha256
from .fornecedores import cnpj_valido, cpf_valido
from .portal import parse_data

log = logging.getLogger("coletor.documentos")

SECAO_PROCESSO = "processo"
LOCAL_ANEXOS = "EditalAnexos"
ARQUIVO_RESUMO = "resumo_processo.html"   # nome estável do documento "Resumo do processo" (PesquisarResumoEdital)
MODULOS_SEM_CADASTRO = {20}               # o próprio mural ignora o cadastro de visitante nesse módulo
# Data de geração da página do resumo (label_0, ao lado da cidade): é a hora da consulta, muda a cada chamada e faria
# cada coleta gravar uma versão nova. As datas do processo (label_1, label_2) ficam como vieram.
_DATA_GERACAO_RESUMO = re.compile(r"(#label_0'\)\.text\(kendo\.toString\(new Date\()\d+")
TAMANHO_MINIMO_CHAVE_HASH = 32


class ArquivoGrande(Exception):
    pass


def _nome_regiao(texto: str) -> str:
    """Nome de cidade comparável: sem acento, sem caixa, espaços únicos."""
    sem = "".join(c for c in unicodedata.normalize("NFKD", texto) if not unicodedata.combining(c))
    return " ".join(sem.casefold().split())


class CadastroPendente(Exception):
    """O portal pede cadastro, mas o coletor não consegue montá-lo completo (ex.: cidade fora da lista do portal).
    O documento fica pendente com o motivo; nenhum SalvarVisitante é chamado com dado incompleto."""


# Endereço do visitante (spec 0061, K-13): opcional; se vier, vem inteiro. RG só com CPF.
CAMPOS_ENDERECO = ("VISITANTE_ENDERECO", "VISITANTE_NUMERO", "VISITANTE_BAIRRO", "VISITANTE_CEP", "VISITANTE_CIDADE")


@dataclass(frozen=True)
class VisitanteInstitucional:
    """Identificação do LicitaGym nos portais: CNPJ da empresa ou CPF de uma pessoa. Lida do ambiente/segredo."""
    documento: str = field(repr=False)  # só dígitos, DV conferido; fora do repr (CPF é dado pessoal)
    nome: str = field(repr=False)       # razão social (CNPJ) ou nome da pessoa (CPF)
    email: str = field(repr=False)
    telefone: str = field(repr=False)
    uf: str = ""
    contato: str = field(default="", repr=False)
    tipo: str = "CNPJ"  # "CNPJ" ou "CPF"
    chave_hash: str = field(default="", repr=False)  # chave do HMAC do CPF (VISITANTE_HASH_CHAVE)
    endereco: str = field(default="", repr=False)
    numero: str = field(default="", repr=False)
    bairro: str = field(default="", repr=False)
    cep: str = field(default="", repr=False)     # 8 dígitos; vai ao portal com a máscara 99.999-999
    cidade: str = field(default="", repr=False)  # nome; o código vem da lista PesquisarRegiao do portal
    rg: str = field(default="", repr=False)      # só com CPF

    @property
    def cnpj(self) -> str | None:
        return self.documento if self.tipo == "CNPJ" else None

    @property
    def tem_endereco(self) -> bool:
        return bool(self.cidade)

    @property
    def cep_mascarado(self) -> str:
        return f"{self.cep[:2]}.{self.cep[2:5]}-{self.cep[5:]}" if len(self.cep) == 8 else ""

    def mascarar(self, texto: str) -> str:
        """Tira do texto os dados do visitante em qualquer formato, para erro e log: caracteres de controle (o texto do
        portal não pode injetar comando `::` no Actions), cada palavra do nome e do contato com 3+ letras (com
        ou sem acento), e-mails e toda sequência de 8+ dígitos (documento e telefone, com qualquer pontuação)."""
        texto = re.sub(r"[\x00-\x1f\x7f]", " ", texto)
        palavras = {p for v in (self.nome, self.contato, self.endereco, self.bairro)
                    for p in re.findall(r"\w{3,}", self._sem_acento(v or ""))}
        for palavra in sorted(palavras, key=len, reverse=True):
            texto = re.sub(rf"\b{self._qualquer_acento(palavra)}\b", "***", texto, flags=re.IGNORECASE)
        texto = re.sub(r"[\w.+-]+@[\w-]+(\.[\w-]+)+", "***", texto)
        return re.sub(r"\+?\(?\d[\d.\-/() _,–—+]{6,}\d",
                      lambda m: "***" if len(re.sub(r"\D", "", m.group())) >= 8 else m.group(), texto)

    @staticmethod
    def _qualquer_acento(palavra: str) -> str:
        """Regex da palavra que casa com ou sem acento ("Jose" acha "JOSÉ")."""
        variantes = {"a": "aàáâãä", "e": "eèéêë", "i": "iìíîï", "o": "oòóôõö", "u": "uùúûü", "c": "cç", "n": "nñ"}
        return "".join(f"[{variantes[c.lower()]}]" if c.lower() in variantes else re.escape(c) for c in palavra)

    @staticmethod
    def _sem_acento(texto: str) -> str:
        return "".join(c for c in unicodedata.normalize("NFKD", texto) if not unicodedata.combining(c))

    def chave_cadastro(self) -> dict | None:
        """Como o visitante é identificado em portal_visitante. CPF só como HMAC-SHA256 com chave secreta: sem a
        chave, um hash puro de CPF é reversível por força bruta (são 10^9 possibilidades). Sem chave, sem cache."""
        if self.tipo == "CNPJ":
            return {"tipo_documento": "CNPJ", "cnpj": self.documento, "documento_hash": None}
        if not self.chave_hash:
            return None
        digest = hmac.new(self.chave_hash.encode(), f"cpf:{self.documento}".encode(), hashlib.sha256).hexdigest()
        return {"tipo_documento": "CPF", "cnpj": None, "documento_hash": digest}

    @classmethod
    def do_ambiente(cls) -> "VisitanteInstitucional | None":
        """None quando não configurado. Exige VISITANTE_CONSENTIMENTO_LGPD=1 (decisão explícita de quem se cadastra)."""
        cnpj, cpf = env("VISITANTE_CNPJ"), env("VISITANTE_CPF")
        if not cnpj and not cpf:
            return None
        if cnpj and cpf:
            raise SystemExit("Defina VISITANTE_CNPJ ou VISITANTE_CPF, não os dois.")
        if cnpj:
            tipo, d, campo_nome = "CNPJ", cnpj_valido(cnpj), "VISITANTE_RAZAO_SOCIAL"
        else:
            tipo, d, campo_nome = "CPF", cpf_valido(cpf), "VISITANTE_NOME"
        if not d:
            raise SystemExit(f"VISITANTE_{tipo} inválido (dígito verificador).")
        if (env("VISITANTE_CONSENTIMENTO_LGPD") or "") != "1":
            raise SystemExit("Defina VISITANTE_CONSENTIMENTO_LGPD=1: o cadastro de visitante no portal exige o aceite.")
        exigidos = (campo_nome, "VISITANTE_EMAIL", "VISITANTE_TELEFONE", "VISITANTE_UF")
        faltam = [k for k in exigidos + (("VISITANTE_HASH_CHAVE",) if tipo == "CPF" else ()) if not env(k)]
        if faltam:
            raise SystemExit(f"Cadastro de visitante incompleto: {', '.join(faltam)}")
        if tipo == "CPF" and len(env("VISITANTE_HASH_CHAVE")) < TAMANHO_MINIMO_CHAVE_HASH:
            # Chave curta se adivinha, e com ela o HMAC volta a ser força bruta sobre 10^9 CPFs.
            raise SystemExit(f"VISITANTE_HASH_CHAVE curta: use ao menos {TAMANHO_MINIMO_CHAVE_HASH} caracteres aleatórios.")
        end = {k: (env(k) or "").strip() for k in CAMPOS_ENDERECO}
        rg = re.sub(r"\D", "", env("VISITANTE_RG") or "")
        if any(end.values()):
            faltam = [k for k, v in end.items() if not v]
            if faltam:
                raise SystemExit(f"Endereço do visitante incompleto: {', '.join(faltam)} (informe todos ou nenhum)")
            end["VISITANTE_CEP"] = re.sub(r"\D", "", end["VISITANTE_CEP"])
            if len(end["VISITANTE_CEP"]) != 8:
                raise SystemExit("VISITANTE_CEP inválido: use os 8 dígitos do CEP.")
        if rg and tipo != "CPF":
            raise SystemExit("VISITANTE_RG só vale com VISITANTE_CPF.")
        return cls(d, env(campo_nome), env("VISITANTE_EMAIL"), re.sub(r"\D", "", env("VISITANTE_TELEFONE")),
                   env("VISITANTE_UF").upper()[:2], env("VISITANTE_CONTATO") or "", tipo,
                   (env("VISITANTE_HASH_CHAVE") or "") if tipo == "CPF" else "",
                   endereco=end["VISITANTE_ENDERECO"], numero=end["VISITANTE_NUMERO"], bairro=end["VISITANTE_BAIRRO"],
                   cep=end["VISITANTE_CEP"], cidade=end["VISITANTE_CIDADE"], rg=rg)

    def dto(self, n_cd_visitante: int, anexo: dict, d: dict, n_cd_cidade: str | None = None,
            n_cd_endereco: int = 0) -> dict:
        """dtoVisitante no formato do formulário do portal (HARs da Firjan de 12/11/2026): documento do tipo CNPJ ou
        CPF; com endereço, CEP com máscara e o código da cidade achado na lista do portal (n_cd_cidade). Sem
        bFlInteresseCertame, como o mural."""
        cpf = self.tipo == "CPF"
        return {
            "nCdVisitante": n_cd_visitante or 0, "nCdEndereco": n_cd_endereco or 0, "nCdEmpresa": 0,
            "sDsCpf": self.documento if cpf else "", "sDsCnpj": "" if cpf else self.documento,
            "sDsRg": self.rg if cpf else "",
            "sNmVisitante": self.nome,
            "sDsEmail": self.email, "sDsTelefone": self.telefone, "sDsEndereco": self.endereco,
            "sNrEndereco": self.numero, "sDsComplemento": "", "sNmBairro": self.bairro, "sCdCep": self.cep_mascarado,
            "sCdPais": "BR", "sCdEstado": self.uf, "nCdCidade": n_cd_cidade or "0",
            "sDsTipoDocumento": self.tipo, "sNmContato": self.contato,
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
        self.n_cd_endereco = 0                  # oComplemento do SalvarVisitante: endereço já gravado no portal
        self._n_cd_cidade: str | None = None    # código da cidade na lista do portal (1 consulta por execução)
        self._pendencia_cidade: str | None = None  # motivo, quando a cidade não está na lista (não repete a consulta)
        # portal_visitante guarda o CNPJ, ou só o HMAC do CPF (dado pessoal); sem chave de cadastro, não há cache.
        self._chave = visitante.chave_cadastro() if visitante is not None else None
        if sb is not None and self._chave is not None and not dry_run:
            filtro = ({"cnpj": f"eq.{self._chave['cnpj']}"} if self._chave["cnpj"]
                      else {"documento_hash": f"eq.{self._chave['documento_hash']}"})
            try:
                rows = sb.selecionar("portal_visitante", select="n_cd_visitante",
                                     fonte=f"eq.{portal.fonte.slug}", **filtro)
                self.n_cd_visitante = rows[0]["n_cd_visitante"] if rows else None
            except Exception as e:
                log.info("portal_visitante indisponível (%s): cadastra de novo nesta execução", e)

    # ---------------- portal ----------------
    def listar(self, d: dict) -> list[dict]:
        if not d.get("nCdAnexo"):
            raise RuntimeError("PesquisarAnexos inconclusivo: nCdAnexo ausente")
        r = self.portal._ws("PesquisarAnexos", {"dtoAnexo": {
            "nCdAnexo": d["nCdAnexo"], "sNmLocalAnexo": LOCAL_ANEXOS, "nCdModulo": d.get("nCdModulo") or 59,
            "nCdOrigem": d.get("nCdOrigem") or d["nCdProcesso"], "bFlPublico": 1}})
        if not isinstance(r, list):
            raise RuntimeError("PesquisarAnexos inconclusivo: resposta não é lista")
        if any(not isinstance(a, dict) for a in r):
            raise RuntimeError("PesquisarAnexos inconclusivo: anexo inválido")
        return [a for a in r if a.get("sNmArquivo") and a.get("sDsParametroCriptografado")]

    def _identificar(self, anexo: dict, d: dict) -> bool:
        """True quando o portal libera o download (sem exigência, ou visitante institucional cadastrado).

        Como o mural (controle de anexos, HAR FIEB de 12/11/2026): o cadastro só é pedido quando a configuração do
        portal exige (bFlCadastroParaEfetuarDownloadAnexoAreaPublica > 0) e o módulo não é dispensado. O
        ValidarSalvarVisitante = 1 quer dizer "permite cadastro", não "exige"."""
        if (d.get("nCdModulo") or 59) in MODULOS_SEM_CADASTRO or getattr(self.portal, "cadastro_download", None) == 0:
            return True
        exige = self.portal._ws("ValidarSalvarVisitante", {"cwAnexoVisitante": {
            "nCdAnexo": anexo["nCdAnexo"], "nSqAnexo": anexo["nSqAnexo"],
            "nIdTipoOrigem": d.get("nCdModulo") or 59, "nCdOrigem": d.get("nCdOrigem") or d["nCdProcesso"]}})
        if exige != 1:
            return True
        if self.visitante is None:
            return False
        cidade = self._codigo_cidade() if self.visitante.tem_endereco else None
        r = self.portal._ws("SalvarVisitante", {"dtoVisitante": self.visitante.dto(
            self.n_cd_visitante or 0, anexo, d, cidade, self.n_cd_endereco)})
        cod = (r or {}).get("nCdCodigo") if isinstance(r, dict) else None
        if not isinstance(cod, int) or cod <= 0:
            # O erro vai para o banco e para o log: só a forma da resposta, o código e a mensagem do portal com os
            # dados do visitante mascarados (o corpo pode ecoar documento, nome, e-mail ou telefone).
            if isinstance(r, dict):
                motivo = self.visitante.mascarar(str(r.get("sDsConteudo") or ""))[:200]
                forma = f"chaves {sorted(r)[:10]}; nCdCodigo={self.visitante.mascarar(str(cod))[:20]}; motivo: {motivo}"
            else:
                forma = type(r).__name__
            raise RuntimeError(f"SalvarVisitante não devolveu código (resposta: {forma})")
        if cod != self.n_cd_visitante and self._chave is not None and self.sb is not None and not self.dry_run:
            self.sb.upsert("portal_visitante", {"fonte": self.portal.fonte.slug, "n_cd_visitante": cod,
                                                **self._chave}, "fonte")
        endereco = r.get("oComplemento")
        if isinstance(endereco, int) and not isinstance(endereco, bool) and endereco > 0:
            self.n_cd_endereco = endereco
        novo = cod != self.n_cd_visitante or not getattr(self, "_cookie_ok", False)
        self.n_cd_visitante = cod
        if not novo:
            return True
        # O mural guarda o visitante no cookie CK_VISITANTE_TEMP antes do download; o coletor faz o mesmo (1x por execução).
        self._cookie_ok = True
        try:
            dto = {k: v for k, v in self.visitante.dto(cod, anexo, d, cidade, self.n_cd_endereco).items()
                   if not k.startswith("dto")}
            self.portal.s.post(f"{self.portal.fonte.base}/WebService/Servicos.asmx/SetCookie",
                               data=json.dumps({"name": "CK_VISITANTE_TEMP", "value": json.dumps(dto)}).encode(),
                               headers={"Content-Type": "application/json; charset=utf-8"}, timeout=30)
        except requests.RequestException as e:
            log.info("SetCookie CK_VISITANTE_TEMP falhou (%s); seguindo", e)
        return True

    def _codigo_cidade(self) -> str:
        """Código da cidade do visitante na lista do portal, como o formulário do mural: PesquisarRegiao tipo 1 (estados
        do país) confere a UF; tipo 2 (cidades da UF) dá o código pelo nome, sem acento nem caixa. Cidade ou UF fora
        da lista -> CadastroPendente com o motivo (nunca o código "0")."""
        if self._n_cd_cidade:
            return self._n_cd_cidade
        if self._pendencia_cidade:
            raise CadastroPendente(self._pendencia_cidade)
        v = self.visitante
        estados = self.portal._ws("PesquisarRegiao", {"dtoRegiao": {"sCdCodigo": "BR", "tmpTipoRegiao": 1,
                                                                    "sCdPais": "BR"}})
        if not isinstance(estados, list):
            raise RuntimeError("PesquisarRegiao (estados) inconclusivo: resposta não é lista")
        if not any(isinstance(e, dict) and e.get("sCdCodigo") == v.uf for e in estados):
            self._pendencia_cidade = f"portal exige cadastro de visitante: UF {v.uf} fora da lista de estados do portal"
            raise CadastroPendente(self._pendencia_cidade)
        cidades = self.portal._ws("PesquisarRegiao", {"dtoRegiao": {"sCdCodigo": v.uf, "tmpTipoRegiao": 2,
                                                                    "sCdPais": "BR"}})
        if not isinstance(cidades, list):
            raise RuntimeError("PesquisarRegiao (cidades) inconclusivo: resposta não é lista")
        alvo = _nome_regiao(v.cidade)
        achadas = [c.get("sCdCodigo") for c in cidades
                   if isinstance(c, dict) and _nome_regiao(str(c.get("sDsRegiao") or "")) == alvo]
        codigos = [str(c) for c in achadas if c not in (None, "", "0", 0)]
        if len(set(codigos)) != 1:
            motivo = "não achada" if not codigos else "ambígua"
            self._pendencia_cidade = (f"portal exige cadastro de visitante: cidade {motivo} na lista do portal para a "
                                      f"UF {v.uf} (confira VISITANTE_CIDADE)")
            raise CadastroPendente(self._pendencia_cidade)
        self._n_cd_cidade = codigos[0]
        return self._n_cd_cidade

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
            "raw": {k: v for k, v in anexo.items() if k != "sDsParametroCriptografado"},
        }

    def resumo_html(self, d: dict) -> str:
        """Resumo do processo como o mural mostra (PesquisarResumoEdital): HTML com objeto, itens, prazo de entrega,
        pagamento e condições gerais. As datas vêm em milissegundos dentro do script da página: guardar o HTML
        original, não o texto renderizado."""
        origem = d.get("nCdOrigem") or d["nCdProcesso"]
        r = self.portal._ws("PesquisarResumoEdital", {"dtoProcesso": {
            "nCdProcesso": origem, "nCdOrigem": origem, "nCdModulo": d.get("nCdModulo") or 59,
            "dtoIdioma": {"nCdIdioma": 1}, "sGMT": "-03:00"}})
        if not isinstance(r, str) or "<" not in r or len(r.strip()) < 50:
            raise RuntimeError("PesquisarResumoEdital inconclusivo: resposta vazia ou sem HTML")
        return _DATA_GERACAO_RESUMO.sub(r"\g<1>0", r)

    def _gravar_gerado(self, lic_id: int | None, d: dict, caminho_base: str, existentes: dict, agora: str,
                       resumo: dict, *, arquivo: str, nome: str, origem: str, raw: dict, mime: str, obter,
                       contador: str) -> None:
        """Documento gerado pelo portal (resumo, relatório) com nome de arquivo estável: registra a linha uma vez,
        versiona o conteúdo no Storage e só marca baixado com SHA-256 e storage_uri conferidos. Falha conta erro e
        não rebaixa o que já estava confirmado."""
        from .versionamento import processar_versao

        doc = existentes.get(arquivo)
        anterior = doc or {}
        confirmado = anterior.get("status_processamento") == "baixado" and bool(anterior.get("sha256"))
        try:
            conteudo = obter()
            if doc is None:
                doc = self.sb.upsert("licitacao_documentos", [{
                    "licitacao_id": lic_id, "secao": SECAO_PROCESSO, "nome_original": nome, "arquivo_origem": arquivo,
                    "data_documento": None, "origem_portal": origem, "last_seen_at": agora, "raw": raw,
                }], "licitacao_id,secao,arquivo_origem")[0]
                resumo["novos"] += 1
            digest = sha256(conteudo)
            versao, _ = processar_versao(sb=self.sb, arm=self.arm, documento_id=doc["id"], caminho_base=caminho_base,
                                         secao=SECAO_PROCESSO, conteudo=conteudo, mime_type=mime)
            if versao.get("sha256") != digest or not versao.get("storage_uri"):
                raise RuntimeError("Versão registrada sem storage_uri ou com SHA-256 divergente")
            if not confirmado or anterior.get("sha256") != digest:
                self.sb.atualizar("licitacao_documentos", doc["id"], {
                    "storage_uri": versao["storage_uri"], "mime_type": mime, "tamanho_bytes": len(conteudo),
                    "sha256": digest, "baixado_em": datetime.now(timezone.utc).isoformat(),
                    "status_processamento": "baixado", "erro": None})
            resumo[contador] += 1
        except Exception as e:
            resumo["erros"] += 1
            log.warning("%s %s %s: %s", self.portal.fonte.slug, d.get("nCdProcesso"), nome, e)
            if doc is not None and not confirmado:
                self.sb.atualizar("licitacao_documentos", doc["id"], {"status_processamento": "erro",
                                                                      "erro": str(e)[:500]})

    def _sincronizar_resumo(self, lic_id: int | None, d: dict, caminho_base: str, existentes: dict, agora: str,
                            resumo: dict) -> None:
        self._gravar_gerado(
            lic_id, d, caminho_base, existentes, agora, resumo, arquivo=ARQUIVO_RESUMO, nome="Resumo do processo",
            origem="Resumo", raw={"metodo": "PesquisarResumoEdital",
                                  "normalizacao": "data de geração da página (label_0) zerada"},
            mime="text/html", obter=lambda: self.resumo_html(d).encode("utf-8"), contador="resumos")

    def relatorios(self, d: dict) -> list[dict]:
        """Relatórios do processo que o mural mostra ao público (PesquisarProcessoDetalheRelatorio, HAR Firjan de
        12/11/2026), ex.: "Pedidos de Reconsiderações". Só os com bExibePublico = 1 e com uidLicitacao e nCdItem."""
        r = self.portal._ws("PesquisarProcessoDetalheRelatorio", {"dtoProcesso": {
            "nCdProcesso": d["nCdProcesso"], "nCdModulo": d.get("nCdModulo") or 59,
            "nIdTipoApuracao": d.get("nIdTipoApuracao") or 0, "nCdSituacao": d.get("nCdSituacao") or 0,
            "nCdEmpresa": d.get("nCdEmpresa") or 0, "dtoIdioma": {"nCdIdioma": 1}}})
        if not isinstance(r, list):
            raise RuntimeError("PesquisarProcessoDetalheRelatorio inconclusivo: resposta não é lista")
        return [x for x in r if isinstance(x, dict) and x.get("bExibePublico") == 1 and x.get("uidLicitacao")
                and isinstance(x.get("nCdItem"), int) and not isinstance(x.get("nCdItem"), bool)
                and (x.get("sNmItem") or "").strip()]

    def _baixar_relatorio(self, rel: dict) -> bytes:
        """PDF do relatório (GetRelatorioAreaExterna, reportType=1; o 2 devolve HTML). Fica na raiz do domínio do
        portal, fora de /portal. Resposta que não começa com %PDF- é erro: o portal devolve HTML quando falha."""
        partes = urlsplit(self.portal.fonte.base)
        url = f"{partes.scheme}://{partes.netloc}/licitacao-backend/wbc/GetRelatorioAreaExterna"
        params = {"uidLicitacao": rel["uidLicitacao"], "nCdItem": rel["nCdItem"], "nCdIdioma": 1,
                  "sDsTitulo": rel["sNmItem"].strip(), "reportType": 1}
        with self.portal.s.get(url, params=params, stream=True, timeout=(30, 300)) as r:
            r.raise_for_status()
            blocos, total = [], 0
            for bloco in r.iter_content(256 * 1024):
                blocos.append(bloco)
                total += len(bloco)
                if total > self.max_bytes:
                    raise ArquivoGrande(f"relatório maior que {self.max_bytes // 1048576} MB")
        time.sleep(self.portal.delay)
        conteudo = b"".join(blocos)
        if not conteudo.startswith(b"%PDF-"):
            raise RuntimeError("portal devolveu outra coisa em vez do PDF do relatório (HTML ou vazio)")
        return conteudo

    def _sincronizar_relatorios(self, lic_id: int | None, d: dict, caminho_base: str, existentes: dict, agora: str,
                                resumo: dict) -> None:
        """Relatórios públicos do processo como documentos (spec 0061, K-14). A falha na lista conta erro e não
        afeta os anexos já sincronizados."""
        try:
            lista = self.relatorios(d)
        except Exception as e:
            resumo["erros"] += 1
            log.warning("%s %s relatórios do processo: %s", self.portal.fonte.slug, d.get("nCdProcesso"), e)
            return
        for rel in lista:
            nome = rel["sNmItem"].strip()
            self._gravar_gerado(
                lic_id, d, caminho_base, existentes, agora, resumo, arquivo=f"relatorio_{rel['nCdItem']}.pdf",
                nome=nome, origem="Relatório",
                raw={"metodo": "GetRelatorioAreaExterna", "reportType": 1, "nCdItem": rel["nCdItem"],
                     "sNmItem": nome, "sDsArquivoRelatorio": rel.get("sDsArquivoRelatorio")},
                mime="application/pdf", obter=lambda rel=rel: self._baixar_relatorio(rel), contador="relatorios")

    def sincronizar(self, lic_id: int | None, d: dict, caminho_base: str, resumo_processo: bool = False) -> dict:
        """Registra todos os anexos do processo e baixa os que ainda não estão no LicitaGym. Com resumo_processo,
        guarda também o resumo do processo (edital encerrado com resultado) como documento."""
        resumo = {"documentos": 0, "novos": 0, "baixados": 0, "aguardando_cadastro": 0, "erros": 0, "ignorados": 0,
                  "removidos_do_portal": 0, "resumos": 0, "relatorios": 0}
        anexos = self.listar(d)
        resumo["documentos"] = len(anexos)
        if self.dry_run:
            for a in anexos:
                print(f"      doc | {parse_data(a.get('tDtAnexo')) or '':25.25} | {a.get('sDsAnexo')}")
            if resumo_processo:
                print("      doc | resumo do processo (PesquisarResumoEdital)")
            print("      doc | relatórios públicos do processo (PesquisarProcessoDetalheRelatorio)")
            return resumo
        agora = datetime.now(timezone.utc).isoformat()
        existentes = {r["arquivo_origem"]: r for r in self.sb.selecionar(
            "licitacao_documentos", select="id,arquivo_origem,status_processamento,sha256,removido_do_portal_em",
            licitacao_id=f"eq.{lic_id}", secao=f"eq.{SECAO_PROCESSO}")}
        linhas = [self.linha(lic_id, a, agora) for a in anexos]
        novas = [
            linha for linha in linhas
            if linha["arquivo_origem"] not in existentes
        ]
        resumo["novos"] = len(novas)

        inseridos = (
            self.sb.upsert(
                "licitacao_documentos",
                novas,
                "licitacao_id,secao,arquivo_origem",
            )
            if novas else []
        )

        salvos = dict(existentes)
        salvos.update({
            s["arquivo_origem"]: s
            for s in inseridos
        })

        if not {a["sNmArquivo"] for a in anexos}.issubset(salvos):
            raise RuntimeError(
                "Supabase não retornou todos os documentos novos"
            )
        # P0.1: ausência na coleta não comprova remoção do portal.
        # Preservar o histórico até existir reconciliação autoritativa.
        # Não atualizar removido_do_portal_em neste fluxo.

        from .versionamento import processar_versao

        for a in anexos:
            doc = salvos[a["sNmArquivo"]]
            anterior = existentes.get(a["sNmArquivo"], {})
            confirmado = (
                anterior.get("status_processamento") == "baixado"
                and bool(anterior.get("sha256"))
            )

            try:
                try:
                    liberado, motivo = self._identificar(a, d), None
                except CadastroPendente as e:
                    liberado, motivo = False, str(e)
                if not liberado:
                    resumo["aguardando_cadastro"] += 1
                    if not confirmado:
                        self.sb.atualizar("licitacao_documentos", doc["id"], {
                            "status_processamento": "pendente",
                            "erro": motivo or "portal exige cadastro de visitante: configure VISITANTE_* (CNPJ ou CPF)",
                        })
                    continue

                conteudo, ctype = self._baixar(a)
                digest = sha256(conteudo)

                versao, criada = processar_versao(
                    sb=self.sb,
                    arm=self.arm,
                    documento_id=doc["id"],
                    caminho_base=caminho_base,
                    secao=SECAO_PROCESSO,
                    conteudo=conteudo,
                    mime_type=ctype,
                )

                if versao.get("sha256") != digest:
                    raise RuntimeError("Versão registrada com SHA-256 divergente")

                if not versao.get("storage_uri"):
                    raise RuntimeError("Versão registrada sem storage_uri")

                if not confirmado or anterior["sha256"] != digest:
                    self.sb.atualizar("licitacao_documentos", doc["id"], {
                        "storage_uri": versao["storage_uri"],
                        "mime_type": ctype,
                        "tamanho_bytes": len(conteudo),
                        "sha256": digest,
                        "baixado_em": datetime.now(timezone.utc).isoformat(),
                        "status_processamento": "baixado",
                        "erro": None,
                    })

                resumo["baixados"] += 1

            except ArquivoGrande as e:
                resumo["ignorados"] += 1
                if not confirmado:
                    self.sb.atualizar("licitacao_documentos", doc["id"], {
                        "status_processamento": "ignorado",
                        "erro": str(e),
                    })

            except Exception as e:
                resumo["erros"] += 1
                log.warning("documento %s: %s", a.get("sDsAnexo"), e)
                if not confirmado:
                    self.sb.atualizar("licitacao_documentos", doc["id"], {
                        "status_processamento": "erro",
                        "erro": str(e)[:500],
                    })

        if resumo_processo:
            self._sincronizar_resumo(lic_id, d, caminho_base, existentes, agora, resumo)
        self._sincronizar_relatorios(lic_id, d, caminho_base, existentes, agora, resumo)
        return resumo
