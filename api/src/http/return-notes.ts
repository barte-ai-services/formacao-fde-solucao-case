/**
 * #140 A fila de notas de devolução.
 *   GET  /api/return-notes?status=pendente|emitida|cancelada  (padrão: pendente)
 *   POST /api/return-notes/:id/issue   { nfeNumber }     pendente → emitida
 *   POST /api/return-notes/:id/cancel { justification } pendente → cancelada
 * Quem emite e cancela é a identidade do Access. Falha do Supabase responde 502 sem detalhe.
 */
import { SupabaseRestError } from '../connectors/supabase-rest.js';
import type { SupabaseRest } from '../connectors/supabase-rest.js';
import type { Env } from '../env.js';
import { RETURN_NOTE_STATUSES, supabaseReturnNoteQueue, type ReturnNoteStatus, type TransitionResult } from '../returns/return-notes.js';
import type { Identity } from './access.js';

export interface ReturnNotesDeps {
  /** #140 Monta o cliente do Supabase a partir do Env; nulo sem credenciais. Os testes injetam um fake. */
  supabase?: (env: Env) => SupabaseRest | null;
  now?: () => Date;
}

const PATH = /^\/api\/return-notes(?:\/([^/]+)\/(issue|cancel))?$/;
const NFE_NUMBER = /^\d{1,9}$/;
const MAX_JUSTIFICATION = 500;

const fail = (status: number, error: string, headers?: HeadersInit) => Response.json({ error }, { status, headers });

async function bodyOf(request: Request): Promise<Record<string, unknown>> {
  try {
    const body: unknown = await request.json();
    return typeof body === 'object' && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

function answer(result: TransitionResult): Response {
  if (result.kind === 'ok') return Response.json(result.note);
  return result.kind === 'conflict' ? fail(409, 'already_decided') : fail(404, 'not_found');
}

/** Devolve nulo quando o caminho não é desta fila, para o roteador seguir. */
export async function returnNoteRoutes(
  request: Request,
  identity: Identity,
  env: Env,
  deps: ReturnNotesDeps,
  fallbackSupabase: (env: Env) => SupabaseRest | null,
): Promise<Response | null> {
  const match = PATH.exec(new URL(request.url).pathname);
  if (!match) return null;
  const [, rawId, action] = match;

  const wanted = action ? 'POST' : 'GET';
  if (request.method !== wanted) return fail(405, 'method_not_allowed', { Allow: wanted });
  if (action && !/^\d+$/.test(rawId ?? '')) return fail(404, 'not_found');

  const rest = (deps.supabase ?? fallbackSupabase)(env);
  if (!rest) return fail(503, 'supabase_not_configured');
  const queue = supabaseReturnNoteQueue(rest);
  const now = (deps.now ?? (() => new Date()))();

  try {
    if (!action) {
      const param = new URL(request.url).searchParams.get('status') ?? 'pendente';
      if (!(RETURN_NOTE_STATUSES as readonly string[]).includes(param)) return fail(400, 'invalid_status');
      return Response.json({ notes: await queue.list(param as ReturnNoteStatus, now) });
    }

    const by = identity.email;
    if (!by) return fail(403, 'forbidden');
    const body = await bodyOf(request);
    const id = Number(rawId);
    if (action === 'issue') {
      const nfeNumber = text(body.nfeNumber);
      if (!NFE_NUMBER.test(nfeNumber)) return fail(400, 'invalid_nfe_number');
      return answer(await queue.emit(id, nfeNumber, by, now));
    }
    const justification = text(body.justification);
    if (justification === '' || justification.length > MAX_JUSTIFICATION) return fail(400, 'invalid_justification');
    return answer(await queue.cancel(id, justification, by, now));
  } catch (error) {
    if (!(error instanceof SupabaseRestError)) throw error;
    console.error('return-notes: falha do Supabase', { operation: error.operation, table: error.table, status: error.status });
    return fail(502, 'supabase_unavailable');
  }
}
