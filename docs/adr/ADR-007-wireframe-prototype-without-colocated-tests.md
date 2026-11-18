# ADR-007: O código do protótipo de wireframe fica fora da regra de testes colocados

- **Status:** accepted
- **Date:** 2026-11-18

## Context

Cada wireframe versionado em `artifacts/wireframe-*/` tem uma pasta `src/` com o código que gera o `index.html`: telas de demonstração, dados de exemplo e scripts de montagem. As regras de testes colocados (`colocated-tests` e `test-placement`) pedem um teste ao lado de cada módulo. O `artifacts/wireframe-contas-a-pagar/src` já está na `main` sem testes, e a revisão do wireframe da #160 (`artifacts/wireframe-tabela-scroll-infinito/src`) bloqueou por falta deles, porque nenhum ADR mantinha esse precedente.

## Decision

O código em `artifacts/wireframe-*/src` não leva teste ao lado. Ele é material de desenho: não entra no build do portal nem do Worker, e quem o confere é o dono do design, olhando o `index.html` gerado. As regras `colocated-tests` e `test-placement` rodam com `artifacts/wireframe-*` excluído, no mesmo modo em que o ADR-004 exclui essas pastas do detector de linguagem. As demais regras (tipagem, ponteiros de comentário, segredos) continuam valendo para esse código. Decidido pelo Fernando Seguim na revisão da #160.

## Consequences

- Um wireframe novo não trava na revisão por falta de teste do protótipo.
- O comportamento desenhado no wireframe é coberto pelos testes da tela de verdade, em `web/`, quando ela é construída.
- Código que passe a ser usado pelo portal não pode morar em `artifacts/wireframe-*/src`; ao ser promovido para `web/`, ganha os testes que a regra pede.

## Alternatives considered

- Escrever testes para o protótipo. Rejeitada: testa um código que só existe para gerar o HTML do desenho, e o HTML gerado já é conferido na aprovação.
- Deixar o precedente sem registro. Rejeitada: cada revisão de wireframe voltaria a bloquear no mesmo ponto.
