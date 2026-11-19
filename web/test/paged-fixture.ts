/*
 * #160 As listas das telas chegam em blocos por cursor (api/README.md, "Listas paginadas por cursor"). Os testes de tela mais antigos tinham o corpo
 * "inteiro" de cada lista; este ajudante monta daquele corpo a resposta paginada de um bloco só (`nextCursor` nulo), com os agregados da lista toda,
 * para que eles sigam protegendo o que protegiam (colunas, selos, gaveta) sem repetir o contrato em cada arquivo. O comportamento da paginação em si
 * é de web/test/tabela-scroll-infinito.test.tsx.
 */
type Row = Record<string, unknown>;
interface Whole {
  items?: Row[];
  duplicates?: Row[];
  rows?: Row[];
  count?: number;
  total?: { cents: number };
  awaiting?: number;
  [key: string]: unknown;
}

const money = (cents: number) => ({ cents, text: `R$ ${(cents / 100).toFixed(2).replace(".", ",")}` });
const sum = (rows: Row[], pick: (row: Row) => number) => rows.reduce((n, row) => n + pick(row), 0);
const cents = (value: unknown): number => (value as { cents: number }).cents;

/** #160 O corpo paginado que a API devolveria para este pedido, dado o corpo inteiro da lista que o teste tem. */
export function pagedBody(url: string, whole: unknown): unknown {
  const [path = "", query = ""] = url.split("?");
  const body = whole as Whole;
  const params = new URLSearchParams(query);
  const page = (items: Row[], total: number, aggregates: unknown) => ({ items, nextCursor: null, total, aggregates });
  switch (path) {
    case "/api/fila": { // ADR-004
      const items = body.items ?? [];
      const approvable = items.filter((item) => item.canApprove);
      const shown = params.get("pode_aprovar") === "1" ? approvable : items;
      return {
        approver: body.approver,
        ...page(shown, shown.length, {
          all: items.length,
          approvable: approvable.length,
          amountAtRisk: money(sum(items, (item) => cents(item.amountAtRisk))),
          blocked: items.filter((item) => item.level === "bloqueio").length,
        }),
      };
    }
    case "/api/hoje": {
      const items = (body.items ?? []).map((item) => ({ ...item, approvedBy: item.approvedBy ?? (item.approver === null ? null : item.approver === "regra" ? "rule" : "person") }));
      return { day: body.day, ...page(items, items.length, { toPay: body.total ?? money(0), approvedByRule: items.filter((item) => item.approvedBy === "rule").length }) };
    }
    case "/api/duplicates": {
      const items = body.duplicates ?? [];
      const reason = (name: string) => items.filter((item) => item.reason === name).length;
      return page(items, items.length, { blockedAmount: money(sum(items, (item) => item.blockedAmountCents as number)), byReason: { titulo_lancado: reason("titulo_lancado"), ordem_sem_saldo: reason("ordem_sem_saldo") } });
    }
    default: {
      // #160 /api/doca e /api/recebimento-loja: o mesmo formato, com o destino e a data como contexto da lista
      const items = body.rows ?? [];
      return { destination: body.destination, date: body.date, destinations: body.destinations, ...page(items, items.length, { awaiting: body.awaiting ?? 0 }) };
    }
  }
}

/** #160 Os caminhos de lista que paginam: só neles um corpo inteiro vira a página. */
export const PAGED_PATHS = ["/api/fila", "/api/hoje", "/api/duplicates", "/api/doca", "/api/recebimento-loja"]; // ADR-004
export const isPaged = (url: string): boolean => PAGED_PATHS.includes(url.split("?")[0] ?? "");
