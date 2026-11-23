/*
 * #356 O adaptador das portas da rodada (automation/round.ts) sobre o SupabaseRest: o modo (demo_settings), a trava
 * (automation_lock, pelas funções take_automation_lock e release_automation_lock) e a gravação da rodada (automation_runs).
 * Cada chamada a uma porta é UMA requisição, que é o que o ROUND_RESERVE de round-budget.ts conta; a gravação refeita sem as colunas
 * novas é a segunda, e a reserva de 7 a prevê.
 *
 * ANTES DA MIGRAÇÃO (20261123100000_modo_demonstracao.sql, aplicada pelo supabase-base-do-kit.yml, que corre em paralelo ao deploy do
 * Worker): cada porta decide o que fazer sem o que a migração cria, e nenhuma derruba a rodada.
 *  - modo: sem a tabela, desligado (o ritmo de 15 minutos de sempre);
 *  - trava: sem a função, a rodada segue SEM trava e o log diz. É o que ela fazia antes de existir trava; a alternativa, pular, deixaria
 *    a automação parada até a migração entrar, e soltar a trava que não existe não gasta requisição;
 *  - adiados: sem a coluna, nada adiado (a ordem de hoje);
 *  - gravação: sem as colunas, refaz uma vez só com as de antes (como recordRun, #311).
 * Escrever o modo sem a tabela falha: ligar o modo que não foi gravado seria mentir a quem pediu. A escrita são duas requisições (a leitura da
 * versão e o PATCH condicionado a ela), fora da rodada; a leitura do modo da rodada segue uma.
 *
 * O que sai daqui: o log leva só o nome do objeto que falta e a decisão tomada, nunca o texto nem o corpo do erro do PostgREST.
 */
import { arrayOf, isBoolean, isInteger, isRecord, isString, nullable, parseOne, parseRows, shaped, type Shape } from '../connectors/guards.js';
import { isMissingSchema, SupabaseRestError, type SupabaseRest } from '../connectors/supabase-rest.js';
import type { DemoModeState, RoundPorts, RoundRecord } from './round.js';
import { runRow } from './runs.js';

export type RoundStoreConfig = {
  /** #356 O SupabaseRest dos passos: modo, trava e adiados. */
  readonly rest: SupabaseRest;
  /** #356 O da reserva: a gravação da rodada e a soltura da trava, o único que gasta o que o orçamento guarda para o fim. */
  readonly finish: SupabaseRest;
  /** #356 Uma linha sem dado sensível. */
  readonly log: (line: string) => void;
};

/**
 * #356 AC-2 A troca de modo que não gravou: `conflict` (a versão lida andou, ou nenhuma linha passou no filtro) ou `missing` (a migração
 * semeia a linha; sem ela não há o que condicionar). A camada API mapeia `conflict` para 409. Só a razão: nunca o e-mail nem o history.
 */
export class DemoModeWriteError extends Error {
  constructor(readonly reason: 'conflict' | 'missing') {
    super(`demo-mode: a troca de modo não foi gravada (${reason})`);
    this.name = 'DemoModeWriteError';
  }
}

type ModeRow = { enabled: boolean; changed_at: string | null };
type ModeVersionRow = { version: number; history: Record<string, unknown>[] };
type DeferredRow = { deferred_steps: string[] };

const isModeRow = shaped<ModeRow>({ enabled: isBoolean, changed_at: nullable(isString) } satisfies Shape<ModeRow>);
const isModeVersionRow = shaped<ModeVersionRow>({ version: isInteger, history: arrayOf(isRecord) } satisfies Shape<ModeVersionRow>);
const isDeferredRow = shaped<DeferredRow>({ deferred_steps: arrayOf(isString) } satisfies Shape<DeferredRow>);

/** #356 AC-3 O rpc devolve verdadeiro ou falso; qualquer outra coisa é resposta fora do formato. */
function expectBoolean(value: unknown, fn: string): boolean {
  if (typeof value !== 'boolean') throw new SupabaseRestError('parse', `rpc/${fn}`, 0, 'a resposta não é verdadeiro ou falso');
  return value;
}

export function supabaseRoundStore(config: RoundStoreConfig): Pick<RoundPorts, 'mode' | 'lock' | 'history'> {
  const { rest, finish, log } = config;
  // #356 AC-3 Uma instância por rodada: lembra que a função da trava não existe, para soltar não gastar uma requisição à toa.
  let lockMissing = false;

  const mode: RoundPorts['mode'] = {
    async read(): Promise<DemoModeState> {
      try {
        const rows = parseRows(await rest.select('demo_settings', { select: 'enabled,changed_at', limit: 1 }), isModeRow, 'demo_settings');
        const row = rows[0];
        return { enabled: row?.enabled ?? false, changedAt: row?.changed_at ?? null };
      } catch (error) {
        if (!isMissingSchema(error)) throw error;
        log('cron: demo_settings ausente (migração não aplicada); modo desligado');
        return { enabled: false, changedAt: null };
      }
    },
    async write(change): Promise<void> {
      // #356 AC-2 Lê a versão e grava por PATCH filtrado por ela: a escrita sobre o estado velho não pega linha e é recusada.
      const rows = parseRows(
        await rest.select('demo_settings', { select: 'version,history', filters: { id: 'eq.true' }, limit: 1 }),
        isModeVersionRow,
        'demo_settings',
      );
      const current = rows[0];
      if (current === undefined) throw new DemoModeWriteError('missing');
      const version = current.version + 1;
      const at = change.changedAt.toISOString();
      const updated = await rest.update(
        'demo_settings',
        { id: 'eq.true', version: `eq.${current.version}` },
        {
          enabled: change.enabled, changed_by: change.changedBy, changed_at: at, version,
          history: [...current.history, { version, at, by: change.changedBy, enabled: change.enabled }],
        },
      );
      if (updated.length === 0) throw new DemoModeWriteError('conflict');
    },
  };

  const lock: RoundPorts['lock'] = {
    async take(owner, validForMs): Promise<boolean> {
      try {
        return expectBoolean(await rest.rpc('take_automation_lock', { p_owner: owner, p_valid_for_ms: validForMs }), 'take_automation_lock');
      } catch (error) {
        if (!isMissingSchema(error)) throw error;
        lockMissing = true;
        log('cron: trava ausente (migração não aplicada); a rodada segue sem trava');
        return true;
      }
    },
    async release(owner): Promise<void> {
      if (lockMissing) return;
      expectBoolean(await finish.rpc('release_automation_lock', { p_owner: owner }), 'release_automation_lock');
    },
  };

  const history: RoundPorts['history'] = {
    async lastDeferred(): Promise<readonly string[]> {
      try {
        const rows = await rest.select('automation_runs', {
          select: 'deferred_steps', order: 'started_at.desc', limit: 1, filters: { status: 'in.(ok,failed)' },
        });
        const row = rows[0];
        return row === undefined ? [] : parseOne(row, isDeferredRow, 'automation_runs').deferred_steps;
      } catch (error) {
        if (isMissingSchema(error)) return [];
        throw error;
      }
    },
    async record(record: RoundRecord): Promise<void> {
      const row = runRow(record);
      try {
        await finish.insert('automation_runs', [{
          ...row, origin: record.origin, demo_enabled: record.demoEnabled, deferred_steps: [...record.deferredSteps],
          failed_steps: [...record.failedSteps], subrequests: record.subrequests,
        }]);
      } catch (error) {
        // #356 A pulada não se refaz: o check antigo não conhece `skipped`, e o reenvio gastaria uma requisição à toa.
        if (record.status === 'skipped' || !(error instanceof SupabaseRestError) || error.code !== 'PGRST204') throw error;
        // #356 Um reenvio só, sem TODAS as colunas novas: o PostgREST aponta uma coluna ausente por vez, sem ordem garantida, e a reserva só tem uma requisição para isto.
        await finish.insert('automation_runs', [row]);
      }
    },
  };

  return { mode, lock, history };
}
