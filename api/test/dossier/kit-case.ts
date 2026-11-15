import { supabaseConnectors } from '../../src/connectors/supabase-connectors.js';
import { SupabaseRest } from '../../src/connectors/supabase-rest.js';
import {
  Divergence,
  type CheckContext,
  type Invoice,
} from '../../src/domain/index.js';
import { FakePostgrest } from '../support/fake-postgrest.js';
import { kitTables } from '../support/kit.js';

// #68: um caso da base do kit, lido pelos conectores de verdade sobre o PostgREST falso.
// NF-004 do F01 cobra 88 UN do leite (F01-001) e o recebimento RC-9228 contou 66 UN.

export const KIT_ACCESS_KEY = '35261126804190000106550010000727681835351811';

/** A E3 ainda é do plano dono; aqui ela entra como a divergência que a conferência acharia. */
const e3 = (): Divergence =>
  Divergence.of({
    classification: 'E3',
    skus: ['SKU-1001'],
    evidence: [
      { source: 'wms', reference: 'RC-9228', description: 'contagem de 66 UN do leite para 88 UN faturadas' },
      { source: 'sefaz', reference: KIT_ACCESS_KEY, description: 'nota com 88 UN do leite' },
    ],
  });

export type KitCase = { readonly invoice: Invoice; readonly ctx: CheckContext; readonly tables: ReturnType<typeof kitTables> };

export async function kitCase(): Promise<KitCase> {
  const tables = kitTables();
  const fake = new FakePostgrest(tables);
  const rest = new SupabaseRest({ url: 'https://fake.supabase.co', secretKey: 'sb_secret_fake', fetch: fake.fetch });
  const d = supabaseConnectors(rest).captureDeps;
  const issued = await d.sefaz.listIssuedInvoices();
  const [purchaseOrders, suppliers, products, postedInvoices, payments, receipts] = await Promise.all([
    d.purchasing.listPurchaseOrders(),
    d.registry.listSuppliers(),
    d.registry.listProducts(),
    d.payables.listPostedInvoices(),
    d.bank.listPayments(),
    d.wms.listReceipts(),
  ]);
  const invoice = issued.find((i) => i.accessKey === KIT_ACCESS_KEY);
  if (!invoice) throw new Error('kit sem a NF-004');
  const ctx: CheckContext = {
    purchaseOrders,
    suppliers,
    products,
    postedInvoices,
    payments,
    receipts,
    capturedInvoices: issued.filter((i) => i.accessKey !== KIT_ACCESS_KEY),
  };
  invoice.check(ctx, [{ id: 'E3', run: () => [e3()] }]);
  return { invoice, ctx, tables };
}

/** Resposta bem formada do Claude falso para a NF-004: todo número por marcador. */
export const kitGoodRaw = () => ({
  summary:
    'A nota cobra {{nota.item[F01-001].quantidade}} do leite SKU-1001, e o recebimento RC-9228 contou {{recebimento[RC-9228].item[F01-001].quantidade}}.',
  divergences: [
    {
      classification: 'E3',
      what_diverges:
        'Chegou menos do que a nota cobra: {{nota.item[F01-001].quantidade}} faturadas a {{nota.item[F01-001].preco_unitario}}, {{recebimento[RC-9228].item[F01-001].quantidade}} contadas.',
      evidence: ['nota.item[F01-001].quantidade', 'recebimento[RC-9228].item[F01-001].quantidade'],
    },
  ],
  supplier_history:
    'O F01 tem {{historico.notas_lancadas.quantidade}} notas lançadas, somando {{historico.notas_lancadas.valor}}, e {{historico.pagamentos.quantidade}} pagamento de {{historico.pagamentos.valor}}.',
});
