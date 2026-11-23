// #311 O que o administrador vê do dossiê automático em GET /api/admin/dossies: as contagens das sugestões por gatilho e status e os
// #311 pedidos que ainda esperam (pending) ou que falharam (error). Só colunas nomeadas: nada de saída do Claude, entrada, texto do erro nem
// #311 quem pediu (requested_by é e-mail).
import { isString, nullable, oneOf, parseRows, shaped, type Shape } from '../connectors/guards.js';
import type { SupabaseRest } from '../connectors/supabase-rest.js';
import { DOSSIER_TASK } from './source.js';
import type { DossierTrigger, RequestReason, RequestStatus } from './requests.js';

type SuggestionCount = { readonly trigger: string; readonly status: string; readonly count: number };

/** #311 Um pedido como o administrador o vê, sem o e-mail de quem pediu. */
export type RequestView = {
  readonly input_key: string;
  readonly trigger: DossierTrigger;
  readonly status: RequestStatus;
  readonly reason: RequestReason | null;
  readonly requested_at: string;
  readonly finished_at: string | null;
};

export type DossierOverview = { readonly suggestions: SuggestionCount[]; readonly requests: RequestView[] };

type SuggestionRow = { readonly trigger: string; readonly status: string };
const isSuggestionRow = shaped<SuggestionRow>({ trigger: isString, status: isString } satisfies Shape<SuggestionRow>);

const REQUEST_COLUMNS = 'input_key,trigger,status,reason,requested_at,finished_at';
const isRequestView = shaped<RequestView>({
  input_key: isString,
  trigger: oneOf('event', 'on_demand'),
  status: oneOf('pending', 'running', 'done', 'error'),
  reason: nullable(oneOf('no_credentials', 'rate_limited', 'auth_refused', 'claude_failed', 'storage_failed', 'not_needed')),
  requested_at: isString,
  finished_at: nullable(isString),
} satisfies Shape<RequestView>);

/** #311 Duas leituras: as sugestões do dossiê (só trigger e status, contadas aqui) e os pedidos pending ou error. */
export async function dossierOverview(rest: SupabaseRest): Promise<DossierOverview> {
  const suggestionRows = parseRows(
    await rest.select('claude_suggestions', { select: 'trigger,status', filters: { task: `eq.${DOSSIER_TASK}` }, order: 'input_key.asc' }),
    isSuggestionRow,
    'claude_suggestions',
  );
  const requests = parseRows(
    await rest.select('dossier_requests', { select: REQUEST_COLUMNS, filters: { status: 'in.(pending,error)' }, order: 'requested_at.desc' }),
    isRequestView,
    'dossier_requests',
  );
  return { suggestions: countBy(suggestionRows), requests };
}

function countBy(rows: readonly SuggestionRow[]): SuggestionCount[] {
  const counts = new Map<string, SuggestionCount>();
  for (const { trigger, status } of rows) {
    const key = `${trigger}/${status}`;
    counts.set(key, { trigger, status, count: (counts.get(key)?.count ?? 0) + 1 });
  }
  return [...counts.values()].sort((a, b) => a.trigger.localeCompare(b.trigger) || a.status.localeCompare(b.status));
}
