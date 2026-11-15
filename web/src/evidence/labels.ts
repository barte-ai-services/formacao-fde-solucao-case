import type { DivergenceCode, EvidenceSource } from "../api/contract";

/** O nome de cada exceção, como no wireframe aprovado (F3). */
export const DIVERGENCE_LABEL: Record<DivergenceCode, string> = {
  E1: "E1 · Falta física",
  E2: "E2 · Item trocado",
  E3: "E3 · Quantidade menor",
  E4: "E4 · Unidade de medida",
  E5: "E5 · Nota sem ordem",
  E6: "E6 · Duplicidade",
  E7: "E7 · Pago fora do fluxo",
  E8: "E8 · Item sem cadastro",
  NAO_CATALOGADA: "Não catalogada",
};

/** O sistema de onde vem cada evidência. */
export const SOURCE_LABEL: Record<EvidenceSource, string> = {
  sefaz: "Nota da SEFAZ",
  erp_compras: "ERP · ordem de compra",
  erp_contas_a_pagar: "ERP · contas a pagar",
  erp_cadastro: "ERP · cadastro",
  banco: "Banco",
  wms: "WMS · recebimento",
};

export function divergenceLabel(code: string): string {
  return Object.hasOwn(DIVERGENCE_LABEL, code) ? DIVERGENCE_LABEL[code as DivergenceCode] : code;
}

export function sourceLabel(source: string): string {
  return Object.hasOwn(SOURCE_LABEL, source) ? SOURCE_LABEL[source as EvidenceSource] : source;
}
