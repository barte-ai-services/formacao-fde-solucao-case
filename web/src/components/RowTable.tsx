import { useEffect, useRef, type KeyboardEvent, type MouseEvent, type ReactElement } from "react";
import { Table } from "barte-design-system";

type TableProps<T extends object> = Parameters<typeof Table<T>>[0];

/** #209 O que é controle dentro da linha: clicar nele faz o que ele faz e não abre a gaveta. */
const CONTROL = 'a, button, input, select, textarea, label, [role="combobox"], [role="listbox"], [role="option"], [role="menuitem"], [data-row-control]';

/**
 * O teclado e o rótulo entram pela posição da linha em `data`. Ordenação, paginação e carga do `Table` mexem nessa
 * posição, então ficam de fora: a grid entrega `data` já na ordem em que quer ver.
 */
type Fixed = "onRowClick" | "sortState" | "onSort" | "pagination" | "loading" | "columns";

export interface RowTableProps<T extends object> extends Omit<TableProps<T>, Fixed> {
  columns: (Omit<TableProps<T>["columns"][number], "sortable"> & { sortable?: false })[];
  /** #209 Abre a gaveta da nota daquela linha. */
  onOpenRow: (row: T) => void;
  /** #209 O nome da linha para leitor de tela ("Abrir a nota 123"). */
  rowLabel: (row: T) => string;
  /**
   * #160 A linha que não é uma nota (o esqueleto da carga do próximo bloco): sem tabindex nem rótulo, `aria-hidden`, e nem o clique
   * nem o teclado a abrem. Opcional: sem ele, toda linha é de nota, como na #209.
   */
  rowInert?: (row: T) => boolean;
  /**
   * #355 Se a linha inerte some também para o leitor de tela. Padrão `true` (o esqueleto da #160); `false` para a linha que é um passo
   * real, só sem ação (a rodada do ao vivo): fica legível, fora do Tab e sem abrir a gaveta.
   */
  hideInert?: boolean;
}

/**
 * #209 A tabela das grids: a linha inteira abre a gaveta da nota, com o mouse (cursor e realce do DS), com Enter ou espaço,
 * e entra na ordem do Tab. O link da NF, um seletor ou um botão dentro da linha não abrem a gaveta.
 * O `Table` do DS só trata o clique; o teclado e o rótulo entram aqui, nas linhas que ele desenha.
 */
export function RowTable<T extends object>({ onOpenRow, rowLabel, rowInert, hideInert = true, data, ...table }: RowTableProps<T>): ReactElement {
  const box = useRef<HTMLDivElement>(null);
  /** O clique que nasceu num controle: lido em captura, antes de a linha tratar o seu. */
  const fromControl = useRef(false);

  useEffect(() => {
    const trs = box.current?.querySelectorAll<HTMLElement>("tbody tr") ?? [];
    data.forEach((record, i) => {
      const tr = trs[i];
      if (!tr) return;
      // #160 A linha inerte fica fora do Tab e, salvo `hideInert` falso (#355), da leitura.
      if (rowInert?.(record)) {
        if (hideInert) tr.setAttribute("aria-hidden", "true");
        return;
      }
      tr.setAttribute("tabindex", "0");
      tr.setAttribute("aria-label", rowLabel(record));
    });
  });

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    const tr = (event.target as HTMLElement).closest("tbody tr");
    // Só a própria linha: Enter num botão ou seletor dentro dela é do controle.
    if (!tr || event.target !== tr) return;
    const record = data[Array.from(tr.parentElement?.children ?? []).indexOf(tr)];
    if (!record || rowInert?.(record)) return;
    event.preventDefault();
    onOpenRow(record);
  };

  return (
    <div
      ref={box}
      className="pagar-row-table"
      onKeyDown={onKeyDown}
      onClickCapture={(event: MouseEvent) => {
        fromControl.current = (event.target as HTMLElement).closest(CONTROL) !== null;
      }}
    >
      <Table<T>
        // #160 O resto das props é `TableProps<T>` sem as de `Fixed`, com `columns` mais estreito (`sortable?: false`), o que ainda cabe em `TableProps<T>`; o TS não junta de volta um `Omit` sobre `T` genérico, então o cast a reabre (como em `ScrollTable`, em `columns`).
        {...(table as unknown as TableProps<T>)}
        data={data}
        onRowClick={(record) => {
          const ignore = fromControl.current;
          fromControl.current = false;
          if (!ignore && !rowInert?.(record)) onOpenRow(record);
        }}
      />
    </div>
  );
}
