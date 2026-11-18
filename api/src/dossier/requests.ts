// #130 Os pedidos do dossiê feitos na gaveta, em dossier_requests. Servem ao 409 (geração em andamento),
// ao 429 (limite por proposta) e ao estado `generating` que a gaveta lê enquanto o Claude trabalha.
import { isString, nullable, oneOf, optional, parseRows, shaped, type Shape } from '../connectors/guards.js';
import type { SupabaseRest } from '../connectors/supabase-rest.js';

const TABLE = 'dossier_requests';

/** #130 Um pedido sem finished_at há menos que isto é geração em andamento; mais velho, abandonado. */
export const IN_FLIGHT_MS = 5 * 60_000;
/** #130 A janela do limite por proposta. */
export const LIMIT_WINDOW_MS = 60 * 60_000;
/** #130 Pedidos aceitos por proposta na janela; o seguinte recebe 429. */
export const MAX_REQUESTS_PER_WINDOW = 3;

/** #130 #38 Quem abriu o pedido: o evento da proposta (#38) ou a pessoa na gaveta. */
export type DossierTrigger = 'event' | 'on_demand';

/** #130 Um pedido como a tabela o guarda. */
export type DossierRequest = {
  readonly input_key: string;
  readonly requested_by: string;
  readonly requested_at: string;
  readonly finished_at: string | null;
  /** #130 #38 Ausente em linha antiga: vale on_demand, o default da coluna. */
  readonly trigger?: DossierTrigger;
};

/** #130 #38 O gatilho do pedido, com o default da coluna para linha sem ele. */
export const triggerOf = (r: DossierRequest): DossierTrigger => r.trigger ?? 'on_demand';

/** #130 A porta dos pedidos; os testes usam o FakePostgrest por trás da implementação do Supabase. */
export interface DossierRequests {
  /** #130 Os pedidos da nota feitos desde `since`, do mais novo ao mais velho. */
  since(invoiceAccessKey: string, since: Date): Promise<DossierRequest[]>;
  /** #130 #38 AC-6 Os pedidos ainda abertos de todas as notas, feitos desde `since`: uma leitura só, para o Cron. */
  openSince(since: Date): Promise<DossierRequest[]>;
  /** #130 Registra o pedido aceito. #38: o evento também abre o seu, com trigger `event`. */
  open(request: Omit<DossierRequest, 'finished_at'>): Promise<number>;
  /**
   * #130 Fecha o pedido `id`, com sucesso ou não. Pelo id, e não pela chave: o fim do evento não fecha um pedido da
   * gaveta aberto para a mesma nota (nem o contrário).
   */
  finish(id: number, at: Date): Promise<void>;
}

/** #130 O pedido em andamento da nota, se houver: aberto e com menos de IN_FLIGHT_MS. */
export function inFlight(requests: readonly DossierRequest[], now: Date): DossierRequest | undefined {
  return requests.find((r) => r.finished_at === null && now.getTime() - Date.parse(r.requested_at) < IN_FLIGHT_MS);
}

const isRequest = shaped<DossierRequest>({
  input_key: isString,
  requested_by: isString,
  requested_at: isString,
  finished_at: nullable(isString),
  trigger: optional(oneOf('event', 'on_demand')),
} satisfies Shape<DossierRequest>);

/** #130 dossier_requests pelo PostgREST. A chave chega aqui já validada pela rota (ACCESS_KEY). */
export class SupabaseDossierRequests implements DossierRequests {
  constructor(private readonly rest: SupabaseRest) {}

  async since(invoiceAccessKey: string, since: Date): Promise<DossierRequest[]> {
    const rows = await this.rest.select(TABLE, {
      select: 'input_key,requested_by,requested_at,finished_at,trigger',
      filters: { input_key: `eq.${invoiceAccessKey}`, requested_at: `gte.${since.toISOString()}` },
      order: 'requested_at.desc',
    });
    return parseRows(rows, isRequest, TABLE);
  }

  async openSince(since: Date): Promise<DossierRequest[]> {
    const rows = await this.rest.select(TABLE, {
      select: 'input_key,requested_by,requested_at,finished_at,trigger',
      filters: { finished_at: 'is.null', requested_at: `gte.${since.toISOString()}` },
      order: 'requested_at.desc',
    });
    return parseRows(rows, isRequest, TABLE);
  }

  async open(request: Omit<DossierRequest, 'finished_at'>): Promise<number> {
    const rows = await this.rest.insert(TABLE, [{ ...request, trigger: triggerOf(request as DossierRequest), finished_at: null }], {
      ignoreDuplicates: false,
    });
    // #130 return=representation: a linha volta com o id da identidade.
    const id = (rows[0] as { id?: unknown } | undefined)?.id;
    if (typeof id !== 'number') throw new Error(`${TABLE}: o insert não devolveu o id`);
    return id;
  }

  async finish(id: number, at: Date): Promise<void> {
    await this.rest.update(TABLE, { id: `eq.${id}` }, { finished_at: at.toISOString() });
  }
}
