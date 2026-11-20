import type { Classification } from './classification.js';
import type { DockAction } from './dock-action.js';

/**
 * #337/AC-3: o que o domínio decide para a ação na doca de cada classificação. `usual` é a ação da classificação sozinha na nota;
 * `wholeInvoiceHeld` é a que vale quando a regra segura todos os itens da nota (actionOf, draft-checked.ts: segurar a nota inteira
 * é recusar); `nothingToHold` é a que vale quando a regra não acha linha a segurar (sem contagem do WMS, por exemplo): receber.
 * É o espelho do motor, `draftForChecked` (draft-checked.ts, o caminho de `proposeChecked`): `draftNotaSemOrdem` (E5), `draftProposal` (approval.ts) e `draftChecked`; o teste
 * api/test/domain/dock-action-by-classification.test.ts roda o motor em toda nota do kit e confere a constante com o que ele propõe.
 */
export type DockDecision = {
  readonly usual: DockAction['kind'];
  readonly wholeInvoiceHeld?: DockAction['kind'];
  readonly nothingToHold?: DockAction['kind'];
};

const HOLDS = { usual: 'receber_parcial', wholeInvoiceHeld: 'recusar', nothingToHold: 'receber' } as const;

export const DOCK_ACTION_BY_CLASSIFICATION: Readonly<Record<Classification, DockDecision>> = Object.freeze({
  // #337/AC-4 approval.ts:287 (draftProposal, MATCH): recebe sem risco.
  MATCH: Object.freeze({ usual: 'receber' }),
  // #337/AC-4 draft-checked.ts:30 (partE1), :107 (actionOf): segura os itens que não aparecem na contagem; sem contagem (:32) não há o que segurar.
  E1: Object.freeze(HOLDS),
  // #337/AC-4 draft-checked.ts:60 (partE2), :107 (actionOf): segura o item trocado.
  E2: Object.freeze(HOLDS),
  // #337/AC-4 e3-quantidade-menor.ts:81 (proposeE3), draft-checked.ts:40 (partE3): recebe parcial devolvendo a diferença.
  E3: Object.freeze(HOLDS),
  // #337/AC-4 draft-checked.ts:69 (partE4): "caixa cobrada como unidade; recebe", sem linha a segurar.
  E4: Object.freeze({ usual: 'receber' }),
  // #337/AC-4 probable-order.ts:147 (draftNotaSemOrdem, a que draftForChecked usa para E5, draft-checked.ts:143): a nota sem ordem recusa, com a nota inteira em risco; antes a constante dizia receber, lendo draftProposal, que a E5 não usa.
  E5: Object.freeze({ usual: 'recusar' }),
  // #337/AC-4 approval.ts:263 (draftProposal, E6) e docs/domain/README.md, regra 3 (l.254): duplicidade leva sempre a recusar.
  E6: Object.freeze({ usual: 'recusar' }),
  // #337/AC-4 approval.ts:270 (draftProposal, E7): a mercadoria já está na loja; recebe com o valor da nota em risco.
  E7: Object.freeze({ usual: 'receber' }),
  // #337/AC-4 draft-checked.ts:74 (partE8), :107 (actionOf): segura os itens sem cadastro.
  E8: Object.freeze(HOLDS),
  // #337/AC-4 approval.ts:279 (draftProposal, NAO_CATALOGADA com cobrança a mais) e :294 (caso geral): recebe.
  NAO_CATALOGADA: Object.freeze({ usual: 'receber' }),
});
