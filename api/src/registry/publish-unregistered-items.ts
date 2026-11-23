// Caso de uso da história #35 (plano #66, AC-5): a proposta aprovada com E8 manda o item ao Cadastro.
import type { RegistryCorrectionMessage, RegistryCorrectionOutbox } from '../connectors/ports.js';
import type { InvoiceItem, InvoiceView, Proposal } from '../domain/index.js';

/** #66 Os códigos do fornecedor que as E8 gravadas na nota apontam, pela referência `<fornecedor>/<código>` da evidência do Cadastro. */
function recordedUnregisteredCodes(invoice: InvoiceView): ReadonlySet<string> {
  const prefix = `${invoice.supplierId}/`;
  const codes = invoice.divergences
    .filter((d) => d.classification === 'E8')
    .flatMap((d) => d.evidence)
    .filter((e) => e.source === 'erp_cadastro' && e.reference.startsWith(prefix))
    .map((e) => e.reference.slice(prefix.length));
  return new Set(codes);
}

/**
 * #35, AC-5: se a proposta foi aprovada (ou alterada) e a nota tem E8, publica uma mensagem por item sem
 * cadastro na caixa de saída do Cadastro. Senão, não publica nada. Devolve quantas publicou.
 * Os itens saem das E8 que a conferência gravou na nota, e não de um novo cálculo: o item que a sugestão do
 * Claude casou naquela rodada não virou E8 e não vai ao Cadastro (#66).
 * Republicar é seguro: a caixa de saída é idempotente. Quem chama é o Cron (`publish-approved-e8.ts`), #66.
 * #356 AC-4 `limit` é o teto de mensagens NOVAS desta chamada (padrão: todas): uma publicação por item. `alreadyPublished` diz
 * quais mensagens a caixa já tem: essas não são publicadas de novo (a caixa as ignoraria) e não contam no teto.
 */
export async function publishUnregisteredItems(
  invoice: InvoiceView,
  proposal: Proposal,
  outbox: RegistryCorrectionOutbox,
  limit: number = Number.POSITIVE_INFINITY,
  alreadyPublished: (message: RegistryCorrectionMessage) => boolean = () => false,
): Promise<number> {
  const decided = proposal.state === 'aprovada' || proposal.state === 'alterada';
  if (!decided) return 0;

  const codes = recordedUnregisteredCodes(invoice);
  const messages: RegistryCorrectionMessage[] = invoice.items
    .filter((item) => codes.has(item.supplierCode))
    .map((item: InvoiceItem) => ({
      invoiceAccessKey: invoice.accessKey,
      kind: 'E8_item_sem_cadastro',
      supplierCode: item.supplierCode,
      sku: item.sku,
      detail:
        `Cadastrar "${item.description}" do fornecedor ${invoice.supplierId}: ` +
        `${item.quantity.amount} ${item.quantity.unit} na nota ${invoice.number}, valor ${item.total.toString()}.`,
    }));
  let published = 0;
  for (const message of messages) {
    if (alreadyPublished(message)) continue;
    if (published >= limit) break;
    await outbox.publish(message);
    published += 1;
  }
  return published;
}
