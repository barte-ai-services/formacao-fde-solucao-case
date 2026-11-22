// #354 GET /api/ao-vivo: os passos da automação, do mais novo ao mais velho, e os indicadores do dia.
import { SupabaseApprovalStore } from '../approval/supabase-store.js';
import {
  decisionEvent,
  humanDecisionEvent,
  LIVE_LIMIT,
  drain,
  newest,
  runEvent,
  type LiveBody,
  type LiveEvent,
  type Stamped,
} from '../automation/live.js';
import { readIndicators, readInvoiceRefs, readPersonApprovals } from '../automation/readers.js';
import { listRuns } from '../automation/runs.js';
import { SupabaseRest, SupabaseRestError } from '../connectors/supabase-rest.js';
import { SupabaseEngineStore } from '../engine/supabase-store.js';
import type { Env } from '../env.js';
import type { Identity } from './access.js';

/** #354 O cursor é um instante ISO 8601 com fuso, o que `at` devolve. */
const ISO_INSTANT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(?:Z|[+-](\d{2}):(\d{2}))$/;

/** #354 Só passa o que o Postgres aceita: o dia existe no calendário e hora, minuto, segundo e fuso estão na faixa. */
function isValidSince(text: string): boolean {
  const m = ISO_INSTANT.exec(text);
  if (m === null) return false;
  const field = (index: number): number => Number(m[index] ?? 0);
  const [year, month, day, hour, minute, second, offsetHour, offsetMinute] = [1, 2, 3, 4, 5, 6, 7, 8].map(field) as [number, number, number, number, number, number, number, number];
  const existsOnCalendar = month >= 1 && month <= 12 && day >= 1 && day <= new Date(Date.UTC(year, month, 0)).getUTCDate();
  return existsOnCalendar && hour <= 23 && minute <= 59 && second <= 59 && offsetHour <= 23 && offsetMinute <= 59 && !Number.isNaN(Date.parse(text));
}

export async function live(_identity: Identity, request: Request, env: Env): Promise<Response> {
  const raw = new URL(request.url).searchParams.get('since');
  if (raw !== null && !isValidSince(raw)) {
    return Response.json({ error: 'since_invalido' }, { status: 400 });
  }
  // #354 O cursor segue como a tela o mandou (o texto do banco, com microssegundos): normalizar em milissegundos pularia passos.
  const since = raw;
  const url = env.BARTE_ACADEMY_SUPABASE_URL;
  const secretKey = env.BARTE_ACADEMY_SUPABASE_SECRET_KEY;
  if (!url || !secretKey) return Response.json({ error: 'supabase_nao_configurado' }, { status: 503 });
  const rest = new SupabaseRest({ url, secretKey });
  // #354 Com cursor, as fontes saem do mais velho ao mais novo (o atraso esvazia sem perder passo); sem cursor, os mais novos.
  const direction = since === null ? 'desc' : 'asc';
  const after = since ?? undefined;
  try {
    const [runs, decisions, approvals, indicators, awaiting] = await Promise.all([
      listRuns(rest, LIVE_LIMIT, after, direction),
      new SupabaseEngineStore(rest).recentCascade(LIVE_LIMIT, after, direction),
      readPersonApprovals(rest, LIVE_LIMIT, after, direction),
      readIndicators(rest, new Date()),
      new SupabaseApprovalStore(rest).listAwaiting(),
    ]);
    const refs = await readInvoiceRefs(
      rest,
      decisions.map((d) => d.invoiceAccessKey),
      approvals.approvals.map((a) => a.proposalId),
    );
    const stamp = (event: LiveEvent | null, raw: string): Stamped[] => (event === null ? [] : [{ event, raw }]);
    const fromRuns = runs.flatMap((r) => stamp(runEvent(r), r.startedAt));
    const fromDecisions = decisions.flatMap((d) =>
      stamp(decisionEvent(d, refs.byKey.get(d.invoiceAccessKey) ?? { access_key: d.invoiceAccessKey, number: null }), d.decidedAt),
    );
    const fromApprovals = approvals.approvals.flatMap((a) => {
      const invoice = refs.byProposal.get(a.proposalId);
      return invoice ? stamp(humanDecisionEvent(a, invoice), a.approvedAt) : [];
    });
    const horizonOf = (rows: readonly { raw: string }[], full: boolean): string | null => (full ? (rows.at(-1)?.raw ?? null) : null);
    const page =
      since === null
        ? newest([...fromRuns, ...fromDecisions, ...fromApprovals], LIVE_LIMIT)
        : drain(
            [
              { steps: fromRuns, horizon: horizonOf(runs.map((r) => ({ raw: r.startedAt })), runs.length === LIVE_LIMIT) },
              { steps: fromDecisions, horizon: horizonOf(decisions.map((d) => ({ raw: d.decidedAt })), decisions.length === LIVE_LIMIT) },
              { steps: fromApprovals, horizon: approvals.horizon },
            ],
            LIVE_LIMIT,
            since,
          );
    const body: LiveBody = { events: page.events, since: page.since, indicators, awaiting: awaiting.length };
    return Response.json(body);
  } catch (error) {
    if (!(error instanceof SupabaseRestError)) throw error;
    console.error(`ao-vivo: ${error.operation} em ${error.table} falhou (HTTP ${error.status})`);
    return Response.json({ error: 'supabase_indisponivel' }, { status: 502 });
  }
}
