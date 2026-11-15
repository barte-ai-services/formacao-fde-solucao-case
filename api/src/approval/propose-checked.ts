// #63 Depois da conferência, o Cron registra a proposta de cada nota conferida e a encaminha pela régua.
import { isInteger, isString, parseRows, shaped } from '../connectors/guards.js';
import type { PurchasingPort, RegistryPort } from '../connectors/ports.js';
import type { SupabaseRest } from '../connectors/supabase-rest.js';
import { draftProposal, propose } from '../domain/approval.js';
import { ApprovalPolicy } from '../domain/approval-policy.js';
import { priceDifference } from '../domain/checks/nao-catalogada.js';
import type { CheckContext } from '../domain/context.js';
import { Title } from '../domain/title.js';
import { todayInBrasilia } from '../http/approval.js';
import { dockActionToJson, loadCheckedInvoices } from './supabase-store.js';

export type ProposeDeps = {
  readonly rest: SupabaseRest;
  readonly purchasing: PurchasingPort;
  readonly registry: RegistryPort;
  readonly now?: () => Date;
};

export type ProposeResult = {
  /** #63 Propostas registradas nesta rodada. */
  readonly proposed: number;
  /** #63 Delas, as que a régua aprovou sem pessoa e foram para a lista do dia (AC-1). */
  readonly approvedByRule: number;
};

/**
 * #63 Idempotente: só propõe para a nota `conferida`, e a restrição única de `proposals` por nota
 * impede a segunda proposta se uma rodada cair no meio. Grava em lote: proposta, título, a aprovação
 * da regra e o novo estado da nota.
 */
export async function proposeChecked(deps: ProposeDeps): Promise<ProposeResult> {
  const invoices = await loadCheckedInvoices(deps.rest);
  if (invoices.length === 0) return { proposed: 0, approvedByRule: 0 };
  const now = (deps.now ?? (() => new Date()))();
  const today = todayInBrasilia(now);
  const [purchaseOrders, suppliers] = await Promise.all([
    deps.purchasing.listPurchaseOrders(),
    deps.registry.listSuppliers(),
  ]);
  const ctx: CheckContext = {
    purchaseOrders,
    suppliers,
    products: [],
    postedInvoices: [],
    payments: [],
    receipts: [],
    capturedInvoices: [],
  };

  const proposed = invoices.map((invoice) => {
    const supplier = suppliers.find((s) => s.id === invoice.supplierId);
    const route = ApprovalPolicy.route(invoice, supplier);
    // #63 A nota da SEFAZ não traz vencimento: o título nasce com o valor da nota e vence na emissão.
    const title = Title.post({ invoiceAccessKey: invoice.accessKey, amount: invoice.total, dueOn: invoice.issuedOn });
    const draft = draftProposal(invoice, priceDifference(invoice, ctx)?.overcharge ?? null);
    const result = propose(invoice, title, { route, ...draft, today });
    return { invoice, title, route, ...result };
  });

  const inserted = parseRows(
    await deps.rest.insert(
      'proposals',
      proposed.map(({ invoice, proposal, route }) => ({
        invoice_access_key: invoice.accessKey,
        classification: proposal.classification,
        dock_action: dockActionToJson(proposal.dockAction),
        approval_level: proposal.level,
        amount_at_risk_cents: proposal.amountAtRisk.amount.cents,
        justification: proposal.justification,
        state: proposal.state,
        regua_line: route.line,
      })),
      { onConflict: 'invoice_access_key', ignoreDuplicates: true },
    ),
    shaped<{ id: number; invoice_access_key: string }>({ id: isInteger, invoice_access_key: isString }),
    'proposals',
  );
  const idByKey = new Map(inserted.map((r) => [r.invoice_access_key, r.id]));
  const fresh = proposed.filter((p) => idByKey.has(p.invoice.accessKey));

  await deps.rest.upsert(
    'titles',
    fresh.map(({ invoice, title }) => ({
      invoice_access_key: invoice.accessKey,
      amount_cents: title.amount.cents,
      due_on: title.dueOn,
      state: title.state,
      updated_at: now.toISOString(),
    })),
    'invoice_access_key',
  );
  const byRule = fresh.filter((p) => p.approval !== null);
  await deps.rest.insert(
    'approvals',
    byRule.map(({ invoice, approval }) => ({
      proposal_id: idByKey.get(invoice.accessKey),
      approver: approval?.approver,
      approver_level: approval?.approverLevel,
      justification: approval?.justification,
      dock_action: approval ? dockActionToJson(approval.dockAction) : null,
      decided_on: approval?.decidedOn,
      approved_at: now.toISOString(),
    })),
    { onConflict: 'proposal_id', ignoreDuplicates: true },
  );
  for (const state of ['com_proposta', 'decidida'] as const) {
    const keys = fresh.filter((p) => p.invoice.state === state).map((p) => p.invoice.accessKey);
    if (keys.length === 0) continue;
    await deps.rest.update(
      'invoices',
      { access_key: `in.(${keys.map((k) => `"${k}"`).join(',')})` },
      { state },
    );
  }
  return { proposed: fresh.length, approvedByRule: byRule.length };
}
