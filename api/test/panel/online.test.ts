// Painel do valor barrado contra o Supabase real (#71). Pula sem BARTE_ACADEMY_SUPABASE_URL e _SECRET_KEY.
// #71 Local: set -a; . ./.dev.vars; set +a; npm --prefix api test. Nenhum valor de chave é impresso.
import { describe, expect, it } from 'vitest';
import { isInteger, isString, parseRows, shaped, type Shape } from '../../src/connectors/guards.js';
import { SupabaseRest } from '../../src/connectors/supabase-rest.js';
import { formatMonth, monthOf, summarizeBarredAmount, type Month } from '../../src/panel/barred-amount.js';
import { readProposalRecords } from '../../src/panel/proposals-reader.js';

function env(name: string): string | undefined {
  const value: unknown = Reflect.get(process.env, name);
  return typeof value === 'string' && value !== '' ? value : undefined;
}

const URL_ = env('BARTE_ACADEMY_SUPABASE_URL');
const KEY = env('BARTE_ACADEMY_SUPABASE_SECRET_KEY');
const ONLINE = Boolean(URL_ && KEY);

type Raw = { classification: string; dock_action: { kind: string }; amount_at_risk_cents: number };
const isRaw = shaped<Raw>({
  classification: isString,
  dock_action: shaped<{ kind: string }>({ kind: isString }),
  amount_at_risk_cents: isInteger,
} satisfies Shape<Raw>);

describe.skipIf(!ONLINE)('#71 online, no Supabase real', () => {
  const rest = new SupabaseRest({ url: URL_ ?? '', secretKey: KEY ?? '' });

  it('#71/AC-4 o total do painel, somado em todos os meses, bate com a soma direta das decididas que barram', async () => {
    const rows = await rest.select('proposals', {
      select: 'classification,dock_action,amount_at_risk_cents',
      filters: { state: 'in.(aprovada,alterada)' },
    });
    const raw = parseRows(rows, isRaw, 'proposals');
    const direct = raw
      .filter((r) => ['recusar', 'receber_parcial'].includes(r.dock_action.kind) && r.classification !== 'MATCH')
      .reduce((s, r) => s + r.amount_at_risk_cents, 0);

    const records = await readProposalRecords(rest);
    const months = new Map<string, Month>();
    for (const r of records) {
      if (r.state !== 'aprovada' && r.state !== 'alterada') continue;
      const m = monthOf(r.approvedAt ?? r.createdAt);
      months.set(formatMonth(m), m);
    }
    const fromPanel = [...months.values()].reduce(
      (s, m) => s + summarizeBarredAmount(records, m).panel.barred.totalCents,
      0,
    );
    console.log(`  AC-4 online: ${raw.length} decididas, ${months.size} meses, total ${fromPanel} centavos`);
    expect(fromPanel).toBe(direct);
  }, 60_000);
});
