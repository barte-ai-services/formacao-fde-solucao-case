import { describe, expect, it } from 'vitest';
import { checkDuplicidade } from '../../src/domain/checks/e6-duplicidade.js';
import { checkPagoForaDoFluxo } from '../../src/domain/checks/e7-pago-fora-do-fluxo.js';
import { checkNotaSemOrdem } from '../../src/domain/checks/e5-nota-sem-ordem.js';
import { checkItemSemCadastro } from '../../src/domain/checks/e8-item-sem-cadastro.js';
import { checkItemTrocado } from '../../src/domain/checks/e2-item-trocado.js';
import { checkUnidadeDeMedida } from '../../src/domain/checks/e4-unidade-de-medida.js';
import { checkFaltaFisica } from '../../src/domain/checks/e1-falta-fisica.js';
import { checkQuantidadeMenor } from '../../src/domain/checks/e3-quantidade-menor.js';
import { checkNaoCatalogada } from '../../src/domain/checks/nao-catalogada.js';
import { matchByDescription, reconcile } from '../../src/domain/index.js';
import { anInvoice, emptyContext } from './fixtures.js';

// Este teste é o contrato das histórias. Quando a sua história preencher uma verificação,
// troque o caso dela aqui pelos testes da história; não mude o nome nem a assinatura.
const contract = {
  checkDuplicidade,
  checkPagoForaDoFluxo,
  checkNotaSemOrdem,
  checkItemSemCadastro,
  checkItemTrocado,
  checkUnidadeDeMedida,
  checkFaltaFisica,
  checkQuantidadeMenor,
  checkNaoCatalogada,
};

describe('contrato das verificações', () => {
  for (const [name, check] of Object.entries(contract)) {
    it(`AC-2: ${name} existe com a assinatura Check e começa devolvendo []`, () => {
      expect(typeof check).toBe('function');
      expect(check(anInvoice(), emptyContext())).toEqual([]);
    });
  }

  it('AC-2: reconcile e matchByDescription existem e começam vazios', () => {
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
    expect(matchByDescription('Arroz 5kg', ['Arroz 5 kg'])).toBeNull();
  });
});
