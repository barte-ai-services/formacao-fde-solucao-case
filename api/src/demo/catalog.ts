// Catálogo do gerador de notas da demonstração (#349): fornecedores e produtos da base do kit (data/kit/fornecedores.json e
// produtos.json), que as linhas geradas citam por chave estrangeira. Um teste confere este catálogo contra os dois arquivos.
// Todos os nomes e CNPJs são fictícios: o CNPJ tem dígito verificador inválido de propósito.

export type DemoSupplier = {
  readonly id: string;
  readonly name: string;
  /** Só os 14 dígitos do CNPJ, que entram na chave de acesso. */
  readonly cnpjDigits: string;
  readonly blocked: boolean;
};

export type DemoProduct = {
  readonly sku: string;
  readonly supplierId: string;
  readonly supplierCode: string;
  readonly description: string;
  readonly boxFactor: number;
  readonly priceCents: number;
};

export type DemoUnregisteredItem = {
  readonly description: string;
  readonly priceCents: number;
};

export const BLOCKED_SUPPLIER = 'F12';

export const SUPPLIERS: readonly DemoSupplier[] = [
  { id: 'F01', name: "Laticínios Serra Azul Ltda.", cnpjDigits: '26804190000106', blocked: false },
  { id: 'F02', name: "Bebidas Rio Claro S.A.", cnpjDigits: '74055489000148', blocked: false },
  { id: 'F03', name: "Hortifruti Vale Verde Ltda.", cnpjDigits: '94433432000143', blocked: false },
  { id: 'F04', name: "Higiene Lume Indústria Ltda.", cnpjDigits: '00023027000111', blocked: false },
  { id: 'F05', name: "Mercearia Atlântica Distribuidora Ltda.", cnpjDigits: '54813096000149', blocked: false },
  { id: 'F06', name: "Congelados Polar Sul Ltda.", cnpjDigits: '47573594000106', blocked: false },
  { id: 'F07', name: "Padaria Trigo Bom Ltda.", cnpjDigits: '13769729000182', blocked: false },
  { id: 'F08', name: "Distribuidora Cerrado Alimentos Ltda.", cnpjDigits: '62833783000154', blocked: false },
  { id: 'F09', name: "Pet Amigo Comércio Ltda.", cnpjDigits: '96332932000113', blocked: false },
  { id: 'F10', name: "Limpeza Brilho Produtos Ltda.", cnpjDigits: '53194517000138', blocked: false },
  { id: 'F11', name: "Snacks Crocante Ltda.", cnpjDigits: '93339323000108', blocked: false },
  { id: 'F12', name: "Café Monte Alto Ltda.", cnpjDigits: '09891615000133', blocked: true },
];

export const PRODUCTS: readonly DemoProduct[] = [
  { sku: 'SKU-1001', supplierId: 'F01', supplierCode: 'F01-001', description: "Leite integral 1 L", boxFactor: 12, priceCents: 489 },
  { sku: 'SKU-1002', supplierId: 'F01', supplierCode: 'F01-002', description: "Iogurte natural 170 g", boxFactor: 6, priceCents: 329 },
  { sku: 'SKU-1003', supplierId: 'F01', supplierCode: 'F01-003', description: "Queijo muçarela fatiado 150 g", boxFactor: 4, priceCents: 990 },
  { sku: 'SKU-1004', supplierId: 'F01', supplierCode: 'F01-004', description: "Manteiga com sal 200 g", boxFactor: 4, priceCents: 1240 },
  { sku: 'SKU-1005', supplierId: 'F02', supplierCode: 'F02-001', description: "Água mineral 1,5 L", boxFactor: 6, priceCents: 279 },
  { sku: 'SKU-1006', supplierId: 'F02', supplierCode: 'F02-002', description: "Refrigerante cola 2 L", boxFactor: 6, priceCents: 849 },
  { sku: 'SKU-1007', supplierId: 'F02', supplierCode: 'F02-003', description: "Suco de uva integral 1 L", boxFactor: 4, priceCents: 1490 },
  { sku: 'SKU-1008', supplierId: 'F02', supplierCode: 'F02-004', description: "Água de coco 1 L", boxFactor: 4, priceCents: 970 },
  { sku: 'SKU-1009', supplierId: 'F03', supplierCode: 'F03-001', description: "Banana prata kg", boxFactor: 4, priceCents: 690 },
  { sku: 'SKU-1010', supplierId: 'F03', supplierCode: 'F03-002', description: "Tomate italiano kg", boxFactor: 4, priceCents: 850 },
  { sku: 'SKU-1011', supplierId: 'F03', supplierCode: 'F03-003', description: "Alface crespa unidade", boxFactor: 4, priceCents: 340 },
  { sku: 'SKU-1012', supplierId: 'F04', supplierCode: 'F04-001', description: "Sabonete em barra 85 g", boxFactor: 12, priceCents: 249 },
  { sku: 'SKU-1013', supplierId: 'F04', supplierCode: 'F04-002', description: "Creme dental 90 g", boxFactor: 12, priceCents: 590 },
  { sku: 'SKU-1014', supplierId: 'F04', supplierCode: 'F04-003', description: "Shampoo 350 ml", boxFactor: 4, priceCents: 1690 },
  { sku: 'SKU-1015', supplierId: 'F05', supplierCode: 'F05-001', description: "Arroz tipo 1 5 kg", boxFactor: 4, priceCents: 2790 },
  { sku: 'SKU-1016', supplierId: 'F05', supplierCode: 'F05-002', description: "Feijão carioca 1 kg", boxFactor: 4, priceCents: 890 },
  { sku: 'SKU-1017', supplierId: 'F05', supplierCode: 'F05-003', description: "Café torrado 500 g", boxFactor: 4, priceCents: 1990 },
  { sku: 'SKU-1018', supplierId: 'F05', supplierCode: 'F05-004', description: "Açúcar refinado 1 kg", boxFactor: 4, priceCents: 499 },
  { sku: 'SKU-1019', supplierId: 'F06', supplierCode: 'F06-001', description: "Pão de queijo congelado 1 kg", boxFactor: 4, priceCents: 2490 },
  { sku: 'SKU-1020', supplierId: 'F06', supplierCode: 'F06-002', description: "Pizza congelada 460 g", boxFactor: 4, priceCents: 2190 },
  { sku: 'SKU-1021', supplierId: 'F06', supplierCode: 'F06-003', description: "Sorvete 1,5 L", boxFactor: 4, priceCents: 2690 },
  { sku: 'SKU-1022', supplierId: 'F07', supplierCode: 'F07-001', description: "Pão de forma 500 g", boxFactor: 4, priceCents: 949 },
  { sku: 'SKU-1023', supplierId: 'F07', supplierCode: 'F07-002', description: "Bisnaguinha 300 g", boxFactor: 4, priceCents: 799 },
  { sku: 'SKU-1024', supplierId: 'F08', supplierCode: 'F08-001', description: "Óleo de soja 900 ml", boxFactor: 4, priceCents: 789 },
  { sku: 'SKU-1025', supplierId: 'F08', supplierCode: 'F08-002', description: "Macarrão espaguete 500 g", boxFactor: 4, priceCents: 469 },
  { sku: 'SKU-1026', supplierId: 'F08', supplierCode: 'F08-003', description: "Molho de tomate 340 g", boxFactor: 4, priceCents: 399 },
  { sku: 'SKU-1027', supplierId: 'F09', supplierCode: 'F09-001', description: "Ração para cães 10 kg", boxFactor: 4, priceCents: 10990 },
  { sku: 'SKU-1028', supplierId: 'F09', supplierCode: 'F09-002', description: "Areia sanitária 4 kg", boxFactor: 4, priceCents: 1990 },
  { sku: 'SKU-1029', supplierId: 'F10', supplierCode: 'F10-001', description: "Detergente 500 ml", boxFactor: 4, priceCents: 269 },
  { sku: 'SKU-1030', supplierId: 'F10', supplierCode: 'F10-002', description: "Sabão em pó 1,6 kg", boxFactor: 4, priceCents: 2490 },
  { sku: 'SKU-1031', supplierId: 'F10', supplierCode: 'F10-003', description: "Água sanitária 2 L", boxFactor: 4, priceCents: 649 },
  { sku: 'SKU-1032', supplierId: 'F11', supplierCode: 'F11-001', description: "Batata chips 120 g", boxFactor: 4, priceCents: 1190 },
  { sku: 'SKU-1033', supplierId: 'F11', supplierCode: 'F11-002', description: "Amendoim torrado 500 g", boxFactor: 4, priceCents: 1390 },
  { sku: 'SKU-1034', supplierId: 'F11', supplierCode: 'F11-003', description: "Biscoito recheado 140 g", boxFactor: 4, priceCents: 379 },
  { sku: 'SKU-1035', supplierId: 'F12', supplierCode: 'F12-001', description: "Café em cápsula 10 un", boxFactor: 4, priceCents: 2190 },
  { sku: 'SKU-1036', supplierId: 'F12', supplierCode: 'F12-002', description: "Café solúvel 200 g", boxFactor: 4, priceCents: 2490 },
  { sku: 'SKU-1037', supplierId: 'F12', supplierCode: 'F12-003', description: "Filtro de papel 103", boxFactor: 4, priceCents: 690 },
];

/** Itens que o fornecedor passou a vender e que ainda não têm cadastro (E8). */
export const UNREGISTERED_ITEMS: Readonly<Record<string, DemoUnregisteredItem>> = {
  F02: { description: 'Isotônico limão 500 ml (lançamento)', priceCents: 590 },
  F05: { description: 'Granola sem açúcar 800 g (lançamento)', priceCents: 2990 },
  F06: { description: 'Hambúrguer vegetal 4 un (lançamento)', priceCents: 2750 },
  F08: { description: 'Molho pesto 200 g (lançamento)', priceCents: 1590 },
  F11: { description: 'Chips de mandioca 80 g (lançamento)', priceCents: 990 },
  F01: { description: 'Kefir natural 500 ml (lançamento)', priceCents: 1890 },
  F04: { description: 'Desodorante sem alumínio 55 g (lançamento)', priceCents: 2390 },
  F09: { description: 'Petisco dental 160 g (lançamento)', priceCents: 1790 },
  F10: { description: 'Limpador multiuso refil 1 L (lançamento)', priceCents: 1190 },
};

export const STORES: readonly string[] = Array.from({ length: 30 }, (_, i) => `LJ-${String(i + 1).padStart(3, '0')}`);
export const DISTRIBUTION_CENTERS: readonly string[] = ['CD-01', 'CD-02', 'CD-03', 'CD-04'];
