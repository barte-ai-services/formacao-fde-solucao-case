export type EvidenceSource =
  | 'sefaz'
  | 'erp_compras'
  | 'erp_contas_a_pagar'
  | 'erp_cadastro'
  | 'banco'
  | 'wms';

/** O registro de um sistema que sustenta uma divergência. */
export type Evidence = {
  readonly source: EvidenceSource;
  readonly reference: string;
  readonly description: string;
};
