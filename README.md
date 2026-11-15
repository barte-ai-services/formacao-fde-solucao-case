# Formação FDE: solução do case Já Chegou

Repositório público com a solução de referência do case **Já Chegou** da Formação FDE. A turma
contribui aqui por clone e PR, sem fork: o passo a passo está no [`CONTRIBUTING.md`](CONTRIBUTING.md).

## Por que o repositório é público

O CISO da Barte liberou o uso de repositório público neste case. Para isso valem as regras abaixo:

- **Nenhum cliente real.** A Já Chegou é fictícia, e nenhum nome de cliente real entra no repositório.
- **Nada de segredo no git.** Credenciais ficam no `.env`, que o git ignora. As de produção ficam só
  no environment `producao`, que só a `main` alcança, e nenhum workflow de PR usa secret.
- **A `main` é protegida.** Só aceita PR com o CI verde e a aprovação de um code owner
  (`.github/CODEOWNERS`).

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
