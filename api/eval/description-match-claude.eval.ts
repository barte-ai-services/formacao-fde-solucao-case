// #66 AC-6, #171: eval do casamento de descrição com o Claude de verdade, pelo mesmo cliente do Worker.
// Fora do gate: `npm run eval:description-match`. Precisa de BARTE_ACADEMY_CLAUDE_CODE_OAUTH_TOKEN ou
// de BARTE_ACADEMY_ANTHROPIC_API_KEY no ambiente. Não grava no banco e só lê o kit (data/kit/notas.json e
// produtos.json), nunca excecoes.json. Esperado: 71,1% de revocação e zero falso positivo.
import { readFileSync } from 'node:fs';
import { env } from 'node:process';
import { describe, expect, it } from 'vitest';
import { ClaudeClient, credentialsFromEnv } from '../src/claude/client.js';
import { buildEvalDataset, narrowKit, pct, runEval, summarize } from '../src/claude/eval-description-match.js';

const read = (name: string): unknown => JSON.parse(readFileSync(new URL(`../../data/kit/${name}`, import.meta.url), 'utf8'));

describe('eval do casamento de descrição com o Claude (#171)', () => {
  it('mede acurácia, precisão e revocação', async () => {
    const credentials = credentialsFromEnv({
      BARTE_ACADEMY_ANTHROPIC_API_KEY: env.BARTE_ACADEMY_ANTHROPIC_API_KEY,
      BARTE_ACADEMY_CLAUDE_CODE_OAUTH_TOKEN: env.BARTE_ACADEMY_CLAUDE_CODE_OAUTH_TOKEN,
    });
    if (!credentials) throw new Error('sem BARTE_ACADEMY_CLAUDE_CODE_OAUTH_TOKEN nem BARTE_ACADEMY_ANTHROPIC_API_KEY');
    const client = new ClaudeClient({ credentials });
    const kit = narrowKit(read('notas.json'), read('produtos.json'));
    const cases = buildEvalDataset(kit.notas, kit.produtos);
    const results = await runEval(cases, client.ask);
    const s = summarize(results);
    console.log('Eval do casamento de descrição (#66, AC-6)');
    console.log(`casos: ${s.total} (positivos ${s.positives}, negativos ${s.negatives}); linhas do kit descartadas: ${kit.dropped}`);
    console.log(`acurácia ${pct(s.accuracy)}, precisão ${pct(s.precision)}, revocação ${pct(s.recall)}`);
    console.log(`falsos positivos nos negativos: ${s.falsePositivesOnNegatives}; falhas do Claude: ${s.claudeFailures}`);
    for (const [variant, v] of Object.entries(s.byVariant)) console.log(`  ${variant}: ${v.correct}/${v.total} (${pct(v.accuracy)})`);
    expect(s.falsePositivesOnNegatives).toBe(0);
    expect(s.claudeFailures).toBe(0);
  });
});
