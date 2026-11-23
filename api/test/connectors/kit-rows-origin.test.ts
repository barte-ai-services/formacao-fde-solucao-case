import { describe, expect, it } from 'vitest';
import { isKitNotaRow } from '../../src/connectors/kit-rows.js';

// #349: a origem da nota é opcional na leitura, para os mocks e as linhas antigas continuarem valendo.
const base = {
  chave: '1'.repeat(44), // ADR-001
  nota_id: 'NF-001', // ADR-001
  numero: 1, // ADR-001
  serie: 1, // ADR-001
  fornecedor_id: 'F01', // ADR-001
  destino: 'LJ-001', // ADR-001
  data_emissao: '2026-11-23', // ADR-001
  pedido_referenciado: null, // ADR-001
  canal_entrada: 'SEFAZ', // ADR-001
  valor_total: '10.00', // ADR-001
};

describe('#349 kit_notas.origin na leitura', () => {
  it('a linha sem origin continua valendo', () => {
    expect(isKitNotaRow(base)).toBe(true);
  });

  it('aceita base e demo', () => {
    expect(isKitNotaRow({ ...base, origin: 'base' })).toBe(true);
    expect(isKitNotaRow({ ...base, origin: 'demo' })).toBe(true);
  });

  it('recusa qualquer outro valor', () => {
    expect(isKitNotaRow({ ...base, origin: 'real' })).toBe(false);
    expect(isKitNotaRow({ ...base, origin: null })).toBe(false);
  });
});
