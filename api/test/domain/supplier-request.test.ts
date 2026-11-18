import { describe, expect, it } from 'vitest';
import {
  DomainError,
  InvalidTransitionError,
  SupplierRequest,
  buildSupplierRequestFacts,
  factKey,
  hasOpenRequest,
  isOpenRequestStatus,
  issueReturnNote,
  validateRequestText,
  type RequestStatus,
  type SupplierRequestText,
} from '../../src/domain/index.js';
import { SOURCE_KEY, returnNote, sourceInvoice } from './supplier-request-fixtures.js';

const DUE = '2026-11-17';
const catalog = () => buildSupplierRequestFacts(returnNote(), sourceInvoice(), DUE);

const GOOD: SupplierRequestText = {
  subject: 'Devolução da nota {{nota.numero}}',
  body: 'Devolvemos {{devolucao.item[F02-002].quantidade}} de F02-002, no valor de {{devolucao.item[F02-002].valor}}. Total {{devolucao.total}}, retorno até {{prazo}}.',
  asks: ['Confirmar o recebimento da nota de devolução', 'Creditar {{devolucao.total}} até {{prazo}}'],
};

const drafted = (): SupplierRequest => {
  const validated = validateRequestText(GOOD, catalog());
  if (!validated.ok) throw new Error('fixture inválida');
  return SupplierRequest.draft({ id: 41, invoiceAccessKey: SOURCE_KEY, note: returnNote(), text: validated.text, draftedOn: '2026-11-12' });
};

const inState = (status: RequestStatus): SupplierRequest => {
  const r = drafted();
  if (status === 'sent') r.markSent();
  if (status === 'send_failed') r.markSendFailed('SMTP fora do ar');
  if (status === 'discarded') r.discard('motivo');
  return r;
};

describe('o catálogo de fatos do pedido', () => {
  it('#156 traz a quantidade e o valor de cada linha devolvida, o total, o número da nota e o prazo', () => {
    const { facts } = catalog();
    expect(facts['devolucao.item[F02-002].quantidade']).toMatchObject({ value: '7 UN', source: 'return_note' });
    expect(facts['devolucao.item[F02-002].valor']?.value).toBe('R$ 59,43');
    expect(facts['devolucao.item[F02-005].quantidade']?.value).toBe('5 CX');
    expect(facts['devolucao.item[F02-005].valor']?.value).toBe('R$ 500,00');
    expect(facts['devolucao.total']?.value).toBe('R$ 559,43');
    expect(facts['nota.numero']).toMatchObject({ value: '43894', source: 'invoice' });
    expect(facts['prazo']?.value).toBe('17/11/2026');
  });

  it('#156 as chaves seguem o contrato do dossiê (factKey)', () => {
    expect(factKey.returnItem('F02-002', 'quantidade')).toBe('devolucao.item[F02-002].quantidade');
    expect(factKey.returnItem('F02-002', 'valor')).toBe('devolucao.item[F02-002].valor');
    expect(factKey.returnTotal()).toBe('devolucao.total');
    expect(factKey.dueDate()).toBe('prazo');
    expect(factKey.invoiceNumber()).toBe('nota.numero');
  });

  it('#156 os identificadores são os códigos, os SKUs, a chave, o fornecedor e o destino', () => {
    expect(catalog().identifiers).toEqual(expect.arrayContaining(['F02-002', 'SKU-1006', SOURCE_KEY, 'F02', 'LJ-012']));
  });
});

describe('a validação do texto do Claude', () => {
  it('#156 aceita o texto cujos números vêm todos de marcadores do catálogo', () => {
    expect(validateRequestText(GOOD, catalog())).toMatchObject({ ok: true });
  });

  it('#156 renderiza os marcadores com os valores do catálogo', () => {
    const result = validateRequestText(GOOD, catalog());
    if (!result.ok) throw new Error('esperava ok');
    expect(result.rendered.subject).toBe('Devolução da nota 43894');
    expect(result.rendered.body).toContain('R$ 559,43');
    expect(result.rendered.asks[1]).toBe('Creditar R$ 559,43 até 17/11/2026');
  });

  it('#156 recusa um número solto fora do catálogo, com o motivo e o campo', () => {
    const result = validateRequestText({ ...GOOD, body: 'Devolvemos 8 unidades.' }, catalog());
    expect(result).toEqual({ ok: false, reason: 'number_mismatch', field: 'body' });
  });

  it('#156 recusa número por extenso na lista do que pedimos e número solto no assunto', () => {
    expect(validateRequestText({ ...GOOD, asks: ['Enviar em dois dias'] }, catalog())).toEqual({
      ok: false,
      reason: 'number_mismatch',
      field: 'asks',
    });
    expect(validateRequestText({ ...GOOD, subject: 'Nota 43894' }, catalog())).toEqual({
      ok: false,
      reason: 'number_mismatch',
      field: 'subject',
    });
  });

  it('#156 recusa marcador que não está no catálogo', () => {
    const result = validateRequestText({ ...GOOD, body: 'Valor {{devolucao.item[F99].valor}}' }, catalog());
    expect(result).toEqual({ ok: false, reason: 'number_mismatch', field: 'body' });
  });

  it('#156 deixa passar um identificador do catálogo fora do marcador', () => {
    const result = validateRequestText({ ...GOOD, body: 'Itens F02-002 e F02-005 da chave ' + SOURCE_KEY }, catalog());
    expect(result.ok).toBe(true);
  });

  it('#156 recusa o que não tem a forma de assunto, corpo e lista de textos', () => {
    for (const raw of [null, 'texto', { subject: 'x' }, { ...GOOD, asks: [1] }, { ...GOOD, body: '' }, { ...GOOD, asks: [] }]) {
      expect(validateRequestText(raw, catalog())).toMatchObject({ ok: false, reason: 'invalid_shape' });
    }
  });
});

describe('o prazo padrão', () => {
  it('#156 o pedido nasce com o prazo de 3 dias úteis depois do dia do rascunho', () => {
    expect(drafted().dueOn).toBe('2026-11-17');
  });
});

describe('o ciclo do pedido', () => {
  it('#156 nasce como rascunho return_note', () => {
    const request = drafted();
    expect(request.status).toBe('draft');
    expect(request.requestType).toBe('return_note');
  });

  it('#156 do rascunho vai para sent, send_failed ou discarded', () => {
    const sent = drafted();
    sent.markSent();
    expect(sent.status).toBe('sent');
    const failed = drafted();
    failed.markSendFailed('SMTP fora do ar');
    expect(failed.status).toBe('send_failed');
    const discarded = drafted();
    discarded.discard('número fora do catálogo');
    expect(discarded.status).toBe('discarded');
  });

  it('#156 de send_failed vai a sent, e o descarte continua recusado', () => {
    const request = inState('send_failed');
    request.markSent();
    expect(request.status).toBe('sent');
    expect(() => inState('send_failed').discard('x')).toThrow(InvalidTransitionError);
  });

  it('#156 um reenvio que falha de novo se registra: continua send_failed, com o motivo novo', () => {
    const request = inState('send_failed');
    request.markSendFailed('caixa do fornecedor cheia');
    expect(request.status).toBe('send_failed');
    expect(request.sendFailureReason).toBe('caixa do fornecedor cheia');
    expect(request.isOpen).toBe(true);
  });

  it('#156 cada falha do envio registra o motivo, em campo próprio, e recusa motivo vazio', () => {
    const request = drafted();
    expect(request.sendFailureReason).toBeNull();
    expect(() => request.markSendFailed('  ')).toThrow(DomainError);
    expect(request.status).toBe('draft');
    request.markSendFailed('SMTP fora do ar');
    expect(request.sendFailureReason).toBe('SMTP fora do ar');
    expect(request.discardReason).toBeNull();
  });

  it('#156 o pedido leva a identidade que o chamador deu, no rascunho e no recusado', () => {
    expect(drafted().id).toBe(41);
    const rejected = validateRequestText({ ...GOOD, body: 'Devolvemos 8 unidades.' }, catalog());
    if (rejected.ok) throw new Error('esperava recusa');
    const request = SupplierRequest.rejected({ id: 42, invoiceAccessKey: SOURCE_KEY, note: returnNote(), draftedOn: '2026-11-12', rejection: rejected });
    expect(request.id).toBe(42);
  });

  it('#156 recusa toda outra transição, sem mudar o estado', () => {
    const attempts: readonly [RequestStatus, (r: SupplierRequest) => void][] = [
      ['sent', (r) => r.markSent()],
      ['sent', (r) => r.markSendFailed('x')],
      ['sent', (r) => r.discard('x')],
      ['discarded', (r) => r.markSent()],
      ['discarded', (r) => r.markSendFailed('x')],
      ['discarded', (r) => r.discard('x')],
    ];
    for (const [from, act] of attempts) {
      const request = inState(from);
      expect(() => act(request)).toThrow(InvalidTransitionError);
      expect(request.status).toBe(from);
    }
  });

  it('#156 o descarte registra o motivo e recusa motivo vazio', () => {
    const request = drafted();
    expect(() => request.discard('  ')).toThrow(DomainError);
    request.discard('número fora do catálogo');
    expect(request.discardReason).toBe('número fora do catálogo');
  });

  it('#156 o texto recusado do Claude nasce como pedido descartado com o motivo', () => {
    const rejected = validateRequestText({ ...GOOD, body: 'Devolvemos 8 unidades.' }, catalog());
    if (rejected.ok) throw new Error('esperava recusa');
    const request = SupplierRequest.rejected({ id: 42, invoiceAccessKey: SOURCE_KEY, note: returnNote(), draftedOn: '2026-11-12', rejection: rejected });
    expect(request.status).toBe('discarded');
    expect(request.discardReason).toBe('number_mismatch: body');
    expect(request.isOpen).toBe(false);
  });

  it('#156 emitir de novo nunca cria uma segunda nota', () => {
    const request = drafted();
    expect(request.issuedNote).toBeNull();
    request.recordIssuance(issueReturnNote(request.note, { sequence: 1, issuedOn: '2026-11-12' }));
    expect(request.issuedNote?.noteId).toBe('ND-1');
    const second = issueReturnNote(request.note, { sequence: 2, issuedOn: '2026-11-12' });
    expect(() => request.recordIssuance(second)).toThrow(DomainError);
    expect(request.issuedNote?.noteId).toBe('ND-1');
  });

  it('#156 só um rascunho registra a emissão: descartado nunca emite', () => {
    const request = inState('discarded');
    const issued = issueReturnNote(request.note, { sequence: 1, issuedOn: '2026-11-12' });
    expect(() => request.recordIssuance(issued)).toThrow(InvalidTransitionError);
    expect(request.issuedNote).toBeNull();
  });

  it('#156 só registra a emissão da nota que o próprio pedido monta', () => {
    const other = { ...returnNote(), destination: 'LJ-099' };
    const issued = issueReturnNote(other, { sequence: 1, issuedOn: '2026-11-12' });
    expect(() => drafted().recordIssuance(issued)).toThrow(DomainError);
  });
});

describe('o pedido aberto', () => {
  it('#156 draft, sent e send_failed contam como aberto; discarded não', () => {
    expect(isOpenRequestStatus('draft')).toBe(true);
    expect(isOpenRequestStatus('sent')).toBe(true);
    expect(isOpenRequestStatus('send_failed')).toBe(true);
    expect(isOpenRequestStatus('discarded')).toBe(false);
    expect(inState('send_failed').isOpen).toBe(true);
    expect(inState('discarded').isOpen).toBe(false);
  });

  it('#156 uma nota de origem não tem dois pedidos abertos do mesmo tipo', () => {
    const existing = [{ invoiceAccessKey: SOURCE_KEY, requestType: 'return_note' as const, status: 'sent' as const }];
    expect(hasOpenRequest(existing, SOURCE_KEY, 'return_note')).toBe(true);
    const closed = [{ ...existing[0]!, status: 'discarded' as const }];
    expect(hasOpenRequest(closed, SOURCE_KEY, 'return_note')).toBe(false);
    expect(hasOpenRequest(existing, '9'.repeat(44), 'return_note')).toBe(false);
  });
});

describe('a edição do pedido', () => {
  it('#156 edita o corpo de um rascunho, revalidado contra o catálogo', () => {
    const request = drafted();
    const result = request.editBody('Segue o total {{devolucao.total}}, até {{prazo}}.', catalog());
    expect(result.ok).toBe(true);
    expect(request.body).toBe('Segue o total {{devolucao.total}}, até {{prazo}}.');
  });

  it('#156 recusa o corpo com número fora do catálogo e mantém o anterior', () => {
    const request = drafted();
    const before = request.body;
    const result = request.editBody('Devolvemos 9 caixas.', catalog());
    expect(result).toEqual({ ok: false, reason: 'number_mismatch', field: 'body' });
    expect(request.body).toBe(before);
  });

  it('#156 recusa a edição de um pedido que não é rascunho', () => {
    for (const status of ['sent', 'send_failed', 'discarded'] as const) {
      const request = inState(status);
      expect(() => request.editBody('Texto novo', catalog())).toThrow(InvalidTransitionError);
    }
  });

  it('#156 o assunto, a lista do que pedimos e os itens da nota não têm como mudar', () => {
    const request = drafted();
    const note = request.note;
    request.editBody('Outro texto {{prazo}}', catalog());
    expect(request.subject).toBe(GOOD.subject);
    expect(request.asks).toEqual(GOOD.asks);
    expect(request.note).toEqual(note);
    expect(Object.isFrozen(request.note)).toBe(true);
    expect(Object.isFrozen(request.note.items)).toBe(true);
    expect(Object.isFrozen(request.asks)).toBe(true);
  });
});
