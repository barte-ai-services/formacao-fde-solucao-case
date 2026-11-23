// Grava o lote de notas da demonstração numa única chamada rpc (#349): uma requisição, uma transação, sem repetir nem apagar nada.
import { SupabaseRestError, type SupabaseRest } from '../connectors/supabase-rest.js';
import type { DemoRows } from './types.js';

export const INSERT_FUNCTION = 'kit_insert_demo_batch';

/**
 * (#349) A falha da gravação, só com campos nomeados: a operação, o status HTTP e o código do banco. Nunca leva o texto do provedor,
 * a resposta nem a chave, e não guarda o erro original: quem chama a rodada (#348) registra o DemoInsertError no log interno, com operation, status, code, seed e sequenceStart (#349).
 */
export class DemoInsertError extends Error {
  constructor(
    readonly operation: string,
    readonly status: number,
    readonly code: string | undefined,
  ) {
    super(`demo: o lote de notas não foi gravado (${operation}, HTTP ${status}${code ? `, ${code}` : ''})`);
    this.name = 'DemoInsertError';
  }
}

export class DemoNoteInserter {
  constructor(private readonly rest: Pick<SupabaseRest, 'rpc'>) {}

  /** Grava as linhas do lote numa só chamada e devolve quantas notas entraram (a duplicada é ignorada). (#349) */
  async insert(rows: DemoRows): Promise<number> {
    let inserted: unknown;
    try {
      inserted = await this.rest.rpc(INSERT_FUNCTION, { p_batch: rows });
    } catch (error) {
      throw error instanceof SupabaseRestError
        ? new DemoInsertError(error.operation, error.status, error.code)
        : new DemoInsertError('unknown', 0, undefined);
    }
    if (typeof inserted !== 'number' || !Number.isSafeInteger(inserted) || inserted < 0) {
      throw new DemoInsertError('parse', 0, undefined);
    }
    return inserted;
  }
}
