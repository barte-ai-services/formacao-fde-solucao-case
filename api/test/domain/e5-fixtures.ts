import {
  Invoice,
  Money,
  Quantity,
  type InvoiceItem,
  type Product,
  type PurchaseOrder,
  type PurchaseOrderItem,
} from '../../src/domain/index.js';

// #65: dados de apoio dos testes da nota sem ordem (E5) e da ordem provável.

export const KEY = '35261100000000000000550010000099991000099999';

export const item = (
  supplierCode: string,
  amount: number,
  unit: 'UN' | 'CX' = 'UN',
  description = `Produto ${supplierCode}`,
  sku: string | null = `SKU-${supplierCode}`,
): InvoiceItem => ({
  supplierCode,
  sku,
  description,
  quantity: Quantity.of(amount, unit),
  unitPrice: Money.ofCents(1000),
  total: Money.ofCents(1000 * amount),
});

export const invoiceWith = (
  purchaseOrderRef: string | null,
  items: readonly InvoiceItem[] = [item('A1', 10)],
  supplierId = 'F-001',
): Invoice =>
  Invoice.receive({
    accessKey: KEY,
    number: '9999',
    series: '1',
    supplierId,
    store: 'L01',
    issuedOn: '2026-11-10',
    purchaseOrderRef,
    entryChannel: 'e-mail',
    items,
    total: items.reduce((sum, i) => sum.add(i.total), Money.zero()),
  });

export const orderItem = (
  supplierCode: string,
  balance: number,
  description = `Produto ${supplierCode}`,
): PurchaseOrderItem => ({
  sku: `SKU-${supplierCode}`,
  supplierCode,
  description,
  quantity: Quantity.of(balance, 'UN'),
  unitPrice: Money.ofCents(1000),
  balance: Quantity.of(balance, 'UN'),
});

export const order = (
  id: string,
  items: readonly PurchaseOrderItem[] = [orderItem('A1', 100)],
  overrides: Partial<PurchaseOrder> = {},
): PurchaseOrder => ({
  id,
  supplierId: 'F-001',
  store: 'L01',
  issuedOn: '2026-11-05',
  status: 'aberta', // ADR-002
  statusReason: '',
  items,
  total: Money.ofCents(100000),
  ...overrides,
});

export const product = (supplierCode: string, boxFactor: number): Product => ({
  sku: `SKU-${supplierCode}`,
  description: `Produto ${supplierCode}`,
  supplierId: 'F-001',
  supplierCode,
  baseUnit: 'UN',
  boxFactor,
  referenceUnitPrice: Money.ofCents(1000),
});
