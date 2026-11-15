export type EvidenceSource = // ADR-002
  | 'sefaz' // ADR-002
  | 'erp_compras' // ADR-002
  | 'erp_contas_a_pagar' // ADR-002
  | 'erp_cadastro' // ADR-002
  | 'banco' // ADR-002
  | 'wms'; // ADR-002

/** O registro de um sistema que sustenta uma divergência. */
export type Evidence = {
  readonly source: EvidenceSource;
  readonly reference: string;
  readonly description: string;
};
