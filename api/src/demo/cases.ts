// Os casos do gerador (#349), portados do gerador da base (kit-domingo/gerador/gerar_base.py), sem o gabarito: cada caso
// grava as linhas e devolve só o que o gerador precisa para dizer, em memória, o que a conferência deve achar. (#349)
import type { Classification } from '../domain/index.js';
import { BLOCKED_SUPPLIER, PRODUCTS, UNREGISTERED_ITEMS } from './catalog.js';
import {
  addDays,
  itemOf,
  lockReason,
  newNote,
  orderIdOf,
  orderItems,
  paymentIdOf,
  pickStore,
  pickSupplier,
  receiptIdOf,
  receiptNote,
  receivedOn,
  targetCents,
  type CaseEnv,
  type CaseOutcome,
  type Size,
} from './case-kit.js';
import { itemCents, receiptLinesOf, totalCents, type DemoItem, type NoteInput } from './rows.js';


export type MatchVariant = 'exato_L' | 'sem_xped_L' | 'exato_C' | 'exato_H' | 'bloqueado_C' | 'tolerancia_L';
export type ExceptionCode = 'E1' | 'E2' | 'E3' | 'E4' | 'E5' | 'E6' | 'E7' | 'E8';

const MATCH_SIZE: Readonly<Record<MatchVariant, Size>> = {
  exato_L: 'L',
  sem_xped_L: 'L',
  exato_C: 'C',
  exato_H: 'H',
  bloqueado_C: 'C',
  tolerancia_L: 'L',
};

type Scenario = { readonly supplierId: string; readonly store: string; readonly issuedOn: string };

function scenario(env: CaseEnv, size: Size, supplierId?: string): Scenario {
  const issuedOn = addDays(env.today, -env.rng.int(0, 3));
  return {
    supplierId: supplierId ?? pickSupplier(env.rng),
    store: pickStore(env.rng, size),
    issuedOn,
  };
}

function outcome(note: NoteInput, classification: Classification): CaseOutcome {
  return { key: note.key, supplierId: note.supplierId, totalCents: totalCents(note.items), classification };
}

/** Grava a ordem do caso e devolve o seu id. (#349) */
function placeOrder(env: CaseEnv, s: Scenario, items: readonly DemoItem[], daysBefore: number, status: 'aberta' | 'atendida' | 'travada' = 'aberta'): string {
  const id = orderIdOf(env);
  env.sink.addOrder({
    id,
    supplierId: s.supplierId,
    store: s.store,
    issuedOn: addDays(s.issuedOn, -daysBefore),
    status,
    statusReason: status === 'travada' ? lockReason(env) : '',
    items,
  });
  return id;
}

function receive(env: CaseEnv, s: Scenario, note: NoteInput, orderId: string | null, items: readonly DemoItem[]): void {
  env.sink.addReceipt({
    id: receiptIdOf(env),
    noteKey: note.key,
    orderId,
    supplierId: s.supplierId,
    store: s.store,
    receivedOn: receivedOn(env, s.issuedOn),
    note: receiptNote(env),
    lines: receiptLinesOf(items),
  });
}

/** Aplica a tolerância: sobe o preço do item de maior quantidade, de modo que a diferença fique dentro de R$ 50 e 0,5%. (#349) */
function withinToleranceDrift(items: readonly DemoItem[]): DemoItem[] {
  const biggest = items.reduce((a, b) => (b.quantity > a.quantity ? b : a));
  const drift = Math.max(1, Math.round(Math.min(4500, totalCents(items) * 0.004) / biggest.quantity));
  return items.map((item) => (item === biggest ? { ...item, priceCents: item.priceCents + drift } : item));
}

export function matchCase(env: CaseEnv, variant: MatchVariant): CaseOutcome {
  const size = MATCH_SIZE[variant];
  const s = scenario(env, size, variant === 'bloqueado_C' ? BLOCKED_SUPPLIER : undefined);
  const items = orderItems(env.rng, s.supplierId, targetCents(env.rng, size));
  const orderId = placeOrder(env, s, items, env.rng.int(3, 9));
  const billed = variant === 'tolerancia_L' ? withinToleranceDrift(items) : items;
  const withoutOrderRef = variant === 'sem_xped_L';
  const note = newNote(env, { ...s, items: billed, orderId: withoutOrderRef ? null : orderId, slot: 0 });
  env.sink.addNote(note);
  receive(env, s, note, orderId, billed);
  // A regra da solução lê a nota sem o número do pedido como nota sem ordem (E5): quem confirma a ordem provável é a coordenação. (#349)
  return outcome(note, withoutOrderRef ? 'E5' : 'MATCH');
}

export function caseE1(env: CaseEnv, size: Size): CaseOutcome {
  const s = scenario(env, size);
  const items = orderItems(env.rng, s.supplierId, targetCents(env.rng, size));
  const orderId = placeOrder(env, s, items, 5);
  const note = newNote(env, { ...s, items, orderId, slot: 0 });
  env.sink.addNote(note);
  const missing = env.rng.pick(items);
  receive(env, s, note, orderId, items.filter((i) => i !== missing));
  return outcome(note, 'E1');
}

export function caseE2(env: CaseEnv, size: Size): CaseOutcome {
  const s = scenario(env, size);
  const products = PRODUCTS.filter((p) => p.supplierId === s.supplierId);
  const ordered = orderItems(env.rng, s.supplierId, targetCents(env.rng, size), Math.min(3, products.length - 1));
  const orderId = placeOrder(env, s, ordered, 5);
  const swapped = env.rng.pick(ordered);
  const replacement = env.rng.pick(products.filter((p) => !ordered.some((o) => o.sku === p.sku)));
  const quantity = Math.max(4, Math.round((itemCents(swapped) / replacement.priceCents / 4)) * 4);
  const billed = [...ordered.filter((i) => i !== swapped), itemOf(replacement, quantity)];
  const note = newNote(env, { ...s, items: billed, orderId, slot: 0 });
  env.sink.addNote(note);
  receive(env, s, note, orderId, billed);
  return outcome(note, 'E2');
}

export function caseE3(env: CaseEnv, size: Size): CaseOutcome {
  const s = scenario(env, size);
  const items = orderItems(env.rng, s.supplierId, targetCents(env.rng, size));
  const orderId = placeOrder(env, s, items, 5);
  const note = newNote(env, { ...s, items, orderId, slot: 0 });
  env.sink.addNote(note);
  const shorter = env.rng.pick(items);
  receive(env, s, note, orderId, items.map((i) => (i === shorter ? { ...i, quantity: Math.floor((i.quantity * 3) / 4) } : i)));
  return outcome(note, 'E3');
}

/** E4: a ordem está em unidade e a nota em caixa; o item de caixa de 4 de maior valor vira CX, com o preço da caixa. (#349) */
export function caseE4(env: CaseEnv, size: Size): CaseOutcome {
  const s = scenario(env, size, pickSupplier(env.rng, (id) => id !== 'F03'));
  const factorOf = (item: DemoItem): number => PRODUCTS.find((p) => p.sku === item.sku)?.boxFactor ?? 1;
  const drawn = orderItems(env.rng, s.supplierId, targetCents(env.rng, size));
  const candidates = drawn.filter((i) => factorOf(i) === 4);
  const boxed = (candidates.length > 0 ? candidates : drawn).reduce((a, b) => (itemCents(b) > itemCents(a) ? b : a));
  const factor = factorOf(boxed);
  // A ordem leva a quantidade em múltiplo da caixa, para a conversão fechar. (#349)
  const ordered = drawn.map((i) => (i === boxed ? { ...i, quantity: Math.max(factor, Math.floor(i.quantity / factor) * factor) } : i));
  const orderId = placeOrder(env, s, ordered, 5);
  const billed = ordered.map((i): DemoItem =>
    i.sku === boxed.sku ? { ...i, quantity: i.quantity / factor, unit: 'CX', priceCents: i.priceCents * factor } : i,
  );
  const note = newNote(env, { ...s, items: billed, orderId, slot: 0 });
  env.sink.addNote(note);
  receive(env, s, note, orderId, billed);
  return outcome(note, 'E4');
}

export function caseE5(env: CaseEnv, size: Size): CaseOutcome {
  const s = scenario(env, size);
  const items = orderItems(env.rng, s.supplierId, targetCents(env.rng, size));
  const note = newNote(env, { ...s, items, orderId: null, channel: env.rng.pick(['SEFAZ', 'e-mail']), slot: 0 });
  env.sink.addNote(note);
  return outcome(note, 'E5');
}

/** E6 (reemissão): a mesma ordem, os mesmos itens e o mesmo valor de uma nota já lançada e recebida; a chave nunca se repete. (#349) */
export function caseE6(env: CaseEnv, size: Size): CaseOutcome {
  const s = scenario(env, size);
  const items = orderItems(env.rng, s.supplierId, targetCents(env.rng, size));
  const orderId = placeOrder(env, s, items, 12, 'atendida');
  const firstDate = addDays(s.issuedOn, -env.rng.int(4, 8));
  const first = newNote(env, { ...s, issuedOn: firstDate, items, orderId, slot: 1 });
  env.sink.addPostedNote(first, env.rng.pick(['lançada', 'paga'] as const));
  receive(env, { ...s, issuedOn: firstDate }, first, orderId, items);
  const note = newNote(env, { ...s, items, orderId, slot: 0, number: first.number + env.rng.int(1, 30) });
  env.sink.addNote(note);
  return outcome(note, 'E6');
}

/** E7: a loja recebeu e pagou antes de a nota chegar; a nota vem sem ordem e o pagamento não tem nota. (#349) */
export function caseE7(env: CaseEnv, size: Size): CaseOutcome {
  const s = scenario(env, size);
  const items = orderItems(env.rng, s.supplierId, targetCents(env.rng, size), 2);
  const note = newNote(env, { ...s, items, orderId: null, channel: 'e-mail', slot: 0 });
  env.sink.addNote(note);
  const paidOn = addDays(s.issuedOn, -env.rng.int(3, 9));
  env.sink.addReceipt({
    id: receiptIdOf(env), noteKey: null, orderId: null, supplierId: s.supplierId, store: s.store,
    receivedOn: paidOn, note: receiptNote(env), lines: receiptLinesOf(items),
  });
  env.sink.addPayment({
    id: paymentIdOf(env), supplierId: s.supplierId, store: s.store, paidOn,
    cents: totalCents(items), method: env.rng.pick(['pix', 'boleto avulso']),
  });
  return outcome(note, 'E7');
}

/** E8: a ordem travou, a mercadoria entrou e a nota traz um item que ainda não tem cadastro. (#349) */
export function caseE8(env: CaseEnv, size: Size): CaseOutcome {
  const s = scenario(env, size, pickSupplier(env.rng, (id) => id in UNREGISTERED_ITEMS));
  const registered = orderItems(env.rng, s.supplierId, targetCents(env.rng, size) * 0.75, 2);
  const fresh = UNREGISTERED_ITEMS[s.supplierId];
  if (!fresh) throw new RangeError(`sem item sem cadastro para ${s.supplierId}`);
  const quantity = Math.max(8, Math.round((targetCents(env.rng, size) * 0.25) / fresh.priceCents / 4) * 4);
  const unregistered: DemoItem = {
    sku: null,
    code: `${s.supplierId}-N${env.rng.int(10, 99)}`,
    description: fresh.description,
    quantity,
    unit: 'UN',
    priceCents: fresh.priceCents,
  };
  const items = [...registered, unregistered];
  const orderId = placeOrder(env, s, items, 6, 'travada');
  const note = newNote(env, { ...s, items, orderId, slot: 0 });
  env.sink.addNote(note);
  receive(env, s, note, orderId, items);
  return outcome(note, 'E8');
}

export const EXCEPTION_CASES: Readonly<Record<ExceptionCode, (env: CaseEnv, size: Size) => CaseOutcome>> = {
  E1: caseE1, E2: caseE2, E3: caseE3, E4: caseE4, E5: caseE5, E6: caseE6, E7: caseE7, E8: caseE8,
};
