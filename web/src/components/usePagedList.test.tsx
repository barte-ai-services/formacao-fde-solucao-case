import { act, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InvalidCursorError, type Block } from "./paged-list-state";
import { ScrollTable } from "./ScrollTable";
import { usePagedList } from "./usePagedList";

/*
 * #160 O estado que dirige a tabela por blocos: carrega o primeiro bloco, pede o próximo pelo cursor sem duplicar,
 * repete o mesmo cursor na falha, recomeça ao trocar o filtro e no `cursor_invalido`, e mantém os números do topo.
 * O IntersectionObserver é simulado (como em ScrollTable.test.tsx); a busca é uma função injetada, sem fetch.
 */

type Row = { key: string; number: string };
type Agg = { all: number };
const SIZE = 30;
const TOTAL = 70;

/** #160 Uma lista de 70 notas em blocos de 30, 30 e 10; o cursor é `<modo>:<posição>`. */
function server(total = TOTAL) {
  const calls: (string | null)[] = [];
  const pending: { cursor: string | null; resolve: () => void }[] = [];
  const hooks = { hold: false, failOnce: new Set<string>(), invalidOnce: false, failTotals: false };
  const fetchBlock = vi.fn(async (cursor: string | null, signal: AbortSignal): Promise<Block<Row, Agg>> => {
    calls.push(cursor);
    if (hooks.hold) await new Promise<void>((resolve) => pending.push({ cursor, resolve }));
    if (signal.aborted && hooks.hold) throw new Error("abortado");
    if (cursor !== null && hooks.invalidOnce) {
      hooks.invalidOnce = false;
      throw new InvalidCursorError("cursor_invalido");
    }
    if (cursor !== null && hooks.failOnce.delete(cursor)) throw new Error("falha com segredo-do-servidor");
    if (cursor === null && hooks.failTotals) throw new Error("falha");
    const at = cursor === null ? 0 : Number(cursor.split(":")[1]);
    const count = Math.min(SIZE, total - at);
    return {
      items: Array.from({ length: count }, (_, i) => ({ key: `k${at + i + 1}`, number: String(at + i + 1) })),
      nextCursor: at + SIZE < total ? `m:${at + SIZE}` : null,
      total,
      aggregates: { all: total },
    };
  });
  return { calls, pending, hooks, fetchBlock };
}

describe("#160 usePagedList", () => {
  it("#160/AC-1: carrega o primeiro bloco com cursor nulo e entrega linhas, total e agregados da resposta", async () => {
    const s = server();
    const { result } = renderHook(() => usePagedList(s.fetchBlock, "todas"));
    expect(result.current.state).toBe("loading");
    await waitFor(() => expect(result.current.state).toBe("ready"));
    expect(s.calls).toEqual([null]);
    expect(result.current.rows).toHaveLength(30);
    expect(result.current.total).toBe(70);
    expect(result.current.aggregates).toEqual({ all: 70 });
    expect(result.current.phase).toBe("idle");
  });

  it("#160/AC-1: pede o próximo bloco pelo nextCursor, uma vez só mesmo com vários avisos enquanto carrega", async () => {
    const s = server();
    const { result } = renderHook(() => usePagedList(s.fetchBlock, "todas"));
    await waitFor(() => expect(result.current.state).toBe("ready"));
    s.hooks.hold = true;
    act(() => {
      result.current.loadNext();
      result.current.loadNext();
      result.current.loadNext();
    });
    expect(result.current.phase).toBe("loading-next");
    expect(s.calls).toEqual([null, "m:30"]);
    s.hooks.hold = false;
    await act(async () => s.pending.forEach((p) => p.resolve()));
    await waitFor(() => expect(result.current.rows).toHaveLength(60));
    expect(result.current.phase).toBe("idle");
    expect(s.calls).toEqual([null, "m:30"]);
  });

  it("#160/AC-3: no último bloco a fase é end e um novo aviso não busca nada", async () => {
    const s = server();
    const { result } = renderHook(() => usePagedList(s.fetchBlock, "todas"));
    await waitFor(() => expect(result.current.state).toBe("ready"));
    act(() => result.current.loadNext());
    await waitFor(() => expect(result.current.rows).toHaveLength(60));
    act(() => result.current.loadNext());
    await waitFor(() => expect(result.current.rows).toHaveLength(70));
    expect(result.current.phase).toBe("end");
    act(() => result.current.loadNext());
    expect(s.calls).toHaveLength(3);
  });

  it("#160/AC-4: o total e os agregados não mudam conforme os blocos chegam", async () => {
    const s = server();
    const { result } = renderHook(() => usePagedList(s.fetchBlock, "todas"));
    await waitFor(() => expect(result.current.state).toBe("ready"));
    const before = { total: result.current.total, aggregates: result.current.aggregates };
    act(() => result.current.loadNext());
    await waitFor(() => expect(result.current.rows).toHaveLength(60));
    expect({ total: result.current.total, aggregates: result.current.aggregates }).toEqual(before);
  });

  it("#160/AC-1: um bloco que falha mantém o carregado; \"Tentar de novo\" repete o MESMO cursor; a tela não guarda o erro", async () => {
    const s = server();
    const { result } = renderHook(() => usePagedList(s.fetchBlock, "todas"));
    await waitFor(() => expect(result.current.state).toBe("ready"));
    s.hooks.failOnce.add("m:30");
    act(() => result.current.loadNext());
    await waitFor(() => expect(result.current.phase).toBe("error-next"));
    expect(result.current.rows).toHaveLength(30);
    // #160 Exposição: o que a tela recebe não carrega o texto nem o corpo do erro do servidor.
    expect(JSON.stringify(result.current)).not.toContain("segredo-do-servidor");
    act(() => result.current.retryBlock());
    await waitFor(() => expect(result.current.rows).toHaveLength(60));
    expect(s.calls).toEqual([null, "m:30", "m:30"]);
  });

  it("#160/AC-1: se o primeiro bloco falha, é erro da tela, e retry recarrega do início", async () => {
    const s = server();
    s.hooks.failTotals = true;
    const { result } = renderHook(() => usePagedList(s.fetchBlock, "todas"));
    await waitFor(() => expect(result.current.state).toBe("error"));
    s.hooks.failTotals = false;
    act(() => result.current.retry());
    await waitFor(() => expect(result.current.state).toBe("ready"));
    expect(result.current.rows).toHaveLength(30);
  });

  it("#160/AC-1: trocar o filtro recarrega do primeiro bloco, pede a rolagem ao topo e guarda os números", async () => {
    const s = server();
    const { result, rerender } = renderHook(({ key }: { key: string }) => usePagedList(s.fetchBlock, key), { initialProps: { key: "todas" } });
    await waitFor(() => expect(result.current.state).toBe("ready"));
    act(() => result.current.loadNext());
    await waitFor(() => expect(result.current.rows).toHaveLength(60));
    const scrollKey = result.current.scrollKey;
    s.hooks.hold = true;
    rerender({ key: "minhas" });
    expect(result.current.rows).toHaveLength(0);
    expect(result.current.counterBusy).toBe(true);
    expect(result.current.phase).toBe("loading-next");
    expect(result.current.aggregates).toEqual({ all: 70 });
    expect(result.current.scrollKey).toBeGreaterThan(scrollKey);
    expect(s.calls.at(-1)).toBeNull();
    s.hooks.hold = false;
    await act(async () => s.pending.forEach((p) => p.resolve()));
    await waitFor(() => expect(result.current.rows).toHaveLength(30));
    expect(result.current.counterBusy).toBe(false);
  });

  it("#160/AC-1: a resposta atrasada do filtro anterior é descartada", async () => {
    const s = server();
    s.hooks.hold = true;
    const { result, rerender } = renderHook(({ key }: { key: string }) => usePagedList(s.fetchBlock, key), { initialProps: { key: "todas" } });
    rerender({ key: "minhas" });
    expect(s.pending).toHaveLength(2);
    // #160 O pedido do filtro novo chega primeiro; o do antigo, depois, com outro conteúdo.
    s.hooks.hold = false;
    await act(async () => s.pending[1]!.resolve());
    await waitFor(() => expect(result.current.state).toBe("ready"));
    const total = result.current.total;
    await act(async () => s.pending[0]!.resolve());
    expect(result.current.total).toBe(total);
    expect(result.current.rows).toHaveLength(30);
    expect(result.current.rows.every((r, i) => r.key === `k${i + 1}`)).toBe(true);
  });

  it("#160/AC-1: cursor_invalido recomeça do primeiro bloco uma vez, com o aviso; a segunda vira erro de bloco", async () => {
    const s = server();
    const { result } = renderHook(() => usePagedList(s.fetchBlock, "todas"));
    await waitFor(() => expect(result.current.state).toBe("ready"));
    s.hooks.invalidOnce = true;
    act(() => result.current.loadNext());
    await waitFor(() => expect(s.calls).toEqual([null, "m:30", null]));
    await waitFor(() => expect(result.current.rows).toHaveLength(30));
    expect(result.current.restarted).toBe(true);
    expect(result.current.phase).toBe("idle");
    s.hooks.invalidOnce = true;
    act(() => result.current.loadNext());
    await waitFor(() => expect(result.current.phase).toBe("error-next"));
    expect(result.current.rows).toHaveLength(30);
    expect(s.calls).toEqual([null, "m:30", null, "m:30"]);
  });

  it("#160/AC-4: tirar uma linha (D3) não volta ao início: as outras ficam, o total desce e os números vêm de uma releitura do primeiro bloco", async () => {
    const s = server();
    const { result } = renderHook(() => usePagedList(s.fetchBlock, "todas"));
    await waitFor(() => expect(result.current.state).toBe("ready"));
    act(() => result.current.loadNext());
    await waitFor(() => expect(result.current.rows).toHaveLength(60));
    const scrollKey = result.current.scrollKey;
    // #160 Agora o servidor tem 69 notas.
    const next = server(69);
    s.fetchBlock.mockImplementation(next.fetchBlock);
    act(() => result.current.remove("k1"));
    expect(result.current.rows).toHaveLength(59);
    expect(result.current.total).toBe(69);
    await waitFor(() => expect(result.current.aggregates).toEqual({ all: 69 }));
    expect(result.current.rows).toHaveLength(59);
    expect(result.current.rows.some((r) => r.key === "k60")).toBe(true);
    expect(result.current.scrollKey).toBe(scrollKey);
    expect(result.current.phase).toBe("idle");
  });

  it("#160/AC-4: se a releitura dos números falha, vale o ajuste local e a lista segue", async () => {
    const s = server();
    const { result } = renderHook(() => usePagedList(s.fetchBlock, "todas"));
    await waitFor(() => expect(result.current.state).toBe("ready"));
    s.hooks.failTotals = true;
    act(() => result.current.remove("k1"));
    await waitFor(() => expect(s.calls).toHaveLength(2));
    expect(result.current.state).toBe("ready");
    expect(result.current.rows).toHaveLength(29);
    expect(result.current.total).toBe(69);
  });
});

class FakeObserver {
  static live: FakeObserver[] = [];
  readonly targets: Element[] = [];
  constructor(private readonly callback: IntersectionObserverCallback, readonly options: IntersectionObserverInit = {}) {
    FakeObserver.live.push(this);
  }
  observe(target: Element): void {
    this.targets.push(target);
  }
  unobserve(): void {}
  disconnect(): void {
    FakeObserver.live = FakeObserver.live.filter((o) => o !== this);
    this.targets.length = 0;
  }
  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }
  fire(): void {
    // #160 o jsdom não tem IntersectionObserverEntry: a entrada parcial só carrega o que a tabela lê
    const entries = this.targets.map((target) => ({ isIntersecting: true, target }) as unknown as IntersectionObserverEntry);
    // #160 o observador simulado não implementa o resto da interface real (`root`, `thresholds`); o teste só chama o callback
    this.callback(entries, this as unknown as IntersectionObserver);
  }
}
const reachEnd = () => act(async () => FakeObserver.live.filter((o) => o.targets.length > 0).forEach((o) => o.fire()));

const columns = [{ key: "nota", title: "Nota", dataIndex: "number" as const, render: (_: unknown, r: Row) => `NF ${r.number}` }];

function Screen({ s, filter }: { s: ReturnType<typeof server>; filter: string }) {
  const list = usePagedList(s.fetchBlock, filter);
  return (
    <ScrollTable<Row>
      rows={list.rows}
      columns={columns}
      total={list.total}
      phase={list.phase}
      skeletonRows={list.skeletonRows}
      counterBusy={list.counterBusy}
      restarted={list.restarted}
      resetKey={list.scrollKey}
      label="Notas"
      onOpenRow={() => {}}
      rowLabel={(r) => `Abrir NF ${r.number}`}
      onNearEnd={list.loadNext}
      onRetry={list.retryBlock}
    />
  );
}

describe("#160 usePagedList dirigindo a ScrollTable", () => {
  beforeEach(() => {
    FakeObserver.live = [];
    vi.stubGlobal("IntersectionObserver", FakeObserver);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("#160/AC-5: perto do fim a tabela pede o próximo bloco, mostra esqueleto enquanto carrega e fecha com \"Você viu todas as 70 notas\"", async () => {
    const s = server();
    render(<Screen s={s} filter="todas" />);
    expect(await screen.findByText("NF 1")).toBeTruthy();
    expect(screen.getByText("70 notas")).toBeTruthy();
    s.hooks.hold = true;
    await reachEnd();
    // #160 30 notas e 3 linhas de esqueleto.
    expect(document.querySelectorAll("tbody tr")).toHaveLength(33);
    s.hooks.hold = false;
    await act(async () => s.pending.forEach((p) => p.resolve()));
    await waitFor(() => expect(screen.getByText("NF 60")).toBeTruthy());
    await reachEnd();
    expect(await screen.findByText("Você viu todas as 70 notas")).toBeTruthy();
    expect(s.calls).toEqual([null, "m:30", "m:60"]);
  });

  it("#160/AC-1: o erro de bloco mostra a faixa, e \"Tentar de novo\" repete o mesmo cursor sem perder as notas", async () => {
    const s = server();
    render(<Screen s={s} filter="todas" />);
    await screen.findByText("NF 1");
    s.hooks.failOnce.add("m:30");
    await reachEnd();
    expect(await screen.findByText("Não consegui carregar as próximas notas")).toBeTruthy();
    expect(screen.getByText("NF 30")).toBeTruthy();
    expect(document.body.textContent).not.toContain("segredo-do-servidor");
    fireEvent.click(screen.getByRole("button", { name: "Tentar de novo" }));
    await waitFor(() => expect(screen.getByText("NF 60")).toBeTruthy());
  });

  it("#160/AC-1: trocar o filtro leva a caixa ao topo e recarrega do início; o cursor_invalido mostra o aviso de uma linha", async () => {
    const s = server();
    const { rerender } = render(<Screen s={s} filter="todas" />);
    await screen.findByText("NF 1");
    const box = screen.getByLabelText("Notas");
    box.scrollTop = 400;
    rerender(<Screen s={s} filter="minhas" />);
    await waitFor(() => expect(box.scrollTop).toBe(0));
    await waitFor(() => expect(screen.getByText("NF 30")).toBeTruthy());
    expect(s.calls).toEqual([null, null]);
    s.hooks.invalidOnce = true;
    await reachEnd();
    expect(await screen.findByText("A lista mudou e voltou ao início")).toBeTruthy();
    await waitFor(() => expect(s.calls).toEqual([null, null, "m:30", null]));
  });
});
