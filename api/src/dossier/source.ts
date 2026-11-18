// #68: de onde o Worker lê o dossiê. Quem escreve é o job do Claude (#66), em claude_suggestions,
// uma linha por (task, input_key). O Worker só lê.
import { isString, isUnknown, nullable, oneOf, parseOne, shaped, type Guard, type Shape } from '../connectors/guards.js';
import type { DossierUnavailableReason } from '../domain/index.js';
import { SupabaseRestError, type SupabaseRest } from '../connectors/supabase-rest.js';

/** #68: o nome da tarefa do job do Claude (#66) em claude_suggestions. */
export const DOSSIER_TASK = 'dossier';
const TABLE = 'claude_suggestions';

/** #68: a sugestão do dossiê como o job a gravou: a saída crua, ainda não conferida contra o banco. */
export type DossierSuggestion = {
  readonly status: 'ok' | 'erro'; // #68
  readonly output: unknown;
  readonly model: string | null;
  readonly generatedAt: string;
  /** #130 O motivo gravado na linha de erro; `null` nas linhas antigas e nas ok. */
  readonly reason: DossierUnavailableReason | null;
  /** #130 Quem disparou: o evento (#38) ou a pessoa na gaveta; `null` nas linhas antigas. */
  readonly trigger: 'event' | 'on_demand' | null;
};

/** #68: a porta de leitura do dossiê; o Worker nunca escreve. */
export interface DossierSource {
  /** #68: a sugestão do dossiê da nota, ou `null` quando o job ainda não rodou para ela. */
  find(invoiceAccessKey: string): Promise<DossierSuggestion | null>;
}

// #38 A tabela grava `ok` ou `error` (claude_suggestions_status_check) e não tem `generated_at`: a hora do dossiê
// é `updated_at`, a última escrita da linha pelo laço (#66).
type SuggestionRow = {
  status: 'ok' | 'error';
  output: unknown;
  model: string | null;
  updated_at: string;
  reason?: DossierUnavailableReason | null;
  trigger?: 'event' | 'on_demand' | null;
};

/** #130 A coluna nula some do JSON quando a linha é antiga: ausente vale como nulo. */
function absentOr<T>(guard: Guard<T>): Guard<T | null | undefined> {
  return (v): v is T | null | undefined => v === undefined || v === null || guard(v);
}

const isRow = shaped<SuggestionRow>({
  status: oneOf('ok', 'error'),
  output: isUnknown,
  model: nullable(isString),
  updated_at: isString,
  reason: absentOr(oneOf('claude_failed', 'number_mismatch', 'invalid_shape', 'timeout')),
  trigger: absentOr(oneOf('event', 'on_demand')),
} satisfies Shape<SuggestionRow>);

// #68: só letras, dígitos e hífen chegam ao filtro do PostgREST: a chave de acesso é numérica.
export const ACCESS_KEY = /^[A-Za-z0-9-]+$/;

/** #68: lê claude_suggestions pelo PostgREST, com os guards do #80. */
export class SupabaseDossierSource implements DossierSource {
  constructor(private readonly rest: SupabaseRest) {}

  async find(invoiceAccessKey: string): Promise<DossierSuggestion | null> {
    if (!ACCESS_KEY.test(invoiceAccessKey)) {
      throw new SupabaseRestError('select', TABLE, 0, 'chave de acesso fora do formato');
    }
    const rows = await this.rest.select(TABLE, {
      select: 'status,output,model,updated_at,reason,trigger',
      filters: { task: `eq.${DOSSIER_TASK}`, input_key: `eq.${invoiceAccessKey}` },
    });
    const [first] = rows;
    if (first === undefined) return null;
    const row = parseOne(first, isRow, TABLE);
    return {
      status: row.status === 'ok' ? 'ok' : 'erro',
      output: row.output,
      model: row.model,
      generatedAt: row.updated_at,
      reason: row.reason ?? null,
      trigger: row.trigger ?? null,
    };
  }
}

