import { describe, expect, it } from "vitest";
import { ApiError } from "./client";
import { parseLive, type LiveEvent } from "./live";

// #354 A borda do ao vivo lê só o contrato de `GET /api/live`.

const day = (pct: number | null) => ({ date: "2026-11-20", decided: 10, byRule: 3, withoutPersonPct: pct });
const person = (n: number): LiveEvent => ({ kind: "human_decision", at: `2026-11-20T13:0${n}:00.000Z`, actor: "person", actor_name: "Ana", step: "Decidiu", invoice: { access_key: `K${n}`, number: String(n) } });
const run: LiveEvent = { kind: "run", at: "2026-11-20T13:00:00.000Z", actor: "system", actor_name: "Automático", step: "Rodada", invoice: null, status: "ok" };

describe("#353 a borda lê o pedido de devolução enviado sozinho", () => {
  const auto = { kind: "auto_return", at: "2026-11-23T13:20:00.000Z", actor: "system", actor_name: "Automático", step: "Enviado automaticamente", invoice: { access_key: "K1", number: "101" } };
  const body = (event: unknown) => ({ events: [event], since: "S", indicators: { day: day(null) }, awaiting: 0 });

  it("#353/AC-1: aceita o passo auto_return, com a nota e o selo da automação", () => {
    expect(parseLive(body(auto)).events[0]).toEqual(auto);
  });

  it("#353/AC-1: recusa o auto_return sem a nota, que a gaveta precisa para abrir", () => {
    expect(() => parseLive(body({ ...auto, invoice: null }))).toThrow(/fora do contrato/);
  });
});

describe("#354 a borda lê só o contrato", () => {
  const raw = { events: [{ ...person(1) }, { ...run }], since: "S", indicators: { day: day(null), month: { month: "2026-11" } }, awaiting: 0 };

  it("aceita o corpo do contrato, inclusive o traço do percentual nulo", () => {
    const parsed = parseLive(raw);
    expect(parsed.events).toHaveLength(2);
    expect(parsed.indicators.day.withoutPersonPct).toBeNull();
  });

  it.each([
    ["sem events", { ...raw, events: undefined }],
    ["kind que a tela não conhece", { ...raw, events: [{ ...person(1), kind: "novo" }] }],
    ["rodada com nota", { ...raw, events: [{ ...run, invoice: { access_key: "K", number: "1" } }] }],
    ["awaiting em texto", { ...raw, awaiting: "6" }],
    ["since em número", { ...raw, since: 1 }],
    ["corpo que não é objeto", "x"],
  ])("recusa %s sem repetir o corpo na mensagem", (_name, bad) => {
    expect(() => parseLive(bad)).toThrow(/fora do contrato/);
  });

  it("o erro de corpo fora do contrato não leva código, como nas outras bordas", () => {
    try {
      parseLive("x");
      expect.unreachable();
    } catch (error) {
      expect((error as ApiError).code).toBeNull();
    }
  });
});
