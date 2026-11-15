# Eval do agente contra o gabarito

Mede as propostas de um agente contra o gabarito das 80 notas do kit: acerto na classificação, na ação na doca e no encaminhamento, por campo e por tipo de exceção. A nota só conta como acerto completo quando os três batem; nota sem proposta conta como erro. É o eval da #154 (grupo 4, agente auditor de notas).

Da raiz do repositório (a pasta `eval/saidas/` já vem no clone; ponha lá o `propostas.jsonl` do agente):

```bash
python3 eval/avaliar.py eval/saidas/propostas.jsonl
python3 eval/avaliar.py eval/saidas/propostas.jsonl --comparar eval/saidas/baseline.jsonl
```

O `propostas.jsonl` tem uma linha por nota, com `nota_id`, `classificacao`, `acao_doca` e `encaminhamento`. Se a mesma nota aparecer mais de uma vez, vale a última. Os dados das notas vêm de `data/kit/`; o gabarito fica em `eval/gabarito/` e a aplicação nunca o lê.
