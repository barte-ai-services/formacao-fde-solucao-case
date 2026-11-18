import { describe, expect, it } from 'vitest';
import { dossierField } from '../../src/dossier/proposal-field.js';
import type { Dossier } from '../../src/domain/index.js';

const GERADO = '2026-11-15T12:00:00.000Z';

describe('dossierField', () => {
  it('#38/AC-1 o dossiê pronto vai como está, em JSON, com o nome da exceção (#128)', () => {
    const dossier: Dossier = {
      status: 'ready',
      summary: 'r',
      divergences: [{ classification: 'E1', whatDiverges: 'o', evidence: [] }],
      supplierHistory: 'h',
      generatedAt: GERADO,
      model: 'claude-opus-5-5',
    };
    expect(JSON.parse(JSON.stringify(dossierField(dossier)))).toEqual({
      ...dossier,
      divergences: [{ classification: 'E1', exceptionName: 'Falta física', whatDiverges: 'o', evidence: [] }],
    });
  });

  it('#38/AC-4 indisponível leva o reason e o notice da tela', () => {
    expect(dossierField({ status: 'unavailable', reason: 'claude_failed', generatedAt: GERADO })).toEqual({
      status: 'unavailable',
      reason: 'claude_failed',
      notice:
        'Não há dossiê para esta proposta: o Claude não respondeu. Decida pelas divergências e evidências da conferência.',
      generatedAt: GERADO,
    });
  });

  it('#38/AC-4 sem dossiê gravado é indisponível pendente, sem data', () => {
    expect(dossierField(null)).toEqual({
      status: 'unavailable',
      reason: 'pending',
      notice: expect.stringContaining('o dossiê ainda não foi gerado'),
      generatedAt: null,
    });
  });
});
