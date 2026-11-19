import { describe, expect, it } from "vitest";
import { initialPagedState, pagedListReducer, viewOf, type Block, type PagedAction, type PagedState } from "./paged-list-state";

// #160 A máquina de estado da lista por cursor, sem React nem rede: o que cada passo faz com as linhas, os números e a fase.

type Row = { key: string; seen?: boolean };
type Agg = { all: number };
const row = (n: number): Row => ({ key: `k${n}` });
const block = (from: number, count: number, nextCursor: string | null, total = 70, all = 70): Block<Row, Agg> => ({
  items: Array.from({ length: count }, (_, i) => row(from + i)),
  nextCursor,
  total,
  aggregates: { all },
});
const run = (actions: PagedAction<Row, Agg>[], from: PagedState<Row, Agg> = initialPagedState<Row, Agg>()): PagedState<Row, Agg> =>
  actions.reduce((s, a) => pagedListReducer(s, a), from);

describe("#160 estado da lista por cursor", () => {
  it("#160/AC-1: o primeiro bloco enche a lista e guarda o cursor do próximo; antes dele, carregando", () => {
    expect(viewOf(initialPagedState<Row, Agg>()).state).toBe("loading");
    const s = run([{ type: "first-loaded", block: block(1, 30, "c30") }]);
    expect(s.rows).toHaveLength(30);
    expect(s.nextCursor).toBe("c30");
    expect(viewOf(s)).toMatchObject({ state: "ready", phase: "idle", counterBusy: false });
  });

  it("#160/AC-1: o próximo bloco entra depois do que já carregou, com esqueleto enquanto carrega, sem repetir chave", () => {
    const loading = run([{ type: "first-loaded", block: block(1, 30, "c30") }, { type: "start-next" }]);
    expect(viewOf(loading)).toMatchObject({ phase: "loading-next", skeletonRows: 3, counterBusy: false });
    const s = run([{ type: "next-loaded", block: block(29, 30, "c60") }], loading);
    expect(s.rows.map((r) => r.key).slice(28, 32)).toEqual(["k29", "k30", "k31", "k32"]);
    expect(s.rows).toHaveLength(58);
    expect(s.nextCursor).toBe("c60");
    expect(viewOf(s).phase).toBe("idle");
  });

  it("#160/AC-3: sem nextCursor a fase é end; uma lista sem nota é vazia, não end", () => {
    const end = run([{ type: "first-loaded", block: block(1, 10, null, 10, 10) }]);
    expect(viewOf(end)).toMatchObject({ state: "ready", phase: "end" });
    const empty = run([{ type: "first-loaded", block: block(1, 0, null, 0, 0) }]);
    expect(viewOf(empty).state).toBe("empty");
  });

  it("#160/AC-4: o total e os agregados são os da resposta e não mudam com os blocos seguintes", () => {
    const first = run([{ type: "first-loaded", block: block(1, 30, "c30") }]);
    expect(first.total).toBe(70);
    expect(first.aggregates).toEqual({ all: 70 });
    const after = run([{ type: "start-next" }, { type: "next-loaded", block: block(31, 30, "c60", 99, 99) }], first);
    expect(after.total).toBe(70);
    expect(after.aggregates).toEqual({ all: 70 });
  });

  it("#160/AC-1: a falha de um bloco mantém o carregado e o cursor; a falha do primeiro é erro da tela", () => {
    const failed = run([{ type: "first-loaded", block: block(1, 30, "c30") }, { type: "start-next" }, { type: "next-failed" }]);
    expect(viewOf(failed)).toMatchObject({ state: "ready", phase: "error-next" });
    expect(failed.rows).toHaveLength(30);
    expect(failed.nextCursor).toBe("c30");
    const firstFailed = run([{ type: "first-failed" }]);
    expect(viewOf(firstFailed).state).toBe("error");
  });

  it("#160/AC-1: recomeçar do início esvazia as linhas, guarda os números, pede a caixa ao topo e liga o aviso só no recomeço", () => {
    const loaded = run([{ type: "first-loaded", block: block(1, 30, "c30") }]);
    const filtered = run([{ type: "start-first", restart: false }], loaded);
    expect(filtered.rows).toHaveLength(0);
    expect(filtered.aggregates).toEqual({ all: 70 });
    expect(filtered.resets).toBe(loaded.resets + 1);
    expect(filtered.restarted).toBe(false);
    expect(viewOf(filtered)).toMatchObject({ state: "ready", phase: "loading-next", counterBusy: true, skeletonRows: 8 });
    const restarted = run([{ type: "start-first", restart: true }], loaded);
    expect(restarted.restarted).toBe(true);
    // #160 Trocar o filtro depois apaga o aviso.
    expect(run([{ type: "start-first", restart: false }], restarted).restarted).toBe(false);
  });

  it("#160/AC-4: tirar uma linha (D3) tira só ela e desce o total, sem tocar nas outras; os agregados vêm da releitura", () => {
    const loaded = run([{ type: "first-loaded", block: block(1, 30, "c30") }, { type: "start-next" }, { type: "next-loaded", block: block(31, 30, "c60") }]);
    const removed = run([{ type: "removed", key: "k1" }], loaded);
    expect(removed.rows).toHaveLength(59);
    expect(removed.rows[0]?.key).toBe("k2");
    expect(removed.total).toBe(69);
    expect(removed.nextCursor).toBe("c60");
    expect(run([{ type: "removed", key: "inexistente" }], loaded).total).toBe(70);
    const refreshed = run([{ type: "totals-refreshed", total: 69, aggregates: { all: 69 } }], removed);
    expect(refreshed.aggregates).toEqual({ all: 69 });
    expect(refreshed.rows).toHaveLength(59);
  });

  it("#160/AC-4: a releitura das linhas troca cada uma pela versão nova na mesma posição, guarda o cursor e acerta o total e os agregados", () => {
    const loaded = run([{ type: "first-loaded", block: block(1, 3, "c3") }]);
    const fresh: Row[] = [{ key: "k2", seen: true }, { key: "k9", seen: true }];
    const s = run([{ type: "rows-refreshed", rows: fresh, total: 70, aggregates: { all: 69 } }], loaded);
    expect(s.rows.map((r) => r.key)).toEqual(["k1", "k2", "k3"]);
    expect(s.rows[1]).toEqual({ key: "k2", seen: true });
    expect(s.rows[0]).toBe(loaded.rows[0]);
    expect(s.nextCursor).toBe("c3");
    expect(s.total).toBe(70);
    expect(s.aggregates).toEqual({ all: 69 });
  });
});
