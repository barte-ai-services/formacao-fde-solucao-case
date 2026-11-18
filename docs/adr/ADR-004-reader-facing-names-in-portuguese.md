# ADR-004: O que a pessoa lê fica em português; os identificadores de código ficam em inglês

- **Status:** accepted
- **Date:** 2026-11-15

## Context

A regra de linguagem dos bastidores pede nomes em inglês, e o AGENTS.md pede prosa em português. O ADR-002 já abriu a exceção para o modelo de domínio da api. Falta dizer o mesmo do que a pessoa lê na web e na documentação: as rotas das telas (`/pagar/fila`), as pastas dos artefatos de wireframe e a chave de página de cada um (`artifacts/wireframe-pedido-ao-fornecedor/`, `artifacts/wireframe-contas-a-pagar/`), e os nomes de `describe` e `it` dos testes, que são frases com o prefixo `#N/AC-n:` (por exemplo `web/test/supplier-request.test.tsx`).

## Decision

O que a pessoa lê segue em português: as rotas das telas, as pastas dos artefatos de wireframe e a chave de página, e os nomes de `describe` e `it`, que mantêm o prefixo `#N/AC-n:`. Os identificadores de código (variáveis, tipos, funções, nomes de arquivo de código e caminhos da API, como `/api/supplier-requests/sr-1/send`) seguem em inglês, como o ADR-002 já fixa. Cada linha que escreve uma rota de tela ou a chave de página de um wireframe leva `// ADR-004`. O detector de linguagem dos bastidores roda com `--exclude 'artifacts/wireframe-*'`, no mesmo modo do ADR-002.

## Consequences

- Quem lê a tela, o wireframe ou o relatório de teste encontra a frase do critério de aceite, sem tradução.
- O nome de um arquivo de código ou de um caminho da API não vira português: o arquivo de teste segue `supplier-request.test.tsx`.
- Renomear uma rota de tela ou a chave de página de um wireframe quebra os links dos planos e é mudança incompatível.
- O detector de linguagem dos bastidores não cobra as linhas marcadas com `ADR-004` nem as pastas de wireframe excluídas; o resto do código segue em inglês.

## Alternatives considered

- Traduzir rotas, pastas de artefato e nomes de teste para inglês. Rejeitada: a pessoa que lê o plano e o relatório de teste perde a ligação com o critério de aceite, e o prefixo `#N/AC-n:` deixa de ser frase.
- Passar também os identificadores de código para português. Rejeitada: contraria o ADR-002, que limita a exceção ao modelo de domínio.
