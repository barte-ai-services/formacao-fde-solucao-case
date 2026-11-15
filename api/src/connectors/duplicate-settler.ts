// Contas a pagar reagindo à duplicidade detectada: bloqueia no Supabase o título de cada nota E6 (#31/AC-5).
// A proposta da E6 (recusar, bloqueio, valor em risco = total) é do proposeChecked do #63; aqui só o título.
import { blockDuplicateTitle } from '../domain/checks/e6-duplicidade.js';
import { Money, Title } from '../domain/index.js';
import { isInteger, isString, parseRows, shaped, type Shape } from './guards.js';
import type { SupabaseRest } from './supabase-rest.js';

export type BlockDuplicatesResult = {
  /** #31 Títulos que passaram de lancado a bloqueado nesta rodada. */
  readonly blocked: number;
  /** #31 Chaves cujo bloqueio falhou; a próxima rodada tenta de novo. */
  readonly failed: number;
};

type KeyRow = { access_key: string };
const isKeyRow = shaped<KeyRow>({ access_key: isString } satisfies Shape<KeyRow>);

type TitleRow = { invoice_access_key: string; amount_cents: number; due_on: string };
const isTitleRow = shaped<TitleRow>({
  invoice_access_key: isString,
  amount_cents: isInteger,
  due_on: isString,
} satisfies Shape<TitleRow>);

/**
 * #31/AC-5: para cada nota E6 com título ainda `lancado`, bloqueia o título pela regra do domínio e
 * grava com o filtro `state=eq.lancado`, a guarda contra corrida: um título que alguém liberou nesse
 * meio-tempo não volta a bloqueado. Idempotente: na segunda rodada não há título lançado de E6.
 * Uma chave que falha não derruba as outras.
 */
export async function blockDuplicateTitles(
  rest: SupabaseRest,
  now: () => Date = () => new Date(),
): Promise<BlockDuplicatesResult> {
  const keys = parseRows(
    await rest.select('invoices', { select: 'access_key', filters: { classification: 'eq.E6' }, order: 'access_key' }),
    isKeyRow,
    'invoices',
  ).map((r) => r.access_key);
  if (keys.length === 0) return { blocked: 0, failed: 0 };

  const titles = parseRows(
    await rest.select('titles', {
      select: 'invoice_access_key,amount_cents,due_on',
      filters: { invoice_access_key: `in.(${keys.map((k) => `"${k}"`).join(',')})`, state: 'eq.lancado' },
      order: 'invoice_access_key',
    }),
    isTitleRow,
    'titles',
  );

  let blocked = 0;
  let failed = 0;
  for (const row of titles) {
    try {
      const title = Title.post({
        invoiceAccessKey: row.invoice_access_key,
        amount: Money.ofCents(row.amount_cents),
        dueOn: row.due_on,
      });
      blockDuplicateTitle({ accessKey: row.invoice_access_key, classification: 'E6' }, title);
      const updated = await rest.update(
        'titles',
        { invoice_access_key: `eq.${row.invoice_access_key}`, state: 'eq.lancado' },
        { state: title.state, updated_at: now().toISOString() },
      );
      if (updated.length > 0) blocked += 1;
    } catch {
      // #31 Sem dado da nota no log nem no retorno: a contagem basta, e a próxima rodada refaz.
      failed += 1;
    }
  }
  return { blocked, failed };
}
