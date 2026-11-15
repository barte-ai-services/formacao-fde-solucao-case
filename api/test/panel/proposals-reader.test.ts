// Leitor das propostas do painel (#71): PostgREST falso servido por fetch, com as notas reais do kit.
import { describe, expect, it } from 'vitest';
import { Money } from '../../src/domain/money.js';
import { PRECEDENCE, type Classification } from '../../src/domain/classification.js';
import { SupabaseRest, SupabaseRestError } from '../../src/connectors/supabase-rest.js';
import { summarizeBarredAmount } from '../../src/panel/barred-amount.js';
import { readProposalRecords } from '../../src/panel/proposals-reader.js';
import { FakePostgrest } from '../support/fake-postgrest.js';
import { kitTables } from '../support/kit.js';

type Row = Record<string, unknown>;

function restOver(fake: FakePostgrest): SupabaseRest {
  return new SupabaseRest({ url: 'https://fake.supabase.co', secretKey: 'sb_secret_teste', fetch: fake.fetch, pageSize: 7 });
}

function proposalRow(overrides: Row = {}): Row {
  return {
    id: 1,
    invoice_access_key: 'chave-1',
    classification: 'E1',
    dock_action: { kind: 'recusar' },
    approval_level: 'analista',
    amount_at_risk_cents: 1_000,
    justification: 'falta física',
    state: 'aprovada',
    created_at: '2026-11-05T12:00:00+00:00',
    ...overrides,
  };
}

describe('#71 leitor das propostas', () => {
  it('junta a data da aprovação e só pede os estados que o painel usa', async () => {
    const fake = new FakePostgrest({
      proposals: [
        proposalRow({ id: 1 }),
        proposalRow({ id: 2, state: 'alterada', dock_action: { kind: 'receber' } }),
        proposalRow({ id: 3, state: 'aguardando_aprovacao' }),
        proposalRow({ id: 4, state: 'registrada' }),
        proposalRow({ id: 5, state: 'aprovada', approval_level: 'regra', classification: 'MATCH', dock_action: { kind: 'receber' } }),
      ],
      approvals: [
        { id: 10, proposal_id: 1, approver: 'ana', approver_level: 'analista', justification: null, approved_at: '2026-11-06T10:00:00+00:00' },
        { id: 11, proposal_id: 2, approver: 'bia', approver_level: 'analista', justification: 'ok', approved_at: '2026-11-07T10:00:00+00:00' },
      ],
    });
    const records = await readProposalRecords(restOver(fake));
    expect(records.map((r) => [r.id, r.state, r.dockActionKind, r.approvedAt])).toEqual([
      [1, 'aprovada', 'recusar', '2026-11-06T10:00:00+00:00'],
      [2, 'alterada', 'receber', '2026-11-07T10:00:00+00:00'],
      [3, 'aguardando_aprovacao', 'recusar', null],
      [5, 'aprovada', 'receber', null],
    ]);
    const proposalsUrl = fake.requests.find((r) => r.url.includes('/proposals?'))?.url ?? '';
    expect(new URL(proposalsUrl).searchParams.get('state')).toBe('in.(aguardando_aprovacao,aprovada,alterada)');
  });

  it('recusa linha fora do formato sem expor os dados', async () => {
    const fake = new FakePostgrest({
      proposals: [proposalRow({ classification: 'E9', justification: 'segredo-da-linha' })],
      approvals: [],
    });
    const error = await readProposalRecords(restOver(fake)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SupabaseRestError);
    expect(String(error)).not.toContain('segredo-da-linha');
  });

  it('recusa dock_action sem kind válido e instante que não é data', async () => {
    for (const bad of [{ dock_action: { kind: 'devolver' } }, { dock_action: null }, { created_at: 'ontem' }]) {
      const fake = new FakePostgrest({ proposals: [proposalRow(bad)], approvals: [] });
      await expect(readProposalRecords(restOver(fake))).rejects.toBeInstanceOf(SupabaseRestError);
    }
  });
});

// #71/AC-4: as propostas nascem das notas reais do kit (data/kit/notas.json), nunca do gabarito.
const STATES = ['registrada', 'aguardando_aprovacao', 'aprovada', 'alterada'] as const;
const KINDS = ['receber', 'receber_parcial', 'recusar'] as const;
const CLASSES: readonly Classification[] = [...PRECEDENCE, 'MATCH'];

function kitProposals(): { proposals: Row[]; approvals: Row[] } {
  const notas = kitTables().kit_notas ?? [];
  const proposals: Row[] = [];
  const approvals: Row[] = [];
  notas.forEach((nota, i) => {
    const id = i + 1;
    const totalCents = Money.fromReais(Number(nota.valor_total)).cents;
    const classification = CLASSES[i % CLASSES.length] ?? 'E1';
    const kind = classification === 'MATCH' ? 'receber' : (KINDS[(i * 7) % KINDS.length] ?? 'recusar');
    const state = STATES[(i * 5) % STATES.length] ?? 'registrada';
    const day = String(nota.data_emissao);
    proposals.push({
      id,
      invoice_access_key: nota.chave,
      classification,
      dock_action: { kind },
      approval_level: classification === 'MATCH' ? 'regra' : 'analista',
      // Entre 0 e o total da nota, inclusive os dois extremos.
      amount_at_risk_cents: Math.floor((totalCents * ((i * 37) % 101)) / 100),
      justification: `proposta ${id}`,
      state,
      created_at: `${day}T13:00:00+00:00`,
    });
    // Parte das decididas sem linha em approvals: aprovação pela regra.
    if ((state === 'aprovada' || state === 'alterada') && i % 3 !== 0) {
      approvals.push({
        id: 1000 + id,
        proposal_id: id,
        approver: 'coordenacao@jachegou.test',
        approver_level: 'coordenacao',
        justification: null,
        approved_at: `${day}T18:30:00.123456+00:00`,
      });
    }
  });
  return { proposals, approvals };
}

describe('#71 na base do kit (AC-4)', () => {
  it('#71/AC-4 o total do painel bate com a soma das propostas decididas que barram', async () => {
    const seed = kitProposals();
    expect(seed.proposals).toHaveLength(80);
    const notas = kitTables().kit_notas ?? [];
    // Todas as notas do kit são de novembro de 2026, longe das bordas do mês.
    expect(notas.every((n) => /^2026-11-(0[2-9]|1\d|2\d)$/.test(String(n.data_emissao)))).toBe(true);

    const barring = (r: Row) => {
      const kind = (r.dock_action as { kind: string }).kind;
      return (kind === 'recusar' || kind === 'receber_parcial') && r.classification !== 'MATCH';
    };
    const sumOf = (rows: Row[]) => rows.reduce((s, r) => s + Number(r.amount_at_risk_cents), 0);
    const decided = seed.proposals.filter((r) => (r.state === 'aprovada' || r.state === 'alterada') && barring(r));
    const waiting = seed.proposals.filter((r) => r.state === 'aguardando_aprovacao' && barring(r));
    expect(decided.length).toBeGreaterThan(5);
    expect(waiting.length).toBeGreaterThan(5);

    const records = await readProposalRecords(restOver(new FakePostgrest(seed)));
    const { panel, ignoredMatchProposalIds } = summarizeBarredAmount(records, { year: 2026, month: 11 });

    expect(panel.barred.totalCents).toBe(sumOf(decided));
    expect(panel.ifApprovedAsProposed.totalCents).toBe(sumOf(waiting));
    expect(panel.barred.byException.reduce((s, e) => s + e.cents, 0)).toBe(panel.barred.totalCents);
    expect(panel.barred.byException.reduce((s, e) => s + e.count, 0)).toBe(decided.length);
    expect(panel.daily.at(-1)?.barredCumulativeCents).toBe(sumOf(decided));
    expect(panel.daily.at(-1)?.proposedCumulativeCents).toBe(sumOf(waiting));
    expect(ignoredMatchProposalIds).toEqual([]);
  });
});
