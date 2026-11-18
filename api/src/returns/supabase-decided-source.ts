// #8 O adaptador Supabase de DecidedReturnSource: as decisões que a varredura da devolução avalia.
import {
  corrupt,
  dockActionFromJson,
  invoiceFromRows,
  isClassification,
  isDivergenceRow,
  isInvoiceRow,
  type DivergenceRow,
  type InvoiceRow,
} from '../approval/supabase-store.js';
import { ErpRegistryConnector } from '../connectors/erp-registry.js';
import { arrayOf, isString, isUnknown, isInteger, nullable, oneOf, parseRows, shaped, type Shape } from '../connectors/guards.js';
import type { SupabaseRest } from '../connectors/supabase-rest.js';
import { WmsCountConnector } from '../connectors/wms-count.js';
import type { Classification } from '../domain/index.js';
import type { DecidedReturnSource } from './decided-return-source.js';
import type { DecidedReturnCase } from './publish-return-note.js';

type EmbeddedInvoice = InvoiceRow & { divergences: DivergenceRow[] };
type EmbeddedApproval = { decided_on: string | null; approved_at: string };
type DecidedRow = {
  id: number;
  invoice_access_key: string;
  classification: Classification;
  state: 'aprovada' | 'alterada'; // ADR-002
  dock_action: unknown;
  approvals: EmbeddedApproval | null;
  invoices: EmbeddedInvoice | null;
};

const isEmbeddedInvoice = (v: unknown): v is EmbeddedInvoice =>
  isInvoiceRow(v) && shaped<{ divergences: DivergenceRow[] }>({ divergences: arrayOf(isDivergenceRow) })(v);

const isDecidedRow = shaped<DecidedRow>({
  id: isInteger,
  invoice_access_key: isString,
  classification: isClassification,
  state: oneOf('aprovada', 'alterada'), // ADR-002
  dock_action: isUnknown,
  approvals: nullable(shaped<EmbeddedApproval>({ decided_on: nullable(isString), approved_at: isString } satisfies Shape<EmbeddedApproval>)),
  invoices: nullable(isEmbeddedInvoice),
} satisfies Shape<DecidedRow>);

/** #8 Q1: proposta, aprovação e nota (com as divergências) numa leitura só, pelas chaves estrangeiras. */
const DECIDED_SELECT =
  'id,invoice_access_key,classification,state,dock_action,' +
  'approvals(decided_on,approved_at),' +
  'invoices(access_key,number,series,supplier_id,store,issued_on,purchase_order_ref,entry_channel,total_cents,items,state,' +
  'divergences(invoice_access_key,seq,classification,skus,evidence))';

/**
 * #8 Lê as propostas aprovadas e alteradas com a nota, os recebimentos e o cadastro em 4 requisições
 * fixas (a proposta com os embutidos, 2 dos recebimentos, 1 dos produtos), qualquer que seja o número de decisões.
 */
export class SupabaseDecidedReturnSource implements DecidedReturnSource {
  constructor(private readonly rest: SupabaseRest) {}

  async listDecided(): Promise<readonly DecidedReturnCase[]> {
    const [proposals, receipts, products] = await Promise.all([
      this.rest.select('proposals', { select: DECIDED_SELECT, filters: { state: 'in.(aprovada,alterada)' }, order: 'id' }), // ADR-002
      new WmsCountConnector(this.rest).listReceipts(),
      new ErpRegistryConnector(this.rest).listProducts(),
    ]);
    return parseRows(proposals, isDecidedRow, 'proposals').flatMap((row): DecidedReturnCase[] => {
      // #156 Decisão do dono do grupo, 17/11: a decisão sem aprovação é pulada e registrada (só a chave e o motivo, sem o corpo),
      // #156 como em dock-source.ts, para as outras entrarem na fila; o propose-checked da main pode deixá-la sem reparo.
      if (row.approvals === null) {
        console.error(`#8 devolução da nota ${row.invoice_access_key} pulada: decisão sem aprovação`);
        return [];
      }
      // #8 Decisão sem nota é dado quebrado: erro sem repetir a linha, nunca decisão pela metade.
      if (row.invoices === null) return corrupt('invoices', 'decisão sem nota');
      return [{
        invoice: invoiceFromRows(row.invoices, row.invoices.divergences),
        decision: {
          classification: row.classification,
          state: row.state,
          dockAction: dockActionFromJson(row.dock_action, 'proposals'),
          // #63 Como approvalFromRow: sem decided_on, o dia de approved_at.
          decidedOn: row.approvals.decided_on ?? row.approvals.approved_at.slice(0, 10),
        },
        receipts,
        products,
      }];
    });
  }
}
