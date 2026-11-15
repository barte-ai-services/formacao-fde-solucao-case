import type { ReactElement } from "react";
import { SegmentedFilter, type SegmentedFilterProps } from "@barte-ai-services/barte-ui-kit";
import "./GridFilter.css";

/** #207: as mesmas props do kit, menos o tamanho e a classe, que o componente fixa. */
export type GridFilterProps<T extends string> = Omit<SegmentedFilterProps<T>, "size" | "className">;

/** A pílula de filtro das grids (#207): o `SegmentedFilter` do kit no tamanho `base` (texto e contador em body-sm, vindos do kit), com altura e respiro de tokens do design system definidos só aqui. */
export function GridFilter<T extends string>(props: GridFilterProps<T>): ReactElement {
  return <SegmentedFilter {...props} size="base" className="grid-filter" />;
}
