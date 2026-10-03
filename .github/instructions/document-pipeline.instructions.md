---
applyTo: "docs/agente-editais/**,docs/agente-juridico-ml/**,**/*document*,**/*pdf*,**/*ocr*,**/*chunk*,**/*embedding*,**/*rag*"
---
# Pipeline documental e agentes (editais, jurídico)

## Alto
- CPF e CNPJ em documentos de edital são dados públicos. Mascarar, descartar ou redact esses identificadores antes do RAG é Alto.
- Embedding do RAG: `text-multilingual-embedding-002`, 768 dimensões. Trocar modelo ou dimensão sem plano de reindex aprovado no PR é Alto.
- Histórico de preço e mapa de fornecedor não nascem deste pipeline documental solto: só de certame homologado, só no BI, com o certame rastreável.

## Ao revisar
- **Original preservado**: documento oficial não é sobrescrito; SHA-256 do conteúdo original. Mesmo documento + mesmo hash = mesma versão; hash diferente = nova versão com histórico.
- **Idempotência**: reprocessar o mesmo hash não cria versão, página, chunk ou embedding duplicado.
- **Granularidade de página**: extração mantém vínculo com página; texto único gigante é [IMPORTANTE].
- **PDF sem texto** → estado `OCR_REQUIRED`, nunca `EXTRACTED` com conteúdo vazio ([BLOQUEANTE]).
- **OCR** como etapa separada, registrando engine, versão e confiança.
- **Chunks** com metadados de evidência: document_id, document_version_id, contratacao_id, page_start/page_end, section, content_hash.
- **Busca** híbrida (FTS + embeddings); não depender só de vetores.
- **Evidência**: resposta do agente → chunk → página → versão → documento oficial. Resposta sem evidência apresentada como fato documental é [BLOQUEANTE].
- Mudança de versão de extractor/OCR/chunker/modelo de embedding deve permitir reprocessamento seletivo.
