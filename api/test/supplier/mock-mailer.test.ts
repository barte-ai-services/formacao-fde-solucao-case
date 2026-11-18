import { describe, expect, it } from 'vitest';
import { mailerFromEnv, mockMailer } from '../../src/supplier/mock-mailer.js';
import type { MailMessage, SupplierMailer } from '../../src/supplier/ports.js';
import { SOURCE_KEY } from '../domain/supplier-request-fixtures.js';
import { SUPPLIER_EMAIL } from './doubles.js';

// #12: o envio pela caixa de saída mock; o registro do envio mock é a linha do pedido (channel mock), não outra tabela.

const message: MailMessage = {
  invoiceAccessKey: SOURCE_KEY,
  supplierId: 'F02',
  requestType: 'return_note',
  to: SUPPLIER_EMAIL,
  subject: 'Devolução da nota 43894',
  body: 'corpo',
  asks: ['Confirmar'],
  attachments: [],
  dueOn: '2026-11-17',
  idempotencyKey: 'claim-abc',
};

describe('#12/AC-5 sem a chave do Resend, o envio usa a caixa de saída mock', () => { // ADR-002
  it('o mock responde ok, pelo canal mock, com um identificador que vem da chave da trava', async () => { // ADR-002
    expect(await mockMailer().send(message)).toEqual({ ok: true, channel: 'mock', providerMessageId: 'mock-claim-abc' });
  });

  it('sem a variável do Resend, ou com ela em branco, o seletor devolve o mock, sem erro', async () => { // ADR-002
    for (const env of [{}, { RESEND_API_KEY: '' }, { RESEND_API_KEY: '   ' }]) {
      expect(await mailerFromEnv(env).send(message)).toMatchObject({ ok: true, channel: 'mock' });
    }
  });

  it('com a chave e o adaptador do Resend, usa o adaptador', async () => { // ADR-002
    const resend: SupplierMailer = { send: async () => ({ ok: true, channel: 'resend', providerMessageId: 'msg-1' }) };
    expect(await mailerFromEnv({ RESEND_API_KEY: 're_chave_de_teste' }, resend).send(message)).toMatchObject({ channel: 'resend' });
  });

  it('com a chave e sem adaptador do Resend, falha fechado com um motivo próprio, sem a chave', async () => { // ADR-002
    const result = await mailerFromEnv({ RESEND_API_KEY: 're_chave_de_teste' }).send(message);
    expect(result).toEqual({ ok: false, reason: 'resend_unavailable' });
    expect(JSON.stringify(result)).not.toContain('re_chave_de_teste');
  });
});
