import { describe, expect, it } from 'vitest';
import { supabaseSourceInvoices } from '../../src/supplier/supabase-source.js';
import { SOURCE_KEY } from '../domain/supplier-request-fixtures.js';
import { SUPPLIER_EMAIL } from './doubles.js';
import { harness, invoiceRow, supplierRow } from './supabase-support.js';

// #12: a nota de origem e o e-mail de teste do fornecedor, lidos de invoices e kit_fornecedores.

describe('#12/AC-1 o e-mail do fornecedor vem de kit_fornecedores', () => { // ADR-002
  it('devolve a nota de origem no domínio e o e-mail do fornecedor dela', async () => { // ADR-002
    const { rest } = harness({ invoices: [invoiceRow()], kit_fornecedores: [supplierRow()] });
    const found = await supabaseSourceInvoices(rest).find(SOURCE_KEY);
    expect(found?.supplierEmail).toBe(SUPPLIER_EMAIL);
    expect(found?.invoice.number).toBe('43894');
    expect(found?.invoice.supplierId).toBe('F02');
    expect(found?.invoice.store).toBe('LJ-012');
    expect(found?.invoice.items).toHaveLength(3);
    expect(found?.invoice.items[0]?.unitPrice.cents).toBe(849);
    expect(found?.invoice.items[2]).toMatchObject({ sku: null, quantity: { amount: 12, unit: 'CX' } });
  });

  it('nota que não existe é null', async () => { // ADR-002
    const { rest } = harness({ kit_fornecedores: [supplierRow()] });
    expect(await supabaseSourceInvoices(rest).find(SOURCE_KEY)).toBeNull();
  });

  it('fornecedor sem e-mail falha fechado: null, nunca um envio sem destinatário', async () => { // ADR-002
    const { rest } = harness({ invoices: [invoiceRow()], kit_fornecedores: [supplierRow(null)] });
    expect(await supabaseSourceInvoices(rest).find(SOURCE_KEY)).toBeNull();
  });

  it('fornecedor que a nota cita e o cadastro não tem também é null', async () => { // ADR-002
    const { rest } = harness({ invoices: [invoiceRow()] });
    expect(await supabaseSourceInvoices(rest).find(SOURCE_KEY)).toBeNull();
  });

  it('lê só o e-mail do fornecedor, não a linha inteira do cadastro', async () => { // ADR-002
    const { fake, rest } = harness({ invoices: [invoiceRow()], kit_fornecedores: [supplierRow()] });
    await supabaseSourceInvoices(rest).find(SOURCE_KEY);
    const urls = fake.requests.map((r) => decodeURIComponent(r.url));
    expect(urls.some((u) => u.includes('kit_fornecedores') && u.includes('select=email'))).toBe(true);
  });

  it('item da nota fora do formato é dado corrompido: falha', async () => { // ADR-002
    const broken = { ...invoiceRow(), items: [{ supplierCode: 1 }] };
    const { rest } = harness({ invoices: [broken], kit_fornecedores: [supplierRow()] });
    await expect(supabaseSourceInvoices(rest).find(SOURCE_KEY)).rejects.toThrow();
  });
});
