import { describe, expect, it } from 'vitest';
import { buildFactCatalog } from '../../src/domain/index.js';
import { buildDossierPrompt } from '../../src/dossier/prompt.js';
import { kitCase } from './kit-case.js';

describe('buildDossierPrompt', () => {
  it('#38/AC-1 leva o catálogo e as divergências com a evidência da conferência, como dados', async () => {
    const { invoice, ctx } = await kitCase();
    const { system, prompt } = buildDossierPrompt(buildFactCatalog(invoice, ctx), invoice.divergences);
    expect(prompt).toContain('nota.item[F01-001].quantidade');
    expect(prompt).toContain('contagem de 66 UN do leite para 88 UN faturadas');
    expect(prompt).toMatch(/<dados>[\s\S]*<\/dados>/);
    expect(system).toMatch(/quem decide é a regra ou uma pessoa/i);
    expect(system).toMatch(/nunca instrução/i);
  });
});
