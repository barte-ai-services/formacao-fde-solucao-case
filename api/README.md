# API

O Worker `formacao-fde-solucao-case-api`, na Cloudflare. Por enquanto, responde
`GET /health`, `GET /me` e `GET /api/valor-barrado` e a tela de `web/` (atrás do Cloudflare Access, #60; o
painel está em `src/panel/README.md`) e tem um Cron a cada 15 minutos que só
registra que rodou.

## Rodar local

```bash
npm ci
npm run dev
```

Os segredos ficam no `api/.dev.vars`, que o git ignora, um por linha:

```
BARTE_ACADEMY_SUPABASE_SECRET_KEY=...
BARTE_ACADEMY_CLAUDE_CODE_OAUTH_TOKEN=...
ACCESS_AUD=...
ACCESS_TEAM_DOMAIN=long-frost-f16b.cloudflareaccess.com
```

## O Claude no Worker (#171)

O Cron chama o Claude pela Messages API (`src/claude/`), no começo de cada rodada, e grava as sugestões em
`claude_suggestions`. A regra determinística confirma cada uma; sem sugestão, decide sozinha.

- **Credencial:** o setup token do Claude Code, em `BARTE_ACADEMY_CLAUDE_CODE_OAUTH_TOKEN` (`Authorization: Bearer` +
  `anthropic-beta: oauth-2025-04-20`). A esteira (`deploy-api.yml`) o põe no Worker com `wrangler secret put`. É uso
  da assinatura fora do Claude Code: a Anthropic pode limitar ou bloquear.
- **Plano B:** com `BARTE_ACADEMY_ANTHROPIC_API_KEY` no Worker, o cliente usa a chave (`x-api-key`) no lugar do
  token. Só o secret muda.
- **Falha fechada:** sem credencial, com 429 ou 401, a rodada é interrompida, a falha é contada e logada sem
  segredo, e nenhuma linha de erro gasta tentativa. A regra decide sozinha.
- **Tarefas:** `src/claude/tasks/` (`description-match`, #66; `probable-order`, #65). Para acrescentar uma, crie o
  arquivo exportando um `ClaudeTask` e uma linha em `tasks/index.ts`.
- **Eval do casamento de descrição** (fora do gate, precisa da credencial): `npm run eval:description-match`.

## Testar

```bash
npm run typecheck
npm test
```

Na raiz do repositório, `make check` roda os dois junto com o resto do gate.

## Publicar

Não se publica à mão. Cada merge na `main` que mexe em `api/` roda o workflow
`.github/workflows/deploy-api.yml`, que testa e publica com `wrangler deploy`.
Ele também pode ser disparado pela aba Actions, mas só publica a partir da `main`. Os segredos do Worker em
produção entram com `npx wrangler secret put <NOME>`, nunca no git.

## Cloudflare Access

Toda rota, menos `GET /health`, exige o JWT do Cloudflare Access (#54). O Worker lê o token do
cabeçalho `Cf-Access-Jwt-Assertion` ou do cookie `CF_Authorization` e confere a assinatura RS256
contra as chaves do time, o `aud`, o `iss` e a validade. `GET /me` devolve o e-mail de quem entrou.

| Situação | Resposta |
|---|---|
| Sem token (mesmo com as variáveis vazias) | 401 `unauthenticated` |
| Com token, mas `ACCESS_AUD` ou `ACCESS_TEAM_DOMAIN` vazios | 503 `access_not_configured` |
| Token inválido (assinatura, `aud`, `iss`, expirado, kid desconhecido) | 403 `forbidden` |
| Chaves do time fora do ar | 503 `access_unavailable` |

As duas variáveis não são segredo. Em produção, a esteira passa com `wrangler deploy --var`, a
partir das variáveis do repositório `BARTE_ACADEMY_ACCESS_AUD` e `BARTE_ACADEMY_ACCESS_TEAM_DOMAIN`.
Localmente, ficam no `.dev.vars`; sem elas, só o `/health` responde 200.

### Provisionar

O time do Zero Trust é `long-frost-f16b.cloudflareaccess.com` (variável do repositório
`BARTE_ACADEMY_ACCESS_TEAM_DOMAIN`). A aplicação do Access que o Worker usa já existe, e o AUD dela está em
`BARTE_ACADEMY_ACCESS_AUD`. O script `scripts/cloudflare_access.py` a atualiza e nunca cria outra: acha a
aplicação pelo AUD, não pelo nome, e um AUD que não bate com nenhuma aplicação é erro, sem gravar nada.

O PUT substitui o recurso, então o corpo parte da aplicação inteira (menos os campos só de leitura: `id`, `uid`,
`aud`, `created_at`, `updated_at`) e troca só duas coisas. Nome, domínio, AUD, sessão, redirecionamento e os demais
campos ficam como estão. Em `allowed_idps` o código por e-mail entra se faltar, mas lista vazia ou ausente, que na
API quer dizer "todos os provedores", fica como está. Em `policies`, a política do script (libera a `barte.com` e
cada e-mail de `BARTE_ACADEMY_ACCESS_ALLOWED_EMAILS`) é trocada no lugar ou acrescentada ao fim, e as outras
políticas da aplicação ficam na forma em que vieram. Execução real sem e-mails é recusada. Rodar de novo deixa o
mesmo estado.

**Pelo workflow** (o caminho normal):

1. Em Settings, Secrets and variables, Actions, confira os secrets `BARTE_ACADEMY_CLOUDFLARE_API_TOKEN` (com
   permissão de Access: Apps and Policies) e `BARTE_ACADEMY_CLOUDFLARE_ACCOUNT_ID`, o secret
   `BARTE_ACADEMY_ACCESS_ALLOWED_EMAILS` (e-mails separados por vírgula ou espaço) e a variável
   `BARTE_ACADEMY_ACCESS_AUD`. Os e-mails são secret porque o Actions imprime o `env` do step no log e só mascara
   secrets.
2. Na aba Actions, rode `Provisiona o Cloudflare Access` (`.github/workflows/cloudflare-access.yml`) na `main`,
   com `dry_run` marcado. O log mostra a chamada que enviaria, com os e-mails mascarados e a contagem deles.
3. Rode de novo com `dry_run` desmarcado para gravar.

O workflow não imprime o token nem os e-mails. Para criar uma aplicação nova, o que só se faz de propósito, rode à
mão com `--create` e `BARTE_ACADEMY_ACCESS_APP_DOMAIN` com o domínio dela; o script imprime o `ACCESS_AUD=...`
novo, que vai para a variável do repositório.

**À mão**, na raiz do repositório:

```bash
export BARTE_ACADEMY_CLOUDFLARE_API_TOKEN=...   # com permissão de Access: Apps and Policies
export BARTE_ACADEMY_CLOUDFLARE_ACCOUNT_ID=...
export BARTE_ACADEMY_ACCESS_AUD=...
export BARTE_ACADEMY_ACCESS_ALLOWED_EMAILS="aluno1@example.com, aluno2@example.com"
python3 scripts/cloudflare_access.py --dry-run   # mostra o que enviaria
python3 scripts/cloudflare_access.py
```
