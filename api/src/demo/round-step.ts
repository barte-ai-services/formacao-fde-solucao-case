// O trabalho do passo "notas novas" da rodada (#349): a rodada da #348 só o embrulha num `RoundStep`.
import type { SupabaseRest } from '../connectors/supabase-rest.js';
import { demoNoteCount, generateDemoBatch } from './generator.js';
import { DemoNoteInserter } from './inserter.js';

/** (#349) O nome do passo na lista da rodada. */
export const DEMO_NOTES_STEP_NAME = 'notas-demo';
/** (#349) O custo declarado, em subrequests: 1 leitura da última nota demo + 1 rpc de gravação em lote. */
export const DEMO_NOTES_STEP_COST = 2;

const DEMO_NOTE_ID = /^DM-(\d{5})$/;

export type DemoNotesRoundDeps = {
  readonly rest: Pick<SupabaseRest, 'select' | 'rpc'>;
  /** O modo demonstração ligado? Desligado, o passo não faz requisição nenhuma. */
  readonly enabled: boolean;
  readonly now: Date;
};

/** (#349) O número da próxima nota: a seguinte à última nota demo gravada, ou 1 se ainda não há. */
async function nextSequence(rest: Pick<SupabaseRest, 'select'>): Promise<number> {
  const rows = await rest.select('kit_notas', {
    select: 'nota_id',
    order: 'nota_id.desc',
    filters: { origin: 'eq.demo' },
    limit: 1,
  });
  const first: unknown = rows[0];
  if (first === undefined) return 1;
  const id = typeof first === 'object' && first !== null && 'nota_id' in first ? first.nota_id : undefined;
  const match = typeof id === 'string' ? DEMO_NOTE_ID.exec(id) : null;
  if (!match?.[1]) throw new Error('demo: a última nota demo não tem id DM-n');
  return Number(match[1]) + 1;
}

/**
 * (#349) Uma rodada de notas novas: de 3 a 8 notas, gravadas em um lote. A semente é o próprio início da sequência, então a
 * rodada é determinística e repetir a gravação é inofensivo. Devolve quantas notas entraram (as "capturadas" da faixa).
 */
export async function runDemoNotesRound({ rest, enabled, now }: DemoNotesRoundDeps): Promise<number> {
  if (!enabled) return 0;
  const sequenceStart = await nextSequence(rest);
  const seed = sequenceStart;
  const { rows } = generateDemoBatch({ seed, count: demoNoteCount(seed), now, sequenceStart });
  return new DemoNoteInserter(rest).insert(rows);
}
