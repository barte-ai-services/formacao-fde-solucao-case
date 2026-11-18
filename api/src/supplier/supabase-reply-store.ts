import { arrayOf, isInteger, isString, isUnknown, nullable, parseRows, shaped, type Shape } from '../connectors/guards.js';
import { SupabaseRestError, type Filters, type SupabaseRest } from '../connectors/supabase-rest.js';
import type { DocumentConfirmation, SupplierReading, SupplierRequestText } from '../domain/index.js';
import type { ClaimAttempt, ClaimWrite, Clock, ConfirmWrite, EditWrite, FollowUpClaim, FollowUpStamp, ReadingRecorded, ReplyRequest, ReplyRequestStore } from './reply-ports.js';
import { guarded, pgCode, refused } from './supabase-reply-call.js';
import { LEASE_MS } from './supabase-store.js';
import { READINGS_TABLE, readingToRow } from './supabase-reply-reading.js';
import {
  CONFIRMED_ACTION,
  FOLLOW_UP_COLUMNS,
  OUTBOX_TABLE,
  READINGS_ORDER,
  REQUEST_SELECT,
  followUpShape,
  confirmationsOf,
  followUpSummary,
  isRequestRow,
  lastState,
  toReplyRequest,
  type FollowUpColumns,
} from './supabase-reply-request-row.js';

// #157: o pedido na leitura da resposta sobre o PostgREST. Toda gravação é UMA requisição numa tabela (uma transação):
// #157: a leitura é um POST no log supplier_reply_readings (append-only, a atual é derivada pela ordem das mensagens);
// #157: a cobrança é um PATCH guardado nas colunas follow_up_* de outbox_supplier_emails, sob a versão e o histórico da #156.
// #157: nenhuma gravação alcança a proposta, o título nem o valor em risco (#157).

const INVOICES = 'invoices';
/** #157: as notas por requisição: a URL cresce com as chaves (44 algarismos cada). */
const KEYS_PER_REQUEST = 50;
const SHORT_REASON = /^[a-z][a-z0-9_]{0,39}$/;

/** #157 (ADR-005): quem grava o rascunho montado pela regra na varredura do prazo: o nome da varredura, não uma pessoa. */
export const FOLLOW_UP_SWEEP_ACTOR = 'supplier-overdue-sweep';

const SENT = { status: 'eq.sent' } as const;
/** #157: a cobrança não se repete: só grava rascunho quem ainda não tem rascunho nem a recusa antiga da tarefa do Claude. */
const NO_TEXT = { ...SENT, follow_up_draft: 'is.null', follow_up_rejection: 'is.null' } as const;
/**
 * #157: a reivindicação do envio tem o prazo da #156 (`LEASE_MS`, o do `send_claim`): sem reivindicação, ou com uma mais velha que o
 * #157: prazo, o envio pode ser reivindicado de novo, com outra ficha (`follow_up_claim`, o `send_claim` da #156). A falha e o carimbo
 * #157: filtram pela ficha de quem os grava (`held`): quem perdeu a reivindicação no prazo recebe 0 linhas e não toca a linha. Risco
 * #157: aceito: se quem a perdeu chegou a enviar e morreu antes de gravar o carimbo, o segundo e-mail sai. Com o carimbo gravado
 * #157: (`follow_up_sent_at`) a reivindicação nunca vence.
 */
const claimable = (at: Date): Filters => ({
  ...SENT,
  follow_up_draft: 'not.is.null',
  follow_up_sent_at: 'is.null',
  or: `(follow_up_claimed_at.is.null,follow_up_claimed_at.lt.${new Date(at.getTime() - LEASE_MS).toISOString()})`,
});
/**
 * #157, AC-5: a guarda da edição, a mesma de `claimable`: o rascunho existe, não foi carimbado e nenhum envio está reivindicado
 * dentro do prazo (o e-mail pode estar saindo com o texto lido). Passado o `LEASE_MS` o envio é dado como morto e a edição volta a valer;
 * a edição solta a ficha vencida, e o antigo detentor, se voltar, perde o carimbo (`lost`).
 */
const editable = claimable;
/** #157: a reivindicação de pé: gravada há menos que o prazo (LEASE_MS) de `at`. */
const heldAt = (claimedAt: string | null, at: Date): boolean => claimedAt !== null && Date.parse(claimedAt) >= at.getTime() - LEASE_MS;
/** #157: o mesmo texto: o assunto, o corpo e os itens (o novo prazo é do rascunho, não do texto que a pessoa lê e edita). */
const sameText = (stored: SupplierRequestText, text: SupplierRequestText): boolean =>
  stored.subject === text.subject && stored.body === text.body && JSON.stringify(stored.asks) === JSON.stringify(text.asks);
/** #157: a guarda da falha e do carimbo: o envio ainda não carimbado e a reivindicação é a deste detentor, pela ficha. */
const held = (claim: FollowUpClaim): Filters => ({ ...SENT, follow_up_claim: `eq.${claim}`, follow_up_sent_at: 'is.null' });

type WriteRow = FollowUpColumns & { id: number; status: string; version: number; history: unknown[]; follow_up_claim: string | null };

const isWriteRow = shaped<WriteRow>({
  ...followUpShape,
  follow_up_claim: nullable(isString),
  id: isInteger,
  status: isString,
  version: isInteger,
  history: arrayOf(isUnknown),
} satisfies Shape<WriteRow>);

const isInvoice = shaped<{ access_key: string; number: string }>({ access_key: isString, number: isString });
const isId = shaped<{ id: number }>({ id: isInteger });

/** #157: uma gravação da cobrança: o que muda, quem e quando, e a guarda atômica da transição. */
type FollowUpChange = {
  readonly action: 'follow_up_drafted' | 'follow_up_edited' | 'follow_up_claimed' | 'follow_up_failed' | 'follow_up_sent' | typeof CONFIRMED_ACTION;
  readonly by: string;
  readonly at: Date;
  readonly guard: Filters;
  readonly columns: Partial<FollowUpColumns> & { follow_up_claim?: string | null };
  /** #157: o texto que quem grava leu e vai usar; se a linha lida já tem outro, nada é gravado (`stale`). */
  readonly expects?: SupplierRequestText;
  /** #157: campos a mais da entrada do histórico (o documento confirmado); nunca texto do rascunho nem da dependência. */
  readonly entry?: Record<string, string>;
  /** #157: a precondição, checada na MESMA leitura que guarda o `PATCH`; se vale, nada é gravado (`skipped`). */
  readonly skipIf?: (row: WriteRow) => boolean;
};

type Written = 'ok' | 'missing' | 'refused' | 'stale' | 'skipped';

export function supabaseReplyRequestStore(rest: SupabaseRest, clock: Clock): ReplyRequestStore {
  /** #157 QR1b: o número da nota de origem de cada pedido; a tabela do pedido não tem chave estrangeira para invoices. */
  async function invoiceNumbers(keys: readonly string[]): Promise<Map<string, string>> {
    const numbers = new Map<string, string>();
    for (let start = 0; start < keys.length; start += KEYS_PER_REQUEST) {
      const filters = { access_key: `in.(${keys.slice(start, start + KEYS_PER_REQUEST).join(',')})` };
      const rows = await guarded(() => rest.select(INVOICES, { select: 'access_key,number', filters }));
      for (const row of parseRows(rows, isInvoice, INVOICES)) numbers.set(row.access_key, row.number);
    }
    return numbers;
  }

  /** #157 QR1 e QR2: o pedido, o fornecedor e as leituras numa requisição, mais as notas de origem. */
  async function load(filters: Filters, limit?: number): Promise<ReplyRequest[]> {
    const options = { select: REQUEST_SELECT, filters: { ...filters, ...READINGS_ORDER }, order: 'id', ...(limit === undefined ? {} : { limit }) };
    const rows = parseRows(await guarded(() => rest.select(OUTBOX_TABLE, options)), isRequestRow, OUTBOX_TABLE);
    const numbers = await invoiceNumbers([...new Set(rows.map((row) => row.invoice_access_key))]);
    return rows.map((row) => {
      const number = numbers.get(row.invoice_access_key);
      if (number === undefined) throw new SupabaseRestError('parse', INVOICES, 0, 'a nota de origem do pedido não foi achada');
      return toReplyRequest(row, number);
    });
  }

  /** #157: a linha lida para montar a gravação da cobrança: a versão, o histórico, as colunas da cobrança e a ficha da reivindicação. */
  async function readForWrite(id: number): Promise<WriteRow | null> {
    const select = `id,status,version,history,follow_up_claim,${FOLLOW_UP_COLUMNS}`;
    const rows = await guarded(() => rest.select(OUTBOX_TABLE, { select, filters: { id: `eq.${id}` }, limit: 1 }));
    return parseRows(rows, isWriteRow, OUTBOX_TABLE)[0] ?? null;
  }

  /**
   * #157: lê a linha e faz UM `PATCH` filtrado pela versão lida e pela guarda da transição, com a entrada de histórico no mesmo
   * `PATCH` (a disciplina da #156). `missing`: não há o pedido; `refused`: nenhuma linha passou na versão e na guarda.
   * #157: com `expects`, o texto da linha lida tem de ser o que quem grava leu (`stale` se não é), e o `PATCH` pela versão
   * lida garante que nenhuma edição entrou entre esta leitura e a gravação.
   */
  async function writeFollowUp(id: number, change: FollowUpChange): Promise<Written> {
    const row = await readForWrite(id);
    if (row === null) return 'missing';
    if (change.skipIf?.(row) === true) return 'skipped'; // #157: decidido na leitura que o PATCH guarda
    if (change.expects !== undefined && row.follow_up_draft !== null && !sameText(row.follow_up_draft, change.expects)) return 'stale'; // #157: sem rascunho a guarda recusa
    const after: FollowUpColumns = { ...row, ...change.columns };
    const version = row.version + 1;
    const at = change.at.toISOString();
    const entry = { version, at, by: change.by, action: change.action, state: lastState(row.history), follow_up: followUpSummary(after), ...change.entry };
    const body = { ...change.columns, version, updated_at: at, history: [...row.history, entry] };
    const updated = await guarded(() => rest.update(OUTBOX_TABLE, { id: `eq.${id}`, version: `eq.${row.version}`, ...change.guard }, body));
    return updated.length > 0 ? 'ok' : 'refused';
  }

  /** #157: o rascunho: com ele (ou a recusa antiga) já gravado, volta sem gravar; qualquer outro motivo de recusa lança. */
  async function saveText(id: number, operation: string, change: FollowUpChange): Promise<void> {
    const written = await writeFollowUp(id, change);
    if (written === 'ok') return;
    const row = written === 'refused' ? await readForWrite(id) : null;
    if (row !== null && (row.follow_up_draft !== null || row.follow_up_rejection !== null)) return;
    throw refused(operation, OUTBOX_TABLE);
  }

  /**
   * #157: falha e envio da cobrança, de quem diz deter a reivindicação `claim`. Lê a linha: se a ficha não é a dele, volta `lost` sem
   * #157: gravar. O `PATCH` filtra pela ficha também; com 0 linhas relê: a ficha deixou de ser dele no meio (`lost`), ou o dado fora
   * #157: do esperado (a versão andou com a reivindicação dele de pé), que lança.
   */
  async function settle(id: number, claim: FollowUpClaim, change: FollowUpChange): Promise<ClaimWrite> {
    const row = await readForWrite(id);
    if (row === null) throw refused(change.action, OUTBOX_TABLE);
    if (row.follow_up_claim !== claim) return 'lost';
    const written = await writeFollowUp(id, { ...change, guard: held(claim) });
    if (written === 'ok') return 'recorded';
    if (written === 'refused' && (await readForWrite(id))?.follow_up_claim !== claim) return 'lost';
    throw refused(change.action, OUTBOX_TABLE);
  }

  /** #157 QR5: existe leitura que vence a recém-gravada? Só informa a saída da tarefa; qual vale é a projeção. */
  async function newerThan(id: number, messageId: number | null): Promise<boolean> {
    const filters = { request_id: `eq.${id}`, message_id: messageId === null ? 'not.is.null' : `gt.${messageId}` };
    const rows = await guarded(() => rest.select(READINGS_TABLE, { select: 'id', filters, limit: 1 }));
    return parseRows(rows, isId, READINGS_TABLE).length > 0;
  }

  /** #157 QR4: o único no_reply por pedido: o índice único parcial responde 409 com 23505 à segunda varredura. */
  async function insertSweep(row: Record<string, unknown>): Promise<'inserted' | 'already'> {
    try {
      await rest.insert(READINGS_TABLE, [row], { ignoreDuplicates: false });
      return 'inserted';
    } catch (error) {
      if (error instanceof SupabaseRestError && error.operation === 'insert' && error.status === 409 && pgCode(error.detail) === '23505') return 'already';
      return guarded(() => Promise.reject(error));
    }
  }

  return {
    get: async (id) => (await load({ id: `eq.${id}` }, 1))[0] ?? null,
    listSent: () => load(SENT),

    async recordReading(id: number, reading: SupplierReading, messageId: number | null): Promise<ReadingRecorded> {
      const row = readingToRow(id, messageId, reading);
      if (messageId === null) {
        if ((await insertSweep(row)) === 'already') return 'superseded';
      } else {
        // #157 QR3: uma leitura por mensagem; a repetida (retentativa de markRead) é ignorada e a primeira fica.
        await guarded(() => rest.insert(READINGS_TABLE, [row], { onConflict: 'message_id', ignoreDuplicates: true }));
      }
      return (await newerThan(id, messageId)) ? 'superseded' : 'recorded';
    },

    saveFollowUpDraft: (id: number, text: SupplierRequestText, dueOn: string) =>
      saveText(id, 'save_follow_up_draft', {
        action: 'follow_up_drafted',
        by: FOLLOW_UP_SWEEP_ACTOR,
        at: clock.now(),
        guard: NO_TEXT,
        columns: { follow_up_draft: { subject: text.subject, body: text.body, asks: [...text.asks], dueOn } },
      }),

    /**
     * #157, AC-5: lê a linha (para manter o novo prazo do rascunho), troca o texto num `PATCH` guardado pela versão e por `editable`.
     * Com 0 linhas relê para dizer por quê: carimbado (`already_sent`), envio reivindicado (`send_in_progress`) ou a versão que andou (`stale`).
     */
    async editFollowUpDraft(id: number, text: SupplierRequestText, by: string): Promise<EditWrite> {
      const row = await readForWrite(id);
      if (row === null || row.follow_up_draft === null) throw refused('edit_follow_up_draft', OUTBOX_TABLE);
      const draft = { subject: text.subject, body: text.body, asks: [...text.asks], ...(row.follow_up_draft.dueOn === undefined ? {} : { dueOn: row.follow_up_draft.dueOn }) };
      const at = clock.now();
      const columns = { follow_up_draft: draft, follow_up_claimed_at: null, follow_up_claim: null }; // #157: solta a ficha vencida
      const written = await writeFollowUp(id, { action: 'follow_up_edited', by, at, guard: editable(at), columns });
      if (written === 'ok') return 'recorded';
      if (written === 'missing') throw refused('edit_follow_up_draft', OUTBOX_TABLE);
      const now = await readForWrite(id);
      if (now === null || now.follow_up_draft === null) throw refused('edit_follow_up_draft', OUTBOX_TABLE);
      if (now.follow_up_sent_at !== null) return 'already_sent';
      return heldAt(now.follow_up_claimed_at, at) ? 'send_in_progress' : 'stale';
    },

    /**
     * #157, AC-4: lê a linha e grava a entrada `document_confirmed` num `PATCH` guardado pela versão lida e por `status=sent`, sem tocar coluna
     * nenhuma (só version, history e updated_at, #157). Com o documento já confirmado no histórico da MESMA leitura que guarda o `PATCH` (`skipIf`), volta sem gravar; com 0 linhas relê
     * para dizer por quê: a outra chamada ganhou (`already_confirmed`) ou a linha andou por outra gravação (`stale`).
     */
    async confirmDocument(id: number, confirmation: DocumentConfirmation): Promise<ConfirmWrite> {
      const confirmed = (history: readonly unknown[]): boolean => confirmationsOf(history).some((c) => c.document === confirmation.document);
      const skipIf = (row: WriteRow): boolean => confirmed(row.history);
      const change: FollowUpChange = { action: CONFIRMED_ACTION, by: confirmation.by, at: confirmation.at, guard: SENT, columns: {}, entry: { document: confirmation.document }, skipIf };
      const written = await writeFollowUp(id, change);
      if (written === 'ok') return 'recorded';
      if (written === 'skipped') return 'already_confirmed';
      const now = await readForWrite(id);
      if (written === 'missing' || now === null) throw refused('confirm_document', OUTBOX_TABLE);
      return confirmed(now.history) ? 'already_confirmed' : 'stale';
    },

    async claimFollowUpSend(id, by, draft): Promise<ClaimAttempt> {
      const at = clock.now();
      const claim = crypto.randomUUID();
      const columns = { follow_up_claimed_at: at.toISOString(), follow_up_claim: claim };
      const written = await writeFollowUp(id, { action: 'follow_up_claimed', by, at, guard: claimable(at), columns, expects: draft });
      if (written === 'ok') return { kind: 'won', claim };
      if (written === 'stale') return { kind: 'stale' };
      if (written === 'missing') return { kind: 'taken' };
      // #157: 0 linhas: ou outro envio ganhou (reivindicado ou carimbado: `taken`), ou a versão andou numa edição no meio (`stale`).
      const now = await readForWrite(id);
      const open = now !== null && now.status === 'sent' && now.follow_up_draft !== null && now.follow_up_sent_at === null && !heldAt(now.follow_up_claimed_at, at);
      return open ? { kind: 'stale' } : { kind: 'taken' };
    },

    recordFollowUpFailure(id, claim, reason, by) {
      // #157: o motivo curto da própria porta; o texto do provedor não cabe no formato e não é gravado.
      if (!SHORT_REASON.test(reason)) return Promise.reject(refused('record_follow_up_failure', OUTBOX_TABLE));
      return settle(id, claim, {
        action: 'follow_up_failed',
        by,
        at: clock.now(),
        guard: {},
        columns: { follow_up_claimed_at: null, follow_up_claim: null, follow_up_failure: reason },
      });
    },

    recordFollowUpSent: (id, claim, stamp: FollowUpStamp) =>
      settle(id, claim, {
        action: 'follow_up_sent',
        by: stamp.by,
        at: stamp.at,
        guard: {},
        // #157: a reivindicação fica de pé depois do envio, com a ficha: é ela que impede o segundo e-mail.
        columns: {
          follow_up_sent_by: stamp.by,
          follow_up_sent_at: stamp.at.toISOString(),
          follow_up_channel: stamp.channel,
          follow_up_provider_message_id: stamp.providerMessageId,
          follow_up_failure: null,
        },
      }),
  };
}
