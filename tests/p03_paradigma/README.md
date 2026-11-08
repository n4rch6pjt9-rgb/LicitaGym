# LicitaGym P0.3-G5.1 — contrato SQL (proposta)

**Não executado**. Arquivos preparados para inspeção e PostgreSQL descartável, não para produção.

A migration define a tabela que `persistencia_versoes.py` espera: `documento_id`, `sha256`, `storage_uri`, `tamanho_bytes`, `mime_type` e `id`. Impõe UNIQUE por documento/hash, FK RESTRICT, RLS, grants mínimos para service_role e trigger de bloqueio de UPDATE/DELETE.

## Pré-condições
- Confirmar que a migration ainda não foi aplicada e que a tabela não existe no ambiente-alvo; `IF NOT EXISTS` não valida estrutura preexistente.
- Confirmar que os papéis `anon`, `authenticated`, `service_role` e a tabela `public.licitacao_documentos` existem no banco de teste.
- Confirmar que o serviço usa `service_role` apenas no backend. Verificar se grants existentes, default privileges e privilégios do dono da tabela estão adequados.
- Revisar dependências de exclusão em cascata: a FK RESTRICT impede exclusão do documento principal com versões.
- Considerar políticas de retenção, backups e controles de Storage; o trigger não impede superusuários de alterar DDL ou desabilitar triggers.

## Testes necessários em banco descartável
1. Inserir uma linha de `licitacao_documentos` de teste com campos obrigatórios reais.
2. Inserir versão com hash válido e verificar `RETURNING id`.
3. Repetir `(documento_id, sha256)` e esperar SQLSTATE 23505.
4. Inserir segunda versão com hash distinto e verificar dois IDs.
5. Tentar UPDATE e DELETE e verificar rejeição pelo trigger.
6. Tentar FK inválida, hash inválido, URI vazia e tamanho negativo.
7. Testar SELECT/INSERT como service_role e bloqueio de anon/authenticated.
8. Verificar rollback/limpeza em ambiente descartável.

**Ainda pendentes em Python:** recuperação de conflito no Storage remoto, retry após conflito 23505, publicação condicional da versão principal e escrita local atômica. Não realizar deploy nem commit neste gate.
