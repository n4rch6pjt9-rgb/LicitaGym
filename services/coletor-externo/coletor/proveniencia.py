"""Proveniência por linha (spec 0023): sha256 do payload, origem e hora da última ingestão. Interface; sem comportamento."""
ORIGENS = ()


def hash_payload(raw):
    return None


def campos_proveniencia(raw, origem, agora=None):
    return {}
