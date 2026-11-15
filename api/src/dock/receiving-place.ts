// #135 O lugar do recebimento sai do destino: doca do CD (WMS) ou app da loja. Função pura.
export type ReceivingPlace = 'doca_cd' | 'app_loja';

/** `LJ-*` recebe pelo app da loja; qualquer outro destino (`CD-*`) é a doca do CD. */
export function receivingPlace(destination: string): ReceivingPlace {
  return destination.startsWith('LJ-') ? 'app_loja' : 'doca_cd';
}
