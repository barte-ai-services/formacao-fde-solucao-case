// #311 O mundo dos testes do dossiê agendado: o kit inteiro já capturado e proposto (o tick sem credencial do Claude),
// o Claude falso e a invocação do cron do dossiê com o fetch que conta as subrequests.
import { vi } from 'vitest';
import { CLAUDE_CRON, DOSSIER_CRON, dispatchScheduled } from '../../src/cron/schedule.js';
import type { Env } from '../../src/env.js';
import { FakePostgrest } from './fake-postgrest.js';
import { kitTables } from './kit.js';
import { countSubrequests, type SubrequestCounter } from './subrequest-counter.js';

export const SUPABASE_ENV: Env = { BARTE_ACADEMY_SUPABASE_URL: 'https://fake.supabase.co', BARTE_ACADEMY_SUPABASE_SECRET_KEY: 'sb_secret_fake' };
export const WITH_CLAUDE: Env = { ...SUPABASE_ENV, BARTE_ACADEMY_CLAUDE_CODE_OAUTH_TOKEN: 'fake-oauth-token' };

/** Resposta mínima e válida da Messages API para o dossiê. */
export function claudeOk(): Response {
  return new Response(
    JSON.stringify({ content: [{ type: 'tool_use', name: 'responder', input: { summary: 'ok', divergences: [], supplier_history: 'ok' } }] }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

/** O banco do kit com as propostas já aguardando uma pessoa, sem nenhum dossiê: o estado de produção que a #311 descreve. */
export async function kitAwaitingPeople(): Promise<FakePostgrest> {
  const fake = new FakePostgrest(kitTables());
  vi.stubGlobal('fetch', fake.fetch);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  await dispatchScheduled({ cron: CLAUDE_CRON }, SUPABASE_ENV);
  return fake;
}

/** As chaves das propostas que esperam uma pessoa e pedem dossiê (rota que não é a regra), na ordem da tabela. */
export function awaitingKeys(fake: FakePostgrest): string[] {
  return fake
    .rows('proposals')
    .filter((p) => p.state === 'aguardando_aprovacao' && p.approval_level !== 'regra')
    .map((p) => String(p.invoice_access_key));
}

export type Invocation = { readonly counter: SubrequestCounter; readonly claudeCalls: () => number };

/** Uma invocação do cron do dossiê, com o Claude respondendo `claude` e o teto de subrequests `cap`. */
export async function runDossierCron(
  fake: FakePostgrest,
  env: Env,
  options: { claude?: () => Response; cap?: number } = {},
): Promise<Invocation> {
  let claudeCalls = 0;
  const claude = options.claude ?? claudeOk;
  const counter = countSubrequests((input, init) => {
    if (input.startsWith('https://api.anthropic.com/')) {
      claudeCalls += 1;
      return Promise.resolve(claude());
    }
    return fake.fetch(input, init);
  }, options.cap ?? 1000);
  vi.stubGlobal('fetch', counter.fetch);
  await dispatchScheduled({ cron: DOSSIER_CRON }, env);
  return { counter, claudeCalls: () => claudeCalls };
}

export const eventSuggestions = (fake: FakePostgrest) => fake.rows('claude_suggestions').filter((r) => r.task === 'dossier' && r.trigger === 'event');
