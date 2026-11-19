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

  it("#160/AC-1: D4 uma vez por geração: depois que um bloco seguinte chega, um novo cursor_invalido recomeça de novo", async () => {
    const s = server();
    const { result } = renderHook(() => usePagedList(s.fetchBlock, "todas"));
    await waitFor(() => expect(result.current.state).toBe("ready"));
    s.hooks.invalidOnce = true;
    act(() => result.current.loadNext());
    await waitFor(() => expect(s.calls).toEqual([null, "m:30", null]));
    await waitFor(() => expect(result.current.rows).toHaveLength(30));
    act(() => result.current.loadNext());
    await waitFor(() => expect(result.current.rows).toHaveLength(60));
    s.hooks.invalidOnce = true;
    act(() => result.current.loadNext());
    await waitFor(() => expect(s.calls).toEqual([null, "m:30", null, "m:30", "m:60", null]));
    await waitFor(() => expect(result.current.rows).toHaveLength(30));
    expect(result.current.phase).toBe("idle");
  });

  it("#160/AC-1: D4 \"Tentar de novo\" depois de um cursor_invalido recomeça do início, não repete o cursor recusado", async () => {
    const s = server();
    const { result } = renderHook(() => usePagedList(s.fetchBlock, "todas"));
    await waitFor(() => expect(result.current.state).toBe("ready"));
    s.hooks.invalidOnce = true;
    act(() => result.current.loadNext());
    await waitFor(() => expect(s.calls).toEqual([null, "m:30", null]));
    await waitFor(() => expect(result.current.phase).toBe("idle"));
    s.hooks.invalidOnce = true;
    act(() => result.current.loadNext());
    await waitFor(() => expect(result.current.phase).toBe("error-next"));
    const scrollKey = result.current.scrollKey;
    act(() => result.current.retryBlock());
    await waitFor(() => expect(s.calls.at(-1)).toBeNull());
    await waitFor(() => expect(result.current.phase).toBe("idle"));
    expect(s.calls).toEqual([null, "m:30", null, "m:30", null]);
    expect(result.current.rows).toHaveLength(30);
    expect(result.current.restarted).toBe(true);
    expect(result.current.scrollKey).toBe(scrollKey + 1);
  });

  it("#160/AC-4: reler os blocos já carregados (D3, o servidor mantém a nota) troca as linhas no lugar, sem voltar ao início, e acerta o total e os números", async () => {
    const s = server();
    const { result } = renderHook(() => usePagedList(s.fetchBlock, "todas"));
    await waitFor(() => expect(result.current.state).toBe("ready"));
    act(() => result.current.loadNext());
    await waitFor(() => expect(result.current.rows).toHaveLength(60));
    const scrollKey = result.current.scrollKey;
    const inner = s.fetchBlock.getMockImplementation()!;
    s.fetchBlock.mockImplementation(async (cursor, signal) => {
      const block = await inner(cursor, signal);
      return { ...block, items: block.items.map((row) => (row.key === "k1" || row.key === "k45" ? { ...row, number: "decidida" } : row)), aggregates: { all: 99 } };
    });
    act(() => result.current.refresh("k1"));
    await waitFor(() => expect(result.current.rows[0]?.number).toBe("decidida"));
    expect(s.calls.slice(2)).toEqual([null, "m:30"]);
    expect(result.current.rows).toHaveLength(60);
    expect(result.current.rows.map((r) => r.key)).toEqual(Array.from({ length: 60 }, (_, i) => `k${i + 1}`));
    expect(result.current.rows[44]?.number).toBe("decidida");
    expect(result.current.aggregates).toEqual({ all: 99 });
    expect(result.current.total).toBe(70);
    expect(result.current.scrollKey).toBe(scrollKey);
    expect(result.current.phase).toBe("idle");
  });

  it("#160/AC-4: uma nota que ordena antes entra no servidor entre a carga e a decisão: a releitura anda até a chave decidida voltar, e a linha mostra o estado novo", async () => {
    const s = server();
    const { result } = renderHook(() => usePagedList(s.fetchBlock, "todas"));
    await waitFor(() => expect(result.current.state).toBe("ready"));
    expect(result.current.rows).toHaveLength(30);
    // #160 O servidor ganha uma nota que ordena antes de todas; a decidida (k30, a última carregada) desce para o segundo bloco e já tem o estado novo.
    const all: Row[] = [{ key: "nova", number: "nova" }, ...Array.from({ length: TOTAL }, (_, i) => ({ key: `k${i + 1}`, number: i === 29 ? "decidida" : String(i + 1) }))];
    s.fetchBlock.mockImplementation(async (cursor): Promise<Block<Row, Agg>> => {
      const at = cursor === null ? 0 : Number(cursor.split(":")[1]);
      return { items: all.slice(at, at + SIZE), nextCursor: at + SIZE < all.length ? `m:${at + SIZE}` : null, total: all.length, aggregates: { all: all.length } };
    });
    act(() => result.current.refresh("k30"));
    await waitFor(() => expect(result.current.rows[29]?.number).toBe("decidida"));
    expect(result.current.rows).toHaveLength(30);
    expect(result.current.rows.map((r) => r.key)).toEqual(Array.from({ length: 30 }, (_, i) => `k${i + 1}`));
    expect(result.current.total).toBe(71);
  });

  it("#160/AC-4: o teto da releitura: chave que sumiu do servidor lê no máximo os blocos carregados mais um, e as linhas ficam intactas", async () => {
    const s = server();
    const { result } = renderHook(() => usePagedList(s.fetchBlock, "todas"));
    await waitFor(() => expect(result.current.state).toBe("ready"));
    const before = result.current.rows;
    act(() => result.current.refresh("sumiu"));
    await waitFor(() => expect(s.calls.slice(1)).toEqual([null, "m:30"]));
    await waitFor(() => expect(result.current.phase).toBe("idle"));
    expect(s.calls).toHaveLength(3);
    expect(result.current.rows).toEqual(before);
  });

  it("#160/AC-4: a releitura que chega depois de trocar o filtro ou depois de outra releitura é descartada", async () => {
    const s = server();
    const { result, rerender } = renderHook(({ key }) => usePagedList(s.fetchBlock, key), { initialProps: { key: "todas" } });
    await waitFor(() => expect(result.current.state).toBe("ready"));
    const inner = s.fetchBlock.getMockImplementation()!;
    const answers: ((a: number) => void)[] = [];
    s.fetchBlock.mockImplementation(async (cursor, signal) => {
      const block = await inner(cursor, signal);
      const all = await new Promise<number>((resolve) => answers.push(resolve));
      return { ...block, aggregates: { all } };
    });
    act(() => result.current.refresh("k1"));
    act(() => result.current.refresh("k1"));
    await waitFor(() => expect(answers).toHaveLength(2));
    await act(async () => answers[1]!(2));
    await waitFor(() => expect(result.current.aggregates).toEqual({ all: 2 }));
    await act(async () => answers[0]!(1));
    expect(result.current.aggregates).toEqual({ all: 2 });
    // #160 Trocar o filtro aborta a releitura em voo: a resposta dela não suja a lista nova.
    act(() => result.current.refresh("k1"));
    await waitFor(() => expect(answers).toHaveLength(3));
    rerender({ key: "minhas" });
    await act(async () => answers[2]!(3));
    await waitFor(() => expect(answers).toHaveLength(4));
    await act(async () => answers[3]!(40));
    await waitFor(() => expect(result.current.aggregates).toEqual({ all: 40 }));
  });

  it("#160/AC-4: se a releitura falha, as linhas ficam como estavam e a lista segue", async () => {
    const s = server();
    const { result } = renderHook(() => usePagedList(s.fetchBlock, "todas"));
    await waitFor(() => expect(result.current.state).toBe("ready"));
    s.hooks.failTotals = true;
    act(() => result.current.refresh("k1"));
    await waitFor(() => expect(s.calls).toHaveLength(2));
    expect(result.current.state).toBe("ready");
    expect(result.current.rows).toHaveLength(30);
    expect(result.current.total).toBe(70);
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
    expect(await screen.findByText("A lista mudou e voltou ao início. Recomeçamos do início; nada que você decidiu se perdeu.")).toBeTruthy();
    await waitFor(() => expect(s.calls).toEqual([null, null, "m:30", null]));
  });
});
