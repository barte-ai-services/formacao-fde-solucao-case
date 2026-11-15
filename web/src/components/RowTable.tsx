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
}

/**
 * #209 A tabela das grids: a linha inteira abre a gaveta da nota, com o mouse (cursor e realce do DS), com Enter ou espaço,
 * e entra na ordem do Tab. O link da NF, um seletor ou um botão dentro da linha não abrem a gaveta.
 * O `Table` do DS só trata o clique; o teclado e o rótulo entram aqui, nas linhas que ele desenha.
 */
export function RowTable<T extends object>({ onOpenRow, rowLabel, data, ...table }: RowTableProps<T>): ReactElement {
  const box = useRef<HTMLDivElement>(null);
  /** O clique que nasceu num controle: lido em captura, antes de a linha tratar o seu. */
  const fromControl = useRef(false);

  useEffect(() => {
    const trs = box.current?.querySelectorAll<HTMLElement>("tbody tr") ?? [];
    data.forEach((record, i) => {
      const tr = trs[i];
      if (!tr) return;
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
    if (!record) return;
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
        {...(table as unknown as TableProps<T>)}
        data={data}
        onRowClick={(record) => {
          const ignore = fromControl.current;
          fromControl.current = false;
          if (!ignore) onOpenRow(record);
        }}
      />
    </div>
  );
}
