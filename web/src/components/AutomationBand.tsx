// #211 AC-2 A faixa de automação, no topo de todas as telas: a última rodada, a próxima e o que ela fez.
// Azul (sistema) quando está ok, âmbar quando a última falhou, vermelha quando a automação está parada.
import { useState } from "react";
import { Alert, Button, Drawer, Table } from "barte-design-system";
import type { AutomationRunDto } from "../api/automation";
import { texts } from "../texts";
import { clock } from "./automation-format";
import { useAutomation } from "./automation-context";

const t = texts.automation;

const toPerson = (r: AutomationRunDto) => Math.max(0, r.figures.proposed - r.figures.approvedByRule);

export function AutomationBand({ now = () => new Date() }: { now?: () => Date }) {
  const data = useAutomation();
  const [open, setOpen] = useState(false);
  // Faixa é informação a mais: se não carrega, a tela segue sem ela.
  if (!data) return null;

  const { last } = data;
  const next = clock(data.next);
  const seeRuns = (
    <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
      {t.seeRuns}
    </Button>
  );

  let band = null;
  if (data.state === "stalled") {
    band = <Alert variant="error" showCloseButton={false} title={last ? t.stalled(clock(last.startedAt)) : t.neverRan} action={seeRuns} />;
  } else if (data.state === "failed" && last) {
    band = <Alert variant="warning" showCloseButton={false} title={t.failed(clock(last.startedAt), next)} action={seeRuns} />;
  } else if (last) {
    const minutes = Math.floor((now().getTime() - Date.parse(last.startedAt)) / 60_000);
    band = (
      <Alert
        variant="info"
        showCloseButton={false}
        title={t.ok(clock(last.startedAt), t.ago(minutes), next)}
        description={t.figures({
          captured: last.figures.inserted,
          checked: last.figures.checked,
          byRule: last.figures.approvedByRule,
          toPerson: toPerson(last),
          published: last.figures.dockPublished,
        })}
        action={seeRuns}
      />
    );
  }

  if (!band) return null;
  return (
    <div className="pagar-automation-band" data-state={data.state}>
      {band}
      {open ? (
        <Drawer isOpen title={t.drawerTitle} onClose={() => setOpen(false)} className="shell-connection-panel">
          <Table<AutomationRunDto>
            data={data.runs}
            rowKey={(r) => String(r.id)}
            size="md"
            emptyText={t.noRuns}
            columns={[
              { key: "at", title: t.columns.at, dataIndex: "startedAt", render: (_, r) => clock(r.startedAt) },
              { key: "status", title: t.columns.status, dataIndex: "status", render: (_, r) => (r.status === "ok" ? t.statusOk : t.statusFailed) },
              { key: "captured", title: t.columns.captured, dataIndex: "figures", render: (_, r) => r.figures.inserted },
              { key: "checked", title: t.columns.checked, dataIndex: "figures", render: (_, r) => r.figures.checked },
              { key: "byRule", title: t.columns.byRule, dataIndex: "figures", render: (_, r) => r.figures.approvedByRule },
              { key: "toPerson", title: t.columns.toPerson, dataIndex: "figures", render: (_, r) => toPerson(r) },
              { key: "published", title: t.columns.published, dataIndex: "figures", render: (_, r) => r.figures.dockPublished },
            ]}
          />
        </Drawer>
      ) : null}
    </div>
  );
}
