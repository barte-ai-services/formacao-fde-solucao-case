import type { NamedCheck } from './check.js';
import { checkFaltaFisica } from './e1-falta-fisica.js';
import { checkItemTrocado } from './e2-item-trocado.js';
import { checkQuantidadeMenor } from './e3-quantidade-menor.js';
import { checkUnidadeDeMedida } from './e4-unidade-de-medida.js';
import { checkNotaSemOrdem } from './e5-nota-sem-ordem.js';
import { checkDuplicidade } from './e6-duplicidade.js';
import { checkPagoForaDoFluxo } from './e7-pago-fora-do-fluxo.js';
import { checkItemSemCadastro } from './e8-item-sem-cadastro.js';
import { checkNaoCatalogada } from './nao-catalogada.js';

export type { Check, NamedCheck } from './check.js';

/** Regra 2 e decisão 1: a ordem em que a conferência roda as verificações. */
export const CHECKS: readonly NamedCheck[] = Object.freeze([
  { id: 'E6', run: checkDuplicidade },
  { id: 'E7', run: checkPagoForaDoFluxo },
  { id: 'E5', run: checkNotaSemOrdem },
  { id: 'E8', run: checkItemSemCadastro },
  { id: 'E2', run: checkItemTrocado },
  { id: 'E4', run: checkUnidadeDeMedida },
  { id: 'E1', run: checkFaltaFisica },
  { id: 'E3', run: checkQuantidadeMenor },
  { id: 'NAO_CATALOGADA', run: checkNaoCatalogada },
]);
