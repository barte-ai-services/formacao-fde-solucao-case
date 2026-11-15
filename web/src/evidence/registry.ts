/**
 * O registro dos componentes de evidência por código de exceção. Cada história registra o seu num
 * arquivo próprio (`e1.tsx` … `e8.tsx`, `nao-catalogada.tsx`); quem desenha a proposta só chama
 * <EvidenceView>, que escolhe o registrado ou cai no genérico.
 */
import type { ComponentType } from "react";
import type { DivergenceCode, DivergenceDto } from "../api/contract";

export interface EvidenceProps {
  divergence: DivergenceDto;
}

export type EvidenceComponent = ComponentType<EvidenceProps>;

const registry = new Map<string, EvidenceComponent>();

/** Registra o componente que desenha a evidência de `code`. Registrar de novo troca o anterior. */
export function registerEvidence(code: DivergenceCode, component: EvidenceComponent): void {
  registry.set(code, component);
}

/** O componente registrado para `code`, ou `undefined`. Aceita qualquer texto: o fio pode trazer um código novo. */
export function evidenceComponentFor(code: string): EvidenceComponent | undefined {
  return registry.get(code);
}

/** Os códigos com componente registrado. */
export function registeredEvidenceCodes(): string[] {
  return [...registry.keys()];
}

/** Esvazia o registro. Só para os testes. */
export function clearEvidenceRegistry(): void {
  registry.clear();
}
