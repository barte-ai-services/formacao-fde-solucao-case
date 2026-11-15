// #211 AC-5 Os dois indicadores, vindos da API: % resolvido sem pessoa e tempo mediano da captura à decisão.
import { Stat, StatGrid } from "@barte-ai-services/barte-ui-kit";
import { texts } from "../texts";
import { duration } from "./automation-format";
import { useAutomation } from "./automation-context";

const t = texts.automation.indicators;
const pct = (v: number | null) => (v === null ? t.none : `${v}%`);

export function AutomationIndicators() {
  const data = useAutomation();
  if (!data) return null;
  const { day, month } = data.indicators;
  return (
    <StatGrid columns={2}>
      <Stat
        caption={t.withoutPerson}
        value={pct(day.withoutPersonPct)}
        context={t.withoutPersonContext(pct(month.withoutPersonPct))}
        tone="info"
        info={t.withoutPersonInfo}
        infoLabel={t.withoutPerson}
      />
      <Stat
        caption={t.captureToDecision}
        value={duration(day.medianSeconds.withoutPerson)}
        context={t.captureToDecisionContext(duration(day.medianSeconds.withPerson))}
        tone="info"
        info={t.captureToDecisionInfo}
        infoLabel={t.captureToDecision}
      />
    </StatGrid>
  );
}
