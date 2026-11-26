# Formação FDE: solução do case Já Chegou

Solução de referência do case **Já Chegou** da Formação FDE. É um repositório **estático**: serve
para a turma refazer o case consultando como a equipe o resolveu, e não recebe mais contribuições.

## Nada está no ar

A solução rodou durante a Formação e foi desligada em 26/11/2026:

- os dois Workers da Cloudflare (a API com a tela e o servidor MCP) foram apagados, com os crons;
- a aplicação do Cloudflare Access que os protegia foi apagada;
- o projeto Supabase foi pausado;
- o environment `producao` e todos os secrets e variáveis do GitHub foram apagados, e os workflows
  de publicação (`deploy-api`, `deploy-mcp`, `supabase-base-do-kit`, `cloudflare-access`) estão
  desativados. Eles ficam no repositório só como referência de como a esteira publicava.

Os endereços `*.barte-academy.workers.dev` citados na documentação não respondem mais.

## Rodar local, com as suas chaves

Nada aqui traz credencial. Para rodar, use as suas:

```bash
cp .env.example .env            # scripts e `make eval`
cp .env.example api/.dev.vars   # o Worker no `wrangler dev`
```

Troque os valores de exemplo pelos seus: um projeto Supabase seu (ou o local, com `supabase start` e
`supabase db reset`, que aplica `supabase/migrations/`), carregado com `set -a; . ./.env; set +a; python3 scripts/load_kit.py`,
e uma chave da API da Anthropic sua. Depois, `npm ci && npm run dev` em `api/`
(detalhes em [`api/README.md`](api/README.md)). Os dois arquivos copiados ficam fora do git.

O `web/` instala o `shell-kit` e o `barte-ui-kit` do GitHub Packages da org, que são internos: fora
da org, o `npm ci` do `web/` falha. O restante (`api/`, `mcp/`, `scripts/`, `eval/`) roda sem eles.

## Dados

- **Nenhum cliente real.** A Já Chegou é fictícia, e os dados do kit (`data/kit/`) são fictícios.
- **Nenhum segredo no git**, nem no histórico: a varredura com gitleaks e trufflehog só achou valores
  de teste (um sha256 e URLs `postgres://` falsas).

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
