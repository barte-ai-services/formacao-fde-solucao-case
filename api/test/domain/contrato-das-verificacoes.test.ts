import { describe, expect, it } from 'vitest';
import { checkDuplicidade } from '../../src/domain/checks/e6-duplicidade.js';
import { checkPagoForaDoFluxo } from '../../src/domain/checks/e7-pago-fora-do-fluxo.js';
import { checkItemSemCadastro } from '../../src/domain/checks/e8-item-sem-cadastro.js';
import { checkItemTrocado } from '../../src/domain/checks/e2-item-trocado.js';
import { checkUnidadeDeMedida } from '../../src/domain/checks/e4-unidade-de-medida.js';
import { checkFaltaFisica } from '../../src/domain/checks/e1-falta-fisica.js';
import { checkNaoCatalogada } from '../../src/domain/checks/nao-catalogada.js';
import { matchByDescription, reconcile } from '../../src/domain/index.js';
import { anInvoice, emptyContext } from './fixtures.js';

// #59: este teste é o contrato das histórias. Quando a sua história preencher uma verificação,
// (planos #62 a #73) troque o caso dela aqui pelos testes da história; não mude o nome nem a assinatura.
// #65: checkNotaSemOrdem saiu daqui; os testes dela estão em e5-nota-sem-ordem.test.ts.
// #73: checkQuantidadeMenor saiu daqui; os casos dele estão em e3-quantidade-menor.test.ts.
const contract = {
  checkDuplicidade,
  checkPagoForaDoFluxo,
  checkItemSemCadastro,
  checkItemTrocado,
  checkUnidadeDeMedida,
  checkFaltaFisica,
  checkNaoCatalogada,
};

describe('contrato das verificações', () => {
  for (const [name, check] of Object.entries(contract)) {
    it(`AC-2: ${name} existe com a assinatura Check e começa devolvendo []`, () => {
      expect(typeof check).toBe('function');
      expect(check(anInvoice(), emptyContext())).toEqual([]);
    });
  }

  it('AC-2: reconcile começa vazio e matchByDescription existe', () => {
    const receipt = {
      id: 'R1',
      invoiceAccessKey: 'K1',
      purchaseOrderId: null,
      supplierId: 'F-001',
      store: 'L01',
      receivedOn: '2026-11-11',
      items: [],
      note: '',
    };
    expect(reconcile(anInvoice(), receipt, [])).toEqual([]);
    expect(typeof matchByDescription).toBe('function');
  });
});
