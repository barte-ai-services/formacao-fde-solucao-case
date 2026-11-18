// #156: a visão do pedido ao fornecedor (api/src/http/supplier-request-view.ts), sem HTTP nem banco; o espelho dela (ADR-003).
import { describe, expect, it } from 'vitest';
import { SupplierRequest } from '../../src/domain/index.js';
import { viewOf } from '../../src/http/supplier-request-view.js';
import type { RequestRecord } from '../../src/supplier/ports.js';
import { SOURCE_KEY, returnNote, sourceInvoice } from '../domain/supplier-request-fixtures.js';
import { GOOD_TEXT, SUPPLIER_EMAIL } from '../supplier/doubles.js';

const base = { id: 1, invoiceAccessKey: SOURCE_KEY, note: returnNote(), draftedOn: '2026-11-12' };
const source = { invoice: sourceInvoice(), supplierEmail: SUPPLIER_EMAIL };
const recordOf = (request: SupplierRequest): RequestRecord => ({ request, queueId: 7, to: SUPPLIER_EMAIL });

describe('#156 a visão monta só os campos nomeados do contrato', () => { // ADR-002
  it('#156: o pedido que a regra recusou vira failed com o motivo e sem o campo', async () => { // ADR-002
    const rejected = SupplierRequest.rejected({ ...base, rejection: { ok: false, reason: 'number_mismatch', field: 'body' } });
    expect(viewOf(recordOf(rejected), null)).toEqual({ ok: true, view: { status: 'failed', failure: 'number_mismatch' } });
  });

  it('#156: um rascunho sem a nota de origem não tem visão: source_missing', async () => { // ADR-002
    const draft = SupplierRequest.draft({ ...base, text: GOOD_TEXT });
    expect(viewOf(recordOf(draft), null)).toEqual({ ok: false, reason: 'source_missing' });
  });

  it('#156: o descartado por uma pessoa sem carimbo na linha mostra quando e quem como nulos', async () => { // ADR-002
    const draft = SupplierRequest.draft({ ...base, text: GOOD_TEXT });
    draft.discard('motivo');
    expect(viewOf(recordOf(draft), source)).toEqual({ ok: true, view: { status: 'discarded', discardedAt: null, discardedBy: null } }); // ADR-002
  });
});
