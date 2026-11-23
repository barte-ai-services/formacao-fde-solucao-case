// #69/AC-1: os recebimentos do WMS que não se ligam a nenhuma nota da SEFAZ, para ficar registrado.
import type { SefazPort, WmsCountPort } from '../connectors/ports.js';
import { unreconciledReceipts } from '../domain/index.js';

export type UnreconciledReceiptIds = {
  /** #69: recebimento sem chave de acesso. */
  readonly noKey: readonly string[];
  /** #69: recebimento com a chave de uma nota que a SEFAZ ainda não trouxe. */
  readonly keyWithoutInvoice: readonly string[];
};

/** #69/AC-1: só lê; os ids por motivo, na ordem em que o WMS os devolve. */
export async function findUnreconciledReceipts(deps: {
  readonly sefaz: SefazPort;
  readonly wms: WmsCountPort;
}): Promise<UnreconciledReceiptIds> {
  // #362 Só as chaves das notas bastam: com a captura na mesma rodada, a leitura das notas já está feita.
  const [keys, receipts] = await Promise.all([deps.sefaz.listIssuedKeys(), deps.wms.listReceipts()]);
  const pending = unreconciledReceipts(receipts, keys.map((accessKey) => ({ accessKey })));
  const ids = (reason: string) => pending.filter((p) => p.reason === reason).map((p) => p.receipt.id);
  return { noKey: ids('no_key'), keyWithoutInvoice: ids('key_without_invoice') };
}
