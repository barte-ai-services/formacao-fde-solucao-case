import type { ReactElement } from "react";
import { Block, Timeline, type TimelineItem } from "@barte-ai-services/barte-ui-kit";
import type { TimelineStepDto } from "../api/approval";
import { DecidedBy } from "../components/DecidedBy";
import { texts } from "../texts";

const HOUR = new Intl.DateTimeFormat("pt-BR", { hour: "2-digit", minute: "2-digit", timeZone: "America/Sao_Paulo", hourCycle: "h23" });
/** #211 "10h15": a hora de Brasília, onde a Já Chegou paga. */
const hourOf = (iso: string): string => HOUR.format(new Date(iso)).replace(":", "h");

/** #211 AC-4 "Como esta nota andou": cada passo com a hora, o que aconteceu e o selo de quem fez, na ordem da API. */
export function ProposalTimeline({ steps }: { steps: readonly TimelineStepDto[] }): ReactElement {
  const items: TimelineItem[] = steps.map((s, i) => ({
    kind: "event",
    id: `${s.kind}-${i}`,
    title: s.step,
    time: hourOf(s.at),
    badge: <DecidedBy actor={s.actor} name={s.actor_name} />,
    byAgent: s.actor === "claude" || s.actor === "engine",
  }));
  return (
    <Block title={texts.timeline.title} size="sm">
      {steps.length === 0 ? <p>{texts.timeline.empty}</p> : <Timeline items={items} ariaLabel={texts.timeline.title} />}
    </Block>
  );
}
