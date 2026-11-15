import {
  buildFactCatalog,
  verifyAndRender,
  type CheckContext,
  type DossierResult,
  type InvoiceView,
} from '../domain/index.js';
import type { DossierSource } from './source.js';

/** #68: o que a leitura do dossiê recebe da rota. */
export type ReadDossierInput = {
  readonly invoiceAccessKey: string;
  /** #68: a nota conferida, com as divergências que a proposta encaminhou. */
  readonly invoice: InvoiceView;
  readonly ctx: CheckContext;
  readonly source: DossierSource;
};

/** #68: quando o job não gravou o modelo, o dossiê ainda vale; só não diz quem escreveu. */
const UNKNOWN_MODEL = 'unknown';

/**
 * #68: lê o dossiê da nota e o confere contra o banco na hora de mostrar (#38/AC-2): um número fora
 * do catálogo, ou uma chave que o banco não tem mais, dá `number_mismatch`. Sem sugestão gravada,
 * `null` (a tela mostra `pending`). Sugestão com erro, `claude_failed` (#38/AC-4). Só lê: não toca na
 * proposta nem escreve em nada (#38/AC-3).
 */
export async function readDossier(input: ReadDossierInput): Promise<DossierResult | null> {
  const suggestion = await input.source.find(input.invoiceAccessKey);
  if (!suggestion) return null;
  if (suggestion.status === 'erro') {
    return { status: 'unavailable', reason: 'claude_failed', generatedAt: suggestion.generatedAt };
  }
  const catalog = buildFactCatalog(input.invoice, input.ctx);
  return verifyAndRender(suggestion.output, catalog, input.invoice.divergences, {
    generatedAt: suggestion.generatedAt,
    model: suggestion.model ?? UNKNOWN_MODEL,
  });
}
