# API

O Worker `formacao-fde-solucao-case-api`, na Cloudflare. Por enquanto, responde
`GET /health` e tem um Cron a cada 15 minutos que só registra que rodou.

## Rodar local

```bash
npm ci
npm run dev
```

Os segredos ficam no `api/.dev.vars`, que o git ignora, um por linha:

```
BARTE_ACADEMY_SUPABASE_SECRET_KEY=...
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
