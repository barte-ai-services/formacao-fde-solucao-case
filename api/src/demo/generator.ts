// Gerador puro das notas novas do modo demonstração (#349): sem I/O, com semente.
// Porta a lógica de kit-domingo/gerador/gerar_base.py sem o gabarito: a classificação esperada é só o retorno em memória. (#349)
import type { ApprovalLevel } from '../domain/index.js';
import { KeyAllocator, CODE_SPACE } from './access-key.js';
import { EXCEPTION_CASES, matchCase, type ExceptionCode, type MatchVariant } from './cases.js';
import type { CaseEnv, CaseOutcome, Size } from './case-kit.js';
import { Rng } from './prng.js';
import { RowSink } from './rows.js';
import type { DemoBatch, DemoBatchInput, ExpectedClassification } from './types.js';

export type { DemoBatch, DemoBatchInput, DemoNotaRow, DemoRows, ExpectedClassification } from './types.js';

export const DEMO_NOTES_MIN = 3;
export const DEMO_NOTES_MAX = 8;
/** Perto de 10% de match, como na base. (#349) */
export const MATCH_SHARE = 0.1;

/** O tamanho de cada nota por exceção, como na composição da base (E6 só em reemissão, que nunca repete chave). (#349) */
const COMPOSITION: Readonly<Record<ExceptionCode, readonly Size[]>> = {
  E1: ['L', 'L', 'L', 'L', 'L', 'C', 'C', 'CB', 'H'],
  E2: ['L', 'L', 'L', 'L', 'L', 'C', 'C', 'C', 'CB'],
  E3: ['L', 'L', 'L', 'L', 'C', 'C', 'C', 'CB', 'H'],
  E4: ['L', 'L', 'L', 'C', 'C', 'C', 'C', 'CB', 'CB'],
  E5: ['L', 'L', 'L', 'L', 'L', 'L', 'C', 'C', 'CB'],
  E6: ['L', 'L', 'L', 'L', 'C', 'C', 'C', 'C', 'H'],
  E7: ['L', 'L', 'L', 'L', 'L', 'L', 'L', 'L', 'L'],
  E8: ['L', 'L', 'L', 'L', 'C', 'C', 'C', 'C', 'H'],
};

const EXCEPTION_CODES: readonly ExceptionCode[] = ['E1', 'E2', 'E3', 'E4', 'E5', 'E6', 'E7', 'E8'];
const EXCEPTION_POOL: readonly (readonly [ExceptionCode, Size])[] = EXCEPTION_CODES.flatMap((code) =>
  COMPOSITION[code].map((size) => [code, size] as const),
);

/** Exato na loja, sem o número do pedido, exato no CD, exato acima de R$ 100 mil, fornecedor bloqueado e dois dentro da tolerância. (#349) */
const MATCH_POOL: readonly MatchVariant[] = ['exato_L', 'exato_L', 'sem_xped_L', 'exato_C', 'exato_H', 'bloqueado_C', 'tolerancia_L', 'tolerancia_L'];

const ANALYST_CEILING_CENTS = 2_000_000;
const COORDINATION_CEILING_CENTS = 10_000_000;
const BLOCKED_ID = 'F12';

/** O nível da régua: o encaminhamento que o gerador espera, calculado à parte da regra da solução. (#349) */
function ladderLevel(outcome: CaseOutcome): ApprovalLevel {
  const { classification, totalCents, supplierId } = outcome;
  if (classification === 'E6') return 'bloqueio';
  if (totalCents > COORDINATION_CEILING_CENTS || supplierId === BLOCKED_ID) return 'diretoria';
  if (classification === 'E5' || classification === 'E8') return 'coordenacao';
  if (['E1', 'E2', 'E3', 'E4'].includes(classification)) return totalCents <= ANALYST_CEILING_CENTS ? 'analista' : 'coordenacao';
  return 'regra';
}

function assertInput(input: DemoBatchInput): void {
  if (!Number.isInteger(input.count) || input.count < DEMO_NOTES_MIN || input.count > DEMO_NOTES_MAX) {
    throw new RangeError(`count deve ser um inteiro de ${DEMO_NOTES_MIN} a ${DEMO_NOTES_MAX}`);
  }
  if (!Number.isSafeInteger(input.sequenceStart) || input.sequenceStart < 1 || (input.sequenceStart + input.count) * 2 >= CODE_SPACE) {
    throw new RangeError('sequenceStart fora da faixa de códigos da chave de acesso');
  }
  if (!Number.isSafeInteger(input.seed)) throw new RangeError('seed deve ser um inteiro');
}

/** Quantas notas a rodada de uma semente emite: de 3 a 8. (#349) */
export function demoNoteCount(seed: number): number {
  return new Rng(seed ^ 0x9e3779b9).int(DEMO_NOTES_MIN, DEMO_NOTES_MAX);
}

/** O início de sequência da rodada seguinte: cada nota gasta um número. (#349) */
export function nextSequenceStart(sequenceStart: number, count: number): number {
  return sequenceStart + count;
}

function generateOne(env: CaseEnv): CaseOutcome {
  if (env.rng.next() < MATCH_SHARE) return matchCase(env, env.rng.pick(MATCH_POOL));
  const [code, size] = env.rng.pick(EXCEPTION_POOL);
  return EXCEPTION_CASES[code](env, size);
}

/**
 * (#349) Gera o lote da rodada. Os ids (OC-DM-n, RC-DM-n, PG-DM-n, DM-n) e o código da chave de cada nota saem só do número de sequência.
 * (#349) Nunca reuse um `sequenceStart`, nem com outra semente: o `on conflict do nothing` do banco manteria a ordem OC-DM-n mais
 * (#349) antiga enquanto uma nota nova, de outra semente, entraria apontando para ela. Cada rodada começa em `nextSequenceStart`.
 */
export function generateDemoBatch(input: DemoBatchInput): DemoBatch {
  assertInput(input);
  const sink = new RowSink();
  const keys = new KeyAllocator(input.takenKeys);
  const rng = new Rng(input.seed);
  const textRng = new Rng(input.seed ^ 0x51ed2701);
  const today = input.now.toISOString().slice(0, 10);
  const expected = new Map<string, ExpectedClassification>();
  for (let i = 0; i < input.count; i += 1) {
    const outcome = generateOne({ rng, textRng, today, n: input.sequenceStart + i, keys, sink });
    expected.set(outcome.key, { classification: outcome.classification, level: ladderLevel(outcome) });
  }
  return { rows: sink.rows, expected };
}
