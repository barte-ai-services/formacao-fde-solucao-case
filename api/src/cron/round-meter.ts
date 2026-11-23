/*
 * #356 AC-4 O medidor da rodada, UM só: o contador de subrequests da #311 (cron/subrequests.ts, `countSubrequests`) com o que a
 * rodada orçada acrescenta, sem outra conta ao lado. A camada API monta um por rodada e passa a tudo o que sai do Worker:
 * `new SupabaseRest({ fetch: meter.fetch })`, `runClaudeRound(..., { fetch })` e `meter.env` no lugar do env, para o `ai.run` do
 * Workers AI entrar na mesma conta. A gravação da rodada e a soltura da trava usam `meter.reservedFetch`, o único que gasta a
 * reserva (`FINISH_RESERVE`).
 *
 * O que o medidor soma ao contador da #311: o corte de tempo da rodada (AC-3), o `ai.run` contado, e o `spent()` que é a porta de
 * automation/round.ts. O contador faz a conta e a recusa por teto: o fetch dos passos recusa, sem subrequest, a chamada que
 * invadiria a reserva, e o passo falha em vez da gravação.
 *
 * Não remenda `globalThis.fetch`: o isolate do Workers o compartilha entre invocações concorrentes (o cron, o rodar-agora, outras
 * requisições), e trocá-lo contaria e cortaria o fetch alheio. Dois medidores ao mesmo tempo não se enxergam.
 */
import { ROUND_LIMIT_MS } from '../automation/round-budget.js';
import type { FetchFn } from '../connectors/supabase-rest.js';
import type { Env } from '../env.js';
import { countSubrequests, SUBREQUEST_CAP } from './subrequests.js';

/**
 * #356 AC-4 O que a fase dos passos deixa para a rodada: a gravação (o insert e o reenvio sem as colunas novas quando o Worker
 * sobe antes da migração, recordRun) e a soltura da trava. É a reserva do contador da #311, de 2 para 3 porque a soltura é nossa.
 */
export const FINISH_RESERVE = 3;

/** #356 AC-3 O limite de tempo da rodada passou: nenhum fetch novo sai. Só o fato, sem a URL nem dado nenhum. */
export class RoundLimitError extends Error {
  constructor() {
    super('prazo da rodada esgotado: nenhuma chamada nova');
    this.name = 'RoundLimitError';
  }
}

export type RoundMeter = {
  /** #356 AC-4 Quantas subrequests saíram por este medidor (com falha ou sem). */
  spent(): number;
  /** #356 AC-4 Quantas chamadas, ou passos inteiros, foram recusadas por falta de teto ou de tempo (o passo que engole a recusa também falhou). */
  refused(): number;
  /** #356 AC-4 O fetch contado dos passos: passe-o ao SupabaseRest, ao Claude e às portas de leitura. Recusa no teto menos a reserva e depois do limite de tempo. */
  readonly fetch: FetchFn;
  /** #356 AC-4 O fetch da gravação da rodada e da soltura da trava: o único que gasta a reserva, sem corte de tempo, ainda dentro do teto. */
  readonly reservedFetch: FetchFn;
  /** #356 AC-4 O env da rodada: o mesmo, com o `ai` contado. Passe-o aos passos no lugar do original. */
  readonly env: Env;
};

export type RoundMeterOptions = {
  readonly limitMs?: number;
  readonly now?: () => number;
  /** #356 AC-4 O fetch a contar; sem ele, o global do Worker, lido na hora de cada chamada e nunca trocado. */
  readonly fetch?: FetchFn;
  /** #356 AC-4 Só conta, sem teto nem corte de tempo: é como o teste mede o gasto de uma rodada sem que a medida a interrompa. */
  readonly measureOnly?: boolean;
};

/** #356 AC-4 Começa a medir: o relógio da rodada (limite de ROUND_LIMIT_MS) corre a partir daqui. */
export function startRoundMeter(env: Env, options: RoundMeterOptions = {}): RoundMeter {
  const now = options.now ?? Date.now;
  const limitMs = options.limitMs ?? ROUND_LIMIT_MS;
  const base: FetchFn = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const counter = countSubrequests(base, options.measureOnly ? undefined : { cap: SUBREQUEST_CAP, reserve: FINISH_RESERVE });
  const startedAt = now();
  let late = 0;
  const admitTime = (): void => {
    if (!options.measureOnly && now() - startedAt >= limitMs) {
      late += 1;
      throw new RoundLimitError();
    }
  };
  const fetch: FetchFn = (input, init) => {
    try {
      admitTime();
    } catch (e) {
      return Promise.reject(e);
    }
    return counter.fetch(input, init);
  };
  return {
    spent: counter.count,
    refused: () => counter.refused() + late,
    fetch,
    reservedFetch: counter.reservedFetch,
    env: env.ai ? { ...env, ai: countedAi(env.ai, () => { admitTime(); counter.admit(); }) } : env,
  };
}

/** #356 AC-4 O binding do Workers AI com `run` contado; o resto do binding segue como estava. */
function countedAi(ai: Ai, admit: () => void): Ai {
  return new Proxy(ai, {
    get(real, key) {
      const value: unknown = Reflect.get(real, key);
      if (key !== 'run' || typeof value !== 'function') return typeof value === 'function' ? value.bind(real) : value;
      return (...args: unknown[]): unknown => {
        try {
          admit();
        } catch (e) {
          return Promise.reject(e);
        }
        return value.apply(real, args);
      };
    },
  });
}
