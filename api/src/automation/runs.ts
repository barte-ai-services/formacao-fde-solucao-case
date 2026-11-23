// #211 AC-1 Cada rodada do Cron fica em automation_runs: só números e a classe do erro, nada sensível.
import { arrayOf, isBoolean, isInteger, isString, nullable, oneOf, optional, parseRows, shaped, type Shape } from '../connectors/guards.js';
import { isMissingSchema, SupabaseRestError, type SupabaseRest } from '../connectors/supabase-rest.js';

const TABLE = 'automation_runs';

/** #211 O que a rodada fez. Os nomes seguem o log do `tick`. */
export type RunFigures = {
  seen: number;
  inserted: number;
  checked: number;
  failed: number;
  proposed: number;
  approvedByRule: number;
  cadastroE8: number;
  dockPublished: number;
  storePublished: number;
  duplicatesBlocked: number;
  /** #41 Propostas que o motor de decisão avaliou na rodada (no modo sombra ou, #42, no delegado). */
  engineEvaluated: number;
  /** #42 Propostas que o motor aprovou na rodada (modo delegado); zero no modo sombra. */
  engineApproved: number;
};

export const NO_FIGURES: RunFigures = {
  seen: 0, inserted: 0, checked: 0, failed: 0, proposed: 0, approvedByRule: 0,
  cadastroE8: 0, dockPublished: 0, storePublished: 0, duplicatesBlocked: 0, engineEvaluated: 0,
  engineApproved: 0,
};

export type RunStatus = 'ok' | 'failed';

export type AutomationRun = {
  id: number;
  startedAt: string;
  finishedAt: string;
  status: RunStatus;
  figures: RunFigures;
  /** #211 A classe do erro (ex.: `SupabaseRestError`), nunca a mensagem. */
  error: string | null;
  /**
   * #311 Os passos periféricos que falharam na rodada (nomes fixos, ex.: `dock`, `claude`). A rodada com passo falho continua `ok` no status:
   * o enum não muda, e quem lê procura aqui. Vazio nas linhas antigas e nas rodadas sem falha.
   */
  failedSteps: string[];
  /** #311 Os subrequests que a invocação gastou, contra os 50 do plano; nulo nas linhas anteriores à contagem. */
  subrequests: number | null;
};

type Row = {
  id: number; started_at: string; finished_at: string; status: RunStatus;
  seen: number; inserted: number; checked: number; failed: number; proposed: number;
  approved_by_rule: number; cadastro_e8: number; dock_published: number; store_published: number;
  duplicates_blocked: number; engine_evaluated: number; engine_approved: number; error: string | null;
  // #311 Opcionais na leitura: antes da migração 20261122130000 a coluna não vem.
  failed_steps?: string[]; subrequests?: number | null;
};

const isRow = shaped<Row>({
  id: isInteger, started_at: isString, finished_at: isString, status: oneOf('ok', 'failed'),
  seen: isInteger, inserted: isInteger, checked: isInteger, failed: isInteger, proposed: isInteger,
  approved_by_rule: isInteger, cadastro_e8: isInteger, dock_published: isInteger, store_published: isInteger,
  duplicates_blocked: isInteger, engine_evaluated: isInteger, engine_approved: isInteger, error: nullable(isString),
  failed_steps: optional(arrayOf(isString)), subrequests: optional(nullable(isInteger)),
} satisfies Shape<Row>);

/** #356 As colunas de sempre de uma linha de automation_runs (as que existem em qualquer versão do banco). */
export function runRow(run: {
  startedAt: Date; finishedAt: Date; status: RunStatus | 'skipped'; figures: RunFigures; error?: string | null;
}): Record<string, unknown> {
  const f = run.figures;
  return {
    started_at: run.startedAt.toISOString(),
    finished_at: run.finishedAt.toISOString(),
    status: run.status,
    seen: f.seen, inserted: f.inserted, checked: f.checked, failed: f.failed, proposed: f.proposed,
    approved_by_rule: f.approvedByRule, cadastro_e8: f.cadastroE8, dock_published: f.dockPublished,
    store_published: f.storePublished, duplicates_blocked: f.duplicatesBlocked,
    engine_evaluated: f.engineEvaluated,
    engine_approved: f.engineApproved,
    error: run.error ?? null,
  };
}

/** #211 Grava a rodada. Quem chama não deixa a falha daqui derrubar o Cron. */
export async function recordRun(
  rest: SupabaseRest,
  run: {
    startedAt: Date; finishedAt: Date; status: RunStatus; figures: RunFigures; error?: string | null;
    /** #311 Os passos periféricos que falharam e os subrequests da invocação (a própria gravação incluída). */
    failedSteps?: readonly string[]; subrequests?: number;
  },
): Promise<void> {
  const row = runRow(run);
  try {
    await rest.insert(TABLE, [{ ...row, failed_steps: run.failedSteps ?? [], subrequests: run.subrequests ?? null }]);
  } catch (error) {
    // #311 O deploy do Worker e a migração das colunas novas correm em paralelo (deploy-api.yml e supabase-base-do-kit.yml): se o
    // #311 Worker sobe antes, o PostgREST recusa o insert com PGRST204 (coluna fora do cache do esquema). Refaz sem elas, para a
    // #311 rodada não se perder; é por isso que a gravação reserva dois subrequests (o insert e este reenvio).
    if (!(error instanceof SupabaseRestError) || error.code !== 'PGRST204') throw error;
    await rest.insert(TABLE, [row]);
  }
}

/** #211 As últimas rodadas, da mais nova para a mais velha. #354 Com `afterIso`, só as iniciadas depois dele; `asc` as devolve da mais velha à mais nova. */
export async function listRuns(rest: SupabaseRest, limit: number, afterIso?: string, direction: 'asc' | 'desc' = 'desc'): Promise<AutomationRun[]> {
  // #356 AC-5 Só as rodadas que rodaram: a pulada (`skipped`) tem lista própria e não quebra a web, que só conhece ok e failed.
  const filters = { status: 'in.(ok,failed)', ...(afterIso !== undefined && { started_at: `gt.${afterIso}` }) };
  const rows = parseRows(await rest.select(TABLE, { order: `started_at.${direction}`, limit, filters }), isRow, TABLE);
  return rows.map((r) => ({
    id: r.id,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    status: r.status,
    error: r.error,
    failedSteps: r.failed_steps ?? [],
    subrequests: r.subrequests ?? null,
    figures: {
      seen: r.seen, inserted: r.inserted, checked: r.checked, failed: r.failed, proposed: r.proposed,
      approvedByRule: r.approved_by_rule, cadastroE8: r.cadastro_e8, dockPublished: r.dock_published,
      storePublished: r.store_published, duplicatesBlocked: r.duplicates_blocked,
      engineEvaluated: r.engine_evaluated,
      engineApproved: r.engine_approved,
    },
  }));
}

/** #356 AC-5 Uma rodada pulada porque outra tinha a trava: quando, de que origem e em que modo. */
export type SkippedRun = { id: number; startedAt: string; origin: 'cron' | 'manual'; demoEnabled: boolean };

type SkippedRow = { id: number; started_at: string; origin: 'cron' | 'manual'; demo_enabled: boolean };

const isSkippedRow = shaped<SkippedRow>({
  id: isInteger, started_at: isString, origin: oneOf('cron', 'manual'), demo_enabled: isBoolean,
} satisfies Shape<SkippedRow>);

/** #356 AC-5 As últimas rodadas puladas, da mais nova à mais velha. Sem as colunas novas (migração não aplicada) não há puladas. */
export async function listSkippedRuns(rest: SupabaseRest, limit: number): Promise<SkippedRun[]> {
  try {
    const rows = await rest.select(TABLE, {
      select: 'id,started_at,origin,demo_enabled', order: 'started_at.desc', limit, filters: { status: 'eq.skipped' },
    });
    return parseRows(rows, isSkippedRow, TABLE).map((r) => ({ id: r.id, startedAt: r.started_at, origin: r.origin, demoEnabled: r.demo_enabled }));
  } catch (error) {
    if (isMissingSchema(error)) return [];
    throw error;
  }
}
