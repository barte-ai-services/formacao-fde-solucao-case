// #211 AC-2 e #242 A faixa de automação, no topo de todas as telas: a última rodada, a próxima e o que ela fez.
// #242 Informativa (azul) quando está ok, aviso (laranja) quando a última falhou, alerta (vermelha) quando está parada,
// #242 neutra quando ainda não rodou. Só tokens da barte-design-system; o ícone muda de forma para o tom não depender só da cor.
import { useState } from "react";
import { StatusBadge } from "@barte-ai-services/barte-ui-kit";
import { CaretRight, Hourglass, Info, Warning, WarningOctagon } from "@phosphor-icons/react";
import { Button, Drawer, Icon, Table } from "barte-design-system";
import type { AutomationRunDto, SkippedRunDto } from "../api/automation";
import { texts } from "../texts";
import { clock } from "./automation-format";
import { AutomationAdminControls } from "./AutomationAdminControls";
import { useAutomation, useAutomationReload } from "./automation-context";

const t = texts.automation;

type Tone = "info" | "warning" | "error" | "neutral";

/** #357 Uma linha das rodadas: a que correu ou a pulada. */
type RunRow = { kind: "run"; run: AutomationRunDto } | { kind: "skipped"; run: SkippedRunDto };

const toPerson = (r: AutomationRunDto) => Math.max(0, r.figures.proposed - r.figures.approvedByRule);

/** Os números de uma rodada que correu; a pulada não fez nada, então não tem número. */
const figure = (r: RunRow, pick: (f: AutomationRunDto["figures"]) => number) => (r.kind === "run" ? pick(r.run.figures) : "—");

export function AutomationBand({ now = () => new Date() }: { now?: () => Date }) {
  const data = useAutomation();
  const reload = useAutomationReload();
  const [open, setOpen] = useState(false);
  // Faixa é informação a mais: se não carrega, a tela segue sem ela.
  if (!data) return null;

  const { last } = data;
  const next = clock(data.next);
  const seeRuns = (
    <Button
      variant="link"
      size="sm"
      className="pagar-automation-band__action"
      iconRight={<Icon icon={CaretRight} />}
      onClick={() => setOpen(true)}
    >
      {t.seeRuns}
    </Button>
  );

  let band: { tone: Tone; icon: typeof Info; title: string; figures?: string } | null = null;
  if (data.state === "stalled") {
    band = last
      ? { tone: "error", icon: WarningOctagon, title: t.stalled(clock(last.startedAt)) }
      : { tone: "neutral", icon: Hourglass, title: t.neverRan };
  } else if (data.state === "failed" && last) {
    band = { tone: "warning", icon: Warning, title: t.failed(clock(last.startedAt), next) };
  } else if (last) {
    const minutes = Math.floor((now().getTime() - Date.parse(last.startedAt)) / 60_000);
    band = {
      tone: "info",
      icon: Info,
      title: t.ok(clock(last.startedAt), t.ago(minutes), next),
      figures: t.figures({
        captured: last.figures.inserted,
        checked: last.figures.checked,
        byRule: last.figures.approvedByRule,
        toPerson: toPerson(last),
        published: last.figures.dockPublished,
      }),
    };
  }

  const isAdmin = data.isAdmin === true;
  const demo = data.demo?.enabled === true;
  const skipped = data.skipped ?? [];
  // #357 AC-1 O administrador sempre tem a faixa, para ter onde pedir a primeira rodada.
  if (!band && isAdmin) band = { tone: "neutral", icon: Hourglass, title: t.neverRan };
  if (!band) return null;
  const rows: RunRow[] = [
    ...data.runs.map((run): RunRow => ({ kind: "run", run })),
    ...skipped.map((run): RunRow => ({ kind: "skipped", run })),
  ].sort((a, b) => Date.parse(b.run.startedAt) - Date.parse(a.run.startedAt));
  return (
    <>
      <div className="pagar-automation-band" data-state={data.state} data-tone={band.tone} role={band.tone === "error" ? "alert" : undefined}>
        <span className="pagar-automation-band__icon" aria-hidden="true">
          <Icon icon={band.icon} />
        </span>
        <div className="pagar-automation-band__text">
          <span className="pagar-automation-band__title">{band.title}</span>
          {demo ? (
            <StatusBadge size="sm" tone="info" className="pagar-automation-band__demo">
              {t.demoMode}
            </StatusBadge>
          ) : null}
          {band.figures ? <span className="pagar-automation-band__figures">{band.figures}</span> : null}
          {skipped[0] ? (
            <span className="pagar-automation-band__skipped" data-testid="automation-skipped">
              {t.skipped(clock(skipped[0].startedAt))}
            </span>
          ) : null}
        </div>
        <div className="pagar-automation-band__actions">
          {isAdmin ? <AutomationAdminControls demoEnabled={demo} onReload={reload} /> : null}
          {seeRuns}
        </div>
      </div>
      {open ? (
        <Drawer isOpen title={t.drawerTitle} onClose={() => setOpen(false)} className="shell-connection-panel">
          <Table<RunRow>
            data={rows}
            rowKey={(r) => `${r.kind}-${r.run.id}`}
            size="md"
            emptyText={t.noRuns}
            columns={[
              { key: "at", title: t.columns.at, dataIndex: "run", render: (_, r) => clock(r.run.startedAt) },
              { key: "status", title: t.columns.status, dataIndex: "kind", render: (_, r) => (r.kind === "skipped" ? t.statusSkipped : r.run.status === "ok" ? t.statusOk : t.statusFailed) },
              { key: "captured", title: t.columns.captured, dataIndex: "run", render: (_, r) => figure(r, (f) => f.inserted) },
              { key: "checked", title: t.columns.checked, dataIndex: "run", render: (_, r) => figure(r, (f) => f.checked) },
              { key: "byRule", title: t.columns.byRule, dataIndex: "run", render: (_, r) => figure(r, (f) => f.approvedByRule) },
              { key: "toPerson", title: t.columns.toPerson, dataIndex: "run", render: (_, r) => r.kind === "run" ? toPerson(r.run) : "—" },
              { key: "published", title: t.columns.published, dataIndex: "run", render: (_, r) => figure(r, (f) => f.dockPublished) },
            ]}
          />
        </Drawer>
      ) : null}
    </>
  );
}
