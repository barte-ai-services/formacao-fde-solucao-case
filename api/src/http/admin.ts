/**
 * #174 Rotas de administração, atrás do Access e só para o papel de administrador.
 *   POST /api/admin/reconferir  { "confirmar": "RECONFERIR" }
 * Apaga as tabelas do domínio (nunca as `kit_*`) e roda o `tick` uma vez; devolve o resumo.
 *   GET /api/admin/dossies
 * #311 Só leitura: as contagens do dossiê por gatilho e status e os pedidos pendentes ou com erro, para ver o caminho automático sem o banco.
 */
import { isAdmin } from '../approval/admins.js';
import { SupabaseRest, SupabaseRestError } from '../connectors/supabase-rest.js';
import type { Env } from '../env.js';
import { dossierOverview } from '../dossier/overview.js';
import { reconferir } from "../ops/reconferir.js";
import type { Identity } from './access.js';

const RECONFERIR_PATH = '/api/admin/reconferir';
const CONFIRMATION = 'RECONFERIR';

const DOSSIES_PATH = '/api/admin/dossies';

const fail = (status: number, error: string, headers?: HeadersInit) => Response.json({ error }, { status, headers });

/** Devolve nulo quando o caminho não é de administração, para o roteador seguir. */
export async function adminRoutes(request: Request, identity: Identity, env: Env): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  if (path !== RECONFERIR_PATH && path !== DOSSIES_PATH) return null;
  if (!isAdmin(env.BARTE_ACADEMY_ADMIN_EMAILS, identity.email)) return fail(403, 'forbidden');
  if (path === DOSSIES_PATH) return dossiesRoute(request, env);
  if (request.method !== 'POST') return fail(405, 'method_not_allowed', { Allow: 'POST' });
  // Muda estado e o Access também aceita o cookie: só JSON, que força o preflight de CORS que o Worker não responde.
  if (!request.headers.get('Content-Type')?.toLowerCase().startsWith('application/json')) {
    return fail(415, 'unsupported_media_type');
  }

  let body: unknown = null;
  try {
    body = await request.json();
  } catch {
    body = null;
  }
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
    console.error(
      'admin-reconferir: falhou',
      error instanceof SupabaseRestError
        ? { by, operation: error.operation, table: error.table, status: error.status }
        : { by, name: error instanceof Error ? error.name : 'unknown' },
    );
    return fail(502, 'reconferir_failed');
  }
}

/** #311 GET /api/admin/dossies: 405 com Allow GET, 503 sem Supabase, 502 genérico quando o banco falha (o log leva só a operação, a tabela e o status). */
async function dossiesRoute(request: Request, env: Env): Promise<Response> {
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
