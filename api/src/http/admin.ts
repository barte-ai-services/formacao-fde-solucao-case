/**
 * #174 Rotas de administração, atrás do Access e só para o papel de administrador.
 *   POST /api/admin/reconferir  { "confirmar": "RECONFERIR" }
 * Apaga as tabelas do domínio (nunca as `kit_*`) e roda o `tick` uma vez; devolve o resumo.
 *   GET /api/admin/dossies
 * #311 Só leitura: as contagens do dossiê por gatilho e status e os pedidos pendentes ou com erro, para ver o caminho automático sem o banco.
 *   POST /api/admin/rodar-agora
 * #356 Dispara uma rodada de origem `manual` depois da resposta (202 na hora); respeita a trava e grava a rodada como as do Cron.
 *   POST /api/admin/modo-demonstracao  { "enabled": true | false }
 * #356 Liga ou desliga o modo demonstração (rodada de minuto em minuto) sem deploy; grava quem mudou e quando.
 */
import { isAdmin } from '../approval/admins.js';
import { SupabaseRest, SupabaseRestError } from '../connectors/supabase-rest.js';
import type { Env } from '../env.js';
import { dossierOverview } from '../dossier/overview.js';
import { reconferir } from "../ops/reconferir.js";
import { setDemoMode } from '../automation/round.js';
import { DemoModeWriteError, supabaseRoundStore } from '../automation/round-store.js';
import { RoundInProgressError, runManualRound } from '../cron/tick.js';
import type { Identity } from './access.js';

const RECONFERIR_PATH = '/api/admin/reconferir';
const CONFIRMATION = 'RECONFERIR';

const DOSSIERS_PATH = '/api/admin/dossies';

const RUN_NOW_PATH = '/api/admin/rodar-agora';
const DEMO_MODE_PATH = '/api/admin/modo-demonstracao';

/** #130 Quem recebe o trabalho que roda depois da resposta (o waitUntil do Worker). */
type Defer = (work: Promise<unknown>) => void;

const fail = (status: number, error: string, headers?: HeadersInit) => Response.json({ error }, { status, headers });

/** Devolve nulo quando o caminho não é de administração, para o roteador seguir. */
export async function adminRoutes(request: Request, identity: Identity, env: Env, defer?: Defer): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  if (![RECONFERIR_PATH, DOSSIERS_PATH, RUN_NOW_PATH, DEMO_MODE_PATH].includes(path)) return null;
  if (!isAdmin(env.BARTE_ACADEMY_ADMIN_EMAILS, identity.email)) return fail(403, 'forbidden');
  if (path === DOSSIERS_PATH) return dossiersRoute(request, env);
  const rejected = rejectUnlessJsonPost(request);
  if (rejected) return rejected;
  if (path === RUN_NOW_PATH) return runNowRoute(env, defer);
  if (path === DEMO_MODE_PATH) return demoModeRoute(request, identity, env);

  const body = await readJson(request);
  const confirmed = typeof body === 'object' && body !== null && (body as Record<string, unknown>).confirmar === CONFIRMATION;
  if (!confirmed) return fail(400, 'confirmation_required');

  const url = env.BARTE_ACADEMY_SUPABASE_URL;
  const secretKey = env.BARTE_ACADEMY_SUPABASE_SECRET_KEY;
  if (!url || !secretKey) return fail(503, 'supabase_not_configured');

  const by = identity.email;
  try {
    const summary = await reconferir(new SupabaseRest({ url, secretKey }), env);
    console.log('admin-reconferir', { by, ...summary });
    return Response.json(summary);
  } catch (error) {
    // #356 AC-3 Trava tomada e válida: nada foi apagado nem gravado, e quem pediu tenta de novo daqui a pouco.
    if (error instanceof RoundInProgressError) return fail(409, 'round_in_progress');
    console.error(
      'admin-reconferir: falhou',
      error instanceof SupabaseRestError
        ? { by, operation: error.operation, table: error.table, status: error.status }
        : { by, name: error instanceof Error ? error.name : 'unknown' },
    );
    return fail(502, 'reconferir_failed');
  }
}

/** #356 405 e 415 das rotas que mudam estado: só POST, e o Access também aceita o cookie, então só JSON, que força o preflight de CORS que o Worker não responde. */
function rejectUnlessJsonPost(request: Request): Response | null {
  if (request.method !== 'POST') return fail(405, 'method_not_allowed', { Allow: 'POST' });
  if (!request.headers.get('Content-Type')?.toLowerCase().startsWith('application/json')) return fail(415, 'unsupported_media_type');
  return null;
}

/** #356 O corpo JSON, ou nulo se não há ou não é JSON. */
async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

/** #356 AC-2 O que o log de uma falha do banco diz: a operação, a tabela e o status, nunca o texto do PostgREST nem o e-mail de quem pediu. */
function failureFields(error: unknown): Record<string, unknown> {
  return error instanceof SupabaseRestError
    ? { operation: error.operation, table: error.table, status: error.status }
    : { name: error instanceof Error ? error.name : 'unknown' };
}

/**
 * #356 AC-2 POST /api/admin/rodar-agora: 202 na hora, a rodada manual no `defer`. O corpo não importa (pode ser `{}` ou vazio). A trava e a
 * gravação são da rodada (automation/round.ts): com a trava tomada ela pula e fica gravada como `skipped`. A falha da rodada é gravada
 * por ela; o que escapa dela vai ao log só como classe, sem o e-mail do administrador. O `defer` (waitUntil) vive só ~30 s depois do 202:
 * a rodada manual tem os limites de cron/manual-window.ts, que fecham a conta, e o que não coube fica adiado para a próxima rodada.
 */
function runNowRoute(env: Env, defer: Defer | undefined): Response {
  if (!env.BARTE_ACADEMY_SUPABASE_URL || !env.BARTE_ACADEMY_SUPABASE_SECRET_KEY) return fail(503, 'supabase_not_configured');
  const work = runManualRound(env).catch((error: unknown) => console.error('admin-rodar-agora: falhou', failureFields(error)));
  (defer ?? ((pending) => void pending))(work);
  return Response.json({ accepted: true, origin: 'manual' }, { status: 202 });
}

/** #356 AC-2 O corpo do modo: exatamente `{ "enabled": boolean }`. */
function enabledOf(body: unknown): boolean | null {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return null;
  const keys = Object.keys(body);
  const { enabled } = body as Record<string, unknown>;
  return keys.length === 1 && typeof enabled === 'boolean' ? enabled : null;
}

/**
 * #356 AC-2 POST /api/admin/modo-demonstracao: grava o modo, o e-mail do Access de quem mudou e quando (o e-mail fica só no banco; a
 * resposta e o log não o levam). `conflict` (a versão andou) é 409; `missing` (a migração não semeou a linha) e a falha do banco são o 502 genérico.
 */
async function demoModeRoute(request: Request, identity: Identity, env: Env): Promise<Response> {
  const enabled = enabledOf(await readJson(request));
  if (enabled === null) return fail(400, 'invalid_body');
  const url = env.BARTE_ACADEMY_SUPABASE_URL;
  const secretKey = env.BARTE_ACADEMY_SUPABASE_SECRET_KEY;
  if (!url || !secretKey) return fail(503, 'supabase_not_configured');
  const rest = new SupabaseRest({ url, secretKey });
  try {
    const { mode } = supabaseRoundStore({ rest, finish: rest, log: (line) => console.log(line) });
    const changed = await setDemoMode({ mode, now: () => new Date() }, { enabled, changedBy: identity.email });
    console.log('admin-modo-demonstracao', { enabled });
    return Response.json(changed);
  } catch (error) {
    if (error instanceof DemoModeWriteError && error.reason === 'conflict') return fail(409, 'conflict');
    console.error('admin-modo-demonstracao: falhou', error instanceof DemoModeWriteError ? { reason: error.reason } : failureFields(error));
    return fail(502, 'modo_demonstracao_failed');
  }
}

/** #311 GET /api/admin/dossies: 405 com Allow GET, 503 sem Supabase, 502 genérico quando o banco falha (o log leva só a operação, a tabela e o status). */
async function dossiersRoute(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'GET') return fail(405, 'method_not_allowed', { Allow: 'GET' });
  const url = env.BARTE_ACADEMY_SUPABASE_URL;
  const secretKey = env.BARTE_ACADEMY_SUPABASE_SECRET_KEY;
  if (!url || !secretKey) return fail(503, 'supabase_not_configured');
  try {
    return Response.json(await dossierOverview(new SupabaseRest({ url, secretKey })));
  } catch (error) {
    console.error(
      'admin-dossies: falhou',
      error instanceof SupabaseRestError ? { operation: error.operation, table: error.table, status: error.status } : { name: error instanceof Error ? error.name : 'unknown' },
    );
    return fail(502, 'dossies_failed');
  }
}
