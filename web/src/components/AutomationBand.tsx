// #211 AC-2 e #242 A faixa de automação, no topo de todas as telas: a última rodada, a próxima e o que ela fez.
// #242 Informativa (azul) quando está ok, aviso (laranja) quando a última falhou, alerta (vermelha) quando está parada,
// #242 neutra quando ainda não rodou. Só tokens da barte-design-system; o ícone muda de forma para o tom não depender só da cor.
import { useState } from "react";
import { CaretRight, Hourglass, Info, Warning, WarningOctagon } from "@phosphor-icons/react";
import { Button, Drawer, Icon, Table } from "barte-design-system";
import type { AutomationRunDto } from "../api/automation";
import { texts } from "../texts";
import { clock } from "./automation-format";
import { useAutomation } from "./automation-context";

const t = texts.automation;

type Tone = "info" | "warning" | "error" | "neutral";

const toPerson = (r: AutomationRunDto) => Math.max(0, r.figures.proposed - r.figures.approvedByRule);

export function AutomationBand({ now = () => new Date() }: { now?: () => Date }) {
  const data = useAutomation();
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

  if (!band) return null;
  return (
    <>
      <div className="pagar-automation-band" data-state={data.state} data-tone={band.tone} role={band.tone === "error" ? "alert" : undefined}>
        <span className="pagar-automation-band__icon" aria-hidden="true">
          <Icon icon={band.icon} />
        </span>
        <div className="pagar-automation-band__text">
          <span className="pagar-automation-band__title">{band.title}</span>
          {band.figures ? <span className="pagar-automation-band__figures">{band.figures}</span> : null}
        </div>
        {seeRuns}
      </div>
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
    </>
  );
}
