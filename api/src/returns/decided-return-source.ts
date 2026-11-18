// #156 A porta de leitura das decisões que a varredura da devolução avalia.
import type { DecidedReturnCase } from './publish-return-note.js';

/** #156 Toda proposta aprovada ou alterada, com o dia da decisão, a nota, os recebimentos e o cadastro, numa leitura só. */
export interface DecidedReturnSource {
  listDecided(): Promise<readonly DecidedReturnCase[]>;
}
