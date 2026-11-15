import type { ReactElement } from "react";
import { SegmentedFilter, type SegmentedFilterProps } from "@barte-ai-services/barte-ui-kit";
import "./GridFilter.css";

/** #207: as mesmas props do kit, menos o tamanho e a classe, que o componente fixa. */
export type GridFilterProps<T extends string> = Omit<SegmentedFilterProps<T>, "size" | "className">;

/** A pílula de filtro das grids (#207): o `SegmentedFilter` do kit, mais gordo, definido só aqui com tokens do design system. */
export function GridFilter<T extends string>(props: GridFilterProps<T>): ReactElement {
  return <SegmentedFilter {...props} className="grid-filter" />;
}
