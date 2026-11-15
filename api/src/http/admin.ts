/**
 * #174 Rotas de administração, atrás do Access e só para o papel de administrador.
 *   POST /api/admin/reconferir  { "confirmar": "RECONFERIR" }
 * Apaga as tabelas do domínio (nunca as `kit_*`) e roda o `tick` uma vez; devolve o resumo.
 */
import { isAdmin } from '../approval/admins.js';
import { SupabaseRest } from '../connectors/supabase-rest.js';
import type { Env } from '../env.js';
import { reconferir } from '../ops/reconferir.js';
import type { Identity } from './access.js';

const RECONFERIR_PATH = '/api/admin/reconferir';
const CONFIRMATION = 'RECONFERIR';

const fail = (status: number, error: string, headers?: HeadersInit) => Response.json({ error }, { status, headers });

/** Devolve nulo quando o caminho não é de administração, para o roteador seguir. */
export async function adminRoutes(request: Request, identity: Identity, env: Env): Promise<Response | null> {
  if (new URL(request.url).pathname !== RECONFERIR_PATH) return null;
  if (request.method !== 'POST') return fail(405, 'method_not_allowed', { Allow: 'POST' });
  if (!isAdmin(env.BARTE_ACADEMY_ADMIN_EMAILS, identity.email)) return fail(403, 'forbidden');

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

  try {
    return Response.json(await reconferir(new SupabaseRest({ url, secretKey }), env));
  } catch {
    return fail(502, 'reconferir_failed');
  }
}
