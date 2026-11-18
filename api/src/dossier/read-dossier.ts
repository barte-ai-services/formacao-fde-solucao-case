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
  /**
   * #68: carrega o contexto da nota. Só é chamado quando há sugestão `ok`: sem linha ou com erro,
   * as tabelas do contexto não são lidas, e uma falha delas não troca `pending` por `read_failed`.
   */
  readonly loadContext: () => Promise<CheckContext>;
  readonly source: DossierSource;
  /** #296: onde registrar o `number_mismatch`. O padrão é `console.warn`. */
  readonly log?: (event: string, detail: Record<string, unknown>) => void;
};

/** #68: quando o job não gravou o modelo, o dossiê ainda vale; só não diz quem escreveu. */
const UNKNOWN_MODEL = 'unknown';

/**
 * #68: lê o dossiê da nota e o confere contra o banco na hora de mostrar (#38/AC-2): um número fora
 * do catálogo, ou uma chave que o banco não tem mais, dá `number_mismatch`. Sem sugestão gravada,
 * `null` (a tela mostra `pending`). Sugestão com erro, o motivo gravado, ou `claude_failed` sem ele (#38/AC-4, #130). Só lê: não toca na
 * proposta nem escreve em nada (#38/AC-3).
 *
 * #296: num `number_mismatch`, registra uma linha `dossier-number-mismatch` com a nota e o detalhe da
 * verificação que falhou (`check`, `field`, `cited`, `bank`), e nada do texto do dossiê. O resultado
 * devolvido não leva o detalhe: a resposta da API e a tela seguem como antes.
 */
export async function readDossier(input: ReadDossierInput): Promise<DossierResult | null> {
  const suggestion = await input.source.find(input.invoiceAccessKey);
  if (!suggestion) return null;
  if (suggestion.status === 'erro') {
    return { status: 'unavailable', reason: suggestion.reason ?? 'claude_failed', generatedAt: suggestion.generatedAt };
  }
  const ctx = await input.loadContext();
  const catalog = buildFactCatalog(input.invoice, ctx);
  const result = verifyAndRender(suggestion.output, catalog, input.invoice.divergences, {
    generatedAt: suggestion.generatedAt,
    model: suggestion.model ?? UNKNOWN_MODEL,
  });
  if (result.status === 'ready' || !result.mismatch) return result;
  const { check, field, cited, bank } = result.mismatch;
  (input.log ?? console.warn)('dossier-number-mismatch', { invoiceAccessKey: input.invoiceAccessKey, check, field, cited, bank });
  return { status: 'unavailable', reason: result.reason, generatedAt: result.generatedAt };
}
