import { describe, expect, it } from "vitest";
import type { LiveBody, LiveEvent } from "../api/live";
import { MAX_ROWS, mergeFeed, noteOf, startFeed } from "./live-state";

/*
 * #355 O estado do ao vivo: as linhas novas entram no topo, o cursor segue o último devolvido, a resposta vazia não mexe na lista nem no cursor.
 */

const day = (pct: number | null) => ({ date: "2026-11-20", decided: 10, byRule: 3, withoutPersonPct: pct });
const person = (n: number): LiveEvent => ({ kind: "human_decision", at: `2026-11-20T13:0${n}:00.000Z`, actor: "person", actor_name: "Ana", step: "Decidiu", invoice: { access_key: `K${n}`, number: String(n) } });
const run: LiveEvent = { kind: "run", at: "2026-11-20T13:00:00.000Z", actor: "system", actor_name: "Automático", step: "Rodada", invoice: null, status: "ok" };
const body = (events: LiveEvent[], since: string | null, pct: number | null = 74, awaiting = 6): LiveBody => ({ events, since, indicators: { day: day(pct) }, awaiting });

describe("#355 o estado do ao vivo", () => {
  it("a primeira carga é a lista como veio, com o cursor e os números da API", () => {
    const feed = startFeed(body([person(2), person(1)], "S1"));
    expect(feed.rows.map((r) => r.event)).toEqual([person(2), person(1)]);
    expect(feed.since).toBe("S1");
    expect(feed.day.withoutPersonPct).toBe(74);
    expect(feed.awaiting).toBe(6);
  });

  it("#355/AC-2: as linhas novas entram no topo, as antigas ficam com a mesma chave, e o cursor passa a ser o devolvido", () => {
    const first = startFeed(body([person(2), person(1)], "S1"));
    const next = mergeFeed(first, body([person(3)], "S2", 75, 5));
    expect(next.rows.map((r) => r.event)).toEqual([person(3), person(2), person(1)]);
    expect(next.rows.slice(1).map((r) => r.key)).toEqual(first.rows.map((r) => r.key));
    expect(new Set(next.rows.map((r) => r.key)).size).toBe(3);
    expect(next.since).toBe("S2");
    expect(next.day.withoutPersonPct).toBe(75);
    expect(next.awaiting).toBe(5);
  });

  it("resposta sem passo mantém a lista e o cursor, e troca só os números", () => {
    const first = startFeed(body([person(1)], "S1"));
    const next = mergeFeed(first, body([], "S1", 80, 2));
    expect(next.rows).toEqual(first.rows);
    expect(next.since).toBe("S1");
    expect(next.awaiting).toBe(2);
    expect(mergeFeed(first, body([], null)).since).toBe("S1");
  });

  it("sem cursor no pedido, a resposta é a lista inteira e não repete a que já estava", () => {
    const empty = startFeed(body([], null, null, 0));
    const next = mergeFeed(empty, body([person(2), person(1)], "S1"));
    expect(next.rows).toHaveLength(2);
    expect(next.since).toBe("S1");
  });

  it("a rodada não tem nota; a decisão e a de pessoa têm", () => {
    expect(noteOf(run)).toBeNull();
    expect(noteOf(person(1))).toEqual({ access_key: "K1", number: "1" });
  });

  it("#355: a lista guarda no máximo MAX_ROWS linhas, as mais novas, e o cursor segue o devolvido", () => {
    const many = (from: number, n: number) => Array.from({ length: n }, (_, i) => person(from + i));
    const first = startFeed(body(many(0, MAX_ROWS + 50), "S1"));
    expect(first.rows).toHaveLength(MAX_ROWS);
    expect(first.rows[0]!.event).toEqual(person(0));
    const next = mergeFeed(first, body([person(7), person(8)], "S2"));
    expect(next.rows).toHaveLength(MAX_ROWS);
    expect(next.rows.slice(0, 2).map((r) => r.event)).toEqual([person(7), person(8)]);
    expect(next.rows[2]!.key).toBe(first.rows[0]!.key);
    expect(next.rows.at(-1)!.key).toBe(first.rows[MAX_ROWS - 3]!.key);
    expect(next.since).toBe("S2");
    expect(next.seq).toBe(first.seq + 2);
  });
});
