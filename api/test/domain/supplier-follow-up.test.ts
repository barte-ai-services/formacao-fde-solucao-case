import { describe, expect, it } from 'vitest';
import { buildSupplierRequestFacts, followUpDraftFor, followUpDue, owesFollowUp, validateReading, validateRequestText, withFollowUpDueDate } from '../../src/domain/index.js';
import { reading } from '../supplier/reply-doubles.js';
import { returnNote, sourceInvoice } from './supplier-request-fixtures.js';

// #58: a cobrança montada pela regra, sem o Claude. Os nomes de `it` seguem o ADR-004.
const DUE = '2026-11-17';
const ASKS = ['Confirmar o recebimento da nota de devolução', 'Creditar {{devolucao.total}} até {{prazo}}', 'Enviar o comprovante da nota {{nota.numero}}'];
const catalog = () => buildSupplierRequestFacts(returnNote(), sourceInvoice(), DUE);

describe('#58/AC-2 a cobrança pede só o que o fornecedor ainda não atendeu', () => {
  it('sem nada atendido, pede todos os itens do pedido', () => {
    const { text } = followUpDraftFor({ asks: ASKS, fulfilledAsks: [] }, '2026-11-20');
    expect(text.asks).toEqual(ASKS);
  });

  it('tira dos itens os que o fornecedor já atendeu', () => {
    const { text } = followUpDraftFor({ asks: ASKS, fulfilledAsks: [ASKS[0] as string] }, '2026-11-20');
    expect(text.asks).toEqual([ASKS[1], ASKS[2]]);
    expect(text.body).not.toContain(ASKS[0]);
  });

  it('#58/AC-2: com tudo atendido (a leitura parcial de um Claude que listou todos os itens e ainda pede follow_up), volta a pedir os itens do pedido', () => {
    const { text } = followUpDraftFor({ asks: ASKS, fulfilledAsks: [...ASKS] }, '2026-11-20');
    expect(text.asks).toEqual(ASKS);
  });

  it('cita a nota de origem, no assunto e no corpo, pelo marcador da nota', () => {
    const { text } = followUpDraftFor({ asks: ASKS, fulfilledAsks: [] }, '2026-11-20');
    expect(text.subject).toContain('{{nota.numero}}');
    expect(text.body).toContain('{{nota.numero}}');
  });
});

describe('#58/AC-2 o novo prazo são 3 dias úteis depois de hoje', () => {
  it('numa sexta, o prazo cai na quarta seguinte, pulando o fim de semana', () => {
    expect(followUpDraftFor({ asks: ASKS, fulfilledAsks: [] }, '2026-11-20').dueOn).toBe('2026-11-25');
  });

  it('numa segunda, o prazo cai na quinta', () => {
    expect(followUpDraftFor({ asks: ASKS, fulfilledAsks: [] }, '2026-11-23').dueOn).toBe('2026-11-26');
  });

  it('o novo prazo entra no catálogo como o fato cobranca.prazo, com a data no formato do e-mail', () => {
    const extended = withFollowUpDueDate(catalog(), '2026-11-25');
    expect(extended.facts['cobranca.prazo']?.value).toBe('25/11/2026');
    expect(extended.facts['prazo']?.value).toBe('17/11/2026');
  });
});

describe('#58/AC-3 todo número do texto vem do catálogo de fatos, como marcador', () => {
  it('o texto montado pela regra passa na mesma conferência do pedido (validateRequestText), com o catálogo do novo prazo', () => {
    const { text, dueOn } = followUpDraftFor({ asks: ASKS, fulfilledAsks: [] }, '2026-11-20');
    const checked = validateRequestText(text, withFollowUpDueDate(catalog(), dueOn));
    expect(checked.ok).toBe(true);
  });

  it('o novo prazo e a nota aparecem só como marcador: o texto cru não leva data nem número', () => {
    const { text } = followUpDraftFor({ asks: ASKS, fulfilledAsks: [] }, '2026-11-20');
    expect(text.body).toContain('{{cobranca.prazo}}');
    expect(text.body.replace(/\{\{[^}]*\}\}/g, '')).not.toMatch(/\d/);
    expect(text.subject.replace(/\{\{[^}]*\}\}/g, '')).not.toMatch(/\d/);
  });

  it('renderizado, o corpo traz a data do novo prazo e o número da nota de origem', () => {
    const { text, dueOn } = followUpDraftFor({ asks: ASKS, fulfilledAsks: [] }, '2026-11-20');
    const checked = validateRequestText(text, withFollowUpDueDate(catalog(), dueOn));
    if (!checked.ok) throw new Error('o texto da regra devia conferir');
    expect(checked.rendered.body).toContain('25/11/2026');
    expect(checked.rendered.body).toContain('43894');
  });

  it('sem o fato do novo prazo no catálogo, o marcador do novo prazo é recusado (number_mismatch)', () => {
    const { text } = followUpDraftFor({ asks: ASKS, fulfilledAsks: [] }, '2026-11-20');
    expect(validateRequestText(text, catalog())).toMatchObject({ ok: false, reason: 'number_mismatch' });
  });
});

// #58/AC-2 (ref-pr40): quais leituras que o domínio produz pedem a cobrança, e a partir de quando.
const PARTIAL = reading({ replyOutcome: 'partially_fulfilled', nextStep: 'follow_up', fulfilledAsks: [ASKS[0] as string] });
const REQUEST = { status: 'sent', dueOn: '2026-11-17' } as const;

describe('#58/AC-2 que leitura pede a cobrança', () => {
  it('no_reply, partially_fulfilled e needs_information com next_step follow_up pedem a cobrança', () => {
    expect(owesFollowUp(reading({ replyOutcome: 'no_reply', nextStep: 'follow_up' }))).toBe(true);
    expect(owesFollowUp(PARTIAL)).toBe(true);
    expect(owesFollowUp(reading({ replyOutcome: 'needs_information', nextStep: 'follow_up' }))).toBe(true);
  });

  it('as mesmas leituras com outro próximo passo, fulfilled, refused e sem leitura não pedem', () => {
    expect(owesFollowUp(reading({ replyOutcome: 'partially_fulfilled', nextStep: 'answer_supplier' }))).toBe(false);
    expect(owesFollowUp(reading({ replyOutcome: 'needs_information', nextStep: 'answer_supplier' }))).toBe(false);
    expect(owesFollowUp(reading({ replyOutcome: 'fulfilled', nextStep: 'follow_up' }))).toBe(false);
    expect(owesFollowUp(reading({ replyOutcome: 'refused', nextStep: 'follow_up' }))).toBe(false);
    expect(owesFollowUp(null)).toBe(false);
  });

  it('a leitura parcial com follow_up é uma que a regra do domínio produz (validateReading)', () => {
    const ctx = { asks: ASKS, replyText: 'Mandamos o crédito; falta o comprovante.', catalog: catalog() };
    const raw = { reply_outcome: 'partially_fulfilled', fulfilled_asks: [ASKS[0]], supplier_document: null, summary: 'Atendeu só parte do pedido.', next_step: 'follow_up', injection_flag: null };
    const checked = validateReading(raw, ctx);
    expect(checked.ok && owesFollowUp(checked.reading)).toBe(true);
  });
});

describe('#58/AC-2 a cobrança é devida só depois do prazo do pedido', () => {
  it('a leitura parcial com follow_up só é devida depois do dia do prazo; no dia, ainda está no prazo', () => {
    expect(followUpDue(REQUEST, PARTIAL, '2026-11-17')).toBe(false);
    expect(followUpDue(REQUEST, PARTIAL, '2026-11-18')).toBe(true);
  });

  it('o no_reply da varredura é devido sempre (só nasce depois do prazo), e o pedido não enviado nunca', () => {
    expect(followUpDue(REQUEST, reading({ replyOutcome: 'no_reply', nextStep: 'follow_up' }), '2026-11-18')).toBe(true);
    expect(followUpDue({ ...REQUEST, status: 'draft' }, PARTIAL, '2026-11-18')).toBe(false);
    expect(followUpDue(REQUEST, null, '2026-11-18')).toBe(false);
  });
});
