import type { ReactElement, ReactNode } from "react";
import { StatusBadge, type Tone } from "@barte-ai-services/barte-ui-kit";
import "./GridBadge.css";

export interface GridBadgeProps {
  /** Padrão `neutral`, como o do kit. */
  tone?: Tone;
  /** `soft` por padrão; `solid` onde o status precisa gritar (a ação da doca). */
  variant?: "soft" | "solid";
  children: ReactNode;
}

/** O selo de status das grids (#201): a pílula do kit, mais gorda, definida só aqui com tokens do design system. */
export function GridBadge({ tone, variant, children }: GridBadgeProps): ReactElement {
  return (
    <StatusBadge size="pill" tone={tone} variant={variant} className="grid-badge">
      {children}
    </StatusBadge>
  );
}
