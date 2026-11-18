import type { ReactElement } from "react";
import { AiSourceBadge } from "@barte-ai-services/barte-ui-kit";
import { GridBadge } from "./GridBadge";
import { texts } from "../texts";

/** #211 Quem fez o passo: o que a API chama de `system`, `rule`, `claude`, `engine` ou `person`. */
export type Actor = "system" | "rule" | "claude" | "engine" | "person";

/**
 * #211 O selo de quem decidiu, um só em toda grid e na gaveta. As cores seguem a legenda do BPMN alvo:
 * sistema e regra em azul, agente (Claude, motor) em rosa pelo `AiSourceBadge` do kit, pessoa em laranja.
 */
export function DecidedBy({ actor, name }: { actor: Actor; name?: string | null }): ReactElement {
  const t = texts.decidedBy;
  switch (actor) {
    case "system":
      return <GridBadge tone="info">{`⚙ ${name || t.system}`}</GridBadge>;
    case "rule":
      return <GridBadge tone="info">{`⚙ ${name || t.rule}`}</GridBadge>;
    case "claude":
    case "engine":
      return <AiSourceBadge source="ai" label={name || t[actor]} size="sm" />;
    case "person":
      return <GridBadge tone="waiting">{name || t.person}</GridBadge>;
  }
}
