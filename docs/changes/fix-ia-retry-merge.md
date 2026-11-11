# FIX — Conflito Git no retry do Gemini

## Identificação

- Branch: fix/ia-retry-merge
- Baseline: 1e5ee5e
- Componente: services/coletor-externo/coletor/ia.py

## Problema

O baseline continha marcadores de conflito Git no método
Gemini._retry(), impedindo a importação do módulo.

## Correção

- Remoção dos marcadores de conflito.
- Reconciliação do backoff exponencial.
- Preservação do jitter para esperas automáticas.
- Respeito às esperas personalizadas.
- Preservação do limite de tentativas.
- Propagação de erros não transitórios.

## Evidências

- Sintaxe Python: PASS
- Teste de importação do coletor: PASS
- Testes comportamentais de retry: 4/4 PASS
- Total executado: 5/5 PASS
- git diff --check: PASS

## Restrições

- Sem deploy
- Sem alteração no banco
- Sem alteração na branch Paradigma
