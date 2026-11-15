# ADR-002: Os nomes do modelo de domínio seguem a língua do modelo

- **Status:** accepted
- **Date:** 2026-11-15

## Context

O contrato do domínio do contas a pagar (#59) é a base que 9 planos (#62 a #73) já citam pelo nome: os arquivos e as funções de verificação (`checks/e6-duplicidade.ts` com `checkDuplicidade`, `nao-catalogada.ts` com `checkNaoCatalogada`, e os demais) e os literais que espelham o modelo e o glossário (`docs/domain/README.md`, `docs/domain/glossary.md`): os estados da nota (`a_conferir`, `conferida`…), da proposta e do título, os níveis de aprovação (`regra`, `analista`…), a ação na doca (`receber`, `receber_parcial`, `recusar`, com `segurar` e `devolver`), as fontes de evidência (`sefaz`, `erp_compras`…) e o status da ordem de compra (`aberta`, `atendida`, `travada`). O AGENTS.md pede prosa em português, e os nomes de teste são frases. A regra de linguagem dos bastidores pede nomes em inglês.

## Decision

Os arquivos e as funções de verificação (`api/src/domain/checks/e*-*.ts`, `nao-catalogada.ts`, `check*`), os literais de estado e de tipo que espelham o modelo e o glossário (estados de `Invoice`, `Proposal` e `Title`, `ApprovalLevel`, `DockAction` com `kind` e `disposition`, `EvidenceSource`, `PurchaseOrder.status`, `ReturnNote` com `pendente`, `emitida` e `cancelada`, #140) e os nomes de teste escritos como frase seguem a língua do modelo, em português. Cada linha que declara um desses nomes leva `// ADR-002`. O detector de linguagem dos bastidores roda com `--exclude 'api/src/domain/checks/*'` e `--exclude 'api/test/domain/*'`. Todo o resto (classes, métodos, campos) segue em inglês.

## Consequences

- Quem lê o código encontra o mesmo termo do modelo, do glossário e do plano dono; o literal que a tela e o banco recebem é o termo do glossário, sem mapeamento.
- Renomear um desses nomes quebra o contrato dos planos #62 a #73 e é mudança incompatível.
- Os detectores de linguagem dos bastidores não cobram as linhas marcadas com `ADR-002` nem os caminhos excluídos; os demais nomes seguem em inglês.

## Alternatives considered

- Traduzir arquivos, funções e literais para inglês e manter um mapeamento na borda. Rejeitada: os 9 planos já citam os nomes em português, o literal deixaria de ser o termo do glossário e a tradução criaria um dicionário a manter, como no ADR-001.
