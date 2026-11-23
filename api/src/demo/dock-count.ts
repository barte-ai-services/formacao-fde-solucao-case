// #363 Contagem da doca da demonstração: módulo puro, sem plugar na rodada (a parte 2 pluga).
// Para cada ação publicada na doca (ou na loja) de nota demo, sorteia em que rodada a contagem chega
// (2 a 5 depois da publicação) e monta as linhas que o conector do WMS lê (kit_recebimentos e itens).
import type { KitRecebimento, KitRecebimentoItem } from '../connectors/kit-rows.js';
import { roundsElapsed, type Clock, type DemoRoundStep } from './demo-step.js';
import { seededInt } from './seeded-draw.js';

/** Uma leitura mais um lote gravado: o custo em subrequests do passo. */
export const DOCK_COUNT_COST = 2;
const MIN_DELAY_ROUNDS = 2;
const MAX_DELAY_ROUNDS = 5;
const DEFAULT_BATCH_LIMIT = 50;
const DEMO_NOTE = 'Contagem gerada pela demonstração';

export type DockChannel = 'dock' | 'store';

export type PendingDockItem = {
  readonly supplierCode: string;
  readonly description: string;
  readonly quantity: number;
  readonly unit: string;
};

/** Ação publicada na doca (ou na loja) de uma nota demo que ainda não tem contagem. */
export type PendingDockAction = {
  readonly actionId: string;
  readonly channel: DockChannel;
  readonly invoiceAccessKey: string;
  readonly publishedAt: Date;
  readonly supplierId: string;
  readonly store: string;
  readonly purchaseOrderId: string | null;
  /** A exceção da nota (por exemplo E1 ou E3); null quando a nota não tem exceção. */
  readonly classification: string | null;
  readonly items: readonly PendingDockItem[];
};

/** O kit não tem coluna de origem: a parte 2 decide a migração; aqui a linha só carrega a marca. */
export type DemoReceipt = KitRecebimento & { readonly origin: 'demo' };
export type DockCountRow = { readonly receipt: DemoReceipt; readonly items: readonly KitRecebimentoItem[] };
export type DockCountBatch = { readonly receipts: readonly DemoReceipt[]; readonly items: readonly KitRecebimentoItem[] };

export type DockCountSource = { listPending(): Promise<readonly PendingDockAction[]> };
export type DockCountSink = { writeBatch(batch: DockCountBatch): Promise<void> };

export type DockCountPlanOptions = { readonly clock: Clock; readonly seed: string; readonly roundMs: number };
export type DockCountStepOptions = DockCountPlanOptions & {
  readonly source: DockCountSource;
  readonly sink: DockCountSink;
  readonly batchLimit?: number;
};

/** Rodadas entre a publicação e a contagem, de 2 a 5, fixo por chave da nota e semente. */
export function dockCountDelay(seed: string, invoiceAccessKey: string): number {
  return seededInt(seed, invoiceAccessKey, 'contagem-atraso', MIN_DELAY_ROUNDS, MAX_DELAY_ROUNDS);
}

const CHANNELS: Record<DockChannel, string> = { dock: 'doca_cd', store: 'app_loja' };

/** E1: um item da nota some da contagem (contado zero). */
function omitOne(items: readonly PendingDockItem[], seed: string, key: string): PendingDockItem[] {
  const skipped = seededInt(seed, key, 'contagem-item-faltante', 0, items.length - 1);
  return items.filter((_, index) => index !== skipped);
}

/**
 * E3: um item com quantidade de 2 ou mais é contado com um valor sorteado em [1, q-1].
 * Sem nenhum item assim não há como contar menos sem zerar, e zerar viraria E1: a contagem traz o que a nota traz.
 */
function countLess(items: readonly PendingDockItem[], seed: string, key: string): PendingDockItem[] {
  const candidates = items.flatMap((item, index) => (item.quantity >= 2 ? [index] : []));
  if (candidates.length === 0) return [...items];
  const chosen = candidates[seededInt(seed, key, 'contagem-item-menor', 0, candidates.length - 1)];
  return items.map((item, index) =>
    index === chosen ? { ...item, quantity: seededInt(seed, key, 'contagem-quantidade', 1, item.quantity - 1) } : item,
  );
}

function countedItems(action: PendingDockAction, seed: string): PendingDockItem[] {
  const key = action.invoiceAccessKey;
  if (action.classification === 'E1') return omitOne(action.items, seed, key);
  if (action.classification === 'E3') return countLess(action.items, seed, key);
  return [...action.items];
}

function toRow(action: PendingDockAction, now: Date, seed: string): DockCountRow {
  const id = `RC-DOCA-${action.invoiceAccessKey}`;
  return {
    receipt: {
      recebimento_id: id,
      nota_chave: action.invoiceAccessKey,
      ordem_id: action.purchaseOrderId,
      fornecedor_id: action.supplierId,
      destino: action.store,
      canal: CHANNELS[action.channel],
      data: now.toISOString().slice(0, 10),
      observacao: DEMO_NOTE,
      origin: 'demo',
    },
    items: countedItems(action, seed).map((item) => ({
      recebimento_id: id,
      codigo_fornecedor: item.supplierCode,
      descricao: item.description,
      quantidade: item.quantity,
      unidade: item.unit,
    })),
  };
}

/** Decide, pura, quais ações já têm a contagem chegando nesta rodada e monta as linhas dela. */
export function planDockCount(pending: readonly PendingDockAction[], options: DockCountPlanOptions): DockCountRow[] {
  const now = options.clock();
  return pending
    .filter((a) => roundsElapsed(now, a.publishedAt, options.roundMs) >= dockCountDelay(options.seed, a.invoiceAccessKey))
    .map((a) => toRow(a, now, options.seed));
}

/** Passo de rodada: uma leitura e, havendo contagem pronta, uma gravação em lote. */
export function dockCountStep(options: DockCountStepOptions): DemoRoundStep {
  return {
    name: 'demo-dock-count',
    maxSubrequests: DOCK_COUNT_COST,
    run: async () => {
      const pending = await options.source.listPending();
      const rows = planDockCount(pending, options).slice(0, options.batchLimit ?? DEFAULT_BATCH_LIMIT);
      if (rows.length === 0) return;
      await options.sink.writeBatch({ receipts: rows.map((r) => r.receipt), items: rows.flatMap((r) => r.items) });
    },
  };
}

