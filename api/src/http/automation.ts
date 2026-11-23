// #211 GET /api/automacao: a última rodada, a próxima, o estado, as últimas 20 e os indicadores.
// #356 AC-5 E, acrescentados (a web de hoje só lê os de antes): o modo demonstração (`demo`), o intervalo do modo, a próxima rodada no
// #356 AC-5 ritmo dele, as rodadas puladas (`skipped`) e se quem pede é administrador (`isAdmin`). O e-mail de quem mudou o modo não sai daqui.
import { isAdmin } from '../approval/admins.js';
import { modeIntervalMinutes } from '../automation/rhythm.js';
import { supabaseRoundStore } from '../automation/round-store.js';
import { readIndicators } from '../automation/readers.js';
import { listRuns, listSkippedRuns } from '../automation/runs.js';
import { automationState, nextRunAt } from '../automation/state.js';
import { SupabaseRest, SupabaseRestError } from '../connectors/supabase-rest.js';
import type { Env } from '../env.js';
import type { Identity } from './access.js';

const RUNS_SHOWN = 20;

export async function automation(identity: Identity, _request: Request, env: Env): Promise<Response> {
  const url = env.BARTE_ACADEMY_SUPABASE_URL;
  const secretKey = env.BARTE_ACADEMY_SUPABASE_SECRET_KEY;
  if (!url || !secretKey) return Response.json({ error: 'supabase_nao_configurado' }, { status: 503 });
  const rest = new SupabaseRest({ url, secretKey });
  const now = new Date();
  try {
    // #356 AC-5 O modo vem do mesmo adaptador da rodada: sem a tabela (migração não aplicada), desligado.
    const { mode } = supabaseRoundStore({ rest, finish: rest, log: (line) => console.log(line) });
    const [runs, indicators, demo, skipped] = await Promise.all([
      listRuns(rest, RUNS_SHOWN),
      readIndicators(rest, now),
      mode.read(),
      listSkippedRuns(rest, RUNS_SHOWN),
    ]);
    const last = runs[0] ?? null;
    const intervalMinutes = modeIntervalMinutes(demo.enabled);
    return Response.json({
      state: automationState(last, now),
      last,
      next: nextRunAt(now, intervalMinutes).toISOString(),
      runs,
      indicators,
      demo: { enabled: demo.enabled, changedAt: demo.changedAt },
      intervalMinutes,
      skipped,
      isAdmin: isAdmin(env.BARTE_ACADEMY_ADMIN_EMAILS, identity.email),
    });
  } catch (error) {
    if (!(error instanceof SupabaseRestError)) throw error;
    console.error(`automacao: ${error.operation} em ${error.table} falhou (HTTP ${error.status})`);
    return Response.json({ error: 'supabase_indisponivel' }, { status: 502 });
  }
}
