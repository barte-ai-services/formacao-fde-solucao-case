// #130 Os pedidos do dossiê feitos na gaveta, em dossier_requests. Servem ao 409 (geração em andamento),
// ao 429 (limite por proposta) e ao estado `generating` que a gaveta lê enquanto o Claude trabalha.
import { ClaudeError } from '../claude/client.js';
import { isInteger, isString, nullable, oneOf, optional, parseRows, shaped, type Shape } from '../connectors/guards.js';
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

/**
 * #311 O estado do pedido: `pending` espera a vez (o backfill das propostas que já existiam), `running` é geração em
 * andamento (o que a gaveta lê como "Gerando" e o que dá 409), `done` e `error` o fecham.
 */
export type RequestStatus = 'pending' | 'running' | 'done' | 'error';

/** #311 O motivo codificado do fechamento, nunca texto livre nem segredo; o mesmo conjunto fechado da coluna `reason`. */
export type RequestReason = 'no_credentials' | 'rate_limited' | 'auth_refused' | 'claude_failed' | 'storage_failed' | 'not_needed';

/** #311 O motivo que vale para o Claude inteiro, não para uma nota: tentar a próxima nota só repetiria a falha. */
export type GlobalReason = 'no_credentials' | 'rate_limited' | 'auth_refused';

/** #311 Como o pedido fecha: o estado final e, no erro (ou em `not_needed`), o motivo. */
export type Closing = { readonly status: 'done' | 'error'; readonly reason?: RequestReason };

const STATUSES = ['pending', 'running', 'done', 'error'] as const satisfies readonly RequestStatus[];
const REASONS = ['no_credentials', 'rate_limited', 'auth_refused', 'claude_failed', 'storage_failed', 'not_needed'] as const satisfies readonly RequestReason[];

export const isGlobalReason = (reason: RequestReason | null | undefined): reason is GlobalReason =>
  reason === 'no_credentials' || reason === 'rate_limited' || reason === 'auth_refused';

/** #311 Sem credencial do Claude no Worker: é falha global, com motivo próprio (a credencial é posta pela pessoa). */
export class NoCredentialsError extends ClaudeError {
  constructor() {
    super('auth', 'sem credencial do Claude no Worker');
  }
}

/** #311 Do erro da chamada ao motivo do pedido; só a classe do erro decide, o texto dele não vai para a linha. */
export function requestReasonOf(error: unknown): 'no_credentials' | 'rate_limited' | 'auth_refused' | 'claude_failed' {
  if (error instanceof NoCredentialsError) return 'no_credentials';
  if (error instanceof ClaudeError && error.kind === 'rate_limit') return 'rate_limited';
  if (error instanceof ClaudeError && error.kind === 'auth') return 'auth_refused';
  return 'claude_failed';
}

/** #130 Um pedido como a tabela o guarda. */
export type DossierRequest = {
  readonly id: number;
  readonly input_key: string;
  readonly requested_by: string;
  readonly requested_at: string;
  readonly finished_at: string | null;
  /** #130 #38 Ausente em linha antiga: vale on_demand, o default da coluna. */
  readonly trigger?: DossierTrigger;
  /** #311 O estado do pedido. */
  readonly status: RequestStatus;
  /** #311 O motivo do fechamento em erro; nulo no mais. */
  readonly reason: RequestReason | null;
};

/** #311 O que o `open` recebe: o pedido que nasce em geração, sem o id, o estado e o fim, que são da tabela. */
export type NewRequest = Omit<DossierRequest, 'id' | 'finished_at' | 'status' | 'reason'>;

/** #130 #38 O gatilho do pedido, com o default da coluna para linha sem ele. */
export const triggerOf = (r: DossierRequest): DossierTrigger => r.trigger ?? 'on_demand';

/** #130 A porta dos pedidos; os testes usam o FakePostgrest por trás da implementação do Supabase. */
export interface DossierRequests {
  /** #130 Os pedidos da nota feitos desde `since`, do mais novo ao mais velho. */
  since(invoiceAccessKey: string, since: Date): Promise<DossierRequest[]>;
  /**
   * #311 Os pedidos de todas as notas feitos desde `since`, mais todo `pending`, qualquer que seja a idade: uma leitura só,
   * para o Cron. Dela saem o que está em andamento, a fila do backfill e o backoff do erro global.
   */
  window(since: Date): Promise<DossierRequest[]>;
  /** #130 Registra o pedido aceito, já em geração (`running`). #38: o evento também abre o seu, com trigger `event`. */
  open(request: NewRequest): Promise<number>;
  /**
   * #311 Reivindica o pedido `pending` `id` no lugar do `open`: vira `running` com `requested_at` agora. Falso quando outra
   * invocação o reivindicou antes (o filtro por status faz a corrida ter um vencedor só).
   */
  claim(id: number, at: Date): Promise<boolean>;
  /**
   * #130 Fecha o pedido `id`, com sucesso ou não. Pelo id, e não pela chave: o fim do evento não fecha um pedido da
   * gaveta aberto para a mesma nota (nem o contrário). #311 Estado e motivo vão no mesmo PATCH do fim.
   */
  finish(id: number, at: Date, closing: Closing): Promise<void>;
  /** #311 Fecha, num PATCH só, os `pending` destas notas. */
  closePending(keys: readonly string[], at: Date, closing: Closing): Promise<void>;
  /** #311 Uma linha `error` já fechada por nota, num insert só: o rastro do lote que a falha global não deixou gerar. */
  recordFailures(keys: readonly string[], at: Date, reason: GlobalReason): Promise<void>;
}

/** #130 O pedido em andamento da nota, se houver: `running`, aberto e com menos de IN_FLIGHT_MS. #311 O `pending` espera a vez e não trava. */
export function inFlight(requests: readonly DossierRequest[], now: Date): DossierRequest | undefined {
  return requests.find((r) => r.status === 'running' && r.finished_at === null && now.getTime() - Date.parse(r.requested_at) < IN_FLIGHT_MS);
}

const isRequest = shaped<DossierRequest>({
  id: isInteger,
  input_key: isString,
  requested_by: isString,
  requested_at: isString,
  finished_at: nullable(isString),
  trigger: optional(oneOf('event', 'on_demand')),
  status: oneOf(...STATUSES),
  reason: nullable(oneOf(...REASONS)),
} satisfies Shape<DossierRequest>);

const COLUMNS = 'id,input_key,requested_by,requested_at,finished_at,trigger,status,reason';

/** #311 A lista de chaves do filtro `in`, entre aspas: a chave chega validada, mas o filtro não depende disso. */
const inList = (keys: readonly string[]): string => `in.(${keys.map((k) => `"${k.replace(/"/g, '')}"`).join(',')})`;

/** #130 dossier_requests pelo PostgREST. A chave chega aqui já validada pela rota (ACCESS_KEY). */
export class SupabaseDossierRequests implements DossierRequests {
  constructor(private readonly rest: SupabaseRest) {}

  async since(invoiceAccessKey: string, since: Date): Promise<DossierRequest[]> {
    const rows = await this.rest.select(TABLE, {
      select: COLUMNS,
      filters: { input_key: `eq.${invoiceAccessKey}`, requested_at: `gte.${since.toISOString()}` },
      order: 'requested_at.desc',
    });
    return parseRows(rows, isRequest, TABLE);
  }

  async window(since: Date): Promise<DossierRequest[]> {
    const rows = await this.rest.select(TABLE, {
      select: COLUMNS,
      filters: { or: `(requested_at.gte.${since.toISOString()},status.eq.pending)` },
      order: 'requested_at.desc',
    });
    return parseRows(rows, isRequest, TABLE);
  }

  async open(request: NewRequest): Promise<number> {
    const rows = await this.rest.insert(TABLE, [{ ...request, trigger: request.trigger ?? 'on_demand', status: 'running', finished_at: null }], {
      ignoreDuplicates: false,
    });
    // #130 return=representation: a linha volta com o id da identidade.
    const id = (rows[0] as { id?: unknown } | undefined)?.id;
    if (typeof id !== 'number') throw new Error(`${TABLE}: o insert não devolveu o id`);
    return id;
  }

  async claim(id: number, at: Date): Promise<boolean> {
    const rows = await this.rest.update(TABLE, { id: `eq.${id}`, status: 'eq.pending' }, { status: 'running', requested_at: at.toISOString() });
    return rows.length > 0;
  }

  async finish(id: number, at: Date, closing: Closing): Promise<void> {
    await this.rest.update(TABLE, { id: `eq.${id}` }, { finished_at: at.toISOString(), status: closing.status, reason: closing.reason ?? null });
  }

  async closePending(keys: readonly string[], at: Date, closing: Closing): Promise<void> {
    if (keys.length === 0) return;
    await this.rest.update(TABLE, { status: 'eq.pending', input_key: inList(keys) }, { finished_at: at.toISOString(), status: closing.status, reason: closing.reason ?? null });
  }

  async recordFailures(keys: readonly string[], at: Date, reason: GlobalReason): Promise<void> {
    const rows = keys.map((input_key) => ({ input_key, requested_by: 'claude', requested_at: at.toISOString(), finished_at: at.toISOString(), trigger: 'event', status: 'error', reason }));
    await this.rest.insert(TABLE, rows, { ignoreDuplicates: false });
  }
}
