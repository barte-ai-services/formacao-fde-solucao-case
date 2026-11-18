import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ScrollTable } from "./ScrollTable";

/*
 * #160 A tabela compartilhada, um teste por estado do wireframe aprovado (18/11/2026): vazio, populado, carregando
 * (esqueleto), erro de bloco, fim da lista e aviso de `cursor_invalido`. O lane do repositório é vitest + Testing Library
 * em jsdom (sem Storybook, Chromatic nem Playwright). A acessibilidade segue o que web/test/auditor-gaveta-a11y.test.tsx
 * usa: papéis, nomes acessíveis e ordem do teclado. O IntersectionObserver é simulado.
 */

type Row = { key: string; number: string };
const rows = (n: number): Row[] => Array.from({ length: n }, (_, i) => ({ key: `k${i + 1}`, number: String(i + 1) }));
const columns = [{ key: "nota", title: "Nota", dataIndex: "number" as const, render: (_: unknown, r: Row) => `NF ${r.number}` }];

class FakeObserver {
  static live: FakeObserver[] = [];
  readonly targets: Element[] = [];
  constructor(
    private readonly callback: IntersectionObserverCallback,
    readonly options: IntersectionObserverInit = {},
  ) {
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
  fire(): void {
    // #160 o jsdom não tem IntersectionObserverEntry: a entrada parcial só carrega o que a tabela lê
    const entries = this.targets.map((target) => ({ isIntersecting: true, target }) as unknown as IntersectionObserverEntry);
    // #160 o observador simulado não tem `root` nem `thresholds` da interface real; o teste só chama o callback
    this.callback(entries, this as unknown as IntersectionObserver);
  }
}
const watching = (): FakeObserver[] => FakeObserver.live.filter((o) => o.targets.length > 0);

beforeEach(() => {
  FakeObserver.live = [];
  vi.stubGlobal("IntersectionObserver", FakeObserver);
});
afterEach(() => vi.unstubAllGlobals());

type Props = Partial<Parameters<typeof ScrollTable<Row>>[0]>;
function setup(props: Props = {}) {
  const handlers = { onOpenRow: vi.fn(), onNearEnd: vi.fn(), onRetry: vi.fn() };
  const view = render(
    <ScrollTable<Row>
      rows={rows(3)}
      columns={columns}
      total={70}
      phase="idle"
      label="Notas da fila"
      rowLabel={(r) => `Abrir a nota ${r.number}`}
      {...handlers}
      {...props}
    />,
  );
  return { ...handlers, ...view };
}
const bodyRows = () => Array.from(document.querySelectorAll("tbody tr"));

describe("#160 ScrollTable: populado", () => {
  it("#160/AC-3: o contador no topo diz o total da API, não as linhas que carregaram", () => {
    setup();
    const counter = screen.getByText("70 notas").closest('[role="status"]');
    expect(counter).toBeTruthy();
    // #160 o contador vem antes da caixa da tabela, no topo
    const box = screen.getByLabelText("Notas da fila");
    expect(counter!.compareDocumentPosition(box) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(bodyRows()).toHaveLength(3);
  });

  it("#160/AC-1: mantém a #209: a linha tem rótulo, entra no Tab e abre pelo clique e pelo Enter", () => {
    const { onOpenRow } = setup();
    const row = screen.getByRole("row", { name: "Abrir a nota 2" });
    expect(row.getAttribute("tabindex")).toBe("0");
    fireEvent.click(within(row).getByText("NF 2"));
    fireEvent.keyDown(row, { key: "Enter" });
    expect(onOpenRow).toHaveBeenCalledTimes(2);
    expect(onOpenRow).toHaveBeenCalledWith({ key: "k2", number: "2" });
  });

  it("#160/AC-2: o cabeçalho e as linhas ficam na mesma caixa que rola, que tem nome acessível", () => {
    setup();
    const box = screen.getByLabelText("Notas da fila");
    expect(box.querySelector("thead")).toBeTruthy();
    expect(box.querySelector("tbody tr")).toBeTruthy();
    expect(screen.getByRole("columnheader", { name: "Nota" })).toBeTruthy();
  });

  it("#160/AC-3: o contador concorda no singular e mostra Carregando… na recarga do início", () => {
    const { rerender } = setup({ total: 1 });
    expect(screen.getByText("1 nota")).toBeTruthy();
    rerender(<ScrollTable<Row> rows={[]} columns={columns} total={1} phase="idle" counterBusy label="Notas da fila" rowLabel={(r) => r.number} onOpenRow={() => {}} />);
    expect(screen.getByText("Carregando…")).toBeTruthy();
    expect(screen.queryByText("1 nota")).toBeNull();
  });
});

describe("#160 ScrollTable: vazio", () => {
  it("#160/AC-3: sem linhas o contador diz 0 notas e não há rodapé de fim nem esqueleto", () => {
    setup({ rows: [], total: 0, phase: "end" });
    expect(screen.getByText("0 notas")).toBeTruthy();
    expect(screen.queryByText(/Você viu/)).toBeNull();
    // #160 o `Table` do DS diz o vazio em inglês por padrão: aqui vem de texts.ts, e nenhuma linha entra no Tab
    expect(screen.getByText("Nenhuma nota nesta lista")).toBeTruthy();
    expect(document.querySelectorAll('tbody tr[tabindex="0"]')).toHaveLength(0);
  });
});

describe("#160 ScrollTable: gatilho do próximo bloco", () => {
  it("#160/AC-1: o observador tem a caixa da tabela como root e olha o fim da lista", () => {
    setup();
    const [observer] = watching();
    expect(observer).toBeTruthy();
    const root = observer!.options.root as Element;
    expect(root).toBe(screen.getByLabelText("Notas da fila"));
    expect(root.querySelector("thead")).toBeTruthy();
    expect(root.querySelector("tbody tr")).toBeTruthy();
    expect(root.contains(observer!.targets[0]!)).toBe(true);
    expect(observer!.targets[0]!.getAttribute("aria-hidden")).toBe("true");
  });

  it("#160/AC-1: perto do fim pede o próximo bloco, e a tabela não decide mais nada", () => {
    const { onNearEnd } = setup();
    watching().forEach((o) => o.fire());
    expect(onNearEnd).toHaveBeenCalledTimes(1);
  });

  it.each(["loading-next", "error-next", "end"] as const)("#160/AC-1: em %s não há observação, então nada é buscado", (phase) => {
    const { onNearEnd } = setup({ phase });
    expect(watching()).toHaveLength(0);
    expect(onNearEnd).not.toHaveBeenCalled();
  });

  it("#160/AC-1: sem onNearEnd (tela sem paginação) a tabela não observa nada", () => {
    setup({ onNearEnd: undefined });
    expect(watching()).toHaveLength(0);
  });
});

describe("#160 ScrollTable: carregando o próximo bloco (esqueleto)", () => {
  it("#160/AC-1: três linhas de esqueleto abaixo da última nota, fora do Tab, da leitura e da gaveta", () => {
    const { onOpenRow } = setup({ phase: "loading-next" });
    const all = bodyRows();
    expect(all).toHaveLength(6);
    const skeleton = all.slice(3);
    skeleton.forEach((tr) => {
      expect(tr.getAttribute("tabindex")).toBeNull();
      expect(tr.getAttribute("aria-label")).toBeNull();
      expect(tr.getAttribute("aria-hidden")).toBe("true");
    });
    fireEvent.click(skeleton[0]!);
    fireEvent.keyDown(skeleton[0]!, { key: "Enter" });
    expect(onOpenRow).not.toHaveBeenCalled();
    // #160 para o leitor de tela só as 3 notas e o cabeçalho
    expect(screen.getAllByRole("row")).toHaveLength(4);
    // #160 as 3 notas são as únicas que o Tab alcança
    expect(document.querySelectorAll('tbody tr[tabindex="0"]')).toHaveLength(3);
  });

  it("#160/AC-1: a quantidade de esqueleto é ajustável", () => {
    setup({ phase: "loading-next", skeletonRows: 5 });
    expect(bodyRows()).toHaveLength(8);
  });

  it("#160/AC-2: o esqueleto respeita prefers-reduced-motion e só usa tokens, sem cor solta", () => {
    const css = readFileSync(resolve(process.cwd(), "src/app.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    const blocks = [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)].filter(([, sel]) => /pagar-skeleton/.test(sel!));
    expect(blocks.length).toBeGreaterThan(0);
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)\s*\{\s*\.pagar-skeleton\s*\{\s*animation:\s*none/);
    expect(blocks.map(([, , b]) => b).join("\n")).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });
});

describe("#160 ScrollTable: erro de bloco", () => {
  it("#160/AC-1: a faixa avisa, oferece Tentar de novo e mantém as notas que já carregaram", () => {
    const { onRetry } = setup({ phase: "error-next" });
    const alert = screen.getByRole("alert");
    expect(within(alert).getByText("Não consegui carregar as próximas notas")).toBeTruthy();
    expect(alert.textContent).toContain("As 3 que já carregaram continuam aqui.");
    fireEvent.click(within(alert).getByRole("button", { name: "Tentar de novo" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(bodyRows()).toHaveLength(3);
  });

  it("#160/AC-1: a faixa só diz o texto do desenho, nunca o erro nem a resposta da chamada", () => {
    // #160 o componente não recebe erro nem corpo de resposta: o que a pessoa lê é fixo, em texts.ts
    setup({ phase: "error-next" });
    expect(screen.getByRole("alert").textContent).toBe(
      "Não consegui carregar as próximas notasAs 3 que já carregaram continuam aqui. Tente de novo em um minuto. Se continuar, avise o suporte da Barte.Tentar de novo",
    );
  });
});

describe("#160 ScrollTable: fim da lista", () => {
  it("#160/AC-3: o rodapé diz Você viu todas as N notas, com o total da API", () => {
    setup({ phase: "end", total: 3 });
    expect(screen.getByText("Você viu todas as 3 notas").closest('[role="status"]')).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("#160 ScrollTable: aviso de cursor_invalido", () => {
  it("#160/AC-1: a lista que recomeçou leva um aviso de uma linha, sem o código do erro", () => {
    setup({ restarted: true });
    const notice = screen.getByText("A lista mudou e voltou ao início");
    expect(notice).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/cursor_invalido/);
    // #160 o aviso fica acima da caixa: não rola junto com as linhas
    expect(screen.getByLabelText("Notas da fila").contains(notice)).toBe(false);
  });

  it("#160/AC-1: sem recomeço não há aviso", () => {
    setup();
    expect(screen.queryByText("A lista mudou e voltou ao início")).toBeNull();
  });
});

describe("#160 ScrollTable: cabeçalho fixo", () => {
  it("#160/AC-2: a caixa rola e o cabeçalho prende ao topo dela por token, sem px solto", () => {
    const css = readFileSync(resolve(process.cwd(), "src/app.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    const box = [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)].filter(([, sel]) => /\.pagar-scroll\s*$/.test(sel!.trim()));
    expect(box.map(([, , b]) => b).join("\n")).toMatch(/overflow:\s*auto/);
    expect(box.map(([, , b]) => b).join("\n")).toMatch(/max-height:\s*var\(/);
    expect(css).toMatch(/thead th\s*\{[^}]*position:\s*sticky;[^}]*top:\s*0/);
  });
});

describe("#160 ScrollTable: a lista recomeçou", () => {
  it("#160/AC-1: mudar o resetKey leva a caixa ao topo; sem mudar, a rolagem fica onde a pessoa deixou", () => {
    const props = { rows: rows(3), columns, total: 3, phase: "idle" as const, label: "Notas", onOpenRow: () => {}, rowLabel: (r: Row) => `Abrir NF ${r.number}` };
    const { rerender } = render(<ScrollTable<Row> {...props} resetKey={1} />);
    const box = screen.getByLabelText("Notas");
    box.scrollTop = 300;
    rerender(<ScrollTable<Row> {...props} resetKey={1} />);
    expect(box.scrollTop).toBe(300);
    rerender(<ScrollTable<Row> {...props} resetKey={2} />);
    expect(box.scrollTop).toBe(0);
  });
});
