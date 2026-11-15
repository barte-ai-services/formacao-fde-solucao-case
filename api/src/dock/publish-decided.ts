// A varredura das decisões para o WMS (#43 AC-1): toda proposta decidida tem a sua ação na caixa de saída.
import { dockActionFromJson } from '../approval/supabase-store.js';
import { canonicalJson } from '../connectors/outbox.js';
import { isString, isUnknown, oneOf, parseRows, shaped, type Shape } from '../connectors/guards.js';
import type { DockActionOutbox } from '../connectors/ports.js';
import type { SupabaseRest } from '../connectors/supabase-rest.js';
import { wmsDockActionOutbox } from '../connectors/wms-dock-action.js';
import type { DockAction } from '../domain/index.js';

type DecidedRow = { invoice_access_key: string; state: 'aprovada' | 'alterada'; dock_action: unknown };

const isDecidedRow = shaped<DecidedRow>({
  invoice_access_key: isString,
  state: oneOf('aprovada', 'alterada'),
  dock_action: isUnknown,
} satisfies Shape<DecidedRow>);

/** #43 A ação comparável: mesmo tipo e mesmas linhas dão o mesmo texto. */
function fingerprint(action: DockAction): string {
  if (action.kind !== 'receber_parcial') return canonicalJson({ kind: action.kind });
  return canonicalJson({
    kind: action.kind,
    lines: action.lines.map((l) => ({ sku: l.sku, amount: l.quantity.amount, unit: l.quantity.unit, disposition: l.disposition })),
  });
}

/**
 * #43 AC-1 Publica na caixa de saída do WMS a ação de toda proposta aprovada ou alterada cuja ação
 * ainda não é a última publicada para a nota. Cobre o que a regra aprova sem pessoa (no Cron, depois
 * do `proposeChecked`) e a aprovação de uma pessoa cuja publicação falhou na hora. #43 AC-3: proposta
 * sem decisão fica de fora. Idempotente: com tudo publicado, lê duas tabelas e não grava nada.
 */
export async function publishDecidedDockActions(
  rest: SupabaseRest,
  outbox: DockActionOutbox = wmsDockActionOutbox(rest),
): Promise<{ published: number }> {
  const rows = parseRows(
    await rest.select('proposals', {
      select: 'invoice_access_key,state,dock_action',
      filters: { state: 'in.(aprovada,alterada)' },
      order: 'invoice_access_key',
    }),
    isDecidedRow,
    'proposals',
  );
  // #72 Vale a publicação de maior id de cada nota, como na doca.
  const latest = new Map<string, { id: number; print: string }>();
  for (const p of await outbox.list()) {
    const current = latest.get(p.invoiceAccessKey);
    if (!current || p.id > current.id) latest.set(p.invoiceAccessKey, { id: p.id, print: fingerprint(p.action) });
  }
  let published = 0;
  for (const row of rows) {
    const action = dockActionFromJson(row.dock_action, 'proposals');
    if (latest.get(row.invoice_access_key)?.print === fingerprint(action)) continue;
    await outbox.publish({ invoiceAccessKey: row.invoice_access_key, action });
    published += 1;
  }
  return { published };
}
