import {
  AmountAtRisk,
  DomainError,
  type Divergence,
  Money,
  type PostedInvoice,
  type TitleState,
} from "../domain/index";
import { duplicateReason, type DuplicateReason } from "../domain/checks/e6-duplicidade";
import { invalidCursor, pageOf, readPageQuery, sortedBy, type Ordering } from "./page";

/** Uma nota barrada por duplicidade (#31/AC-6), com o título original quando ele existe. */
export type DuplicateEntry = {
  readonly duplicate: {
    readonly accessKey: string;
    readonly number: string;
    readonly supplierId: string;
    readonly issuedOn: string;
    readonly total: Money;
  };
  readonly original: { readonly accessKey: string; readonly number: string; readonly status: string } | null;
  readonly reason: DuplicateReason;
  readonly blockedAmount: Money;
  /** #31/AC-5: o estado gravado do título da nota duplicada; null se ainda não há título. */
  readonly titleState: TitleState | null;
};

/**
 * O que a entrada precisa da nota conferida E6. Uma `Invoice` serve, e a linha do banco também,
 * que não é uma `Invoice`.
 */
export type DuplicateRecord = {
  readonly accessKey: string;
  readonly number: string;
  readonly supplierId: string;
  readonly issuedOn: string;
  readonly total: Money;
  readonly divergences: readonly Divergence[];
};

/** Porta de leitura das duplicidades. */
export interface DuplicatesReader {
  list(): Promise<readonly DuplicateEntry[]>;
}

/** Sem banco configurado, nenhuma duplicidade. */
export const noDuplicates: DuplicatesReader = { list: async () => [] };

/**
 * Monta a entrada a partir da nota conferida E6. O original é o título lançado citado na evidência
 * `erp_contas_a_pagar` (null quando o motivo é só a ordem sem saldo). O valor barrado é o valor da
 * nota (regra 3). Com os dois motivos, vale `titulo_lancado`.
 */
export function toDuplicateEntry(
  record: DuplicateRecord,
  posted: readonly PostedInvoice[],
  titleState: TitleState | null = null,
): DuplicateEntry {
  const e6 = record.divergences.filter((d) => d.classification === "E6");
  if (e6.length === 0) {
    throw new DomainError(`Duplicidade: a nota ${record.number} não tem divergência E6`);
  }
  const reason: DuplicateReason = e6.map(duplicateReason).includes("titulo_lancado")
    ? "titulo_lancado" // ADR-002
    : "ordem_sem_saldo"; // ADR-002
  const originalKey = e6.flatMap((d) => d.evidence).find((e) => e.source === "erp_contas_a_pagar")?.reference;
  const original = posted.find((p) => p.accessKey === originalKey);
  return {
    duplicate: {
      accessKey: record.accessKey,
      number: record.number,
      supplierId: record.supplierId,
      issuedOn: record.issuedOn,
      total: record.total,
    },
    original: original ? { accessKey: original.accessKey, number: original.number, status: original.status } : null,
    reason,
    blockedAmount: AmountAtRisk.full(record.total).amount,
    titleState,
  };
}

/**
 * `GET /api/duplicates` (#31/AC-6). Responde:
 *
 * ```json
 * { "duplicates": [{
 *     "duplicate": { "accessKey", "number", "supplierId", "issuedOn", "totalCents": <centavos>, "total": "R$ 1.209,60" },
 *     "original": { "accessKey", "number", "status" } | null,
 *     "reason": "titulo_lancado" | "ordem_sem_saldo",
 *     "blockedAmountCents": <centavos>, "blockedAmount": "R$ 1.209,60",
 *     "titleState": "lancado" | "liberado" | "reduzido" | "bloqueado" | "na_lista_do_dia" | null
 *   }],
 *   "count": <quantidade> }
 * ```
 *
 * Os campos `*Cents` são centavos inteiros; os sem sufixo, o valor formatado em reais. Os valores de
 * `reason` e de `titleState` são literais do modelo (ADR-002). `titleState` é o estado gravado do
 * título da nota duplicada, null quando ainda não há título: a tela só afirma "bloqueado" quando ele é.
 *
 * #159 Com `cursor` ou `limite` na query, a forma é paginada, e a antiga fica para quem não os manda:
 * `{ items, nextCursor, total, aggregates }`. Os `items` têm a forma de cada entrada acima. `aggregates`
 * vale para a lista inteira: `blockedAmount` (`{ cents, text }`, a soma do valor barrado) e `byReason`
 * (quantas por `titulo_lancado` e por `ordem_sem_saldo`). A quantidade é o `total`.
 */
export async function listDuplicates(reader: DuplicatesReader, params: URLSearchParams = new URLSearchParams()): Promise<Response> {
  const query = readPageQuery(params);
  if (query.kind === "invalid") return query.response;
  const stored = await reader.list();
  if (query.kind === "whole") return Response.json({ duplicates: stored.map(toJson), count: stored.length });
  const entries = sortedBy(stored, DUPLICATES_ORDER);
  const page = pageOf(DUPLICATES_ORDER, entries, query);
  if (!page) return invalidCursor();
  const blocked = entries.reduce((sum, e) => sum + e.blockedAmount.cents, 0);
  const byReason = (reason: DuplicateReason) => entries.filter((e) => e.reason === reason).length;
  return Response.json({
    items: page.items.map(toJson),
    nextCursor: page.nextCursor,
    total: page.total,
    aggregates: {
      blockedAmount: { cents: blocked, text: Money.ofCents(blocked).toString() },
      byReason: { titulo_lancado: byReason("titulo_lancado"), ordem_sem_saldo: byReason("ordem_sem_saldo") },
    },
  });
}

/**
 * #159 A ordem das páginas é a chave de acesso da nota duplicada, a tupla que o cursor guarda. Sem
 * `cursor` nem `limite`, a ordem é a da leitura.
 */
const DUPLICATES_ORDER: Ordering<DuplicateEntry> = {
  list: "duplicadas",
  shape: ["string"],
  key: (e) => [e.duplicate.accessKey],
};

function toJson(entry: DuplicateEntry) {
  return {
    duplicate: {
      accessKey: entry.duplicate.accessKey,
      number: entry.duplicate.number,
      supplierId: entry.duplicate.supplierId,
      issuedOn: entry.duplicate.issuedOn,
      totalCents: entry.duplicate.total.cents,
      total: entry.duplicate.total.toString(),
    },
    original: entry.original,
    reason: entry.reason,
    blockedAmountCents: entry.blockedAmount.cents,
    blockedAmount: entry.blockedAmount.toString(),
    titleState: entry.titleState,
  };
}
