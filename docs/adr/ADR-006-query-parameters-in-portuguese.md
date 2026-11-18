# ADR-006: Os parâmetros de consulta da API e os códigos de erro ficam em português

- **Status:** accepted
- **Date:** 2026-11-18

## Context

O ADR-004 pôs os caminhos da API em inglês e não falou dos parâmetros de consulta nem dos códigos de erro. Na prática eles já nasceram em português: `dia`, `data`, `mes`, `semana`, `de`, `ate`, `destino`, `loja`, `limite`, e os códigos `limite_invalido` e `cursor_invalido` (#159). A #323 acrescenta `pode_aprovar` e `pode_aprovar_invalido`, e a revisão perguntou se o nome novo devia ser em inglês, já que nenhum ADR mantinha o português.

## Decision

Os parâmetros de consulta da API, os códigos de erro que ela devolve e a identidade de lista dentro do cursor (`fila`, `hoje:<dia>`, `fila:pode_aprovar`) seguem em português, no vocabulário do domínio. Os caminhos seguem em inglês, como no ADR-004, e os identificadores de código também. A linha que introduz um parâmetro, um código de erro ou uma identidade de lista nova leva `ADR-006`.

## Consequences

- Um parâmetro novo combina com os que a web e os alunos já usam; ninguém precisa lembrar qual lista fala qual língua.
- Renomear um parâmetro ou um código de erro existente é mudança incompatível para a web e para quem consome a API.
- O detector de linguagem dos bastidores não cobra as linhas marcadas com `ADR-006`.

## Alternatives considered

- Pôr os parâmetros novos em inglês (`approvable=1`). Rejeitada: a mesma rota passaria a misturar `limite` e `approvable`.
- Traduzir todos os parâmetros e códigos para inglês. Rejeitada: quebra a web e o material da turma sem ganho para quem lê.
