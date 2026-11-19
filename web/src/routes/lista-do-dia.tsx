import { useState } from "react";
import { Stat, StatGrid } from "@barte-ai-services/barte-ui-kit";
import { approvalApi, type TodayAggregates, type TodayRow } from "../api/approval";
import { InvoiceDrawer } from "../approval/InvoiceDrawer";
import { ScrollTable } from "../components/ScrollTable";
import { ACTION_LABEL, ACTION_TONE, codeLabel } from "../approval/labels";
import { AutomationIndicators } from "../components/AutomationIndicators";
import { DecidedBy } from "../components/DecidedBy";
import { GridBadge } from "../components/GridBadge";
import { InvoiceCell } from "../components/InvoiceCell";
import { EmptyState } from "../components/EmptyState";
import { Screen } from "../components/Screen";
import { usePagedList } from "../components/usePagedList";
import type { RouteProps } from "./types";
import { texts } from "../texts";

/**
 * /pagar/hoje: a lista do dia (AC-13). Só os títulos liberados ou reduzidos hoje, pela regra ou por
 * uma pessoa; nenhum bloqueado e nenhum de nota sem decisão.
 * #160 A lista chega em blocos por cursor, na ordem do servidor; os números do topo são o `total` e os agregados da resposta (AC-4).
 */
export default function ListaDoDia(_props: RouteProps) {
  const list = usePagedList<TodayRow, TodayAggregates>((cursor, signal) => approvalApi.todayPage(cursor, signal), "hoje");
  const { aggregates } = list;
  const [open, setOpen] = useState<string | null>(null);
  return (
    <Screen
      title={texts.listaDoDia.title}
      subtitle={texts.listaDoDia.subtitle}
      state={list.state}
      onRetry={list.retry}
      loadingLabel={texts.listaDoDia.loading}
      errorTitle={texts.listaDoDia.error}
      emptyLabel={texts.listaDoDia.empty}
      empty={
        <EmptyState
          title={texts.emptyState.todayList.title}
          description={texts.emptyState.todayList.description}
          action={{ label: texts.emptyState.action, to: "/pagar/fila" }}
        />
      }
    >
      {() => (
        <>
          <StatGrid columns={3}>
            <Stat caption={texts.listaDoDia.statTitles.caption} value={list.total} context={texts.listaDoDia.statTitles.context} />
            <Stat caption={texts.listaDoDia.statToPay.caption} value={aggregates?.toPay.text ?? ""} context={texts.listaDoDia.statToPay.context} />
            <Stat caption={texts.listaDoDia.statByRule.caption} value={aggregates?.approvedByRule ?? 0} context={texts.listaDoDia.statByRule.context} tone="positive" />
          </StatGrid>
          <AutomationIndicators />
          <ScrollTable<TodayRow>
            rows={list.rows}
            total={list.total}
            phase={list.phase}
            skeletonRows={list.skeletonRows}
            counterBusy={list.counterBusy}
            restarted={list.restarted}
            resetKey={list.scrollKey}
            onNearEnd={list.loadNext}
            onRetry={list.retryBlock}
            label={texts.listaDoDia.title}
            onOpenRow={(i) => setOpen(i.invoiceAccessKey)}
            rowLabel={(i) => texts.grid.openInvoice(i.number)}
            columns={[
              { key: "nota", title: texts.listaDoDia.columns.invoice, dataIndex: "number", render: (_, i) => <InvoiceCell number={i.number} bottom={i.supplierId} /> },
              {
                key: "excecao",
                title: texts.listaDoDia.columns.classification,
                dataIndex: "exceptionName",
                render: (_, i) => (
                  <GridBadge tone="neutral">
                    {i.exceptionName}
                  </GridBadge>
                ),
              },
              { key: "codigo", title: texts.listaDoDia.columns.code, dataIndex: "exceptionCode", render: (_, i) => codeLabel(i.exceptionCode) },
              {
                key: "acao",
                title: texts.listaDoDia.columns.action,
                dataIndex: "dockAction",
                render: (_, i) => (
                  <GridBadge tone={ACTION_TONE[i.dockAction]}>
                    {ACTION_LABEL[i.dockAction]}
                  </GridBadge>
                ),
              },
              { key: "quem", title: texts.listaDoDia.columns.approver, dataIndex: "approver", render: (_, i) => (i.approvedBy === null ? "—" : <DecidedBy actor={i.approvedBy} name={i.approvedBy === "person" ? i.approver : null} />) }, // #160 o motor não é pessoa: `approvedBy` o diz
              { key: "valor", title: texts.listaDoDia.columns.amount, dataIndex: "amount", align: "right", render: (_, i) => `${i.amount.text} de ${i.invoiceTotal.text}` },
            ]}
          />
          {open !== null ? <InvoiceDrawer invoiceAccessKey={open} title={texts.fila.drawerTitle} onClose={() => setOpen(null)} /> : null}
        </>
      )}
    </Screen>
  );
}
