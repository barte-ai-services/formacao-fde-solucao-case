import { useState, type ReactElement } from "react";
import { Alert } from "barte-design-system";
import { Stat, StatGrid } from "@barte-ai-services/barte-ui-kit";
import { InvoiceDrawer } from "../approval/InvoiceDrawer";
import type { LiveInvoiceRef } from "../api/live";
import { clock } from "../components/automation-format";
import { DecidedBy } from "../components/DecidedBy";
import { EmptyState } from "../components/EmptyState";
import { InvoiceCell } from "../components/InvoiceCell";
import { noteOf, type LiveFeed, type LiveRow } from "../components/live-state";
import { RowTable } from "../components/RowTable";
import { Screen } from "../components/Screen";
import { useLiveFeed } from "../components/useLiveFeed";
import type { RouteProps } from "./types";
import { texts } from "../texts";

const t = texts.aoVivo;
const KEY_TAIL = 8;

/** #355 O número da nota; sem ele, a chave curta (a API nem sempre resolve o número). */
const numberOf = (note: LiveInvoiceRef): string => note.number ?? note.access_key.slice(-KEY_TAIL);

function Figures({ feed }: { feed: LiveFeed }): ReactElement {
  const { withoutPersonPct, decided, byRule } = feed.day;
  return (
    <StatGrid columns={2}>
      <Stat
        caption={t.statWithoutPerson.caption}
        value={withoutPersonPct === null ? texts.automation.indicators.none : `${withoutPersonPct}%`}
        context={t.statWithoutPerson.context(decided, byRule)}
        tone="info"
      />
      <Stat caption={t.statAwaiting.caption} value={feed.awaiting} context={t.statAwaiting.context} tone="info" />
    </StatGrid>
  );
}

/** /pagar/ao-vivo: os passos da automação, do mais novo ao mais velho, que se atualizam sozinhos (#355). */
export default function AoVivo(_props: RouteProps): ReactElement {
  const { state, feed, stale, retry } = useLiveFeed();
  const [open, setOpen] = useState<string | null>(null);

  return (
    <Screen
      title={t.title}
      subtitle={t.subtitle}
      state={state}
      onRetry={retry}
      loadingLabel={t.loading}
      errorTitle={t.error}
      emptyLabel={t.empty}
      empty={<EmptyState title={t.emptyTitle} description={t.emptyDescription} />}
    >
      {() =>
        feed ? (
          <>
            <Figures feed={feed} />
            {stale ? <Alert variant="info" title={t.refreshFailed} showCloseButton={false} /> : null}
            <RowTable<LiveRow>
              data={feed.rows}
              rowKey={(row) => row.key}
              size="md"
              onOpenRow={(row) => {
                const note = noteOf(row.event);
                if (note) setOpen(note.access_key);
              }}
              rowInert={(row) => noteOf(row.event) === null}
              rowLabel={(row) => {
                const note = noteOf(row.event);
                return note ? texts.grid.openInvoice(numberOf(note)) : "";
              }}
              columns={[
                { key: "hora", title: t.columns.time, dataIndex: "event", render: (_, row) => clock(row.event.at) },
                {
                  key: "nota",
                  title: t.columns.invoice,
                  dataIndex: "event",
                  render: (_, row) => {
                    const note = noteOf(row.event);
                    return note ? <InvoiceCell number={numberOf(note)} /> : t.noInvoice;
                  },
                },
                {
                  key: "decididoPor",
                  title: texts.decidedBy.column,
                  dataIndex: "event",
                  render: (_, row) => <DecidedBy actor={row.event.actor} name={row.event.actor_name} />,
                },
                { key: "passo", title: t.columns.step, dataIndex: "event", render: (_, row) => row.event.step },
              ]}
            />
            {open !== null ? <InvoiceDrawer invoiceAccessKey={open} title={texts.fila.drawerTitle} onClose={() => setOpen(null)} /> : null}
          </>
        ) : null
      }
    </Screen>
  );
}
