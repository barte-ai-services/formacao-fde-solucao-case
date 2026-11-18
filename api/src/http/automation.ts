// #211 GET /api/automacao: a última rodada, a próxima, o estado, as últimas 20 e os indicadores.
import { computeIndicators } from '../automation/indicators.js';
import { readDecisionRecords } from '../automation/readers.js';
import { listRuns } from '../automation/runs.js';
import { automationState, nextRunAt } from '../automation/state.js';
import { SupabaseRest, SupabaseRestError } from '../connectors/supabase-rest.js';
import type { Env } from '../env.js';
import type { Identity } from './access.js';
import { todayInBrasilia } from './approval.js';

const RUNS_SHOWN = 20;

export async function automation(_identity: Identity, _request: Request, env: Env): Promise<Response> {
  const url = env.BARTE_ACADEMY_SUPABASE_URL;
  const secretKey = env.BARTE_ACADEMY_SUPABASE_SECRET_KEY;
  if (!url || !secretKey) return Response.json({ error: 'supabase_nao_configurado' }, { status: 503 });
  const rest = new SupabaseRest({ url, secretKey });
  const now = new Date();
  try {
    const [runs, records] = await Promise.all([listRuns(rest, RUNS_SHOWN), readDecisionRecords(rest, `${todayInBrasilia(now).slice(0, 7)}-01`)]);
    const last = runs[0] ?? null;
    return Response.json({
      state: automationState(last, now),
      last,
      next: nextRunAt(now).toISOString(),
      runs,
      indicators: computeIndicators(records, now),
    });
  } catch (error) {
    if (!(error instanceof SupabaseRestError)) throw error;
    console.error(`automacao: ${error.operation} em ${error.table} falhou (HTTP ${error.status})`);
    return Response.json({ error: 'supabase_indisponivel' }, { status: 502 });
  }
}
