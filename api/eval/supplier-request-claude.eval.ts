// #11 (#2): eval do e-mail ao fornecedor com o Claude de verdade, pelo mesmo cliente do Worker e pelo mesmo prompt.
// #11: Fora do gate: `npm run eval:supplier-request`. Precisa de BARTE_ACADEMY_CLAUDE_CODE_OAUTH_TOKEN ou
// #11: de BARTE_ACADEMY_ANTHROPIC_API_KEY no ambiente. Não grava em banco nem envia nada: só pede o texto e conta
// #11: quantas vezes o catálogo o recusa (validateRequestText). Esperado: nenhuma recusa nos casos abaixo.
import { env } from 'node:process';
import { describe, expect, it } from 'vitest';
import { ClaudeClient, credentialsFromEnv } from '../src/claude/client.js';
import { buildReturnNote, buildSupplierRequestFacts, validateRequestText } from '../src/domain/index.js';
import { buildSupplierRequestPrompt } from '../src/supplier/prompt.js';
import { queueEntry, sourceInvoice } from '../test/domain/supplier-request-fixtures.js';

// #11: devoluções sobre a nota do kit (F02, NF 43894): duas linhas, e uma linha só com descrição com número (2 L).
const CASES = [
  { name: 'duas linhas', lines: [{ supplierCode: 'F02-002', amount: 7, unit: 'UN' as const }, { supplierCode: 'F02-005', amount: 5, unit: 'CX' as const }] },
  { name: 'uma linha, descrição com número', lines: [{ supplierCode: 'F02-002', amount: 12, unit: 'UN' as const }] },
  { name: 'uma linha em caixa', lines: [{ supplierCode: 'F02-005', amount: 2, unit: 'CX' as const }] },
];

describe('eval do e-mail ao fornecedor com o Claude (#11)', () => { // ADR-002
  it('conta as recusas do catálogo sobre o texto que o Claude escreve', async () => { // ADR-002
    const credentials = credentialsFromEnv({
      BARTE_ACADEMY_ANTHROPIC_API_KEY: env.BARTE_ACADEMY_ANTHROPIC_API_KEY,
      BARTE_ACADEMY_CLAUDE_CODE_OAUTH_TOKEN: env.BARTE_ACADEMY_CLAUDE_CODE_OAUTH_TOKEN,
    });
    if (!credentials) throw new Error('sem BARTE_ACADEMY_CLAUDE_CODE_OAUTH_TOKEN nem BARTE_ACADEMY_ANTHROPIC_API_KEY');
    const client = new ClaudeClient({ credentials });
    const invoice = sourceInvoice();
    let rejected = 0;
    console.log('Eval do e-mail ao fornecedor (#11)');
    for (const c of CASES) {
      const note = buildReturnNote(queueEntry({ lines: c.lines }), invoice);
      const catalog = buildSupplierRequestFacts(note, invoice, '2026-11-17');
      const raw = await client.ask<unknown>(buildSupplierRequestPrompt(catalog, 'return_note'));
      const checked = validateRequestText(raw, catalog);
      if (!checked.ok) rejected += 1;
      console.log(`  ${c.name}: ${checked.ok ? 'aceito' : `recusado (${checked.reason}: ${checked.field})`}`);
    }
    console.log(`recusas: ${rejected} de ${CASES.length}`);
    expect(rejected).toBe(0);
  });
});
