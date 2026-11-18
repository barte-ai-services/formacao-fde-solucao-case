# ADR-003: Os testes da api ficam em api/test, espelhando api/src

- **Status:** accepted
- **Date:** 2026-11-15

## Context

O plugin de TypeScript do Ahrena pede, na regra `colocated-tests`, que o teste de `foo.ts` seja `foo.test.ts` ao lado dele. Este repositório guarda os testes da api em `api/test/`, espelhando os caminhos de `api/src/` (por exemplo `api/src/domain/return-note.ts` e `api/test/domain/return-note.test.ts`), e os planos, os detectores de linguagem dos bastidores (ADR-002) e o `make check` já contam com esse layout.

## Decision

Este repositório é uma exceção registrada à regra `colocated-tests` do plugin de TypeScript. Todos os testes da api ficam em `api/test/`, espelhando `api/src/`, e nenhum teste fica ao lado do código. O `make check` os executa por `vitest run`.

## Consequences

- Quem procura o teste de um arquivo de `api/src/` o encontra no mesmo caminho sob `api/test/`.
- A revisão não cobra `*.test.ts` ao lado do código da api; cobra o teste em `api/test/` no caminho espelhado.
- Mover os testes para ao lado do código seria mudança de layout em toda a api e exigiria novo ADR.

## Alternatives considered

- Mover os testes para ao lado do código. Rejeitada: toda a api e os detectores de ADR-002 (`--exclude 'api/test/domain/*'`) dependem do layout atual, e a mudança não traz comportamento novo.
