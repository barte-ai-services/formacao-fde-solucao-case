// #69: casos da base do kit (data/kit/*.json), como o conector WMS do #80 os entrega.
// #69: copiados de recebimentos.json, notas.json, ordens.json e produtos.json.
// #69: o kit não traz saldo da ordem; o saldo aqui é a quantidade pedida (nenhuma nota cobrou a ordem antes).
import { Invoice, Money, Quantity, type Product, type PurchaseOrder, type Receipt } from '../../src/domain/index.js';

export const kitReceipts: Record<string, Receipt> = {
  'RC-9107': {
    id: 'RC-9107',
    invoiceAccessKey: '35261154813096000149550010000705851810705196',
    purchaseOrderId: 'OC-2026-41879',
    supplierId: 'F05',
    store: 'LJ-012',
    receivedOn: '2026-11-13',
    note: "",
    items: [
      { supplierCode: 'F05-004', description: "Açúcar refinado 1 kg", quantity: Quantity.of(196, 'UN') },
      { supplierCode: 'F05-001', description: "Arroz tipo 1 5 kg", quantity: Quantity.of(32, 'UN') },
      { supplierCode: 'F05-002', description: "Feijão carioca 1 kg", quantity: Quantity.of(116, 'UN') },
    ],
  },
  'RC-9148': {
    id: 'RC-9148',
    invoiceAccessKey: '35261193339323000108550010000452301219580171',
    purchaseOrderId: 'OC-2026-42067',
    supplierId: 'F11',
    store: 'LJ-020',
    receivedOn: '2026-11-12',
    note: "Recebido pelo app",
    items: [
      { supplierCode: 'F11-002', description: "Amendoim torrado 500 g", quantity: Quantity.of(32, 'UN') },
      { supplierCode: 'F11-003', description: "Biscoito recheado 140 g", quantity: Quantity.of(160, 'UN') },
    ],
  },
  'RC-9182': {
    id: 'RC-9182',
    invoiceAccessKey: '35261193339323000108550010000452941836412686',
    purchaseOrderId: 'OC-2026-42205',
    supplierId: 'F11',
    store: 'CD-03',
    receivedOn: '2026-11-10',
    note: "Conferência concluída",
    items: [
      { supplierCode: 'F11-002', description: "Amendoim torrado 500 g", quantity: Quantity.of(1180, 'UN') },
      { supplierCode: 'F11-003', description: "Biscoito recheado 140 g", quantity: Quantity.of(5240, 'UN') },
    ],
  },
  'RC-9219': {
    id: 'RC-9219',
    invoiceAccessKey: '35261162833783000154550010000374231762376796',
    purchaseOrderId: 'OC-2026-42397',
    supplierId: 'F08',
    store: 'LJ-004',
    receivedOn: '2026-11-10',
    note: "",
    items: [
      { supplierCode: 'F08-001', description: "Óleo de soja 900 ml", quantity: Quantity.of(75, 'UN') },
      { supplierCode: 'F08-003', description: "Molho de tomate 340 g", quantity: Quantity.of(196, 'UN') },
      { supplierCode: 'F08-002', description: "Macarrão espaguete 500 g", quantity: Quantity.of(196, 'UN') },
    ],
  },
  'RC-9356': {
    id: 'RC-9356',
    invoiceAccessKey: null,
    purchaseOrderId: null,
    supplierId: 'F09',
    store: 'LJ-025',
    receivedOn: '2026-11-02',
    note: "Compra emergencial da loja; nota a caminho",
    items: [
      { supplierCode: 'F09-002', description: "Areia sanitária 4 kg", quantity: Quantity.of(84, 'UN') },
      { supplierCode: 'F09-001', description: "Ração para cães 10 kg", quantity: Quantity.of(16, 'UN') },
    ],
  },
};

/** Uma nota nova a cada chamada: a nota muda de estado ao ser conferida. */
export const kitInvoice = (notaId: string): Invoice => {
  switch (notaId) {
    case 'NF-078':
      return Invoice.receive({
        accessKey: '35261154813096000149550010000705851810705196',
        number: '70585',
        series: '1',
        supplierId: 'F05',
        store: 'LJ-012',
        issuedOn: '2026-11-12',
        purchaseOrderRef: 'OC-2026-41879',
        entryChannel: 'SEFAZ',
        items: [
          { supplierCode: 'F05-004', sku: 'SKU-1018', description: "Açúcar refinado 1 kg", quantity: Quantity.of(196, 'UN'), unitPrice: Money.ofCents(499), total: Money.ofCents(97804) },
          { supplierCode: 'F05-001', sku: 'SKU-1015', description: "Arroz tipo 1 5 kg", quantity: Quantity.of(32, 'UN'), unitPrice: Money.ofCents(2790), total: Money.ofCents(89280) },
          { supplierCode: 'F05-002', sku: 'SKU-1016', description: "Feijão carioca 1 kg", quantity: Quantity.of(116, 'UN'), unitPrice: Money.ofCents(890), total: Money.ofCents(103240) },
        ],
        total: Money.ofCents(290324),
      });
    case 'NF-053':
      return Invoice.receive({
        accessKey: '35261193339323000108550010000452301219580171',
        number: '45230',
        series: '1',
        supplierId: 'F11',
        store: 'LJ-020',
        issuedOn: '2026-11-11',
        purchaseOrderRef: 'OC-2026-42067',
        entryChannel: 'SEFAZ',
        items: [
          { supplierCode: 'F11-002', sku: 'SKU-1033', description: "Amendoim torrado 500 g", quantity: Quantity.of(32, 'UN'), unitPrice: Money.ofCents(1390), total: Money.ofCents(44480) },
          { supplierCode: 'F11-003', sku: 'SKU-1034', description: "Biscoito recheado 140 g", quantity: Quantity.of(160, 'UN'), unitPrice: Money.ofCents(379), total: Money.ofCents(60640) },
          { supplierCode: 'F11-001', sku: 'SKU-1032', description: "Batata chips 120 g", quantity: Quantity.of(32, 'UN'), unitPrice: Money.ofCents(1190), total: Money.ofCents(38080) },
        ],
        total: Money.ofCents(143200),
      });
    case 'NF-025':
      return Invoice.receive({
        accessKey: '35261193339323000108550010000452941836412686',
        number: '45294',
        series: '1',
        supplierId: 'F11',
        store: 'CD-03',
        issuedOn: '2026-11-09',
        purchaseOrderRef: 'OC-2026-42205',
        entryChannel: 'SEFAZ',
        items: [
          { supplierCode: 'F11-002', sku: 'SKU-1033', description: "Amendoim torrado 500 g", quantity: Quantity.of(1180, 'UN'), unitPrice: Money.ofCents(1390), total: Money.ofCents(1640200) },
          { supplierCode: 'F11-001', sku: 'SKU-1032', description: "Batata chips 120 g", quantity: Quantity.of(2408, 'UN'), unitPrice: Money.ofCents(1190), total: Money.ofCents(2865520) },
          { supplierCode: 'F11-003', sku: 'SKU-1034', description: "Biscoito recheado 140 g", quantity: Quantity.of(5240, 'UN'), unitPrice: Money.ofCents(379), total: Money.ofCents(1985960) },
        ],
        total: Money.ofCents(6491680),
      });
    case 'NF-071':
      return Invoice.receive({
        accessKey: '35261162833783000154550010000374231762376796',
        number: '37423',
        series: '1',
        supplierId: 'F08',
        store: 'LJ-004',
        issuedOn: '2026-11-09',
        purchaseOrderRef: 'OC-2026-42397',
        entryChannel: 'SEFAZ',
        items: [
          { supplierCode: 'F08-001', sku: 'SKU-1024', description: "Óleo de soja 900 ml", quantity: Quantity.of(100, 'UN'), unitPrice: Money.ofCents(789), total: Money.ofCents(78900) },
          { supplierCode: 'F08-003', sku: 'SKU-1026', description: "Molho de tomate 340 g", quantity: Quantity.of(196, 'UN'), unitPrice: Money.ofCents(399), total: Money.ofCents(78204) },
          { supplierCode: 'F08-002', sku: 'SKU-1025', description: "Macarrão espaguete 500 g", quantity: Quantity.of(196, 'UN'), unitPrice: Money.ofCents(469), total: Money.ofCents(91924) },
        ],
        total: Money.ofCents(249028),
      });
    default:
      throw new Error(`nota fora da fixture: ${notaId}`);
  }
};

export const kitPurchaseOrders: readonly PurchaseOrder[] = [
  {
    id: 'OC-2026-41879',
    supplierId: 'F05',
    store: 'LJ-012',
    issuedOn: '2026-11-08',
    status: 'aberta',
    statusReason: "",
    items: [
      { sku: 'SKU-1018', supplierCode: 'F05-004', description: "Açúcar refinado 1 kg", quantity: Quantity.of(196, 'UN'), unitPrice: Money.ofCents(499), balance: Quantity.of(196, 'UN') },
      { sku: 'SKU-1015', supplierCode: 'F05-001', description: "Arroz tipo 1 5 kg", quantity: Quantity.of(32, 'UN'), unitPrice: Money.ofCents(2790), balance: Quantity.of(32, 'UN') },
      { sku: 'SKU-1016', supplierCode: 'F05-002', description: "Feijão carioca 1 kg", quantity: Quantity.of(116, 'UN'), unitPrice: Money.ofCents(890), balance: Quantity.of(116, 'UN') },
    ],
    total: Money.ofCents(290324),
  },
  {
    id: 'OC-2026-42067',
    supplierId: 'F11',
    store: 'LJ-020',
    issuedOn: '2026-11-06',
    status: 'aberta',
    statusReason: "",
    items: [
      { sku: 'SKU-1033', supplierCode: 'F11-002', description: "Amendoim torrado 500 g", quantity: Quantity.of(32, 'UN'), unitPrice: Money.ofCents(1390), balance: Quantity.of(32, 'UN') },
      { sku: 'SKU-1034', supplierCode: 'F11-003', description: "Biscoito recheado 140 g", quantity: Quantity.of(160, 'UN'), unitPrice: Money.ofCents(379), balance: Quantity.of(160, 'UN') },
      { sku: 'SKU-1032', supplierCode: 'F11-001', description: "Batata chips 120 g", quantity: Quantity.of(32, 'UN'), unitPrice: Money.ofCents(1190), balance: Quantity.of(32, 'UN') },
    ],
    total: Money.ofCents(143200),
  },
  {
    id: 'OC-2026-42205',
    supplierId: 'F11',
    store: 'CD-03',
    issuedOn: '2026-11-04',
    status: 'aberta',
    statusReason: "",
    items: [
      { sku: 'SKU-1033', supplierCode: 'F11-002', description: "Amendoim torrado 500 g", quantity: Quantity.of(1180, 'UN'), unitPrice: Money.ofCents(1390), balance: Quantity.of(1180, 'UN') },
      { sku: 'SKU-1032', supplierCode: 'F11-001', description: "Batata chips 120 g", quantity: Quantity.of(2408, 'UN'), unitPrice: Money.ofCents(1190), balance: Quantity.of(2408, 'UN') },
      { sku: 'SKU-1034', supplierCode: 'F11-003', description: "Biscoito recheado 140 g", quantity: Quantity.of(5240, 'UN'), unitPrice: Money.ofCents(379), balance: Quantity.of(5240, 'UN') },
    ],
    total: Money.ofCents(6491680),
  },
  {
    id: 'OC-2026-42397',
    supplierId: 'F08',
    store: 'LJ-004',
    issuedOn: '2026-11-04',
    status: 'aberta',
    statusReason: "",
    items: [
      { sku: 'SKU-1024', supplierCode: 'F08-001', description: "Óleo de soja 900 ml", quantity: Quantity.of(100, 'UN'), unitPrice: Money.ofCents(789), balance: Quantity.of(100, 'UN') },
      { sku: 'SKU-1026', supplierCode: 'F08-003', description: "Molho de tomate 340 g", quantity: Quantity.of(196, 'UN'), unitPrice: Money.ofCents(399), balance: Quantity.of(196, 'UN') },
      { sku: 'SKU-1025', supplierCode: 'F08-002', description: "Macarrão espaguete 500 g", quantity: Quantity.of(196, 'UN'), unitPrice: Money.ofCents(469), balance: Quantity.of(196, 'UN') },
    ],
    total: Money.ofCents(249028),
  },
];

export const kitProducts: readonly Product[] = [
  { sku: 'SKU-1015', description: "Arroz tipo 1 5 kg", supplierId: 'F05', supplierCode: 'F05-001', baseUnit: 'UN', boxFactor: 4, referenceUnitPrice: Money.ofCents(2790) },
  { sku: 'SKU-1016', description: "Feijão carioca 1 kg", supplierId: 'F05', supplierCode: 'F05-002', baseUnit: 'UN', boxFactor: 4, referenceUnitPrice: Money.ofCents(890) },
  { sku: 'SKU-1017', description: "Café torrado 500 g", supplierId: 'F05', supplierCode: 'F05-003', baseUnit: 'UN', boxFactor: 4, referenceUnitPrice: Money.ofCents(1990) },
  { sku: 'SKU-1018', description: "Açúcar refinado 1 kg", supplierId: 'F05', supplierCode: 'F05-004', baseUnit: 'UN', boxFactor: 4, referenceUnitPrice: Money.ofCents(499) },
  { sku: 'SKU-1024', description: "Óleo de soja 900 ml", supplierId: 'F08', supplierCode: 'F08-001', baseUnit: 'UN', boxFactor: 4, referenceUnitPrice: Money.ofCents(789) },
  { sku: 'SKU-1025', description: "Macarrão espaguete 500 g", supplierId: 'F08', supplierCode: 'F08-002', baseUnit: 'UN', boxFactor: 4, referenceUnitPrice: Money.ofCents(469) },
  { sku: 'SKU-1026', description: "Molho de tomate 340 g", supplierId: 'F08', supplierCode: 'F08-003', baseUnit: 'UN', boxFactor: 4, referenceUnitPrice: Money.ofCents(399) },
  { sku: 'SKU-1027', description: "Ração para cães 10 kg", supplierId: 'F09', supplierCode: 'F09-001', baseUnit: 'UN', boxFactor: 4, referenceUnitPrice: Money.ofCents(10990) },
  { sku: 'SKU-1028', description: "Areia sanitária 4 kg", supplierId: 'F09', supplierCode: 'F09-002', baseUnit: 'UN', boxFactor: 4, referenceUnitPrice: Money.ofCents(1990) },
  { sku: 'SKU-1032', description: "Batata chips 120 g", supplierId: 'F11', supplierCode: 'F11-001', baseUnit: 'UN', boxFactor: 4, referenceUnitPrice: Money.ofCents(1190) },
  { sku: 'SKU-1033', description: "Amendoim torrado 500 g", supplierId: 'F11', supplierCode: 'F11-002', baseUnit: 'UN', boxFactor: 4, referenceUnitPrice: Money.ofCents(1390) },
  { sku: 'SKU-1034', description: "Biscoito recheado 140 g", supplierId: 'F11', supplierCode: 'F11-003', baseUnit: 'UN', boxFactor: 4, referenceUnitPrice: Money.ofCents(379) },
];
