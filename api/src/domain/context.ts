import type { Invoice } from './invoice.js';
import type { Money } from './money.js';
import type { Quantity, Unit } from './quantity.js';

// Snapshots read-only que as verificações recebem. Os conectores preenchem; o domínio só lê.

export type PurchaseOrderItem = {
  readonly sku: string;
  readonly supplierCode: string;
  readonly description: string;
  readonly quantity: Quantity;
  readonly unitPrice: Money;
  /** Regra 5: o saldo que Compras publica para o item da ordem. */
  readonly balance: Quantity;
};

/** Ordem de compra, do ERP Compras. */
export type PurchaseOrder = {
  readonly id: string;
  readonly supplierId: string;
  readonly store: string;
  readonly issuedOn: string;
  readonly status: 'aberta' | 'atendida' | 'travada';
  readonly statusReason: string;
  readonly items: readonly PurchaseOrderItem[];
  readonly total: Money;
  readonly complements?: string;
};

/** Fornecedor, do ERP Cadastro. */
export type Supplier = {
  readonly id: string;
  readonly legalName: string;
  readonly cnpj: string;
  readonly paymentBlocked: boolean;
  readonly blockReason: string;
};

/** Produto, do ERP Cadastro. */
export type Product = {
  readonly sku: string;
  readonly description: string;
  readonly supplierId: string;
  readonly supplierCode: string;
  readonly baseUnit: Unit;
  readonly boxFactor: number;
  readonly referenceUnitPrice: Money;
};

/** Título já lançado no ERP Contas a pagar. */
export type PostedInvoice = {
  readonly accessKey: string;
  readonly number: string;
  readonly supplierId: string;
  readonly purchaseOrderRef: string | null;
  readonly total: Money;
  readonly status: string;
};

/** Pagamento, do banco. */
export type Payment = {
  readonly id: string;
  readonly supplierId: string;
  readonly store: string;
  readonly paidOn: string;
  readonly amount: Money;
  readonly method: string;
  readonly origin: string;
  readonly invoiceAccessKey: string | null;
};

export type ReceiptItem = {
  readonly supplierCode: string;
  readonly description: string;
  readonly quantity: Quantity;
};

/** Recebimento físico (contagem), do WMS. */
export type Receipt = {
  readonly id: string;
  readonly invoiceAccessKey: string;
  readonly purchaseOrderId: string | null;
  readonly supplierId: string;
  readonly store: string;
  readonly receivedOn: string;
  readonly items: readonly ReceiptItem[];
  readonly note: string;
};

/** Tudo o que uma verificação pode consultar. */
export type CheckContext = {
  readonly purchaseOrders: readonly PurchaseOrder[];
  readonly suppliers: readonly Supplier[];
  readonly products: readonly Product[];
  readonly postedInvoices: readonly PostedInvoice[];
  readonly payments: readonly Payment[];
  readonly receipts: readonly Receipt[];
  /** Notas já capturadas, para a duplicidade (regra 1). */
  readonly capturedInvoices: readonly Invoice[];
};
