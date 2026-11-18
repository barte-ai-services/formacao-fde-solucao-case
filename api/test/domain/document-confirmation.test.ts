import { describe, expect, it } from 'vitest';
import {
  NEXT_STEPS,
  REPLY_OUTCOMES,
  confirmRefusal,
  confirmationOf,
  filterOf,
  guardNextStep,
  type DocumentConfirmation,
  type SupplierReading,
} from '../../src/domain/index.js';

// #63: a confirmação do documento que o fornecedor citou (#4/AC-4). A regra mora no domínio: nada aqui lê banco, relógio nem HTTP.
// Os nomes de `it` seguem o ADR-004.

const DUE = '2026-11-17';
const sent = { status: 'sent', dueOn: DUE } as const;
const ANA = 'ana@jachegou.test';
const confirmed = (document: string, at = '2026-11-21T10:00:00Z'): DocumentConfirmation => ({ document, by: ANA, at: new Date(at) });
const read = (over: Partial<SupplierReading> = {}): SupplierReading => ({
  replyOutcome: 'fulfilled',
  fulfilledAsks: [],
  supplierDocument: '881',
  summary: 'Resumo.',
  nextStep: 'confirm_document',
  injectionFlag: null,
  ...over,
});

describe('#63/AC-1 só o atendido com documento citado e próximo passo confirm_document pode ser confirmado', () => {
  it('#63/AC-1: o pedido enviado, atendido, com documento e confirm_document, não tem recusa', () => {
    expect(confirmRefusal(sent, read(), [])).toBeNull();
  });

  it('#63/AC-4: sem leitura, ou com outro próximo passo, ou sem documento, a recusa é not_confirm_document', () => {
    expect(confirmRefusal(sent, null, [])).toBe('not_confirm_document');
    expect(confirmRefusal(sent, read({ nextStep: 'close', supplierDocument: null }), [])).toBe('not_confirm_document');
    expect(confirmRefusal(sent, read({ nextStep: 'answer_supplier' }), [])).toBe('not_confirm_document');
    expect(confirmRefusal(sent, read({ supplierDocument: null }), [])).toBe('not_confirm_document');
    expect(confirmRefusal(sent, read({ replyOutcome: 'partially_fulfilled' }), [])).toBe('not_confirm_document');
  });

  it('#63/AC-4: o pedido que não foi enviado não se confirma', () => {
    for (const status of ['draft', 'send_failed', 'discarded'] as const) expect(confirmRefusal({ status, dueOn: DUE }, read(), [])).toBe('not_confirm_document');
  });

  it('#63/AC-4: o documento já confirmado não se confirma de novo: already_confirmed', () => {
    expect(confirmRefusal(sent, read(), [confirmed('881')])).toBe('already_confirmed');
  });
});

describe('#63/AC-3 a confirmação vale para o documento da leitura atual, e só para ele', () => {
  it('#63/AC-3: devolve a confirmação do documento citado na leitura', () => {
    expect(confirmationOf(read(), [confirmed('881')])).toEqual(confirmed('881'));
  });

  it('#63/AC-3: sem confirmação, sem leitura ou sem documento, é nula', () => {
    expect(confirmationOf(read(), [])).toBeNull();
    expect(confirmationOf(null, [confirmed('881')])).toBeNull();
    expect(confirmationOf(read({ supplierDocument: null }), [confirmed('881')])).toBeNull();
  });

  it('#63/AC-1: uma leitura nova com outro documento deixa a confirmação velha para trás e volta a pedir a confirmação', () => {
    expect(confirmationOf(read({ supplierDocument: '882' }), [confirmed('881')])).toBeNull();
    expect(confirmRefusal(sent, read({ supplierDocument: '882' }), [confirmed('881')])).toBeNull();
  });

  it('#63/AC-3: com várias confirmações, vale a mais recente do documento atual', () => {
    const list = [confirmed('881', '2026-11-21T10:00:00Z'), confirmed('882', '2026-11-22T10:00:00Z'), confirmed('881', '2026-11-23T10:00:00Z')];
    expect(confirmationOf(read(), list)?.at.toISOString()).toBe('2026-11-23T10:00:00.000Z');
    expect(confirmationOf(read({ supplierDocument: '882' }), list)?.at.toISOString()).toBe('2026-11-22T10:00:00.000Z');
  });

  it('#63/AC-3: a confirmação só conta se a leitura ainda é a do atendido com confirm_document', () => {
    expect(confirmationOf(read({ replyOutcome: 'refused', nextStep: 'answer_supplier' }), [confirmed('881')])).toBeNull();
  });
});

describe('#63/AC-2 confirmado, o pedido sai de "precisam de você" e cai em "atendidos"', () => {
  it('#63/AC-2: atendido com confirm_document e confirmação é answered; sem ela, needs_you', () => {
    expect(filterOf(sent, read(), DUE)).toBe('needs_you');
    expect(filterOf(sent, read(), DUE, [])).toBe('needs_you');
    expect(filterOf(sent, read(), DUE, [confirmed('881')])).toBe('answered');
  });

  it('#63/AC-2: a confirmação de outro documento não tira o pedido de needs_you', () => {
    expect(filterOf(sent, read({ supplierDocument: '882' }), DUE, [confirmed('881')])).toBe('needs_you');
  });

  it('#63/AC-2 #50/AC-3: toda combinação de leitura, documento, confirmação e dia cai em exatamente um dos quatro filtros', () => {
    const filters = ['awaiting', 'answered', 'needs_you', 'overdue'];
    const readings: (SupplierReading | null)[] = [null];
    for (const o of REPLY_OUTCOMES) {
      for (const n of NEXT_STEPS) {
        for (const supplierDocument of [null, '881']) {
          const raw = read({ replyOutcome: o, nextStep: n, supplierDocument });
          readings.push(raw, { ...raw, nextStep: guardNextStep(o, supplierDocument, n) });
        }
      }
    }
    for (const x of readings) {
      for (const list of [[], [confirmed('881')], [confirmed('999')]]) {
        for (const today of ['2026-11-13', DUE, '2026-11-18']) {
          const placed = filterOf(sent, x, today, list);
          expect(placed, JSON.stringify({ x, today, list })).not.toBeNull();
          expect(filters.filter((f) => f === placed)).toHaveLength(1);
        }
      }
    }
  });

  it('#63/AC-2: o que não foi enviado segue em nenhum filtro, mesmo com confirmação', () => {
    for (const status of ['draft', 'send_failed', 'discarded'] as const) expect(filterOf({ status, dueOn: DUE }, read(), DUE, [confirmed('881')])).toBeNull();
  });
});
