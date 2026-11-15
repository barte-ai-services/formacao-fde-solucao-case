// Portas dos conectores (#59, AC-2): o que a conferência lê dos sistemas e o que publica para eles.
import type {
  AuditResult,
  DockAction,
  Invoice,
  Payment,
  PostedInvoice,
  Product,
  PurchaseOrder,
  Quantity,
  NotAudited,
  Receipt,
  RuleProposal,
  Supplier,
} from '../domain/index.js';

// #59 Leitura

/** #59 SEFAZ: as notas emitidas contra a Já Chegou, todas a conferir. */
export interface SefazPort {
  listIssuedInvoices(): Promise<Invoice[]>;
}

/** #59 ERP Compras: as ordens de compra, com o saldo de cada item (regra 5). */
export interface PurchasingPort {
  listPurchaseOrders(): Promise<PurchaseOrder[]>;
}

/** #59 ERP Contas a pagar: as notas já lançadas. */
export interface PayablesPort {
  listPostedInvoices(): Promise<PostedInvoice[]>;
}

/** #135 App da loja: a ação no recebimento da nota de loja (mock de saída). */
export type StoreActionOutbox = Outbox<StoreActionMessage>;

/** #59 ERP Cadastro: fornecedores e produtos. */
export interface RegistryPort {
  listSuppliers(): Promise<Supplier[]>;
  listProducts(): Promise<Product[]>;
}

/** #59 Banco: os pagamentos feitos, inclusive os fora do fluxo. */
export interface BankPort {
  listPayments(): Promise<Payment[]>;
}

/** #59 WMS e app de loja: as contagens do recebimento. */
export interface WmsCountPort {
  listReceipts(): Promise<Receipt[]>;
}

// #59 Saída (caixas de saída)

/** #59 O que a caixa de saída devolve: a mensagem, com o número e a hora em que foi publicada. */
export type Published<T> = T & { readonly id: number; readonly publishedAt: string };

export interface Outbox<T> {
  publish(message: T): Promise<Published<T>>;
  list(): Promise<Published<T>[]>;
}

export type DockActionMessage = {
  readonly invoiceAccessKey: string;
  readonly action: DockAction;
};

/** #135 A ação no recebimento da nota de loja: vai para o app da loja, não para o WMS. */
export type StoreActionMessage = {
  readonly invoiceAccessKey: string;
  readonly store: string;
  readonly action: DockAction;
};

export type RegistryCorrectionKind = 'E8_item_sem_cadastro' | 'E4_fator_de_caixa';

export type RegistryCorrectionMessage = {
  readonly invoiceAccessKey: string;
  readonly kind: RegistryCorrectionKind;
  readonly supplierCode: string;
  readonly sku: string | null;
  readonly detail: string;
};

export type ReturnNoteLine = {
  readonly supplierCode: string;
  readonly quantity: Quantity;
};

export type ReturnNoteMessage = {
  readonly invoiceAccessKey: string;
  readonly lines: readonly ReturnNoteLine[];
  readonly reason: string;
};

/** #59 WMS: a ação na doca aprovada, antes do caminhão. */
export type DockActionOutbox = Outbox<DockActionMessage>;

/** #59 ERP Cadastro: o item sem cadastro (E8) e o fator de caixa a corrigir (E4). */
export type RegistryCorrectionOutbox = Outbox<RegistryCorrectionMessage>;

/** #59 ERP: a nota de devolução das linhas devolvidas. */
export type ReturnNoteOutbox = Outbox<ReturnNoteMessage>;

// #230 O auditor de notas (história #153)

/** #230 A nota capturada e a proposta da regra, como a auditoria as lê. */
export type AuditedNote = { readonly invoice: Invoice; readonly proposal: RuleProposal };

/**
 * #230 O que a auditoria lê e grava por nota. `save` é a única escrita do auditor: grava a auditoria com
 * `agreement`, `raised_level` e `injection_flag` e, só se `raisedLevel` vier e a proposta ainda estiver em
 * aguardando_aprovacao NO MOMENTO da gravação, sobe o nível na mesma transação (a nota pode ter sido
 * decidida desde o `loadNote`). Nenhum método troca a ação da proposta nem aprova.
 */
export interface InvoiceAuditPort {
  /** A nota capturada com a proposta da regra, ou null se a nota ou a proposta não existe. */
  loadNote(invoiceAccessKey: string): Promise<AuditedNote | null>;
  save(invoiceAccessKey: string, result: AuditResult): Promise<void>;
  /** AC-6: a nota fica "não auditada" com o motivo; a proposta da regra segue como estava. */
  saveNotAudited(invoiceAccessKey: string, outcome: NotAudited): Promise<void>;
}

/**
 * #230 As 11 leituras das tools do auditor, sobre o banco da solução. Cada uma devolve o JSON que o modelo
 * lê (a mesma informação das tools do ja-chegou); nenhuma lê arquivo nem o gabarito.
 */
export interface AuditReadsPort {
  getInvoice(invoiceAccessKey: string): Promise<unknown>;
  getPurchaseOrder(orderId: string): Promise<unknown>;
  searchPurchaseOrders(query: { supplierId: string; store?: string; status?: string }): Promise<unknown>;
  getReceipt(invoiceAccessKey: string): Promise<unknown>;
  searchReceiptsWithoutInvoice(query: { supplierId: string; store: string }): Promise<unknown>;
  getRegistry(query: { sku?: string; supplierCode?: string; supplierId?: string }): Promise<unknown>;
  getSupplier(supplierId: string): Promise<unknown>;
  searchPostedInvoices(query: { supplierId: string; number?: string; orderId?: string }): Promise<unknown>;
  searchOutOfFlowPayments(query: { supplierId: string; store?: string }): Promise<unknown>;
  compareItems(invoiceAccessKey: string): Promise<unknown>;
  getRegua(): Promise<unknown>;
}
