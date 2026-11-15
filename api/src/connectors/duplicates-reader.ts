// Leitura das notas barradas por duplicidade (E6) no Supabase, para o GET /api/duplicates (#31/AC-6).
import { Divergence, Money, type Evidence, type TitleState } from '../domain/index.js';
import { toDuplicateEntry, type DuplicateEntry, type DuplicatesReader } from '../http/duplicates.js';
import { arrayOf, isInteger, isString, oneOf, parseRows, shaped, type Shape } from './guards.js';
import type { PayablesPort } from './ports.js';
import type { SupabaseRest } from './supabase-rest.js';

type InvoiceRow = {
  access_key: string;
  number: string;
  supplier_id: string;
  issued_on: string;
  total_cents: number;
};

const isInvoiceRow = shaped<InvoiceRow>({
  access_key: isString,
  number: isString,
  supplier_id: isString,
  issued_on: isString,
  total_cents: isInteger,
} satisfies Shape<InvoiceRow>);

const isEvidence = shaped<Evidence>({
  source: oneOf('sefaz', 'erp_compras', 'erp_contas_a_pagar', 'erp_cadastro', 'banco', 'wms'), // ADR-002
  reference: isString,
  description: isString,
} satisfies Shape<Evidence>);

type DivergenceRow = {
  invoice_access_key: string;
  seq: number;
  skus: string[];
  evidence: Evidence[];
};

const isDivergenceRow = shaped<DivergenceRow>({
  invoice_access_key: isString,
  seq: isInteger,
  skus: arrayOf(isString),
  evidence: arrayOf(isEvidence),
} satisfies Shape<DivergenceRow>);

type TitleRow = { invoice_access_key: string; state: TitleState };

const isTitleRow = shaped<TitleRow>({
  invoice_access_key: isString,
  state: oneOf('lancado', 'liberado', 'reduzido', 'bloqueado', 'na_lista_do_dia'), // ADR-002
} satisfies Shape<TitleRow>);

export class SupabaseDuplicatesReader implements DuplicatesReader {
  constructor(
    private readonly rest: SupabaseRest,
    private readonly payables: PayablesPort,
  ) {}

  /** #31/AC-6: as notas conferidas E6, cada uma com o título original achado pela evidência. */
  async list(): Promise<readonly DuplicateEntry[]> {
    const invoices = parseRows(
      await this.rest.select('invoices', {
        select: 'access_key,number,supplier_id,issued_on,total_cents',
        filters: { classification: 'eq.E6' },
        order: 'access_key',
      }),
      isInvoiceRow,
      'invoices',
    );
    if (invoices.length === 0) return [];
    const keys = invoices.map((i) => `"${i.access_key}"`).join(',');
    const [divergenceRows, posted, titleRows] = await Promise.all([
      this.rest.select('divergences', {
        select: 'invoice_access_key,seq,skus,evidence',
        filters: { classification: 'eq.E6' },
        order: 'invoice_access_key,seq',
      }),
      this.payables.listPostedInvoices(),
      this.rest.select('titles', {
        select: 'invoice_access_key,state',
        filters: { invoice_access_key: `in.(${keys})` },
        order: 'invoice_access_key',
      }),
    ]);
    // #31/AC-5: o estado do título vem do banco; a tela não presume o bloqueio.
    const titleState = new Map(parseRows(titleRows, isTitleRow, 'titles').map((t) => [t.invoice_access_key, t.state]));
    const byKey = new Map<string, Divergence[]>();
    for (const d of parseRows(divergenceRows, isDivergenceRow, 'divergences')) {
      const list = byKey.get(d.invoice_access_key) ?? [];
      list.push(Divergence.of({ classification: 'E6', skus: d.skus, evidence: d.evidence }));
      byKey.set(d.invoice_access_key, list);
    }
    // Nota E6 sem divergência gravada não deveria existir (REL-3); se aparecer, fica de fora.
    return invoices
      .filter((i) => (byKey.get(i.access_key) ?? []).length > 0)
      .map((i) =>
        toDuplicateEntry(
          {
            accessKey: i.access_key,
            number: i.number,
            supplierId: i.supplier_id,
            issuedOn: i.issued_on,
            total: Money.ofCents(i.total_cents),
            divergences: byKey.get(i.access_key) ?? [],
          },
          posted,
          titleState.get(i.access_key) ?? null,
        ),
      );
  }
}
