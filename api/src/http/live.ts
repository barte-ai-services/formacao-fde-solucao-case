// #354 GET /api/ao-vivo: os passos da automação, do mais novo ao mais velho, e os indicadores do dia.
import { SupabaseApprovalStore } from '../approval/supabase-store.js';
import {
  decisionEvent,
  humanDecisionEvent,
  LIVE_LIMIT,
  newestFirst,
  runEvent,
  type LiveBody,
  type LiveEvent,
} from '../automation/live.js';
import { readIndicators, readInvoiceRefs, readPersonApprovals } from '../automation/readers.js';
import { listRuns } from '../automation/runs.js';
import { SupabaseRest, SupabaseRestError } from '../connectors/supabase-rest.js';
import { SupabaseEngineStore } from '../engine/supabase-store.js';
import type { Env } from '../env.js';
import type { Identity } from './access.js';

/** #354 O cursor é um instante ISO 8601 com fuso, o que `at` devolve. */
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

export async function live(_identity: Identity, request: Request, env: Env): Promise<Response> {
  const raw = new URL(request.url).searchParams.get('since');
  if (raw !== null && (!ISO_INSTANT.test(raw) || Number.isNaN(Date.parse(raw)))) {
    return Response.json({ error: 'since_invalido' }, { status: 400 });
  }
  const since = raw === null ? null : new Date(raw).toISOString();
  const url = env.BARTE_ACADEMY_SUPABASE_URL;
  const secretKey = env.BARTE_ACADEMY_SUPABASE_SECRET_KEY;
  if (!url || !secretKey) return Response.json({ error: 'supabase_nao_configurado' }, { status: 503 });
  const rest = new SupabaseRest({ url, secretKey });
  const after = since ?? undefined;
  try {
    const [runs, decisions, approvals, indicators, awaiting] = await Promise.all([
      listRuns(rest, LIVE_LIMIT, after),
      new SupabaseEngineStore(rest).recentCascade(LIVE_LIMIT, after),
      readPersonApprovals(rest, LIVE_LIMIT, after),
      readIndicators(rest, new Date()),
      new SupabaseApprovalStore(rest).listAwaiting(),
    ]);
    const refs = await readInvoiceRefs(
      rest,
      decisions.map((d) => d.invoiceAccessKey),
      approvals.map((a) => a.proposalId),
    );
    const found: (LiveEvent | null)[] = [
      ...runs.map(runEvent),
      ...decisions.map((d) => decisionEvent(d, refs.byKey.get(d.invoiceAccessKey) ?? { access_key: d.invoiceAccessKey, number: null })),
      ...approvals.flatMap((a) => {
        const invoice = refs.byProposal.get(a.proposalId);
        return invoice ? [humanDecisionEvent(a, invoice)] : [];
      }),
    ];
    const events = newestFirst(found.filter((e): e is LiveEvent => e !== null), LIVE_LIMIT, since);
    const body: LiveBody = { events, since: events[0]?.at ?? since, indicators, awaiting: awaiting.length };
    return Response.json(body);
  } catch (error) {
    if (!(error instanceof SupabaseRestError)) throw error;
    console.error(`ao-vivo: ${error.operation} em ${error.table} falhou (HTTP ${error.status})`);
    return Response.json({ error: 'supabase_indisponivel' }, { status: 502 });
  }
}
