// #355 O estado puro do ao vivo: as linhas, o cursor e os números do topo. Sem React nem rede; o hook `useLiveFeed` traduz cada resposta em uma destas chamadas.
import type { LiveBody, LiveDayIndicators, LiveEvent, LiveInvoiceRef } from "../api/live";

export interface LiveRow {
  /** Identidade da linha na tela: a ordem de chegada, que não muda quando entram linhas acima. */
  key: string;
  event: LiveEvent;
}

export interface LiveFeed {
  /** Do mais novo ao mais velho. */
  rows: LiveRow[];
  /** O cursor devolvido pela API, intacto; nulo enquanto não houve passo algum. */
  since: string | null;
  day: LiveDayIndicators;
  awaiting: number;
  /** Quantas linhas já ganharam chave. */
  seq: number;
}

/** A nota que a linha abre na gaveta; a rodada não tem nota. Um `kind` novo quebra a compilação aqui. */
export function noteOf(event: LiveEvent): LiveInvoiceRef | null {
  switch (event.kind) {
    case "run":
      return null;
    case "decision":
    case "human_decision":
      return event.invoice;
    default: {
      const unreachable: never = event;
      return unreachable;
    }
  }
}

const keyed = (events: LiveEvent[], from: number): LiveRow[] => events.map((event, i) => ({ key: String(from + i), event }));

/** A primeira carga: a lista é a resposta, e o cursor é o que ela devolveu. */
export function startFeed(body: LiveBody): LiveFeed {
  return { rows: keyed(body.events, 0), since: body.since, day: body.indicators.day, awaiting: body.awaiting, seq: body.events.length };
}

/**
 * Uma resposta de `?since=`: as linhas novas entram no topo e as que já estavam ficam como estão; os números do topo são os do corpo novo.
 * O cursor é o `since` devolvido; sem ele (resposta sem passo algum) fica o que já havia. Sem cursor no pedido, a resposta é a lista inteira.
 */
export function mergeFeed(feed: LiveFeed, body: LiveBody): LiveFeed {
  const base = { day: body.indicators.day, awaiting: body.awaiting };
  if (feed.since === null) return { ...base, rows: keyed(body.events, feed.seq), since: body.since, seq: feed.seq + body.events.length };
  return {
    ...base,
    rows: [...keyed(body.events, feed.seq), ...feed.rows],
    since: body.since ?? feed.since,
    seq: feed.seq + body.events.length,
  };
}
