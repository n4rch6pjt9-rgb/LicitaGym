# P0.3.4 — Integração do versionamento documental Paradigma

## Identificação

- Branch: feat/p03-paradigma-integracao
- Worktree: D:\DevWorktrees\Licitagym\feat-p03-paradigma-integracao
- Baseline: 1e5ee5e
- Status: Em desenvolvimento

## Objetivo

Integrar armazenamento documental imutável e histórico de versões
ao coletor Paradigma.

## Implementação

- storage_imutavel.py: escrita sem sobrescrita
- persistencia_versoes.py: consulta e registro de versões
- versionamento.py: orquestração e recuperação local
- documentos_paradigma.py: integração local implementada; validação remota pendente

## Evidências

- Laboratório P0.3: 17 testes aprovados na etapa original; G5.2-C.05: 38 testes aprovados na suíte executada
- Testes de integração: G5.2-C.06 aprovou 1 teste isolado com Supabase simulado; PostgreSQL, Supabase e Storage reais ainda não validados
- Supabase real: não validado
- Google Cloud Storage real: não validado

## Restrições

- Sem deploy
- Sem migrations de produção
- Sem alteração do repositório original
- Sem operações destrutivas
