import type { Classification } from './classification.js';

export type ExceptionEntry = { readonly code: Classification; readonly name: string };

/**
 * O nome de cada exceção, como no glossário (`docs/domain/glossary.md`). É o espelho da tabela
 * `public.exceptions` (migração `20261115220000_exceptions_reference.sql`); a API devolve o nome
 * daqui e a tela não traduz código (#128).
 */
export const EXCEPTION_CATALOG: Readonly<Record<Classification, ExceptionEntry>> = Object.freeze({
  E1: { code: 'E1', name: 'Falta física' },
  E2: { code: 'E2', name: 'Item trocado' },
  E3: { code: 'E3', name: 'Quantidade menor' },
  E4: { code: 'E4', name: 'Unidade de medida' },
  E5: { code: 'E5', name: 'Nota sem ordem' },
  E6: { code: 'E6', name: 'Duplicidade' },
  E7: { code: 'E7', name: 'Pago fora do fluxo' },
  E8: { code: 'E8', name: 'Item sem cadastro' },
  NAO_CATALOGADA: { code: 'NAO_CATALOGADA', name: 'Divergência não catalogada' },
  MATCH: { code: 'MATCH', name: 'Confere' },
});

export function exceptionName(code: Classification): string {
  return EXCEPTION_CATALOG[code].name;
}

/** Os dois campos que a API devolve onde antes havia só a classificação. */
export function exceptionFields(code: Classification): { exceptionCode: Classification; exceptionName: string } {
  return { exceptionCode: code, exceptionName: exceptionName(code) };
}
