# API

O Worker `formacao-fde-solucao-case-api`, na Cloudflare. Por enquanto, responde
`GET /health`, `GET /me` (atrás do Cloudflare Access) e tem um Cron a cada 15 minutos que só
registra que rodou.

## Rodar local

```bash
npm ci
npm run dev
```

Os segredos ficam no `api/.dev.vars`, que o git ignora, um por linha:

```
BARTE_ACADEMY_SUPABASE_SECRET_KEY=...
ACCESS_AUD=...
ACCESS_TEAM_DOMAIN=barte-academy.cloudflareaccess.com
```

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

Uma vez por conta, no painel da Cloudflare: abra o Zero Trust, crie o time `barte-academy` e
escolha o plano Free. Depois, na raiz do repositório:

```bash
export BARTE_ACADEMY_CLOUDFLARE_API_TOKEN=...   # com permissão de Access: Apps and Policies
export BARTE_ACADEMY_CLOUDFLARE_ACCOUNT_ID=...
export BARTE_ACADEMY_ACCESS_ALLOWED_EMAILS="aluno1@gmail.com, aluno2@gmail.com"
python3 scripts/cloudflare_access.py --dry-run   # mostra o que enviaria
python3 scripts/cloudflare_access.py
```

O script garante o login por código no e-mail e a aplicação `formacao-fde-solucao-case`, com a
política que libera a `barte.com` e os alunos listados. Rodar de novo atualiza, não duplica. No fim,
imprime `ACCESS_AUD=...` e `ACCESS_TEAM_DOMAIN=...`: são os valores das variáveis do repositório.
