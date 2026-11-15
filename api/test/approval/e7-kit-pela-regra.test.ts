import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { draftProposal, propose } from '../../src/domain/approval.js';
import { ApprovalPolicy } from '../../src/domain/approval-policy.js';
import { Money, Title, type Payment } from '../../src/domain/index.js';
import { kitDomain } from '../support/kit-domain.js';

// #177 / #33: o E7 segue o BPMN. As 9 notas E7 do kit saem aprovadas pela regra, sem pessoa, com o
// vínculo ao pagamento como evidência e o título bloqueado (nunca na lista do dia, #107).
const TODAY = '2026-11-15';

type KitPayment = {
  pagamento_id: string; fornecedor_id: string; destino: string; data: string; valor: number;
  forma: string; origem: string; nota_chave: string | null;
};

const payments: Payment[] = (
  JSON.parse(readFileSync(new URL('../../../data/kit/pagamentos.json', import.meta.url), 'utf8')) as KitPayment[]
).map((p) => ({
  id: p.pagamento_id, supplierId: p.fornecedor_id, store: p.destino, paidOn: p.data,
  amount: Money.fromReais(p.valor), method: p.forma, origin: p.origem, invoiceAccessKey: p.nota_chave,
}));

describe('#177 as 9 notas E7 do kit, pela regra', () => {
  it('AC-1: cada nota E7 é aprovada pela regra, com o pagamento como evidência e o título bloqueado', async () => {
    const kit = await kitDomain();
    let e7 = 0;
    for (const invoice of kit.invoices) {
      invoice.check({ ...kit.ctx, payments });
      if (invoice.classification !== 'E7') continue;
      e7++;
      const route = ApprovalPolicy.route(invoice, kit.ctx.suppliers.find((s) => s.id === invoice.supplierId));
      expect(route).toMatchObject({ line: 6, level: 'regra' });
      const title = Title.post({ invoiceAccessKey: invoice.accessKey, amount: invoice.total, dueOn: TODAY });
      const draft = draftProposal(invoice, null);
      const { proposal, approval } = propose(invoice, title, { route, ...draft, today: TODAY });
      expect(proposal.state).toBe('aprovada');
      expect(approval?.approver).toBe('regra');
      expect(draft.amountAtRisk.equals(invoice.total)).toBe(true);
      expect(invoice.divergences.find((d) => d.classification === 'E7')?.evidence[0]?.source).toBe('banco');
      expect(title.state).toBe('bloqueado');
    }
    expect(e7).toBe(9);
  });
});
