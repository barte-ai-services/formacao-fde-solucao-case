# Tela do contas a pagar

A tela da Já Chegou (fictícia), em React + Vite, na moldura do `@barte-ai-services/shell-kit` e com
os componentes do `@barte-ai-services/barte-ui-kit`, seguindo o wireframe aprovado (F3,
`artifacts/wireframe-contas-a-pagar`). O Worker de `api/` a serve, atrás do Cloudflare Access (#60).

## Rodar

Os kits saem do GitHub Packages, que pede token até para ler:

```bash
NODE_AUTH_TOKEN=$(gh auth token) npm --prefix web ci && npm --prefix web run dev
```

Em dev, o Vite repassa `/me` e `/api/...` ao `wrangler dev` da pasta `api/` (porta 8787). Sem a API
de pé, a moldura abre com o contexto fixo e a pessoa anônima. Com `VITE_SHELL_URL`, o contexto vem
do Shell.

Na raiz, `make check` roda o typecheck, os testes e o build daqui junto com o resto do gate.

## Estrutura

- `src/routes/`: **uma rota, um arquivo** (`fila.tsx`, `proposta.tsx`, `lista-do-dia.tsx`,
  `duplicadas.tsx`, `valor-barrado.tsx`, `doca.tsx`). `routes/index.ts` liga caminho a componente.
- `src/evidence/`: **uma evidência, um arquivo** (`e1.tsx` … `e8.tsx`, `nao-catalogada.tsx`).
  `<EvidenceView divergence={...} />` escolhe o componente registrado para o código ou cai no
  `GenericEvidence`, que lista fonte, referência e descrição e nunca quebra. Se o registrado lançar
  um erro, o genérico entra no lugar.
- `src/components/`: `Screen` (a casca de toda tela: título compacto e carregando, vazio e erro) e
  `useLoad` (o `LoadState` de uma promessa, com `retry`).
- `src/api/`: `client.ts` (`apiGet`, `apiPost`, `me`, `ApiError`) e `contract.ts`, os DTOs do fio
  tipados pelo domínio de `api/src/domain` (`import type` por `@domain`).
- `src/router/`: o stand-in de `next/navigation` sobre a History API, o casamento de rota com
  parâmetro (`/pagar/fila/:id`) e o `Link`, que navega sem recarregar.
- `src/shell/context.ts`: o contexto da moldura e o menu.

## Como uma história preenche a sua tela

1. **A rota.** Abra o arquivo da sua rota em `src/routes/`. Troque a carga vazia por um `apiGet`
   do seu endpoint, que vive sob `/api/...` no Worker, e diga quando o resultado é vazio:

   ```tsx
   const { state, data, retry } = useLoad((signal) => apiGet<ProposalDto[]>("/api/fila", { signal }), (rows) => rows.length === 0);
   return <Screen ... state={state} onRetry={retry}>{() => <Table data={data!} ... />}</Screen>;
   ```

   Título, subtítulo e textos de carregando, erro e vazio já são os do wireframe. Não mexa em
   `routes/index.ts`, a não ser para criar uma rota nova.
2. **O contrato.** Se o seu endpoint precisa de um DTO novo, acrescente em `src/api/contract.ts`,
   tipado pelos tipos do domínio.
3. **A evidência.** Se a história é de uma exceção, troque o corpo do componente em
   `src/evidence/eN.tsx` (ou `nao-catalogada.tsx`). A linha `registerEvidence(...)` e o
   `evidence/index.ts` ficam como estão.
4. **Os testes** ficam em `test/`, nomeados pelo critério (`#<issue>/AC-<n>`).
