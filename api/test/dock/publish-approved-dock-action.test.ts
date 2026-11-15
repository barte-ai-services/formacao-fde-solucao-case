import { describe, expect, it } from 'vitest';
import { SupabaseRest } from '../../src/connectors/supabase-rest.js';
import { wmsDockActionOutbox } from '../../src/connectors/wms-dock-action.js';
import { publishApprovedDockAction, type ProposalApproved } from '../../src/dock/publish-approved-dock-action.js';
import {
  AmountAtRisk,
  DockAction,
  DomainError,
  Money,
  Proposal,
  Quantity,
  type ApprovalLevel,
} from '../../src/domain/index.js';
import { FakePostgrest } from '../support/fake-postgrest.js';
import { kitInvoiceRows, kitNotesOf } from './kit-invoices.js';

const TABLE = 'outbox_dock_actions';
// #72 Nota real do kit: CD-03 em 2026-11-11, a de menor número (F08).
const [note] = kitNotesOf('CD-03', '2026-11-11');
if (!note) throw new Error('kit sem nota do CD-03 em 2026-11-11');

function setup() {
  const fake = new FakePostgrest({ invoices: kitInvoiceRows() });
  const outbox = wmsDockActionOutbox(new SupabaseRest({ url: 'https://supabase.test', secretKey: 'sb_teste', fetch: fake.fetch }));
  return { fake, outbox };
}

function proposal(level: ApprovalLevel, dockAction: DockAction = DockAction.receive()): Proposal {
  return Proposal.register({
    classification: level === 'regra' ? 'MATCH' : 'E1',
    dockAction,
    level,
    amountAtRisk: AmountAtRisk.of(Money.zero(), Money.ofCents(1000)),
    justification: 'contagem bate',
  });
}

const approved = (p: Proposal): ProposalApproved => ({
  type: 'proposta_aprovada',
  invoiceAccessKey: note.chave,
  proposal: p,
});

const partial = () =>
  DockAction.partial([
    { sku: 'SKU-1025', quantity: Quantity.of(32, 'CX'), disposition: 'segurar' },
    { sku: 'SKU-1026', quantity: Quantity.of(64, 'UN'), disposition: 'devolver' },
  ]);

describe('publishApprovedDockAction: o assinante do evento proposta aprovada (#72)', () => {
  it('#43/AC-1 proposta aprovada pela regra publica a ação na caixa de saída do WMS com a chave da nota do kit', async () => {
    const { fake, outbox } = setup();
    const p = proposal('regra');
    p.approveByRule();

    const published = await publishApprovedDockAction(approved(p), outbox);

    expect(published.invoiceAccessKey).toBe(note.chave);
    expect(published.action.kind).toBe('receber');
    expect(fake.rows(TABLE)).toHaveLength(1);
    expect(fake.rows(TABLE)[0]).toMatchObject({ invoice_access_key: note.chave, payload: { kind: 'receber' } });
  });

  it('#43/AC-1 regra 8: proposta alterada publica a ação nova, não a proposta original', async () => {
    const { fake, outbox } = setup();
    const p = proposal('analista');
    p.awaitApproval();
    p.alter(DockAction.refuse(), 'fornecedor reenviou a nota');

    await publishApprovedDockAction(approved(p), outbox);

    expect(fake.rows(TABLE)).toHaveLength(1);
    expect(fake.rows(TABLE)[0]).toMatchObject({ invoice_access_key: note.chave, payload: { kind: 'recusar' } });
  });

  it('#43/AC-1 publicar o mesmo evento duas vezes grava uma linha só (idempotente)', async () => {
    const { fake, outbox } = setup();
    const p = proposal('coordenacao');
    p.awaitApproval();
    p.approve();

    const first = await publishApprovedDockAction(approved(p), outbox);
    const second = await publishApprovedDockAction(approved(p), outbox);

    expect(second.id).toBe(first.id);
    expect(fake.rows(TABLE)).toHaveLength(1);
  });

  it('#43/AC-2 receber parcial publica os itens a segurar e a devolver', async () => {
    const { fake, outbox } = setup();
    const p = proposal('analista', partial());
    p.awaitApproval();
    p.approve();

    await publishApprovedDockAction(approved(p), outbox);

    expect(fake.rows(TABLE)[0]).toMatchObject({
      payload: {
        kind: 'receber_parcial',
        lines: [
          { sku: 'SKU-1025', amount: 32, unit: 'CX', disposition: 'segurar' },
          { sku: 'SKU-1026', amount: 64, unit: 'UN', disposition: 'devolver' },
        ],
      },
    });
  });

  it('#43/AC-3 proposta registrada, sem decisão, não publica nada', async () => {
    const { fake, outbox } = setup();

    await expect(publishApprovedDockAction(approved(proposal('analista')), outbox)).rejects.toThrow(DomainError);
    expect(fake.rows(TABLE)).toHaveLength(0);
  });

  it('#43/AC-3 proposta aguardando aprovação não publica nada', async () => {
    const { fake, outbox } = setup();
    const p = proposal('diretoria');
    p.awaitApproval();

    await expect(publishApprovedDockAction(approved(p), outbox)).rejects.toThrow(DomainError);
    expect(fake.rows(TABLE)).toHaveLength(0);
  });

  it('evento sem chave da nota não publica nada', async () => {
    const { fake, outbox } = setup();
    const p = proposal('regra');
    p.approveByRule();

    await expect(
      publishApprovedDockAction({ ...approved(p), invoiceAccessKey: '  ' }, outbox),
    ).rejects.toThrow(DomainError);
    expect(fake.rows(TABLE)).toHaveLength(0);
  });
});
