Regras do contas a pagar, puras e síncronas, sem dependência de fora: objetos de valor (`Money`, `Quantity`, `AmountAtRisk`…), a nota (`Invoice`), a proposta e o título.
`Invoice.check()` roda as verificações de `CHECKS` na ordem E6, E7, E5, E8, E2, E4, E1, E3, não catalogada, e para logo depois da duplicidade (E6) quando ela acha algo (regra 2).
Cada verificação mora num arquivo próprio em `checks/`, com nome e assinatura fixos; o plano dono preenche o corpo.
O modelo, o glossário e as regras numeradas estão em [`docs/domain/README.md`](../../../docs/domain/README.md); os nomes em português seguem o [ADR-002](../../../docs/adr/ADR-002-domain-model-names.md).
