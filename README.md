# Formação FDE: solução do case Já Chegou

Repositório público com a solução de referência do case **Já Chegou** da Formação FDE. A turma
contribui aqui por clone e PR, sem fork: o passo a passo está no [`CONTRIBUTING.md`](CONTRIBUTING.md).

O CISO da Barte liberou o uso de repositório público neste case.

## O problema

A Já Chegou paga sem saber se a mercadoria chegou. A conferência da nota contra o pedido e
contra o recebido acontece depois de a mercadoria entrar, é manual e leva até 14 dias, e a
lista de pagamentos do dia não espera por ela. O resultado é o **pagar errado**: em média
R$ 543 mil por mês pagos sem mercadoria correspondente, sem nada recuperado.

A solução ataca o pagar errado levando a conferência para **antes da doca**, assim que a nota
é emitida.

## Como a solução é construída

De dentro para fora, uma camada de cada vez:

1. Processo (BPMN): o processo atual e o processo-alvo, em [`docs/processo/`](docs/processo/).
2. Modelo de domínio.
3. Casos de uso.
4. Dados no Supabase.
5. Servidor MCP lendo do Supabase.
6. Agente sobre o MCP.
7. Decisão: e-mail e tela de aprovação.

## O gate

```bash
make check
```
